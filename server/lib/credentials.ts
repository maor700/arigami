// VAULT1 — the sign-in card (docs/INSTRUCTIONS-AND-VAULT.md, phase 3).
//
// The agent reaches a sign-in form and calls request_credentials. The host looks at the page over CDP — which of
// username / password / one-time-code are there, and the page's origin; never a value — and puts a card on the
// session. The owner answers in the cockpit: the cockpit holds the vault (a KDBX file it decrypts itself, in a Web
// Worker), and sends the values for that one pending request to fill(). The host types them into that same tab with
// the page's own value setter, submits, forgets them, and tells the agent only "filled" — the values never pass
// through a tool result, the chat, a prompt or a log line.
//
// What the host stores: the KDBX file as ciphertext (vaultFile / writeVaultFile — the key never reaches the host),
// and per-origin preferences without secrets (login-prefs.json: auto | ask | manual).
//
// Not protected, and said so in the design: the browser that receives the password runs on the host, and an agent
// with shell access could read a field off the page after the fill.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ARIGAMI_DIR } from './instance.js';
import { listTabs, frontPage, cdpCall, type ChromeTab } from './chrome-cdp.js';
import { hostOf, registrable } from './login-sites.js';

export type CredRole = 'username' | 'password' | 'otp';
export const ROLES: CredRole[] = ['username', 'password', 'otp'];
export type LoginPref = 'auto' | 'ask' | 'manual';

// ---- VAULT2: named fields -------------------------------------------------------------------------------------------
// An entry holds more than a sign-in: a card number, an ID number, a customer code — any field the owner names, with a
// type that only shapes the cockpit's input (digits, a date…). The host knows the NAMES and types (the catalog the
// cockpit uploads, below) and types a value into a page on the owner's say-so; it never holds, logs or returns one.

export type FieldType = 'text' | 'secret' | 'number' | 'date' | 'email' | 'phone' | 'otp' | 'multiline';
export const FIELD_TYPES: FieldType[] = ['text', 'secret', 'number', 'date', 'email', 'phone', 'otp', 'multiline'];
export interface FieldSpec {
  name: string;
  type: FieldType;
  /** What the owner sees on the form (the name when absent). */
  label?: string;
  required?: boolean;
}
export const FIELD_NAME_MAX = 64;
export const FIELDS_MAX = 24;
/** KDBX keys an agent may not name as a field: they are the entry's own. */
const RESERVED_FIELD = /^(title|url|notes|arigami( |_).*)$/i;

/** Pure: a field name as the vault stores it — trimmed, one space between words, no control characters, ≤ 64. */
export function fieldName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const s = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s || s.length > FIELD_NAME_MAX || RESERVED_FIELD.test(s)) return null;
  return s;
}

export const fieldType = (raw: unknown): FieldType => (FIELD_TYPES.includes(raw as FieldType) ? (raw as FieldType) : 'secret');

/** Pure: what an agent asked the owner for, cleaned — or why it cannot be asked. */
export function normalizeFieldSpecs(raw: unknown): { fields: FieldSpec[] } | { error: string } {
  const list = Array.isArray(raw) ? raw : [];
  if (!list.length) return { error: 'fields required: [{name, type?, label?}]' };
  if (list.length > FIELDS_MAX) return { error: `at most ${FIELDS_MAX} fields on one form` };
  const out: FieldSpec[] = [];
  const seen = new Set<string>();
  for (const f of list) {
    const o = typeof f === 'string' ? { name: f } : f && typeof f === 'object' ? (f as Record<string, unknown>) : {};
    const name = fieldName(o.name);
    if (!name) return { error: `a field name is missing, too long (> ${FIELD_NAME_MAX}) or reserved: ${JSON.stringify(String(o.name ?? '')).slice(0, 80)}` };
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const spec: FieldSpec = { name, type: fieldType(o.type) };
    if (typeof o.label === 'string' && o.label.trim()) spec.label = o.label.replace(/\s+/g, ' ').trim().slice(0, 80);
    if (o.required === false) spec.required = false;
    out.push(spec);
  }
  return { fields: out };
}

/** What the session's card shows — no values, ever. */
export interface CredentialRequest {
  requestId: string;
  at: string;
  origin: string;
  host: string;
  /** Sign-in roles (username / password / otp) — or, with `kind`, the names of the owner's own fields. */
  fields: string[];
  reason?: string;
  pref: LoginPref;
  /** 'shared' = the field is in the owner's Chrome on the shared desktop (sign_in); typed there with real keys. */
  target?: 'shared';
  /** The Chrome profile it is typed into, for the card ("work.example"). */
  account?: string;
  /** VAULT2: 'form' = the owner fills these fields on a secure form (nothing goes to a page); 'field' = one named field is typed into the session browser. Absent = a sign-in. */
  kind?: 'form' | 'field';
  /** 'form': the fields with their types and labels. */
  spec?: FieldSpec[];
  /** 'form': the entry the details belong to (an account name); 'field': the entry the agent asked for, if it named one. */
  entry?: string;
  /** 'field': the page element the value goes into, so the owner sees WHERE on the card — its tag, type, id/name and label words. */
  page?: { tag: string; type: string; label: string; id?: string; name?: string };
  /** 'field': which part of the saved value goes in — the whole value, or an expiry's month / full year (split in the vault worker, never here). */
  part?: FieldPart;
  /** 'field': the catalog (names only) says an entry of this origin holds this field — so the card can say "unlock to fill it" instead of a dead end. */
  saved?: boolean;
}

