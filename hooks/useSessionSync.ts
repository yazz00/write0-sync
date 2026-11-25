import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { Document } from '../types';
import { ChannelLike, SessionSync } from '../sync/session';

export const UNAUTHORIZED_EVENT = 'write0:unauthorized';
export const AUTHENTICATED_EVENT = 'write0:authenticated';

interface Options {
  documents: Document[];
  setDocuments: (docs: Document[]) => void;
  activeDocId: string;
  setActiveDocId: (id: string) => void;
}

/** Branche le moteur de session (sync/session.ts) sur l'état React de write0. */
export function useSessionSync({ documents, setDocuments, activeDocId, setActiveDocId }: Options) {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const [notices, setNotices] = useState<string[]>([]);
  const docsRef = useRef(documents);
  const activeRef = useRef(activeDocId);
  docsRef.current = documents;
  activeRef.current = activeDocId;

  const engineRef = useRef<SessionSync | null>(null);
  const unauthorizedRef = useRef(false);
  if (!engineRef.current) {
    const channel =
      typeof BroadcastChannel === 'undefined'
        ? null
        : (new BroadcastChannel('write0-session') as unknown as ChannelLike);
    engineRef.current = new SessionSync({
      getDocs: () => docsRef.current,
      setDocs: (docs) => {
        docsRef.current = docs;
        setDocuments(docs);
      },
      getActiveDocId: () => activeRef.current,
      setActiveDocId: (id) => {
        activeRef.current = id;
        setActiveDocId(id);
      },
      onUpdate: () => {
        rerender();
        // Session de connexion expirée : l'écran de connexion s'affiche par-dessus l'appli.
        const unauthorized = engineRef.current?.network === 'unauthorized';
        if (unauthorized && !unauthorizedRef.current) {
          window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
        }
        unauthorizedRef.current = unauthorized;
      },
      onNotice: (message) => setNotices((prev) => [...prev, message]),
      channel,
    });
  }
  const engine = engineRef.current;

  useEffect(() => {
    const onAuthenticated = () => engine.resume();
    const onPageHide = () => engine.onUnload();
    window.addEventListener(AUTHENTICATED_EVENT, onAuthenticated);
    window.addEventListener('pagehide', onPageHide);
    engine.start();
    return () => {
      window.removeEventListener(AUTHENTICATED_EVENT, onAuthenticated);
      window.removeEventListener('pagehide', onPageHide);
      engine.stop();
    };
  }, [engine]);

  // Chaque modification locale de la session active est diffusée aux autres onglets.
  useEffect(() => {
    engine.localChanged();
  }, [documents, activeDocId, engine]);

  const dismissNotice = useCallback(
    (index: number) => setNotices((prev) => prev.filter((_, i) => i !== index)),
    [],
  );

  return {
    role: engine.role,
    network: engine.network,
    owner: engine.owner,
    canEdit: engine.canEdit,
    canPersist: engine.canPersist,
    unsavedCount: engine.unsavedCount,
    savedContent: (id: string) => engine.savedContent(id),
    requestControl: () => engine.requestControl(),
    notices,
    dismissNotice,
  };
}
