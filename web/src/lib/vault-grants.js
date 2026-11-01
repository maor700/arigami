// VAULT4 — the owner's one-time "fill the rest yourself" grant. Given on a field card after the vault is unlocked, it
// lets THIS cockpit tab fill the saved details of ONE session on ONE exact origin without a tap per field, while the
// vault stays open. What it holds is a names-only SNAPSHOT taken at the tick: for every field name saved on that origin
// in exactly one entry, the entry it comes from (field → entry id). A name saved in two entries is not bound (the owner
// taps and picks), a sign-in role never is, and nothing saved later joins without a new tick. Lives in this tab's
// memory only (never stored, never sent to the host or the agent); gone when the vault locks, the session ends, the
// time is up or the owner taps Stop — and never reaches another origin, another session, a form or the owner's Chrome.
const grants = new Map(); // `${sessionId}\n${origin}` → { until, bindings: {name → entryId}, entries: [{id, title, fields}], ambiguous: [names] }
const notes = new Map(); // requestId → { error } — why an automatic fill did not land, for the card (and the rail) to show
const subs = new Set();
let version = 0;

export const GRANT_MINUTES_MAX = 60;
export const GRANT_MINUTES_DEFAULT = 30;

const key = (sessionId, origin) => `${sessionId}\n${origin}`;
// a sign-in role is never a grant's: those keep sign_in / the sign-in card's own rules (incl. the same-site match)
const ROLE = /^(username|password|otp)$/i;
const norm = (f) => String(f?.name ?? f ?? '').trim().toLowerCase();
export const isRoleField = (f) => ROLE.test(norm(f));
function bump() {
  version++;
  for (const fn of subs) fn();
}

/**
 * Pure: the snapshot a tick would take from the exact-origin entries as the vault describes them (`{id, title, fields:[{name}]}`).
 * `bindings` = field name → the one entry holding it; `ambiguous` = names held by more than one entry (a tap each time);
 * `entries` = what to show the owner, per entry, names only. Roles are left out of all three.
 */
export function snapshotBindings(entries) {
  const holders = new Map(); // name → Set(entryId)
  const shown = [];
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e?.id) continue;
    const names = [...new Set((e.fields || []).map(norm).filter((n) => n && !ROLE.test(n)))];
    for (const n of names) (holders.get(n) || holders.set(n, new Set()).get(n)).add(String(e.id));
    shown.push({ id: String(e.id), title: String(e.title || e.username || e.id), fields: names });
  }
  const bindings = {};
  const ambiguous = [];
  for (const [n, ids] of holders) (ids.size === 1 ? (bindings[n] = [...ids][0]) : ambiguous.push(n));
  return { bindings, ambiguous: ambiguous.sort(), entries: shown.map((e) => ({ ...e, fields: e.fields.filter((n) => bindings[n] === e.id) })).filter((e) => e.fields.length) };
}

/** Grant automatic fills for one session on one exact origin: the snapshot of `entries` now, for `minutes` (clamped). */
export function grantAutoFill({ sessionId, origin, entries, minutes = GRANT_MINUTES_DEFAULT }, now = Date.now()) {
  if (!sessionId || !/^https?:\/\//.test(String(origin || ''))) return null;
  const snap = snapshotBindings(entries);
  if (!Object.keys(snap.bindings).length) return null;
  const m = Math.max(1, Math.min(GRANT_MINUTES_MAX, Number(minutes) || GRANT_MINUTES_DEFAULT));
  const g = { until: now + m * 60_000, ...snap };
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

/** The entry a grant binds this request's field to — or null: a sign-in, a form, the owner's Chrome, a role, an unbound or ambiguous name, no grant. */
export function bindingFor(sessionId, req, now = Date.now()) {
  if (!req || req.kind !== 'field' || req.target === 'shared') return null;
  const name = norm(req.fields?.[0]);
  if (!name || ROLE.test(name)) return null;
  const g = grantFor(sessionId, req.origin, now);
  return (g && g.bindings[name]) || null;
}
export const coversRequest = (sessionId, req, now = Date.now()) => !!bindingFor(sessionId, req, now);

export function revokeGrant(sessionId, origin) {
  if (grants.delete(key(sessionId, origin))) bump();
}
export function revokeSession(sessionId) {
  let n = 0;
  for (const k of [...grants.keys()]) if (k.startsWith(`${sessionId}\n`)) { grants.delete(k); n++; }
  if (n) bump();
}
export function revokeAllGrants() {
  // the notes stay: a card whose automatic fill just failed keeps saying why after the lock that followed
  if (grants.size) { grants.clear(); bump(); }
}
/** Drop the grants of sessions that are gone. */
export function pruneGrants(liveSessionIds) {
  const live = new Set(liveSessionIds);
  let n = 0;
  for (const k of [...grants.keys()]) if (!live.has(k.split('\n')[0])) { grants.delete(k); n++; }
  if (n) bump();
}
export const grantCount = () => grants.size;

/** An automatic fill's outcome for the card: an error (the card stays up, says why, and needs the human again) or cleared on success. */
export function noteAuto(requestId, error) {
  if (error) notes.set(requestId, { error: String(error) });
  else notes.delete(requestId);
  bump();
}
export const autoNote = (requestId) => notes.get(requestId) || null;
/** The rail's question: does this open card need the human — not covered by a grant, or covered but the automatic fill failed? */
export const needsHuman = (sessionId, req, now = Date.now()) => !!req && (!coversRequest(sessionId, req, now) || !!autoNote(req.requestId)?.error);

// VAULT4: the vault worker's fatal failure (dead, silent, unreachable) while a grant promised an automatic fill: whoever holds
// the open cards (VaultAutoFill) acknowledges each covered request to the host by code BEFORE the lock revokes the grants —
// so the agent's tool ends now, without a tap, and the owner is asked again after unlocking.
let fatalHook = null;
export function setFatalHook(fn) { fatalHook = fn; }
export function reportFatal(code) {
  try { fatalHook?.(code); } catch { /* a card's problem never stops the lock */ }
}

export function subscribeGrants(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}
export const grantsVersion = () => version;
