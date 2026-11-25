import { Document } from '../types';
import { INITIAL_FOLDER_ID } from '../constants';
import { newId } from '../utils/id';
import {
  api,
  Client,
  NotOwnerError,
  OfflineError,
  PollResult,
  ServerDoc,
  UnauthorizedError,
} from './api';

/**
 * Rôle de cette session (onglet) :
 * - starting : premier contact avec le serveur ;
 * - active : elle a la main, elle seule écrit et envoie ;
 * - handing-over : une autre session demande la main, on termine les envois puis on la rend ;
 * - acquiring : on a demandé la main, on attend que l'autre session la rende (10 s max) ;
 * - passive : on suit le texte de la session active, en lecture seule.
 */
export type Role = 'starting' | 'active' | 'handing-over' | 'acquiring' | 'passive';
export type Network = 'online' | 'offline' | 'unauthorized';

/** Dernière version d'un document confirmée par le serveur. */
export interface SavedDoc {
  title: string;
  hasCustomTitle: boolean;
  content: string;
}

export interface SyncMeta {
  /** Révision du serveur sur laquelle repose l'état local. */
  base: number;
  saved: Record<string, SavedDoc>;
}

type Message =
  | { type: 'state'; from: string; docs: Document[]; meta: SyncMeta; activeDocId: string }
  | { type: 'takeover'; from: string };

export interface ChannelLike {
  postMessage(message: Message): void;
  onmessage: ((event: { data: Message }) => void) | null;
  close(): void;
}

export interface SessionDeps {
  getDocs: () => Document[];
  setDocs: (docs: Document[]) => void;
  getActiveDocId: () => string;
  setActiveDocId: (id: string) => void;
  /** Appelé dès que le rôle, le réseau ou l'état de sauvegarde change. */
  onUpdate: () => void;
  onNotice: (message: string) => void;
  client?: Client;
  channel?: ChannelLike | null;
  storage?: Storage;
}

export const META_KEY = 'write0_sync';
export const INTERVALS: Record<Role, number> = {
  starting: 2000,
  active: 2000, // battement de cœur + envoi des modifications
  'handing-over': 1000,
  acquiring: 1000,
  passive: 2500, // suivi du texte de la session active
};

export function isUnsaved(doc: Document, saved: SavedDoc | undefined) {
  if (!saved) return doc.content !== '' || !!doc.hasCustomTitle;
  return (
    saved.content !== doc.content ||
    saved.title !== doc.title ||
    saved.hasCustomTitle !== !!doc.hasCustomTitle
  );
}

const savedOf = (s: ServerDoc): SavedDoc => ({
  title: s.title,
  hasCustomTitle: s.hasCustomTitle,
  content: s.content,
});

function toDocument(s: ServerDoc, previous?: Document): Document {
  return {
    id: s.id,
    title: s.title,
    content: s.content,
    hasCustomTitle: s.hasCustomTitle,
    updatedAt: s.updatedAt,
    folderId: previous?.folderId ?? INITIAL_FOLDER_ID,
    // Les surlignages de texte collé restent locaux ; ils ne valent que pour le même texte.
    pastedRanges: previous?.content === s.content ? previous.pastedRanges : [],
  };
}

