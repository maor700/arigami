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

/** What the session's card shows — no values, ever. */
export interface CredentialRequest {
  requestId: string;
  at: string;
  origin: string;
  host: string;
  fields: CredRole[];
  reason?: string;
  pref: LoginPref;
}

interface Pending {
  sessionId: string;
  origin: string;
  tabId: string;
  fields: CredRole[];
  at: number;
  /** what the card shows — the session's copy is a mirror of this, never read back */
  request: CredentialRequest;
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

export function getPending(sessionId: string, requestId: string): Pending | null {
  const p = pending.get(requestId);
  if (!p || p.sessionId !== sessionId) return null;
  if (Date.now() - p.at > REQUEST_TTL_MS) {
    pending.delete(requestId);
    return null;
  }
  return p;
}

export function forget(requestId: string): void {
  pending.delete(requestId);
}

export function forgetSession(sessionId: string): void {
  for (const [id, p] of pending) if (p.sessionId === sessionId) pending.delete(id);
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
): Promise<{ filled: CredRole[]; submitted: boolean; origin: string }> {
  const p = getPending(sessionId, requestId);
  if (!p) throw new FillError('this sign-in request is no longer open', 404);
  const values: Partial<Record<CredRole, string>> = {};
  for (const r of ROLES) if (typeof raw[r] === 'string' && (raw[r] as string).length && (raw[r] as string).length <= 1024) values[r] = raw[r] as string;
  if (!Object.keys(values).length) throw new FillError('nothing to fill', 400);
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
  return { filled: [...filled], submitted, origin: p.origin };
}

/** Test hook: put a pending request in place without a browser. */
export function _setPending(requestId: string, p: Pending): void {
  pending.set(requestId, p);
}
