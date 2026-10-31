// VAULT2 — what a vault entry's fields are, in the names an agent uses (pure; shared by the vault worker, the
// Passwords page and the tests). An entry is a KDBX entry: its standard keys (UserName, Password, the otp / TOTP Seed
// pair) are the sign-in roles `username` / `password` / `otp`; every other string field is a detail the owner named
// (a card number, an ID number…), stored protected unless its type is `text`. The type is kept in one JSON field,
// "Arigami field types", so KeePassXC shows the values as ordinary additional attributes and nothing else changes for
// an entry that predates this.
export const FIELD_TYPES = ['text', 'secret', 'number', 'date', 'email', 'phone', 'otp', 'multiline'];
export const ORIGIN_FIELD = 'Arigami origin';
export const TYPES_FIELD = 'Arigami field types';
/** KDBX keys that are the entry's own, never a fillable field. */
export const HIDDEN_KEYS = new Set(['Title', 'URL', 'Notes', ORIGIN_FIELD, TYPES_FIELD, 'TOTP Settings']);
const RESERVED = /^(title|url|notes|arigami( |_).*)$/i;

const STANDARD_TO_NAME = { UserName: 'username', Password: 'password', 'TOTP Seed': 'otp', otp: 'otp', OTP: 'otp' };
const NAME_TO_KEY = { username: 'UserName', password: 'Password', otp: 'otp' };
const STANDARD_TYPE = { username: 'text', password: 'secret', otp: 'otp' };

/** The agent's name of a KDBX key ("UserName" → "username"; a custom key is its own name). */
export const agentName = (key) => STANDARD_TO_NAME[key] || key;
/** The KDBX key a field name is stored under ("username" → "UserName"; a custom name is its own key). */
export const kdbxKey = (name) => NAME_TO_KEY[String(name || '').toLowerCase()] || name;

/** A field name as the vault stores it — trimmed, single spaces, ≤ 64 chars, not one of the entry's own keys; null when unusable. */
export function cleanName(raw) {
  if (typeof raw !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const s = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s || s.length > 64 || RESERVED.test(s)) return null;
  return s;
}

export const cleanType = (t) => (FIELD_TYPES.includes(t) ? t : 'secret');

/**
 * The fields of an entry, for the agent and the Passwords page: `[{name, type}]` — names and types, no value.
 * `kv` = `[{key, protected, empty}]` straight off the KDBX entry; `types` = the parsed "Arigami field types" JSON.
 */
export function fieldsOf(kv, types = {}) {
  const out = [];
  const seen = new Set();
  for (const f of kv || []) {
    if (!f || HIDDEN_KEYS.has(f.key) || f.empty) continue;
    const name = agentName(f.key);
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const type = STANDARD_TYPE[name] || cleanType(types?.[name] || types?.[f.key] || (f.protected ? 'secret' : 'text'));
    out.push({ name, type });
  }
  return out;
}

/** Whether a value of this type is kept protected (memory-protected in KDBX, dots in the UI). Plain text and notes are not. */
export const isProtectedType = (type) => type !== 'text' && type !== 'multiline';

/** "Arigami field types" as stored: only custom names, only types that the protected flag alone would not say. */
export function typesToStore(fields) {
  const out = {};
  for (const f of fields || []) {
    if (!f?.name || STANDARD_TYPE[f.name.toLowerCase()]) continue;
    const t = cleanType(f.type);
    if (t !== 'secret' && t !== 'text') out[f.name] = t; // multiline included: a plain value alone reads as text
  }
  return out;
}

export function parseTypes(text) {
  try {
    const j = JSON.parse(text || '{}');
    return j && typeof j === 'object' && !Array.isArray(j) ? Object.fromEntries(Object.entries(j).filter(([, v]) => FIELD_TYPES.includes(v))) : {};
  } catch {
    return {};
  }
}

/** The catalog the cockpit uploads after each save: ids, titles, origins and field names — never a value or a username. */
export function catalogOf(entries) {
  return { entries: (entries || []).map((e) => ({ id: e.id, title: e.title, origin: e.origin, fields: (e.fields || []).map((f) => ({ name: f.name, type: f.type })) })) };
}

const registrableOf = (origin) => {
  let host = '';
  try { host = new URL(origin).hostname; } catch { return ''; }
  const p = host.toLowerCase().split('.').filter(Boolean);
  if (p.length <= 2) return p.join('.');
  const two = p.slice(-2).join('.');
  return /^(co|com|org|net|ac|gov)\.[a-z]{2}$/.test(two) ? p.slice(-3).join('.') : two;
};
const isRole = (field) => /^(username|password|otp)$/i.test(String(field || ''));

/**
 * May an entry's value go to a page on `requestOrigin`? A sign-in role keeps the sign-in card's rule (the same site,
 * so login.x.example serves x.example — legacy, unchanged). A named field is stricter: the entry's origin must be
 * exactly the page's; a sibling subdomain is another origin and gets nothing without the owner typing it there.
 */
export function entryAllowedFor(entryOrigin, requestOrigin, field) {
  if (!entryOrigin || !requestOrigin) return false;
  if (entryOrigin === requestOrigin) return true;
  if (!isRole(field)) return false;
  const a = registrableOf(entryOrigin), b = registrableOf(requestOrigin);
  return !!a && a === b && entryOrigin.startsWith('https://') === requestOrigin.startsWith('https://');
}

/** Does an entry (as `describe` returns it) match the agent's hint — its id, its title or its username? */
export function entryMatches(e, hint) {
  const h = String(hint || '').trim().toLowerCase();
  if (!h) return true;
  return e.id === hint || String(e.title || '').toLowerCase() === h || String(e.username || '').toLowerCase() === h;
}

/** Input attributes for a field type on the cockpit's own forms — never type="password" (the owner's browser would offer to save it). */
export function inputPropsFor(type) {
  switch (type) {
    case 'number':
      return { inputMode: 'numeric', secret: true };
    case 'date':
      return { inputMode: 'numeric', placeholderHint: 'MM/YY · DD/MM/YYYY', secret: false };
    case 'email':
      return { inputMode: 'email', secret: false };
    case 'phone':
      return { inputMode: 'tel', secret: false };
    case 'text':
      return { secret: false };
    case 'multiline':
      return { secret: false, multiline: true };
    case 'otp':
      return { secret: true, placeholderHint: 'otpauth://… or the base32 secret' };
    default:
      return { secret: true };
  }
}