export class SessionSync {
  readonly session = newId();
  role: Role = 'starting';
  network: Network = 'online';
  owner: string | null = null;
  meta: SyncMeta;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private chain: Promise<unknown> = Promise.resolve();
  private running = false;
  private lastOwnerDoc = '';
  private broadcastTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private deps: SessionDeps) {
    this.listen();
    this.meta = { base: 0, saved: {} };
    try {
      const raw = JSON.parse(this.storage?.getItem(META_KEY) ?? 'null');
      if (raw && typeof raw.base === 'number' && raw.saved && typeof raw.saved === 'object') {
        this.meta = raw;
      }
    } catch {
      // Cache illisible : on repartira de l'état du serveur.
    }
  }

  private get client() {
    return this.deps.client ?? api;
  }

  private get storage(): Storage | undefined {
    return this.deps.storage ?? (typeof localStorage === 'undefined' ? undefined : localStorage);
  }

  /** Seule la session qui a la main écrit dans le cache local du navigateur. */
  get canPersist() {
    return this.role === 'active' || this.role === 'handing-over';
  }

  get canEdit() {
    return this.role === 'active';
  }

  /** Nombre de documents dont une modification n'est pas encore sur le serveur. */
  get unsavedCount() {
    const docs = this.deps.getDocs();
    const ids = new Set(docs.map((d) => d.id));
    return (
      docs.filter((d) => isUnsaved(d, this.meta.saved[d.id])).length +
      Object.keys(this.meta.saved).filter((id) => !ids.has(id)).length
    );
  }

  savedContent(id: string): string {
    return this.meta.saved[id]?.content ?? '';
  }

  // --- Cycle de vie -----------------------------------------------------------------------

  start() {
    if (this.running) return;
    this.running = true;
    this.listen();
    this.schedule(0);
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    clearTimeout(this.broadcastTimer);
    if (this.deps.channel) this.deps.channel.onmessage = null;
  }

  /** Fermeture ou rechargement de l'onglet : on rend la main tout de suite. */
  onUnload() {
    if (this.canPersist) {
      this.persistMeta();
      this.client.releaseOnUnload(this.session);
    }
  }

  /** Après une reconnexion (session expirée puis mot de passe saisi). */
  resume() {
    this.setNetwork('online');
    this.schedule(0);
  }

  /** Premier clic ou première frappe dans une session passive. */
  requestControl() {
    if (this.role !== 'passive') return;
    this.setRole('acquiring');
    // Même navigateur : prévient tout de suite l'onglet actif, sans attendre son prochain cycle.
    this.deps.channel?.postMessage({ type: 'takeover', from: this.session });
    this.schedule(0);
  }

  /** À chaque modification locale (session active) : diffusion aux autres onglets du navigateur. */
  localChanged() {
    if (!this.canPersist) return;
    this.persistMeta();
    clearTimeout(this.broadcastTimer);
    this.broadcastTimer = setTimeout(() => this.broadcast(), 100);
  }

  /** Un cycle : exécuté régulièrement, et directement par les tests. */
  tick(): Promise<void> {
    const run = this.chain.then(() => this.step());
    this.chain = run.catch(() => {});
    return run;
  }

  // --- Interne ----------------------------------------------------------------------------

  private listen() {
    if (this.deps.channel) this.deps.channel.onmessage = (event) => this.onMessage(event.data);
  }

  private schedule(delay: number) {
    clearTimeout(this.timer);
    if (!this.running) return;
    this.timer = setTimeout(() => {
      void this.tick().finally(() => {
        if (this.network !== 'unauthorized') this.schedule(INTERVALS[this.role]);
      });
    }, delay);
  }

  private async step() {
    if (this.network === 'unauthorized') return;
    try {
      if (this.role === 'starting') await this.startUp();
      else if (this.role === 'acquiring') await this.acquireStep();
      else if (this.role === 'passive') await this.passiveStep();
      else await this.activeStep();
    } catch (error) {
      if (error instanceof NotOwnerError) await this.lostControl();
      else if (!(error instanceof OfflineError) && !(error instanceof UnauthorizedError)) {
        console.error('write0 sync:', error);
      }
    }
  }

  private async net<T>(request: () => Promise<T>): Promise<T> {
    try {
      const result = await request();
      this.setNetwork('online');
      return result;
    } catch (error) {
      if (error instanceof OfflineError) this.setNetwork('offline');
      if (error instanceof UnauthorizedError) this.setNetwork('unauthorized');
      throw error;
    }
  }

  private poll(since: number) {
    const activeDoc = this.canPersist ? this.deps.getActiveDocId() : '';
    return this.net(() => this.client.poll(this.session, since, activeDoc));
  }

  private async startUp() {
    const p = await this.poll(this.meta.base);
    this.owner = p.owner;
    // Personne n'écrit : cette session prend la main d'office.
    if (!p.owner && (await this.net(() => this.client.acquire(this.session, '')))) {
      await this.afterAcquire(false);
      return;
    }
    this.setRole('passive');
    if (p.revision !== this.meta.base) await this.applyFull();
    this.followOwnerDoc(p);
  }

  private async acquireStep() {
    const granted = await this.net(() =>
      this.client.acquire(this.session, this.deps.getActiveDocId()),
    );
    if (granted) await this.afterAcquire(true);
  }

  /**
   * La main vient d'être obtenue. Si personne n'a écrit depuis notre état local, on le garde
   * (et on envoie ce qui manque). Sinon, la version du serveur remplace la nôtre.
   */
  private async afterAcquire(notify: boolean) {
    const p = await this.poll(this.meta.base);
    if (p.revision < this.meta.base) {
      // Données du serveur réinitialisées : tout le contenu local sera renvoyé.
      this.meta = { base: p.revision, saved: {} };
    } else if (p.revision > this.meta.base) {
      const discarded = notify && this.meta.base > 0 && this.unsavedCount > 0;
      await this.applyFull();
      if (discarded) {
        this.deps.onNotice(
          'Unsaved changes from this session were discarded: another session saved newer text.',
        );
      }
    }
    this.owner = this.session;
    this.setRole('active');
    this.persistMeta();
    await this.push();
    this.broadcast();
  }

  private async activeStep() {
    const p = await this.poll(this.meta.base);
    if (p.owner !== this.session) {
      await this.lostControl(p);
      return;
    }
    if (p.takeover || this.role === 'handing-over') {
      await this.handOver();
      return;
    }
    await this.push();
  }

  /** Une autre session a demandé la main : on termine les envois, puis on la rend. */
  private async handOver() {
    this.setRole('handing-over');
    await this.push();
    await this.net(() => this.client.release(this.session));
    this.owner = null;
    this.setRole('passive');
  }

  /** La main a été prise sans passation (session restée muette plus de 10 s). */
  private async lostControl(p?: PollResult) {
    p ??= await this.poll(this.meta.base);
    if (!p.owner) {
      // Personne d'autre ne l'a prise : on la reprend.
      if (await this.net(() => this.client.acquire(this.session, this.deps.getActiveDocId()))) {
        await this.afterAcquire(true);
        return;
      }
    }
    const discarded = p.revision !== this.meta.base && this.unsavedCount > 0;
    this.owner = p.owner;
    this.setRole('passive');
    if (p.revision !== this.meta.base) await this.applyFull();
    if (discarded) {
      this.deps.onNotice(
        'Another session took over: unsaved changes from this session were discarded.',
      );
    }
  }

  private async passiveStep() {
    const p = await this.poll(this.meta.base);
    this.owner = p.owner;
    if (p.revision > this.meta.base) this.applyChanges(p);
    else if (p.revision < this.meta.base) await this.applyFull();
    this.followOwnerDoc(p);
    this.deps.onUpdate();
  }

  /** Envoie les suppressions et les documents modifiés. */
  private async push() {
    let changed = false;
    const ids = new Set(this.deps.getDocs().map((d) => d.id));
    for (const id of Object.keys(this.meta.saved)) {
      if (ids.has(id)) continue;
      this.meta.base = await this.net(() => this.client.remove(this.session, id));
      delete this.meta.saved[id];
      changed = true;
    }
    for (const doc of this.deps.getDocs()) {
      if (!isUnsaved(doc, this.meta.saved[doc.id])) continue;
      const snapshot: ServerDoc = {
        id: doc.id,
        title: doc.title,
        hasCustomTitle: !!doc.hasCustomTitle,
        updatedAt: doc.updatedAt,
        content: doc.content,
      };
      this.meta.base = await this.net(() => this.client.save(this.session, snapshot));
      this.meta.saved[doc.id] = savedOf(snapshot);
      changed = true;
    }
    if (changed) {
      this.persistMeta();
      this.broadcast();
      this.deps.onUpdate();
    }
  }

  /** Remplace tout l'état local par celui du serveur. */
  private async applyFull() {
    const p = await this.poll(0);
    const previous = new Map(this.deps.getDocs().map((d) => [d.id, d]));
    this.meta = {
      base: p.revision,
      saved: Object.fromEntries(p.changed.map((s) => [s.id, savedOf(s)])),
    };
    this.deps.setDocs(p.changed.map((s) => toDocument(s, previous.get(s.id))));
    this.deps.onUpdate();
  }

  /** Applique les documents modifiés ou supprimés depuis notre révision. */
  private applyChanges(p: PollResult) {
    const onServer = new Set(p.ids);
    const changed = new Map(p.changed.map((s) => [s.id, s]));
    const docs = this.deps.getDocs();
    const known = new Set(docs.map((d) => d.id));
    const next = docs
      .filter((d) => onServer.has(d.id) || !this.meta.saved[d.id])
      .map((d) => (changed.has(d.id) ? toDocument(changed.get(d.id)!, d) : d));
    for (const s of p.changed) if (!known.has(s.id)) next.unshift(toDocument(s));
    for (const s of p.changed) this.meta.saved[s.id] = savedOf(s);
    for (const id of Object.keys(this.meta.saved)) {
      if (!onServer.has(id)) delete this.meta.saved[id];
    }
    this.meta.base = p.revision;
    this.deps.setDocs(next);
  }

  /** Une session passive affiche le document que la session active vient d'ouvrir. */
  private followOwnerDoc(p: { ownerDoc: string }) {
    if (!p.ownerDoc || p.ownerDoc === this.lastOwnerDoc) return;
    this.lastOwnerDoc = p.ownerDoc;
    if (this.deps.getDocs().some((d) => d.id === p.ownerDoc)) this.deps.setActiveDocId(p.ownerDoc);
  }

  private onMessage(message: Message) {
    if (message.type === 'takeover') {
      if (this.role === 'active') {
        this.setRole('handing-over');
        this.schedule(0);
      }
      return;
    }
    if (this.canPersist) return;
    // Onglet actif du même navigateur : mise à jour immédiate, texte non envoyé compris.
    this.meta = message.meta;
    this.owner = message.from;
    this.deps.setDocs(message.docs);
    this.followOwnerDoc({ ownerDoc: message.activeDocId });
    this.deps.onUpdate();
  }

  private broadcast() {
    if (!this.canPersist) return;
    this.deps.channel?.postMessage({
      type: 'state',
      from: this.session,
      docs: this.deps.getDocs(),
      meta: this.meta,
      activeDocId: this.deps.getActiveDocId(),
    });
  }

  private persistMeta() {
    if (!this.canPersist) return;
    try {
      this.storage?.setItem(META_KEY, JSON.stringify(this.meta));
    } catch {
      // Le bandeau d'erreur de stockage de write0 prévient déjà l'utilisateur.
    }
  }

  private setRole(role: Role) {
    if (this.role === role) return;
    this.role = role;
    this.deps.onUpdate();
  }

  private setNetwork(network: Network) {
    if (this.network === network) return;
    this.network = network;
    this.deps.onUpdate();
  }
}
