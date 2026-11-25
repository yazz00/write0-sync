import { describe, expect, it } from 'vitest';
import { Document } from '../types';
import { Client, NotOwnerError, OfflineError, PollResult, ServerDoc } from '../sync/api';
import { ChannelLike, SessionSync } from '../sync/session';

/** Faux serveur qui applique les mêmes règles que server/api.php. */
class FakeServer {
  now = 1_000_000;
  revision = 0;
  lock: {
    session: string;
    beat: number;
    doc: string;
    takeover: { session: string; at: number } | null;
  } | null = null;
  docs = new Map<string, ServerDoc & { rev: number }>();
  offline = new Set<string>();

  private alive() {
    return !!this.lock && this.now - this.lock.beat <= 10_000;
  }

  /** Client propre à une session (pour couper le réseau d'une seule). */
  client(name: () => string): Client {
    const check = () => {
      if (this.offline.has(name())) throw new OfflineError('network');
    };
    const owner = (session: string) => {
      if (this.lock?.session !== session) throw new NotOwnerError();
    };
    return {
      status: async () => ({ authenticated: true }),
      login: async () => 'ok',
      logout: async () => ({}),
      releaseOnUnload: (session) => {
        if (this.lock?.session === session) this.lock = null;
        return true;
      },
      poll: async (session, since, activeDoc): Promise<PollResult> => {
        check();
        if (this.lock?.session === session) {
          this.lock.beat = this.now;
          this.lock.doc = activeDoc;
        }
        if (since > this.revision) since = 0;
        return structuredClone({
          revision: this.revision,
          ids: [...this.docs.keys()],
          changed: [...this.docs.values()]
            .filter((d) => d.rev > since)
            .map(({ rev: _rev, ...doc }) => doc),
          owner: this.alive() ? this.lock!.session : null,
          ownerDoc: this.alive() ? this.lock!.doc : '',
          takeover: this.lock?.session === session && !!this.lock.takeover,
        });
      },
      acquire: async (session, activeDoc) => {
        check();
        const t = this.lock?.takeover;
        const waited = t?.session === session && this.now - t.at >= 10_000;
        if (!this.lock || this.lock.session === session || !this.alive() || waited) {
          this.lock = { session, beat: this.now, doc: activeDoc, takeover: null };
          return true;
        }
        if (t?.session !== session) this.lock.takeover = { session, at: this.now };
        return false;
      },
      release: async (session) => {
        check();
        if (this.lock?.session === session) this.lock = null;
        return {};
      },
      save: async (session, doc) => {
        check();
        owner(session);
        this.revision++;
        this.docs.set(doc.id, { ...structuredClone(doc), rev: this.revision });
        this.lock!.beat = this.now;
        return this.revision;
      },
      remove: async (session, id) => {
        check();
        owner(session);
        if (this.docs.delete(id)) this.revision++;
        return this.revision;
      },
    };
  }
}

class MemoryStorage {
  private items = new Map<string, string>();
  getItem = (key: string) => this.items.get(key) ?? null;
  setItem = (key: string, value: string) => void this.items.set(key, value);
  removeItem = (key: string) => void this.items.delete(key);
}

/** Canal partagé entre onglets d'un même navigateur (BroadcastChannel). */
class Hub {
  members: ChannelLike[] = [];
  channel(): ChannelLike {
    const member: ChannelLike = {
      onmessage: null,
      postMessage: (message) => {
        for (const other of this.members) {
          if (other !== member) other.onmessage?.({ data: structuredClone(message) });
        }
      },
      close: () => {},
    };
    this.members.push(member);
    return member;
  }
}

let clock = 1;

