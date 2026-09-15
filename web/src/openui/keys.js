// OPENUI phase 3 — when a card's global key handler must stand down: a
// screenshot lightbox is open (Escape closes it, nothing else), the human is
// typing, or focus sits inside ANOTHER card (Enter must activate what is
// focused, never approve something else).
import { isVncInputTarget } from '../lib/useScreenConnection.js';

export const CARD_SELECTOR = '[data-question-card],[data-permission-card],[data-screen-request]';

export function keysBlocked(e, cardEl) {
  if (e.metaKey || e.ctrlKey || e.altKey) return true;
  if (typeof document === 'undefined') return true;
  if (document.querySelector('[data-lightbox]')) return true;
  const el = document.activeElement;
  if (!el) return false;
  if (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && el.type !== 'button') || isVncInputTarget(el)) return true;
  const owner = el.closest ? el.closest(CARD_SELECTOR) : null;
  return !!(owner && cardEl && owner !== cardEl);
}