// VAULT3: a saved expiry ("MM/YY") lands in two selects on most payment forms. The agent names the part; the owner's
// vault worker does the split (month → two digits, year → four); the host only learns "month" / "year" and types what
// the worker sends into the one marked element — a <select> gets the option that matches, hidden afterwards.
export type FieldPart = 'value' | 'month' | 'year';
export const FIELD_PARTS: FieldPart[] = ['value', 'month', 'year'];
export const fieldPart = (raw: unknown): FieldPart | null => (raw === undefined || raw === null || raw === '' ? 'value' : FIELD_PARTS.includes(raw as FieldPart) ? (raw as FieldPart) : null);
/**
 * Pure: the part of a whole expiry — the worker's rule, kept here only for a cockpit tab older than the host that sends
 * the whole value (MM/YY, MM/YYYY, M/YY, MM-YY, MM.YY, MMYY, YYYY-MM, YYYY/MM); month → two digits, year → four. Null
 * for anything else. Runs in the fill route's memory and nowhere else.
 */
export function expiryPartOf(value: string, part: FieldPart): string | null {
  if (part === 'value') return value;
  const s = String(value ?? '').trim();
  let mm: string | null = null, yy: string | null = null, m: RegExpExecArray | null;
  if ((m = /^(\d{1,2})\s*[/\-. ]\s*(\d{2}|\d{4})$/.exec(s))) { mm = m[1]; yy = m[2]; }
  else if ((m = /^(\d{4})\s*[/\-. ]\s*(\d{1,2})$/.exec(s))) { yy = m[1]; mm = m[2]; }
  else if ((m = /^(\d{2})(\d{2})$/.exec(s))) { mm = m[1]; yy = m[2]; }
  else return null;
  const month = Number(mm);
  if (!(month >= 1 && month <= 12)) return null;
  const year = yy.length === 2 ? 2000 + Number(yy) : Number(yy);
  if (!(year >= 2000 && year <= 2099)) return null;
  return part === 'month' ? String(month).padStart(2, '0') : String(year);
}

/** Pure: what the worker may send for a part — a month is exactly two digits 01–12, a year exactly 20YY. Returns the complaint (never the value) or null. */
export function partShape(part: FieldPart | undefined, value: string): string | null {
  if (!part || part === 'value') return null;
  if (part === 'month') return /^(0[1-9]|1[0-2])$/.test(value) ? null : 'what was sent for the month is not a two-digit month (01–12)';
  if (part === 'year') return /^20\d{2}$/.test(value) ? null : 'what was sent for the year is not a four-digit year (20YY)';
  return 'unknown part';
}

interface Pending {
  sessionId: string;
  origin: string;
  /** The session-browser tab (target 'session'); '' for the shared desktop. */
  tabId: string;
  fields: string[];
  at: number;
  /** what the card shows — the session's copy is a mirror of this, never read back */
  request: CredentialRequest;
  /** Shared desktop: re-checks, right before the keys go out, that the focused field is still on `origin`. */
  recheck?: () => Promise<string | null>;
}

/** How a request ended — what a host-side waiter (sign_in) hears. Never a value. */
export type Settled = 'filled' | 'manual' | 'cancel' | 'expired' | 'saved' | 'failed';
/** VAULT4: the cockpit's filtered codes for a fill attempt that broke on its side, and the one line each becomes. No free text crosses. */
export const FAIL_REASONS: Record<string, string> = {
  worker_dead: "the owner's vault worker stopped while filling",
  worker_timeout: "the owner's vault did not answer in time",
  worker_unreachable: "the owner's vault worker could not be reached",
  host_timeout: "the owner's cockpit got no answer from the host in time",
  host_unreachable: "the owner's cockpit could not reach the host",
  host_error: 'the host failed while filling',
};
export const failReason = (code: unknown): string | null => (typeof code === 'string' && FAIL_REASONS[code]) || null;
const settleWaiters = new Map<string, (s: Settled) => void>();
// VAULT2: what the owner saved on a form — the entry's id, title and field NAMES, for the agent's next vault_fill.
const settleDetails = new Map<string, unknown>();
export function setSettleDetail(requestId: string, detail: unknown): void {
  settleDetails.set(requestId, detail);
}
export function takeSettleDetail(requestId: string): unknown {
  const d = settleDetails.get(requestId);
  settleDetails.delete(requestId);
  return d;
}

/** Wait for a request to be answered (filled / the owner types it / cancelled), at most `timeoutMs`. */
export function waitSettled(requestId: string, timeoutMs = REQUEST_TTL_MS): Promise<Settled> {
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      settleWaiters.delete(requestId);
      resolve('expired');
    }, timeoutMs);
    (t as any).unref?.();
    settleWaiters.set(requestId, (v) => {
      clearTimeout(t);
      resolve(v);
    });
  });
}

/** Does a host-side caller wait on this request (then IT tells the agent, not a "[host] …" message)? */
export const hasWaiter = (requestId: string): boolean => settleWaiters.has(requestId);

export function settle(requestId: string, outcome: Settled): void {
  const w = settleWaiters.get(requestId);
  if (!w) return;
  settleWaiters.delete(requestId);
  w(outcome);
}

/** The keys that type a value on the shared desktop — the real one, or a test's. */
export type SharedTyper = (value: string) => Promise<{ ok: true } | { ok: false; error: string }>;
let sharedTyper: SharedTyper = async (value) => (await import('./desktop-control.js')).sharedTypeSecret(value);
/** Test hook. */
export function _setSharedTyper(fn: SharedTyper): void {
  sharedTyper = fn;
}

export const REQUEST_TTL_MS = 15 * 60_000;
const pending = new Map<string, Pending>();

// ---- sites a password is never filled on ---------------------------------------------------------------------------
// Google and GitHub treat a scripted sign-in as an attack (Google blocks the browser outright; GitHub pairs it with
// device verification) — and both are better reached as connections. The owner signs in to them in My browser, and the
// session gets the login through request_login.

const REFUSED: { id: string; label: string; test: (host: string) => boolean }[] = [
  { id: 'google.com', label: 'Google', test: (h) => /(^|\.)google\.(com?\.)?[a-z]{2,3}$/.test(h) || /(^|\.)(youtube|gmail)\.com$/.test(h) },
  { id: 'github.com', label: 'GitHub', test: (h) => /(^|\.)github\.com$/.test(h) },
];

