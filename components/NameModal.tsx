import React, { useRef, useState } from 'react';
import { X } from 'lucide-react';
import { useDialogFocus } from '../hooks/useDialogFocus';

interface NameModalProps {
  isOpen: boolean;
  onConfirm: (name: string) => void;
  onCancel: () => void;
}

/** Demande le nom d'un nouveau texte (même style que ConfirmModal). */
export const NameModal: React.FC<NameModalProps> = ({ isOpen, onConfirm, onCancel }) => {
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');

  useDialogFocus(isOpen, dialogRef, inputRef, onCancel);

  if (!isOpen) return null;

  const trimmed = name.trim();
  const close = () => {
    setName('');
    onCancel();
  };
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!trimmed) return;
    setName('');
    onConfirm(trimmed);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/10 dark:bg-black/40 backdrop-blur-[1px]"
      onClick={close}
    >
      <div
        className="bg-white dark:bg-neutral-900 rounded-2xl shadow-lg w-full max-w-md overflow-hidden relative border border-gray-200 dark:border-gray-800"
        onClick={(e) => e.stopPropagation()}
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="w0-name-title"
      >
        <form onSubmit={submit}>
          <div className="px-5 pt-6 pb-1 flex justify-between items-center">
            <h2
              id="w0-name-title"
              className="font-semibold text-gray-900 dark:text-white text-[20px]"
            >
              New document
            </h2>
            <button
              type="button"
              onClick={close}
              className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition-colors p-1 rounded-full hover:bg-gray-200 dark:hover:bg-gray-700"
              aria-label="Close dialog"
            >
              <X size={18} />
            </button>
          </div>

          <div className="px-5 py-4">
            <input
              ref={inputRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={200}
              placeholder="Document name"
              aria-label="Document name"
              className="w-full rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div className="px-5 py-4 pt-0 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={close}
              className="px-4 py-2 rounded-xl text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!trimmed}
              className="px-4 py-2 rounded-xl text-sm font-medium transition-colors bg-gray-900 dark:bg-white text-white dark:text-gray-900 hover:opacity-90 disabled:opacity-50"
            >
              Create
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
