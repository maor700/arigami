// Promise-based, non-blocking replacement for window.confirm(). Call
// `confirmDialog({...})` and await the boolean; a single <ConfirmHost/> mounted
// in App renders the current request. Unlike window.confirm this doesn't freeze
// the page/extension and matches the app's visual style.
import { useSyncExternalStore } from 'react';

let current = null; // { id, title, body, confirmLabel, cancelLabel, danger, resolve }
const listeners = new Set();
let seq = 0;

function emit() {
  for (const fn of listeners) fn();
}

export function confirmDialog(opts = {}) {
  // If one is already open, resolve it false first (shouldn't normally happen).
  if (current) {
    current.resolve(false);
    current = null;
  }
  return new Promise((resolve) => {
    current = {
      id: ++seq,
      title: opts.title || 'Are you sure?',
      body: opts.body || '',
      confirmLabel: opts.confirmLabel || 'Confirm',
      cancelLabel: opts.cancelLabel || 'Cancel',
      danger: !!opts.danger,
      resolve,
    };
    emit();
  });
}

export function resolveConfirm(value) {
  if (!current) return;
  const { resolve } = current;
  current = null;
  emit();
  resolve(value);
}

function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useConfirm() {
  return useSyncExternalStore(subscribe, () => current);
}