export function refusedSite(host: string): { id: string; label: string } | null {
  const r = REFUSED.find((x) => x.test(host.toLowerCase()));
  return r ? { id: r.id, label: r.label } : null;
}

// ---- preferences (no secrets) --------------------------------------------------------------------------------------

export const PREFS_FILE = () => path.join(ARIGAMI_DIR, 'login-prefs.json');

export function prefs(): Record<string, LoginPref> {
  try {
    const j = JSON.parse(fs.readFileSync(PREFS_FILE(), 'utf8'));
    const out: Record<string, LoginPref> = {};
    for (const [k, v] of Object.entries(j || {})) if (v === 'auto' || v === 'ask' || v === 'manual') out[k] = v;
    return out;
  } catch {
    return {};
  }
}

export function prefFor(origin: string): LoginPref {
  return prefs()[origin] || 'ask';
}

export function setPref(origin: string, pref: LoginPref | null): Record<string, LoginPref> {
  const all = prefs();
  if (!pref || pref === 'ask') delete all[origin];
  else all[origin] = pref;
  fs.mkdirSync(path.dirname(PREFS_FILE()), { recursive: true });
  fs.writeFileSync(PREFS_FILE(), JSON.stringify(all, null, 2) + '\n');
  return all;
}

// ---- the vault file: ciphertext only --------------------------------------------------------------------------------

export const VAULT_DIR = () => path.join(ARIGAMI_DIR, 'user', 'vault');
export const VAULT_FILE = () => path.join(VAULT_DIR(), 'arigami.kdbx');
export const VAULT_MAX_BYTES = 8 * 1024 * 1024;
// KeePass signature: 0x9AA2D903, 0xB54BFB67 (little-endian), then the major version (4 = KDBX4) at byte 10.
const KDBX_SIG = Buffer.from([0x03, 0xd9, 0xa2, 0x9a, 0x67, 0xfb, 0x4b, 0xb5]);

export function isKdbx4(buf: Buffer): boolean {
  return buf.length > 12 && buf.subarray(0, 8).equals(KDBX_SIG) && buf.readUInt16LE(10) === 4;
}

const etagOf = (buf: Buffer) => '"' + crypto.createHash('sha256').update(buf).digest('hex').slice(0, 32) + '"';

export function vaultFile(): { buf: Buffer; etag: string } | null {
  try {
    const buf = fs.readFileSync(VAULT_FILE());
    return { buf, etag: etagOf(buf) };
  } catch {
    return null;
  }
}

export class VaultConflict extends Error {
  status = 412;
}

/**
 * Store the owner's encrypted vault. `ifMatch` is the ETag the cockpit last read ('*' or absent = only when there is
 * no file yet), so two open cockpits can't overwrite each other's entries. The file stays out of the user repo's
 * remote: user/.gitignore gets `vault/` the first time one is written.
 */
export function writeVaultFile(buf: Buffer, ifMatch?: string | null): { etag: string } {
  if (!isKdbx4(buf)) throw Object.assign(new Error('not a KDBX 4 file'), { status: 400 });
  if (buf.length > VAULT_MAX_BYTES) throw Object.assign(new Error('vault file too large'), { status: 413 });
  const cur = vaultFile();
  if (cur ? ifMatch !== cur.etag : ifMatch && ifMatch !== '*') throw new VaultConflict('the vault changed elsewhere — reload it');
  fs.mkdirSync(VAULT_DIR(), { recursive: true, mode: 0o700 });
  ensureIgnored();
  const tmp = VAULT_FILE() + '.tmp';
  fs.writeFileSync(tmp, buf, { mode: 0o600 });
  fs.renameSync(tmp, VAULT_FILE());
  return { etag: etagOf(buf) };
}

export function ensureIgnored(userDir = path.join(ARIGAMI_DIR, 'user')): void {
  const gi = path.join(userDir, '.gitignore');
  let cur = '';
  try { cur = fs.readFileSync(gi, 'utf8'); } catch { /* none yet */ }
  if (cur.split('\n').some((l) => l.trim() === 'vault/' || l.trim() === '/vault/')) return;
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(gi, cur + (cur && !cur.endsWith('\n') ? '\n' : '') + '# the credential vault (ciphertext) stays on this machine\nvault/\n');
}

// ---- the page --------------------------------------------------------------------------------------------------------

// One detector, shared by the inspection and the fill, so the fill finds exactly the fields the card announced — the
// cockpit names roles, never selectors, and cannot point a value at any other field.
const DETECT = `
  const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && !el.disabled && !el.readOnly; };
  const inputs = [...document.querySelectorAll('input')].filter(vis);
  const words = (el) => ((el.name || '') + ' ' + (el.id || '') + ' ' + (el.placeholder || '') + ' ' + (el.getAttribute('aria-label') || '')).toLowerCase();
  const ac = (el) => (el.autocomplete || '').toLowerCase();
  const isOtp = (el) => ac(el) === 'one-time-code' || /\\botp\\b|one.?time|verification.?code|2fa|mfa|totp|auth.?code|security.?code/.test(words(el));
  const textish = (el) => ['text', 'email', 'tel', ''].includes((el.getAttribute('type') || '').toLowerCase());
  const password = inputs.find((el) => el.type === 'password' && !isOtp(el) && ac(el) !== 'new-password') || null;
  const otp = inputs.find((el) => el !== password && isOtp(el) && (el.type === 'password' || textish(el) || el.type === 'number')) || null;
  let username = inputs.find((el) => textish(el) && /(^|\\s)(username|email)$/.test(ac(el)) && !isOtp(el)) || null;
  if (!username) {
    const pool = inputs.filter((el) => textish(el) && !isOtp(el) && (!password || el.form === password.form));
    if (password) username = pool.filter((el) => el.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING).pop() || null;
    else if (pool.length === 1 && (pool[0].type === 'email' || /user|e-?mail|login|account|identifier|phone/.test(words(pool[0])))) username = pool[0];
  }
  const found = { username, password, otp };
`;

