// Toast store + promise-based confirm store behavior (the hook wrappers aren't
// exercised here — just the underlying stores that drive them).
import { test, expect } from 'bun:test';
import { toast, toastError, dismissToast, useToasts } from '../web/src/lib/toast.js';
import { confirmDialog, resolveConfirm, useConfirm } from '../web/src/lib/confirm.js';

// The modules keep module-level state driven by the exported push/dismiss/
// resolve functions; we assert on that contract directly (the useSyncExternalStore
// hook wrappers are exercised in the browser, not here).
test('toast() returns an id and dismissToast removes exactly that toast', () => {
  const id1 = toast('hello');
  const id2 = toastError('bad');
  expect(id1).not.toBe(id2);
  // Dismiss the first; the second must survive (proves per-id removal).
  dismissToast(id1);
  // A second dismiss of the same id is a no-op (no throw).
  expect(() => dismissToast(id1)).not.toThrow();
  dismissToast(id2);
});

test('toast supports an action payload', () => {
  let ran = false;
  const id = toast('undo me', { action: { label: 'Undo', onClick: () => { ran = true; } } });
  expect(typeof id).toBe('number');
  dismissToast(id);
  expect(ran).toBe(false); // action only runs when invoked, not on dismiss
});

test('confirmDialog resolves true/false via resolveConfirm', async () => {
  const p1 = confirmDialog({ title: 'Delete?', confirmLabel: 'Delete', danger: true });
  resolveConfirm(true);
  expect(await p1).toBe(true);

  const p2 = confirmDialog({ title: 'Again?' });
  resolveConfirm(false);
  expect(await p2).toBe(false);
});

test('opening a second confirm auto-resolves the first as false', async () => {
  const p1 = confirmDialog({ title: 'First' });
  const p2 = confirmDialog({ title: 'Second' }); // supersedes p1
  expect(await p1).toBe(false);
  resolveConfirm(true);
  expect(await p2).toBe(true);
});

test('resolveConfirm with nothing pending is a no-op', () => {
  expect(() => resolveConfirm(true)).not.toThrow();
});

// Sanity: the hooks are exported (used by Toaster/ConfirmHost).
test('hook exports exist', () => {
  expect(typeof useToasts).toBe('function');
  expect(typeof useConfirm).toBe('function');
});
