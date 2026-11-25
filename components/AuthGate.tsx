import React, { useCallback, useEffect, useState } from 'react';
import { api, OfflineError } from '../sync/api';
import { AUTHENTICATED_EVENT, UNAUTHORIZED_EVENT } from '../hooks/useSessionSync';

type Gate = 'checking' | 'offline' | 'login' | 'open';

/**
 * Vérifie la connexion avant d'afficher l'éditeur.
 * Sans réseau à l'ouverture, pas de service : un écran l'indique, avec un bouton pour réessayer.
 */
export const AuthGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [gate, setGate] = useState<Gate>('checking');
  const [expired, setExpired] = useState(false);

  const check = useCallback(() => {
    setGate('checking');
    api
      .status()
      .then((s) => setGate(s.authenticated ? 'open' : 'login'))
      .catch(() => setGate('offline'));
  }, []);

  useEffect(() => {
    check();
    const onUnauthorized = () => setExpired(true);
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, [check]);

  const onLoggedIn = () => {
    setGate('open');
    setExpired(false);
    window.dispatchEvent(new Event(AUTHENTICATED_EVENT));
  };

  if (gate === 'checking') return null;
  if (gate === 'offline') return <OfflineScreen onRetry={check} />;
  if (gate === 'login') return <LoginScreen onLoggedIn={onLoggedIn} />;
  return (
    <>
      {children}
      {expired && <LoginScreen onLoggedIn={onLoggedIn} overlay />}
    </>
  );
};

const Screen: React.FC<{ overlay?: boolean; children: React.ReactNode }> = ({
  overlay,
  children,
}) => (
  <div
    className={`${overlay ? 'fixed inset-0 z-[60] bg-gray-50/95 dark:bg-[#191919]/95' : 'h-dvh bg-gray-50 dark:bg-[#191919]'} flex items-center justify-center px-6`}
  >
    <div className="w-full max-w-xs space-y-4">
      <h1 className="font-mono font-medium text-2xl text-gray-800 dark:text-gray-100">write0</h1>
      {children}
    </div>
  </div>
);

const OfflineScreen: React.FC<{ onRetry: () => void }> = ({ onRetry }) => (
  <Screen>
    <p className="text-sm text-gray-600 dark:text-gray-400">
      The server cannot be reached. write0 needs a network connection to open.
    </p>
    <button
      onClick={onRetry}
      className="w-full rounded-md bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 py-2 text-sm font-medium"
    >
      Try again
    </button>
  </Screen>
);

const LoginScreen: React.FC<{ onLoggedIn: () => void; overlay?: boolean }> = ({
  onLoggedIn,
  overlay,
}) => {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await api.login(password);
      if (result === 'ok') return onLoggedIn();
      setError(
        result === 'locked' ? 'Too many attempts. Try again in 15 minutes.' : 'Wrong password.',
      );
    } catch (e) {
      setError(e instanceof OfflineError ? 'The server cannot be reached.' : 'Unexpected error.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen overlay={overlay}>
      {overlay && (
        <p className="text-sm text-gray-600 dark:text-gray-400">
          Your session has expired. Log in again to keep saving your writing.
        </p>
      )}
      <form onSubmit={submit} className="space-y-4">
        <label className="block">
          <span className="sr-only">Password</span>
          <input
            type="password"
            autoComplete="current-password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            className="w-full rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </label>
        {error && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={busy || !password}
          className="w-full rounded-md bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 py-2 text-sm font-medium disabled:opacity-50"
        >
          {busy ? 'Logging in…' : 'Log in'}
        </button>
      </form>
    </Screen>
  );
};