const INSPECT_JS = `(() => {${DETECT}
  return { origin: location.origin, fields: Object.keys(found).filter((k) => found[k]) };
})()`;

/** The fill, run inside the page: re-checks the origin in the same tick it types, so a navigation can't redirect it. */
export function fillJs(origin: string, values: Partial<Record<CredRole, string>>, submit: boolean): string {
  return `(async () => {
    if (location.origin !== ${JSON.stringify(origin)}) return { error: 'origin', origin: location.origin };
    ${DETECT}
    const values = ${JSON.stringify(values)};
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    const filled = [];
    for (const role of ['username', 'password', 'otp']) {
      const el = found[role];
      if (!el || typeof values[role] !== 'string') continue;
      el.focus();
      setter.call(el, values[role]);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      filled.push(role);
    }
    let submitted = false;
    if (${submit ? 'true' : 'false'} && filled.length) {
      await new Promise((r) => setTimeout(r, 150));
      const last = found.otp || found.password || found.username;
      const form = last && last.form;
      const btns = [...(form || document).querySelectorAll('button,input[type=submit],[role=button]')].filter(vis);
      const btn = (form && btns.find((b) => (b.type || '').toLowerCase() === 'submit')) ||
        btns.find((b) => /^(sign ?in|log ?in|login|continue|next|submit|verify|כניסה|התחבר(ות)?|המשך|הבא|אישור)$/i.test((b.innerText || b.value || '').trim()));
      if (btn) { btn.click(); submitted = true; }
      else if (form) { form.requestSubmit ? form.requestSubmit() : form.submit(); submitted = true; }
    }
    return { filled, submitted };
  })()`;
}

async function evalOn(tab: ChromeTab, expression: string, timeoutMs = 4000): Promise<any> {
  const r = await cdpCall(tab.webSocketDebuggerUrl!, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, timeoutMs);
  // never echo the expression (it may hold a value) — only that it failed
  if (r?.exceptionDetails) throw new Error('the page refused the script');
  return r?.result?.value;
}

/** Look at the front tab: its origin and which sign-in fields it shows. */
export async function inspect(sessionId: string): Promise<{ tab: ChromeTab; origin: string; fields: CredRole[] }> {
  const tab = await frontPage(sessionId);
  const r = (await evalOn(tab, INSPECT_JS)) as { origin: string; fields: CredRole[] };
  return { tab, origin: String(r?.origin || ''), fields: (r?.fields || []).filter((f) => ROLES.includes(f)) };
}

// ---- the request -----------------------------------------------------------------------------------------------------

export type RequestOutcome =
  | { status: 'pending'; request: CredentialRequest }
  | { status: 'manual'; origin: string; host: string }
  | { status: 'refused'; site: { id: string; label: string }; host: string }
  | { status: 'error'; error: string; next?: string };

