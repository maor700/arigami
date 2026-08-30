// A5 (#11) — one place that turns a REST failure into a sentence a human reads.
//
// `api.js` throws `Error("HTTP 429 — <server message>")` with `.status` and the
// parsed `.body`. Printing that Error directly gave the cockpit lines like
// `Error: HTTP 429 — agent "Nili" hit its daily token budget …` — the status
// code leaked into the UI and the server's message was English-only (it even
// carried a Hebrew settings path inside an English sentence). The host now sends
// a structured `budget` object with its 429s, so the numbers come from the server
// and the wording from the locale.
import { t } from './i18n.js';

const num = (n) => Number(n || 0).toLocaleString();

/** `2026-08-31T00:00:00.000Z` → `00:00` (local). */
export function hhmm(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** The localized line for a 429 whose body carries the agent's budget state. */
export function budgetText(b) {
  return t('agents.budget.refused', {
    name: b.name || b.slug || '',
    used: num(b.usedTokens),
    cap: num(b.cap),
    at: hhmm(b.resetsAt),
  });
}

/** Anything thrown by `api.*` (or a plain string) → the message to show. */
export function errText(e) {
  if (!e) return '';
  if (typeof e === 'string') return e;
  const body = e.body;
  if (body && typeof body === 'object' && body.budget) return budgetText(body.budget);
  if (body && typeof body.error === 'string' && body.error) return body.error;
  return e.message || String(e);
}