/** Un onglet : sa liste de documents (l'état React de write0) et son moteur de session. */
function tab(
  server: FakeServer,
  options: { docs?: Document[]; storage?: MemoryStorage; hub?: Hub } = {},
) {
  let docs = options.docs ?? [];
  let activeDocId = docs[0]?.id ?? '';
  const notices: string[] = [];
  const engine: SessionSync = new SessionSync({
    getDocs: () => docs,
    setDocs: (next) => (docs = next),
    getActiveDocId: () => activeDocId,
    setActiveDocId: (id) => (activeDocId = id),
    onUpdate: () => {},
    onNotice: (m) => notices.push(m),
    client: server.client(() => engine.session),
    channel: options.hub?.channel() ?? null,
    storage: (options.storage ?? new MemoryStorage()) as unknown as Storage,
  });
  return {
    engine,
    notices,
    get docs() {
      return docs;
    },
    get activeDocId() {
      return activeDocId;
    },
    text(id: string) {
      return docs.find((d) => d.id === id)?.content;
    },
    write(id: string, content: string) {
      const exists = docs.some((d) => d.id === id);
      const doc = { id, content, title: content.split('\n')[0], folderId: 'f', updatedAt: ++clock };
      docs = exists ? docs.map((d) => (d.id === id ? { ...d, ...doc } : d)) : [doc, ...docs];
      activeDocId = id;
      engine.localChanged();
    },
    rename(id: string, title: string) {
      docs = docs.map((d) => (d.id === id ? { ...d, title, hasCustomTitle: true } : d));
      engine.localChanged();
    },
    remove(id: string) {
      docs = docs.filter((d) => d.id !== id);
      engine.localChanged();
    },
    offline(on: boolean) {
      if (on) server.offline.add(engine.session);
      else server.offline.delete(engine.session);
    },
  };
}

describe('une seule session a la main', () => {
  it('la première session prend la main et enregistre', async () => {
    const server = new FakeServer();
    const a = tab(server);
    await a.engine.tick();
    expect(a.engine.role).toBe('active');

    a.write('d1', 'Bonjour');
    expect(a.engine.unsavedCount).toBe(1);
    await a.engine.tick();
    expect(server.docs.get('d1')?.content).toBe('Bonjour');
    expect(a.engine.unsavedCount).toBe(0);
  });

  it('une deuxième session est passive et suit le texte', async () => {
    const server = new FakeServer();
    const a = tab(server);
    await a.engine.tick();
    a.write('d1', 'Bonjour');
    await a.engine.tick();

    const b = tab(server);
    await b.engine.tick();
    expect(b.engine.role).toBe('passive');
    expect(b.engine.canEdit).toBe(false);
    expect(b.text('d1')).toBe('Bonjour');
    expect(b.activeDocId).toBe('d1');

    a.write('d1', 'Bonjour, la suite');
    await a.engine.tick();
    await b.engine.tick();
    expect(b.text('d1')).toBe('Bonjour, la suite');
  });

  it("la passation récupère le texte que l'ancienne session n'avait pas encore envoyé", async () => {
    const server = new FakeServer();
    const a = tab(server);
    await a.engine.tick();
    a.write('d1', 'Début');
    await a.engine.tick();
    const b = tab(server);
    await b.engine.tick();

    a.write('d1', 'Début et fin non envoyée');
    b.engine.requestControl();
    await b.engine.tick(); // demande la main : pas encore accordée
    expect(b.engine.role).toBe('acquiring');

    await a.engine.tick(); // A voit la demande, termine ses envois et rend la main
    expect(a.engine.role).toBe('passive');
    expect(server.docs.get('d1')?.content).toBe('Début et fin non envoyée');

    await b.engine.tick();
    expect(b.engine.role).toBe('active');
    expect(b.text('d1')).toBe('Début et fin non envoyée');

    b.write('d1', 'Début et fin non envoyée. Suite écrite sur B.');
    await b.engine.tick();
    await a.engine.tick();
    expect(a.text('d1')).toBe('Début et fin non envoyée. Suite écrite sur B.');
  });

  it("prend la main après 10 s si l'ancienne session ne répond pas, et abandonne son texte non envoyé", async () => {
    const server = new FakeServer();
    const a = tab(server);
    await a.engine.tick();
    a.write('d1', 'Version enregistrée');
    await a.engine.tick();
    const b = tab(server);
    await b.engine.tick();

    a.offline(true);
    a.write('d1', 'Version enregistrée + texte perdu');
    await a.engine.tick();
    expect(a.engine.network).toBe('offline');
    expect(a.engine.role).toBe('active'); // on continue d'écrire hors ligne

    b.engine.requestControl();
    await b.engine.tick();
    server.now += 5_000;
    await b.engine.tick();
    expect(b.engine.role).toBe('acquiring');
    server.now += 5_001;
    await b.engine.tick();
    expect(b.engine.role).toBe('active');
    expect(b.text('d1')).toBe('Version enregistrée');

    b.write('d1', 'Version de B');
    await b.engine.tick();

    a.offline(false);
    await a.engine.tick();
    expect(a.engine.role).toBe('passive');
    expect(a.text('d1')).toBe('Version de B');
    expect(a.notices[0]).toContain('discarded');
    expect(server.docs.get('d1')?.content).toBe('Version de B');
  });

  it('une session active coupée du réseau garde la main si personne ne la prend', async () => {
    const server = new FakeServer();
    const a = tab(server);
    await a.engine.tick();
    a.offline(true);
    a.write('d1', 'Écrit hors ligne');
    await a.engine.tick();
    server.now += 60_000;
    a.offline(false);
    await a.engine.tick();
    expect(a.engine.role).toBe('active');
    await a.engine.tick();
    expect(server.docs.get('d1')?.content).toBe('Écrit hors ligne');
    expect(a.notices).toEqual([]);
  });

  it('propage les suppressions', async () => {
    const server = new FakeServer();
    const a = tab(server);
    await a.engine.tick();
    a.write('d1', 'Un');
    a.write('d2', 'Deux');
    await a.engine.tick();
    const b = tab(server);
    await b.engine.tick();
    expect(b.docs).toHaveLength(2);

    a.remove('d1');
    await a.engine.tick();
    expect(server.docs.has('d1')).toBe(false);
    await b.engine.tick();
    expect(b.docs.map((d) => d.id)).toEqual(['d2']);
  });

  it('enregistre tout de suite un nouveau texte nommé, même vide', async () => {
    const server = new FakeServer();
    const a = tab(server);
    await a.engine.tick();
    a.write('d1', '');
    a.rename('d1', 'Journal');
    await a.engine.tick();
    expect(server.docs.get('d1')).toMatchObject({ title: 'Journal', hasCustomTitle: true });
  });

  it("n'envoie pas un document vide tant que rien n'y est écrit", async () => {
    const server = new FakeServer();
    const a = tab(server);
    await a.engine.tick();
    a.write('d1', '');
    await a.engine.tick();
    expect(server.docs.size).toBe(0);
    expect(a.engine.unsavedCount).toBe(0);
  });
});