/** The agent asks: inspect the page, and either open a card or say why not. Never sees a value either way. */
export async function request(sessionId: string, opts: { site?: string; reason?: string } = {}): Promise<RequestOutcome> {
  let page;
  try {
    page = await inspect(sessionId);
  } catch (e) {
    return { status: 'error', error: (e as Error).message, next: "open the site's sign-in page with browser_open, then call request_credentials again" };
  }
  const { tab, origin, fields } = page;
  if (!/^https?:\/\//.test(origin)) return { status: 'error', error: `the front tab is not a web page (${origin || 'blank'})`, next: 'open the sign-in page first' };
  const host = hostOf(origin);
  if (opts.site) {
    const want = registrable(hostOf(opts.site));
    if (want && want !== registrable(host)) return { status: 'error', error: `the front tab is on ${host}, not ${hostOf(opts.site)}`, next: "open that site's sign-in page first — the card fills only the page it was opened on" };
  }
  const refused = refusedSite(host);
  if (refused) return { status: 'refused', site: refused, host };
  if (!fields.length) return { status: 'error', error: `no sign-in field on ${host} right now`, next: 'open the sign-in form (click "Sign in"), then call request_credentials again' };
  const pref = prefFor(origin);
  if (pref === 'manual') return { status: 'manual', origin, host };
  // one card per session: a newer request replaces an older one
  for (const [id, p] of pending) if (p.sessionId === sessionId) pending.delete(id);
  const requestId = 'cred_' + crypto.randomBytes(9).toString('base64url');
  const request: CredentialRequest = { requestId, at: new Date().toISOString(), origin, host, fields, pref, ...(opts.reason ? { reason: String(opts.reason).slice(0, 200) } : {}) };
  pending.set(requestId, { sessionId, origin, tabId: tab.id, fields, at: Date.now(), request });
  return { status: 'pending', request };
}

/**
 * sign_in on the shared desktop: a card for ONE field the agent has clicked into, in the owner's Chrome. The host
 * already checked the page is on `origin` (lib/sign-in.ts sharedFillGuard) and checks it again right before typing.
 * Google and GitHub are not refused here: the refusal is about scripted sign-ins in an automated browser, and this is
 * the owner's own Chrome, typed into with real keys.
 */
export function requestShared(
  sessionId: string,
  o: { origin: string; field: string; reason?: string; account?: string; entry?: string; recheck: () => Promise<string | null> }
): { status: 'pending'; request: CredentialRequest } | { status: 'manual'; origin: string; host: string } {
  const host = hostOf(o.origin);
  const pref = prefFor(o.origin);
  if (pref === 'manual') return { status: 'manual', origin: o.origin, host };
  for (const [id, p] of pending) if (p.sessionId === sessionId) { pending.delete(id); settle(id, 'cancel'); }
  const requestId = 'cred_' + crypto.randomBytes(9).toString('base64url');
  const request: CredentialRequest = {
    requestId, at: new Date().toISOString(), origin: o.origin, host, fields: [o.field], pref, target: 'shared',
    // (only sign_in({fill}) reaches this with a role; a named field on the shared desktop is refused upstream — api.ts vaultFill)
    ...(ROLES.includes(o.field as CredRole) ? {} : { kind: 'field' as const }),
    ...(o.entry ? { entry: o.entry.slice(0, 120) } : {}),
    ...(o.account ? { account: o.account.slice(0, 120) } : {}), ...(o.reason ? { reason: String(o.reason).slice(0, 200) } : {}),
  };
  pending.set(requestId, { sessionId, origin: o.origin, tabId: '', fields: [o.field], at: Date.now(), request, recheck: o.recheck });
  return { status: 'pending', request };
}

// ---- VAULT2: a secure form, a named field in the session browser, and the catalog ----------------------------------

/** The origin a site name stands for in the vault (`bituach.example` → `https://bituach.example`). */
export function siteOrigin(site: string): string | null {
  const host = hostOf(String(site || '').trim());
  if (!host || !/^[a-z0-9.-]+$/i.test(host) || !host.includes('.')) return null;
  return `https://${host.toLowerCase()}`;
}

/**
 * vault_collect: the agent asks the owner for named details of a site. No page is involved — the cockpit encrypts what
 * the owner types straight into the vault and tells the host only the names it saved (answer → 'saved').
 */
export function requestForm(
  sessionId: string,
  o: { site: string; fields: FieldSpec[]; title?: string; reason?: string }
): { status: 'pending'; request: CredentialRequest } | { status: 'error'; error: string } {
  const origin = siteOrigin(o.site);
  if (!origin) return { status: 'error', error: 'site required: a domain the details belong to (e.g. bank.example)' };
  if (!o.fields.length) return { status: 'error', error: 'fields required' };
  for (const [id, p] of pending) if (p.sessionId === sessionId) { pending.delete(id); settle(id, 'cancel'); }
  const requestId = 'cred_' + crypto.randomBytes(9).toString('base64url');
  const request: CredentialRequest = {
    requestId, at: new Date().toISOString(), origin, host: hostOf(origin), fields: o.fields.map((f) => f.name), pref: 'ask', kind: 'form', spec: o.fields,
    ...(o.title ? { entry: String(o.title).replace(/\s+/g, ' ').trim().slice(0, 120) } : {}),
    ...(o.reason ? { reason: String(o.reason).slice(0, 200) } : {}),
  };
  pending.set(requestId, { sessionId, origin, tabId: '', fields: request.fields, at: Date.now(), request });
  return { status: 'pending', request };
}

// The field the agent means, found inside the page and marked with the request's id — so the fill, later, can go only
// to that one element on that one origin. `target` = words of its label / name / placeholder; none = the focused field.
const WORDS_JS = `
  const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && !el.disabled && !el.readOnly; };
  const editable = (el) => el && ((el.tagName === 'INPUT' && !['hidden', 'submit', 'button', 'checkbox', 'radio', 'file', 'image', 'reset', 'range', 'color'].includes((el.type || '').toLowerCase())) || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT');
  const labelOf = (el) => { let t = ''; if (el.labels) for (const l of el.labels) t += ' ' + (l.innerText || ''); const by = el.getAttribute('aria-labelledby'); if (by) for (const id of by.split(/\\s+/)) { const n = document.getElementById(id); if (n) t += ' ' + (n.innerText || ''); } return t; };
  const words = (el) => ((el.name || '') + ' ' + (el.id || '') + ' ' + (el.placeholder || '') + ' ' + (el.getAttribute('aria-label') || '') + ' ' + (el.autocomplete || '') + labelOf(el)).replace(/\\s+/g, ' ').toLowerCase();
`;

export function targetJs(requestId: string, target: string | null): string {
  return `(() => {${WORDS_JS}
    const id = ${JSON.stringify(requestId)};
    const want = ${JSON.stringify((target || '').toLowerCase().replace(/\s+/g, ' ').trim())};
    let el = null;
    if (want) {
      const pool = [...document.querySelectorAll('input,textarea,select')].filter((e) => editable(e) && vis(e));
      let best = Infinity;
      for (const e of pool) { const w = words(e); if (w.includes(want) && w.length < best) { el = e; best = w.length; } }
      if (!el) return { origin: location.origin, found: false, why: 'no field matches ' + JSON.stringify(want) };
    } else {
      el = document.activeElement;
      if (!editable(el) || !vis(el)) return { origin: location.origin, found: false, why: 'no field has the focus' };
    }
    for (const o of document.querySelectorAll('[data-arigami-fill]')) o.removeAttribute('data-arigami-fill');
    el.setAttribute('data-arigami-fill', id);
    const type = (el.type || '').toLowerCase();
    const label = (labelOf(el).trim() || el.getAttribute('aria-label') || el.placeholder || el.name || el.id || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
    // a search box or a free-text area prints what it gets back on the page: not a place for a secret
    const searchy = type === 'search' || (el.getAttribute('role') || '').toLowerCase() === 'searchbox' || /\\bsearch\\b|חיפוש|חפש/.test(words(el));
    return { origin: location.origin, found: true, tag: el.tagName.toLowerCase(), type, label, searchy, textarea: el.tagName === 'TEXTAREA', id: String(el.id || '').slice(0, 80), name: String(el.name || '').slice(0, 80) };
  })()`;
}

/** Pure: the agent's `site` names the page's host — exactly, or up to a leading `www.` (no "same site" list here). */
export function sameHost(a: string, b: string): boolean {
  const n = (h: string) => String(h || '').toLowerCase().replace(/^www\./, '');
  return !!n(a) && n(a) === n(b);
}

/** The fill of ONE named field, inside the page: the origin is re-checked in the same tick, and only the marked element gets the value. */
export function fillFieldJs(origin: string, requestId: string, value: string, part: FieldPart = 'value'): string {
  return `(() => {
    if (location.origin !== ${JSON.stringify(origin)}) return { error: 'origin', origin: location.origin };
    const el = document.querySelector('[data-arigami-fill=' + JSON.stringify(${JSON.stringify(requestId)}) + ']');
    if (!el) return { error: 'gone' };
    const value = ${JSON.stringify(value)};
    const part = ${JSON.stringify(part)};
    // the element is marked as holding a vault value: the browser tools refuse to click, type into or match it from now
    // on; the request's own mark goes only once the fill succeeded, so a miss (no option) leaves the card retryable
    const hide = (props) => { for (const [k, v] of props) el.style.setProperty(k, v, 'important'); el.removeAttribute('data-arigami-fill'); el.setAttribute('data-arigami-filled', '1'); };
    if (el.tagName === 'SELECT') {
      // a <select>: the ONE enabled option that matches what the worker sent — by value or text, or as the same number
      // ("03" ↔ "3"); a year (part "year") also by its last two digits ("2027" ↔ "27"). Two candidates = no choice.
      // The selection is never reported back, only that one matched
      const norm = (s) => String(s ?? '').trim();
      const digits = (s) => /^\\d+$/.test(s);
      const enabled = (o) => !o.disabled && !(o.parentElement && o.parentElement.tagName === 'OPTGROUP' && o.parentElement.disabled);
      const opts = [...el.options].filter(enabled);
      const want = norm(value);
      const hits = new Set();
      for (const o of opts) {
        const v = norm(o.value), t = norm(o.text);
        if (v === want || t === want) hits.add(o);
        else if (digits(want) && ((digits(v) && Number(v) === Number(want)) || (digits(t) && Number(t) === Number(want)))) hits.add(o);
        else if (part === 'year' && digits(want) && want.length === 4 && (v === want.slice(2) || t === want.slice(2))) hits.add(o);
      }
      if (hits.size !== 1) return { error: 'nomatch', options: opts.length, candidates: hits.size };
      const match = [...hits][0];
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex').set.call(el, match.index);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      // the chosen option's text is drawn transparent, and the control is made INERT: no click (not even through its
      // <label>), no focus (programmatic or by Tab) and no key reaches it, so a native dropdown — which would show the
      // selection highlighted — can never open. Unlike 'disabled', inert keeps the value in the form's submission.
      hide([['color', 'transparent'], ['-webkit-text-fill-color', 'transparent'], ['pointer-events', 'none']]);
      el.setAttribute('tabindex', '-1');
      el.inert = true;
      el.setAttribute('inert', '');
      el.blur();
      return { ok: true };
    }
    el.focus();
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    // what the agent's screenshots (browser_snapshot / capture_screen) show of this field from now on: dots for a text
    // input or textarea (drawn like a password field), and for the input types Chrome does not dot (number, date…) an
    // invisible value — in both the value stays in the field for the page to submit
    const t = (el.type || '').toLowerCase();
    if (/^(number|date|month|week|time|datetime-local|range)$/.test(t)) hide([['color', 'transparent'], ['-webkit-text-fill-color', 'transparent'], ['caret-color', 'transparent']]);
    else hide([['-webkit-text-security', 'disc']]);
    return { ok: true };
  })()`;
}

export type FieldOutcome =
  | { status: 'pending'; request: CredentialRequest }
  | { status: 'manual'; origin: string; host: string }
  | { status: 'error'; error: string; next?: string };

/**
 * vault_fill in the session's own browser: find the field the agent means on the front tab, mark it, and put a card up
 * for that one named value. The fill (fill → fillField) types it only into the marked element, only on this origin.
 */
export async function requestField(
  sessionId: string,
  o: { site?: string; field: string; entry?: string; target?: string; reason?: string; part?: FieldPart }
): Promise<FieldOutcome> {
  let tab: ChromeTab;
  try {
    tab = await frontPage(sessionId);
  } catch (e) {
    return { status: 'error', error: (e as Error).message, next: 'open the page that has the field with browser_open / browser_navigate, click into the field (or pass target), then call vault_fill again' };
  }
  const requestId = 'cred_' + crypto.randomBytes(9).toString('base64url');
  let r: { origin: string; found: boolean; why?: string; tag?: string; type?: string; label?: string; searchy?: boolean; textarea?: boolean; id?: string; name?: string };
  try {
    r = await evalOn(tab, targetJs(requestId, o.target || null));
  } catch (e) {
    return { status: 'error', error: (e as Error).message };
  }
  const origin = String(r?.origin || '');
  if (!/^https?:\/\//.test(origin)) return { status: 'error', error: `the front tab is not a web page (${origin || 'blank'})`, next: 'open the page first' };
  const host = hostOf(origin);
  // the agent's site must be this very host (www. aside) — no "same site" list decides where a value may go
  if (o.site && !sameHost(hostOf(o.site), host)) return { status: 'error', error: `the front tab is on ${host}, not ${hostOf(o.site)}`, next: 'open that page first — a value goes only to the host it belongs to' };
  if (!r.found) return { status: 'error', error: r.why || 'no field', next: 'click into the field with browser_click, or pass target: words of its label / name / placeholder' };
  // a search box or a free-text area echoes its content back on the page (results, a posted comment): a detail that is
  // not plain text by its saved type (secret, a number, a code — or one the catalog does not know) never goes there
  const types = new Set(catalogFor(origin).flatMap((e) => e.fields.filter((f) => f.name.toLowerCase() === o.field.toLowerCase()).map((f) => f.type)));
  const plain = o.field.toLowerCase() === 'username' || (types.size > 0 && [...types].every((t) => t === 'text' || t === 'multiline' || t === 'email' || t === 'phone'));
  if (!plain && (r.textarea || r.searchy))
    return { status: 'error', error: `${JSON.stringify(o.field)} is not put into a ${r.textarea ? 'free-text area' : 'search box'} (${r.label || r.tag}) — such a field shows what it gets back on the page`, next: 'aim at the field made for it (a labelled input), or ask the owner with sign_in({site, human}) / request_screen' };
  const pref = prefFor(origin);
  if (pref === 'manual') return { status: 'manual', origin, host };
  for (const [id, p] of pending) if (p.sessionId === sessionId) { pending.delete(id); settle(id, 'cancel'); }
  const request: CredentialRequest = {
    // a named field is never filled without a tap: the sign-in card's "auto" choice for this origin does not reach here
    requestId, at: new Date().toISOString(), origin, host, fields: [o.field], pref: 'ask', kind: 'field', saved: types.size > 0,
    page: { tag: String(r.tag || ''), type: String(r.type || ''), label: String(r.label || ''), ...(r.id ? { id: String(r.id) } : {}), ...(r.name ? { name: String(r.name) } : {}) },
    ...(o.part && o.part !== 'value' ? { part: o.part } : {}),
    ...(o.entry ? { entry: String(o.entry).slice(0, 120) } : {}),
    // the reason is the one line every card generation shows: a part and its target go in it too, so a cockpit tab
    // that predates `part` / `page.name` still says "month of the saved expiry → select cmbExpiryMonth"
    ...(o.part && o.part !== 'value'
      ? { reason: `${o.part} of the saved ${o.field} → ${r.tag} ${r.name || r.id || r.label || ''}`.trim().slice(0, 120) + (o.reason ? ` — ${String(o.reason).slice(0, 80)}` : '') }
      : o.reason ? { reason: String(o.reason).slice(0, 200) } : {}),
  };
  pending.set(requestId, { sessionId, origin, tabId: tab.id, fields: [o.field], at: Date.now(), request });
  return { status: 'pending', request };
}

async function fillField(sessionId: string, requestId: string, p: Pending, values: Record<string, string>): Promise<{ filled: string[]; submitted: boolean; origin: string }> {
  const name = p.fields[0];
  const value = values[name];
  if (typeof value !== 'string') throw new FillError(`the card was for ${JSON.stringify(name)}, and no value for it was given`, 400);
  // the part's shape is the contract, checked here before anything touches the page: a cockpit tab older than this
  // host ignores `part` and sends the whole expiry. Compatibility, in this route's memory only: a whole expiry in a
  // known format is split here (the same rule as the worker's) into the part that was asked for; anything else is
  // refused, and no message ever carries what was sent
  const part = p.request.part || 'value';
  const sent = partShape(part, value) ? expiryPartOf(value, part) : value;
  if (sent === null || partShape(part, sent)) throw new FillError(`${partShape(part, value)} — the cockpit tab may be older than the host: reload it (Ctrl+Shift+R); nothing was filled`, 400);
  const tab = (await listTabs(sessionId)).find((t) => t.id === p.tabId && t.webSocketDebuggerUrl);
  if (!tab) throw new FillError('the tab with the field was closed', 410);
  const r = (await evalOn(tab, fillFieldJs(p.origin, requestId, sent, part))) as { error?: string; ok?: boolean; options?: number; candidates?: number };
  if (r?.error === 'origin') throw new FillError(`the tab is no longer on ${hostOf(p.origin)} — nothing was filled`);
  if (r?.error === 'gone') throw new FillError('the field is no longer on the page — nothing was filled', 410);
  // a <select> with no (or more than one) enabled option for the saved value: nothing is chosen, the card stays up for
  // another try, and nothing about the value is said
  if (r?.error === 'nomatch')
    throw new FillError(`${r.candidates ? `${r.candidates} of the` : 'none of the'} ${r.options ?? 0} enabled options of ${p.request.page?.name || p.request.page?.id || 'the select'} match${r.candidates ? '' : 'es'} the saved ${name}${part !== 'value' ? ` ${part}` : ''} — nothing was chosen`, 409);
  pending.delete(requestId);
  settle(requestId, 'filled');
  return { filled: [name], submitted: false, origin: p.origin };
}

// ---- the catalog: which entries and FIELD NAMES the vault holds — never a value, never a username -------------------
// The cockpit (the only place the vault is open) uploads it after every save, so an agent can ask "what does the vault
// know for this site?" (vault_fields) without the owner at the keyboard. Cleaned on the way in: whatever the shape of
// the upload, only ids, titles, origins, field names and types are kept — a value can't be smuggled into this file.

export const CATALOG_FILE = () => path.join(VAULT_DIR(), 'catalog.json');
export const CATALOG_MAX_ENTRIES = 500;
export interface CatalogEntry {
  id: string;
  title: string;
  origin: string;
  fields: { name: string; type: FieldType }[];
}

export function cleanCatalog(raw: unknown): CatalogEntry[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray((raw as any).entries) ? (raw as any).entries : [];
  const out: CatalogEntry[] = [];
  for (const e of list.slice(0, CATALOG_MAX_ENTRIES)) {
    if (!e || typeof e !== 'object') continue;
    const id = String((e as any).id || '').slice(0, 64);
    const origin = String((e as any).origin || '');
    if (!id || !/^https?:\/\/[^/\s]+$/.test(origin)) continue;
    const fields: CatalogEntry['fields'] = [];
    const seen = new Set<string>();
    for (const f of Array.isArray((e as any).fields) ? (e as any).fields.slice(0, FIELDS_MAX * 4) : []) {
      const name = fieldName(typeof f === 'string' ? f : f?.name) || (ROLES.includes(f?.name) ? f.name : null);
      if (!name || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      fields.push({ name, type: fieldType(typeof f === 'object' ? f?.type : undefined) });
    }
    out.push({ id, title: String((e as any).title || hostOf(origin)).replace(/\s+/g, ' ').trim().slice(0, 120), origin, fields });
  }
  return out;
}

export function writeCatalog(raw: unknown): { entries: number } {
  const entries = cleanCatalog(raw);
  fs.mkdirSync(VAULT_DIR(), { recursive: true, mode: 0o700 });
  ensureIgnored();
  const tmp = CATALOG_FILE() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ entries }, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, CATALOG_FILE());
  return { entries: entries.length };
}

export function readCatalog(): CatalogEntry[] {
  try {
    return cleanCatalog(JSON.parse(fs.readFileSync(CATALOG_FILE(), 'utf8')));
  } catch {
    return [];
  }
}

/** The entries of ONE host (exactly, `www.` aside — no "same site" list) — what an agent may learn: names, never values. */
export function catalogFor(site: string): CatalogEntry[] {
  const want = hostOf(String(site || ''));
  if (!want) return [];
  return readCatalog().filter((e) => sameHost(hostOf(e.origin), want));
}

export function getPending(sessionId: string, requestId: string): Pending | null {
  const p = pending.get(requestId);
  if (!p || p.sessionId !== sessionId) return null;
  if (Date.now() - p.at > REQUEST_TTL_MS) {
    pending.delete(requestId);
    return null;
  }
  return p;
}

export function forget(requestId: string, outcome: Settled = 'cancel'): void {
  pending.delete(requestId);
  settle(requestId, outcome);
}

export function forgetSession(sessionId: string): void {
  for (const [id, p] of pending) if (p.sessionId === sessionId) { pending.delete(id); settle(id, 'cancel'); }
}

export class FillError extends Error {
  constructor(message: string, public status = 409) {
    super(message);
  }
}

/**
 * Type the owner's values into the tab the request was opened on. Values are accepted only for roles the card
 * announced (plus a password that shows up on the next step of a two-step form), only on the request's origin, and are
 * dropped when this returns.
 */
export async function fill(
  sessionId: string,
  requestId: string,
  raw: Record<string, unknown>,
  opts: { submit?: boolean; waitMs?: number } = {}
): Promise<{ filled: string[]; submitted: boolean; origin: string }> {
  const p = getPending(sessionId, requestId);
  if (!p) throw new FillError('this sign-in request is no longer open', 404);
  if (p.request.kind === 'form') throw new FillError('a form card is saved in the cockpit, not filled into a page', 400);
  // only the keys the card announced (a sign-in's roles, or the one named field) are read out of the body
  const allowed = p.request.kind === 'field' ? p.fields : ROLES;
  const values: Record<string, string> = {};
  for (const r of allowed) if (typeof raw[r] === 'string' && (raw[r] as string).length && (raw[r] as string).length <= 1024) values[r] = raw[r] as string;
  if (!Object.keys(values).length) throw new FillError('nothing to fill', 400);
  if (p.request.target === 'shared') return fillShared(requestId, p, values);
  if (p.request.kind === 'field') return fillField(sessionId, requestId, p, values);
  const tab = (await listTabs(sessionId)).find((t) => t.id === p.tabId && t.webSocketDebuggerUrl);
  if (!tab) throw new FillError('the sign-in tab was closed', 410);
  const submit = opts.submit !== false;
  const r = (await evalOn(tab, fillJs(p.origin, values, submit))) as { error?: string; origin?: string; filled?: CredRole[]; submitted?: boolean };
  if (r?.error === 'origin') throw new FillError(`the tab is no longer on ${hostOf(p.origin)} — nothing was filled`);
  const filled = new Set<CredRole>(r?.filled || []);
  let submitted = !!r?.submitted;
  // Two-step forms (the username first, the password on the next screen): the same origin, the same tab, a few
  // seconds — then the rest of what the owner gave. A page that moved to another origin gets nothing more.
  const rest = () => Object.fromEntries(Object.entries(values).filter(([k]) => !filled.has(k as CredRole))) as Partial<Record<CredRole, string>>;
  const deadline = Date.now() + (opts.waitMs ?? 10_000);
  while (submitted && Object.keys(rest()).length && Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, 500));
    const now = (await listTabs(sessionId)).find((t) => t.id === p.tabId && t.webSocketDebuggerUrl);
    if (!now) break;
    let step;
    try {
      step = (await evalOn(now, fillJs(p.origin, rest(), submit))) as typeof r;
    } catch {
      continue; // mid-navigation
    }
    if (step?.error === 'origin') break;
    for (const f of step?.filled || []) filled.add(f);
    if (step?.submitted) submitted = true;
  }
  pending.delete(requestId);
  settle(requestId, 'filled');
  return { filled: [...filled], submitted, origin: p.origin };
}

/**
 * The shared desktop: type the ONE field the card was for, with real keys, into the field that has the focus — after
 * the page is checked again. Nothing is submitted: the agent presses Enter / the button, as a person would.
 */
async function fillShared(requestId: string, p: Pending, values: Record<string, string>): Promise<{ filled: string[]; submitted: boolean; origin: string }> {
  const role = p.fields[0];
  const value = values[role];
  if (typeof value !== 'string') throw new FillError(`the card was for the ${role}, and none was given`, 400);
  const moved = p.recheck ? await p.recheck() : null;
  if (moved) {
    pending.delete(requestId);
    settle(requestId, 'cancel');
    throw new FillError(`nothing was typed: ${moved}`, 409);
  }
  const r = await sharedTyper(value);
  if (!r.ok) throw new FillError(`typing on the shared desktop failed: ${r.error}`, 500);
  pending.delete(requestId);
  settle(requestId, 'filled');
  return { filled: [role], submitted: false, origin: p.origin };
}

/** Test hook: put a pending request in place without a browser. */
export function _setPending(requestId: string, p: Pending): void {
  pending.set(requestId, p);
}
