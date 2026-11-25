export const API_URL: string = import.meta.env.VITE_API_URL ?? './api.php';

/** Ce que le serveur garde d'un document. */
export interface ServerDoc {
  id: string;
  title: string;
  hasCustomTitle: boolean;
  updatedAt: number;
  content: string;
}

export interface PollResult {
  revision: number;
  ids: string[];
  changed: ServerDoc[];
  /** Session qui a la main (null : personne). */
  owner: string | null;
  /** Document ouvert dans la session qui a la main. */
  ownerDoc: string;
  /** Une autre session demande la main à celle qui l'a. */
  takeover: boolean;
}

/** Réseau ou serveur injoignable. */
export class OfflineError extends Error {}
/** Session de connexion expirée ou absente. */
export class UnauthorizedError extends Error {}
/** Cette session n'a plus la main : une autre l'a prise. */
export class NotOwnerError extends Error {}

async function call<T>(action: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_URL}?action=${action}`, {
      method: body === undefined ? 'GET' : 'POST',
      credentials: 'same-origin',
      headers: { 'X-Write0': '1', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    });
  } catch {
    throw new OfflineError('network');
  }
  let data: Record<string, unknown> = {};
  try {
    data = await response.json();
  } catch {
    // Réponse non JSON (page d'erreur de l'hébergeur, portail Wi-Fi…) : traitée comme hors ligne.
    if (response.ok) throw new OfflineError('bad_response');
  }
  if (response.status === 401 && action !== 'login') throw new UnauthorizedError();
  if (response.status === 409) throw new NotOwnerError();
  if (!response.ok) {
    if (response.status >= 500) throw new OfflineError(String(data.error));
    throw new Error(String(data.error ?? response.status));
  }
  return data as T;
}

export const api = {
  status: () => call<{ authenticated: boolean }>('status'),
  login: async (password: string): Promise<'ok' | 'bad_password' | 'locked'> => {
    try {
      await call('login', { password });
      return 'ok';
    } catch (error) {
      if (error instanceof OfflineError) throw error;
      return (error as Error).message === 'too_many_attempts' ? 'locked' : 'bad_password';
    }
  },
  logout: () => call('logout', {}),
  poll: (session: string, since: number, activeDoc: string) =>
    call<PollResult>('poll', { session, since, activeDoc }),
  acquire: (session: string, activeDoc: string) =>
    call<{ granted: boolean }>('acquire', { session, activeDoc }).then((r) => r.granted),
  release: (session: string) => call('release', { session }),
  /** Rend la main à la fermeture de l'onglet (fetch classique impossible à ce moment-là). */
  releaseOnUnload: (session: string) =>
    navigator.sendBeacon?.(`${API_URL}?action=release`, JSON.stringify({ session })),
  save: (session: string, doc: ServerDoc) =>
    call<{ revision: number }>('save', { session, doc }).then((r) => r.revision),
  remove: (session: string, id: string) =>
    call<{ revision: number }>('delete', { session, id }).then((r) => r.revision),
};

export type Client = typeof api;
