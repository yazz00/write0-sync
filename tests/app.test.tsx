import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import App from '../App';
import { STORAGE_KEYS } from '../utils/storageUtils';

// Ces tests d'origine de write0 portent sur l'éditeur seul : la session a toujours la main.
// Le moteur de session est testé à part (session.test.ts, api-php.test.ts).
vi.mock('../hooks/useSessionSync', () => ({
  UNAUTHORIZED_EVENT: 'write0:unauthorized',
  AUTHENTICATED_EVENT: 'write0:authenticated',
  useSessionSync: () => ({
    role: 'active',
    network: 'online',
    owner: null,
    canEdit: true,
    canPersist: true,
    unsavedCount: 0,
    savedContent: () => '',
    requestControl: () => {},
    notices: [],
    dismissNotice: () => {},
  }),
}));

it('keeps a deleted library empty after reloading', () => {
  vi.useFakeTimers();
  const view = render(<App />);
  fireEvent.click(screen.getByRole('button', { name: 'Delete document' }));
  fireEvent.click(screen.getByRole('button', { name: /^Delete$/ }));
  act(() => {
    vi.advanceTimersByTime(250);
  });
  expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.documents)!)).toEqual([]);
  view.unmount();
  render(<App />);
  expect(screen.queryByRole('textbox', { name: 'Editor' })).toBeNull();
  expect(screen.getByText('Select or create a document to start writing')).toBeTruthy();
});

it('never undoes content from another document into the active document', () => {
  localStorage.setItem(
    STORAGE_KEYS.documents,
    JSON.stringify([
      {
        id: 'one',
        title: 'One',
        content: 'first',
        folderId: 'root',
        updatedAt: 1,
        hasCustomTitle: true,
      },
      {
        id: 'two',
        title: 'Two',
        content: 'second',
        folderId: 'root',
        updatedAt: 2,
        hasCustomTitle: true,
      },
    ]),
  );
  localStorage.setItem(STORAGE_KEYS.activeDocumentId, JSON.stringify('one'));
  render(<App />);
  fireEvent.change(screen.getByRole('textbox', { name: 'Editor' }), {
    target: { value: 'first edited', selectionStart: 12 },
  });
  fireEvent.click(screen.getByRole('button', { name: /^Two/ }));
  const textarea = screen.getByRole('textbox', { name: 'Editor' }) as HTMLTextAreaElement;
  fireEvent.keyDown(textarea, { key: 'z', ctrlKey: true });
  expect(textarea.value).toBe('second');
});

it('shows a visible warning when browser storage rejects a save', () => {
  vi.useFakeTimers();
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('Full', 'QuotaExceededError');
  });
  render(<App />);
  act(() => {
    vi.advanceTimersByTime(250);
  });
  expect(screen.getByRole('alert').textContent).toContain('not saved');
});

it('renders with missing or invalid saved settings', () => {
  localStorage.setItem(STORAGE_KEYS.settings, 'null');
  render(<App />);
  expect(screen.getByRole('button', { name: 'Enable typewriter mode' })).toBeTruthy();
});

it('asks for a name when creating a document', () => {
  render(<App />);
  fireEvent.click(screen.getByRole('button', { name: /New Document/ }));
  const input = screen.getByRole('textbox', { name: 'Document name' });
  expect(screen.getByRole('button', { name: 'Create' })).toHaveProperty('disabled', true);

  fireEvent.change(input, { target: { value: '  Journal de novembre  ' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create' }));

  expect(screen.queryByRole('dialog')).toBeNull();
  const current = screen.getByRole('button', { current: 'page' });
  expect(current.textContent).toContain('Journal de novembre');
});

it('creates nothing when the name dialog is cancelled', () => {
  render(<App />);
  const before = screen.getAllByRole('button', { name: 'Delete document' }).length;
  fireEvent.click(screen.getByRole('button', { name: /New Document/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getAllByRole('button', { name: 'Delete document' })).toHaveLength(before);
});
