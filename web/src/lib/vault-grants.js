// VAULT4 — the owner's one-time "fill the rest yourself" grant. Given on a field card after the vault is unlocked, it
// lets THIS cockpit tab fill the saved details of ONE session on ONE exact origin without a tap per field, while the
// vault stays open. Lives in this tab's memory only (never stored, never sent to the host or the agent); gone when the
// vault locks, the session ends, the time is up — and never reaches another origin, another session or a sign-in.
const grants = new Map(); // `${sessionId}\n${origin}` → { until, entryId, fields: [lower-case names] }
const notes = new Map(); // requestId → { error } — why an automatic fill did not land, for the card to show
const subs = new Set();
let version = 0;

export const GRANT_MINUTES_MAX = 60;
export const GRANT_MINUTES_DEFAULT = 30;

const key = (sessionId, origin) => `${sessionId}\n${origin}`;
function bump() {
  version++;
  for (const fn of subs) fn();
}

/**
 * Grant automatic fills for one session on one exact origin, from ONE entry, for the field NAMES it holds now, for
 * `minutes` (clamped) from now. A field saved on the entry later is not covered — the owner approved a list, not an entry.
 */
export function grantAutoFill({ sessionId, origin, entryId, fields, minutes = GRANT_MINUTES_DEFAULT }, now = Date.now()) {
  if (!sessionId || !/^https?:\/\//.test(String(origin || ''))) return null;
  const names = [...new Set((Array.isArray(fields) ? fields : []).map((f) => String(f?.name ?? f ?? '').trim().toLowerCase()).filter(Boolean))];
  if (!entryId || !names.length) return null;
  const m = Math.max(1, Math.min(GRANT_MINUTES_MAX, Number(minutes) || GRANT_MINUTES_DEFAULT));
  const g = { until: now + m * 60_000, entryId: String(entryId), fields: names };
  grants.set(key(sessionId, origin), g);
  bump();
  return g;
}

/** The live grant for a session + exact origin, or null (an expired one is dropped on the way). */
export function grantFor(sessionId, origin, now = Date.now()) {
  const k = key(sessionId, origin);
  const g = grants.get(k);
  if (!g) return null;
  if (g.until <= now) {
    grants.delete(k);
    bump();
    return null;
  }
  return g;
}

/** Does a grant cover this request — one of ITS field names (never a sign-in or a form) into the session browser (never the owner's Chrome)? */
export function coversRequest(sessionId, req, now = Date.now()) {
  if (!req || req.kind !== 'field' || req.target === 'shared') return false;
  const g = grantFor(sessionId, req.origin, now);
  return !!g && g.fields.includes(String(req.fields?.[0] || '').toLowerCase());
}

export function revokeGrant(sessionId, origin) {
  if (grants.delete(key(sessionId, origin))) bump();
}
export function revokeSession(sessionId) {
  let n = 0;
  for (const k of [...grants.keys()]) if (k.startsWith(`${sessionId}\n`)) { grants.delete(k); n++; }
  if (n) bump();
}
export function revokeAllGrants() {
  if (grants.size || notes.size) { grants.clear(); notes.clear(); bump(); }
}
/** Drop the grants of sessions that are gone. */
export function pruneGrants(liveSessionIds) {
  const live = new Set(liveSessionIds);
  let n = 0;
  for (const k of [...grants.keys()]) if (!live.has(k.split('\n')[0])) { grants.delete(k); n++; }
  if (n) bump();
}
export const grantCount = () => grants.size;

/** An automatic fill's outcome for the card: an error (the card stays up and says why) or cleared on success. */
export function noteAuto(requestId, error) {
  if (error) notes.set(requestId, { error: String(error) });
  else notes.delete(requestId);
  bump();
}
export const autoNote = (requestId) => notes.get(requestId) || null;

export function subscribeGrants(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}
export const grantsVersion = () => version;