describe('onglets du même navigateur', () => {
  it("l'onglet passif voit la frappe tout de suite, y compris le texte non envoyé", async () => {
    const server = new FakeServer();
    const hub = new Hub();
    const storage = new MemoryStorage();
    const a = tab(server, { hub, storage });
    await a.engine.tick();
    const b = tab(server, { hub, storage });
    await b.engine.tick();
    expect(b.engine.role).toBe('passive');

    a.write('d1', 'Tapé à l’instant');
    await new Promise((r) => setTimeout(r, 150)); // diffusion groupée (100 ms)
    expect(b.text('d1')).toBe('Tapé à l’instant');
    expect(b.engine.savedContent('d1')).toBe(''); // encore orange dans l'onglet passif
  });

  it("la demande de main est transmise immédiatement à l'onglet actif", async () => {
    const server = new FakeServer();
    const hub = new Hub();
    const a = tab(server, { hub });
    await a.engine.tick();
    const b = tab(server, { hub });
    await b.engine.tick();

    a.write('d1', 'Texte de A');
    b.engine.requestControl();
    expect(a.engine.role).toBe('handing-over');
    expect(a.engine.canEdit).toBe(false);
    await a.engine.tick();
    await b.engine.tick();
    expect(b.engine.role).toBe('active');
    expect(b.text('d1')).toBe('Texte de A');
  });

  it('un rechargement de la page reprend le texte non envoyé', async () => {
    const server = new FakeServer();
    const storage = new MemoryStorage();
    const a = tab(server, { storage });
    await a.engine.tick();
    a.write('d1', 'Enregistré');
    await a.engine.tick();
    a.offline(true);
    a.write('d1', 'Enregistré + pas encore envoyé');
    await a.engine.tick();
    a.engine.onUnload();

    const reloaded = tab(server, { storage, docs: a.docs });
    await reloaded.engine.tick();
    expect(reloaded.engine.role).toBe('active');
    expect(server.docs.get('d1')?.content).toBe('Enregistré + pas encore envoyé');
  });

  it("un nouveau navigateur prend l'état du serveur sans message d'alerte", async () => {
    const server = new FakeServer();
    const a = tab(server);
    await a.engine.tick();
    a.write('d1', 'Mon texte');
    await a.engine.tick();
    a.engine.onUnload();

    const welcome = {
      id: 'welcome-note',
      title: 'Welcome',
      content: '# Welcome',
      folderId: 'f',
      updatedAt: 1,
    };
    const fresh = tab(server, { docs: [welcome] });
    await fresh.engine.tick();
    expect(fresh.engine.role).toBe('active');
    expect(fresh.docs.map((d) => d.id)).toEqual(['d1']);
    expect(fresh.notices).toEqual([]);
  });
});
