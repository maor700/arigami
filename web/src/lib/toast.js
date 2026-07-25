// Tiny global toast store — non-blocking feedback for actions (copy, save,
// delete) and for errors that would otherwise vanish into a silent .catch().
// Replaces blocking window.alert(), which freezes the page (and, in a proxied
// tab, the extension). Subscribe via useToasts(); push via toast()/toastError().
import { useSyncExternalStore } from 'react';

let toasts = [];
const listeners = new Set();
let seq = 0;

function emit() {
  for (const fn of listeners) fn();
}

export function dismissToast(id) {
  const next = toasts.filter((t) => t.id !== id);
  if (next.length !== toasts.length) {
    toasts = next;
    emit();
  }
}

export function toast(message, opts = {}) {
  const id = ++seq;
  const ttl = opts.ttl ?? (opts.kind === 'error' ? 6000 : 3200);
  toasts = [...toasts, { id, message: String(message), kind: opts.kind || 'info', action: opts.action || null }];
  emit();
  if (ttl > 0) {
    const t = setTimeout(() => dismissToast(id), ttl);
    if (t.unref) t.unref();
  }
  return id;
}

export const toastError = (message, opts) => toast(message, { ...opts, kind: 'error' });
export const toastSuccess = (message, opts) => toast(message, { ...opts, kind: 'success' });

// Copy text to the clipboard and confirm with a toast. Returns the promise.
export async function copyWithToast(text, label = 'Copied') {
  try {
    await navigator.clipboard.writeText(String(text));
    toastSuccess(label);
  } catch {
    toastError('Copy failed — clipboard unavailable');
  }
}

function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useToasts() {
  return useSyncExternalStore(subscribe, () => toasts);
}
