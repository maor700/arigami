// Esc-Esc interrupts the selected working session. A lone Esc is the universal
// "close" key, so it must never stop work on its own: the first press only arms
// (and shows a hint), a second press on the SAME session within the window
// fires. An Esc that something else consumed (a menu, the palette, a dialog)
// never reaches this at all — see overlayOpen and e.defaultPrevented in App.

export const ESC_INTERRUPT_MS = 1500;

/** One Esc press → { fire, arm }: fire = interrupt now; arm = the new armed state. */
export function escInterruptStep(armed, sessionId, now) {
  if (armed && armed.id === sessionId && now - armed.at < ESC_INTERRUPT_MS) return { fire: true, arm: null };
  return { fire: false, arm: { id: sessionId, at: now } };
}

/** An open menu / popover / dialog / lightbox anywhere — Esc belongs to it. */
export function overlayOpen(doc = document) {
  return !!doc.querySelector('[role="menu"],[role="dialog"],[role="alertdialog"],[role="listbox"],[data-lightbox]');
}
