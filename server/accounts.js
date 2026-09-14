// Multi-account credential store for host sessions.
//
// An "account" is one login the host can run sessions on, issued by a PROVIDER
// (server/lib/providers.ts): `claude` accounts feed the claude engine, `codex`
// accounts feed the codex engine. They are never interchangeable, so every
// query below is per provider and a session is pinned to an account of the
// provider its engine consumes.
//
// Claude account types:
//   - keychain     : the machine's own Claude Code login, read live — from the
//                    "Claude Code-credentials" keychain item on macOS, from
//                    ~/.claude/.credentials.json on Windows/Linux.
//   - oauth-token  : an explicit token (PKCE in the browser, or `claude
//                    setup-token`). Stored here, sealed.
// Codex account types:
//   - codex-home   : the machine's own `codex login` (~/.codex/auth.json), read
//                    live — the codex-side twin of `keychain`.
//   - chatgpt      : a ChatGPT login minted through `codex login --device-auth`.
//   - api-key      : an OpenAI API key (`codex login --with-api-key`).
//   Codex credentials are NOT stored in accounts.json: codex REFRESHES its own
//   auth.json in place while it runs, so the file has to stay a real file the
//   CLI can write. Each chatgpt/api-key account owns a directory
//   $ARIGAMI_DIR/codex-accounts/<id>/ holding that auth.json (0600), and a
//   session's $CODEX_HOME symlinks its auth.json to it (server/codex.ts) —
//   exactly the way a keychain account is a live pointer, not a copy.
//
// Claude tokens are kept portably in accounts.json under the state dir (macOS
// ~/.arigami, Linux/K8s /data — same code path), the file is chmod 600, and
// oauth-token secrets are encrypted at rest with a key derived from
// ARIGAMI_SECRET when that env var is set (K8s). Without a secret the token
// is stored plaintext behind 600 perms (local dev), same posture as Claude
// Code's own on-disk credentials.
//
// This replaces the single cleartext CLAUDE_CODE_OAUTH_TOKEN that used to leak
// into EVERY session via .env — the host now injects a per-session token from
// the account the session is assigned to (see claude.js).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { HOME } from './lib/platform.js';
import { cfg } from './lib/config.js';
import { broadcast } from './bus.js';
import { PROVIDERS, DEFAULT_PROVIDER, normalizeProvider, isProviderId } from './lib/providers.js';

const STATE_DIR = cfg.stateDir || cfg.configDir;
const FILE = path.join(STATE_DIR, 'accounts.json');
const SECRET = process.env.ARIGAMI_SECRET || '';
const KEYCHAIN_ITEM = 'Claude Code-credentials';
/** Where chatgpt / api-key codex accounts keep their auth.json (one subdir per account id). */
export const CODEX_ACCOUNTS_DIR = path.join(STATE_DIR, 'codex-accounts');

const uid = () => 'acc_' + crypto.randomUUID().replace(/-/g, '').slice(0, 12);

// ---- at-rest encryption (only when ARIGAMI_SECRET is set) ------------------
const aesKey = () => crypto.createHash('sha256').update(SECRET).digest();

function seal(plain) {
  if (!plain) return null;
  if (!SECRET) return { v: 0, t: plain }; // dev: plaintext behind 600 perms
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', aesKey(), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return {
    v: 1,
    iv: iv.toString('base64'),
    tag: c.getAuthTag().toString('base64'),
    t: ct.toString('base64'),
  };
}

function open(box) {
  if (!box || typeof box !== 'object') return '';
  if (box.v === 0) return box.t || '';
  if (!SECRET) return ''; // encrypted but no key available — cannot recover
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', aesKey(), Buffer.from(box.iv, 'base64'));
    d.setAuthTag(Buffer.from(box.tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(box.t, 'base64')), d.final()]).toString('utf8');
  } catch {
    return '';
  }
}

// ---- persistence ------------------------------------------------------------
// `activeIds` is the active account PER PROVIDER. `activeId` is kept in the
// file as the claude one for anything (older hosts, backups, scripts) that
// still reads the pre-provider shape — load() and save() keep the two in sync.
/** @type {{ activeId: string|null, activeIds: Record<string, string|null>, accounts: any[] }} */
let store = { activeId: null, activeIds: {}, accounts: [] };

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (raw && Array.isArray(raw.accounts)) store = raw;
    else store = { activeId: null, activeIds: {}, accounts: [] };
  } catch {
    store = { activeId: null, activeIds: {}, accounts: [] };
  }
  // Pre-provider records: every account written before `provider` existed is a
  // claude one, and the old single activeId was its active account.
  for (const a of store.accounts) if (a && !isProviderId(a.provider)) a.provider = DEFAULT_PROVIDER;
  if (!store.activeIds || typeof store.activeIds !== 'object') store.activeIds = {};
  if (store.activeId && !store.activeIds[DEFAULT_PROVIDER]) store.activeIds[DEFAULT_PROVIDER] = store.activeId;
  // An active id that no longer points at an account of its provider is dropped.
  for (const p of Object.keys(store.activeIds)) {
    const a = getAccount(store.activeIds[p]);
    if (!a || a.provider !== p) store.activeIds[p] = null;
  }
}

function save() {
  try {
    store.activeId = store.activeIds[DEFAULT_PROVIDER] || null;
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 });
    try { fs.chmodSync(FILE, 0o600); } catch {}
  } catch (e) {
    console.error('[accounts] save failed:', e.message);
  }
}

// ---- keychain (the local Claude Code login) ---------------------------------
// macOS keeps it in the login keychain; Windows/Linux keep the same JSON blob in
// ~/.claude/.credentials.json. Both are read live (never copied into our store)
// so a `claude` re-login is picked up without touching the host.
function readKeychainBlob(account) {
  if (process.platform !== 'darwin') return readCredentialsFile();
  const args = ['find-generic-password', '-s', KEYCHAIN_ITEM];
  if (account) args.push('-a', account);
  args.push('-w');
  const r = spawnSync('security', args, { encoding: 'utf8', timeout: 4000 });
  if (r.status !== 0 || !r.stdout) return null;
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
}

export const CREDENTIALS_FILE = path.join(HOME, '.claude', '.credentials.json');

function readCredentialsFile() {
  try {
    return JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf8'));
  } catch {
    return null;
  }
}

// True when this platform has a local Claude Code login the host can borrow.
export const hasLocalLogin = () =>
  process.platform === 'darwin' || fs.existsSync(CREDENTIALS_FILE);

function keychainToken() {
  if (!hasLocalLogin()) return null;
  try {
    // macOS only: there are MULTIPLE generic-password items named "Claude Code-
    // credentials": one holds `mcpOAuth` (MCP server tokens, acct="unknown"),
    // another holds the real login `claudeAiOauth` (acct = macOS short username).
    // A plain `-s … -w` read returns just one — often the mcpOAuth item — which
    // has no `claudeAiOauth.accessToken`, so usage came back "no-credentials" and
    // the rail meter vanished. Target the login item by account first, then fall
    // back. Off macOS both live in one file, so the account arg is ignored.
    let user = '';
    try { user = os.userInfo().username; } catch { user = process.env.USER || ''; }
    for (const acct of [user, null]) {
      const tok = readKeychainBlob(acct)?.claudeAiOauth?.accessToken;
      if (tok) return tok;
    }
    return null;
  } catch {
    return null;
  }
}

// ---- the local codex login (~/.codex) ---------------------------------------
/** The REAL codex home — where `codex login` on the host put auth.json. */
export function codexRealHome() {
  return process.env.ARIGAMI_CODEX_HOME || process.env.CODEX_HOME || path.join(HOME, '.codex');
}

/** True when this machine has its own `codex login` the host can borrow. */
export const hasLocalCodexLogin = () => fs.existsSync(path.join(codexRealHome(), 'auth.json'));

/**
 * The directory whose auth.json a codex account authenticates with — what a
 * session's $CODEX_HOME links to, and what an app-server probe runs under.
 * codex-home accounts point at the machine's ~/.codex; the rest own a subdir.
 */
export function codexHomeOfAccount(idOrAccount) {
  const a = typeof idOrAccount === 'string' ? getAccount(idOrAccount) : idOrAccount;
  if (!a || a.provider !== 'codex') return null;
  if (a.type === 'codex-home') return codexRealHome();
  return path.join(CODEX_ACCOUNTS_DIR, a.id);
}

/**
 * The auth.json a codex SESSION should link to: its pinned account when that
 * is a codex account whose file exists, else the active codex account, else
 * null (the caller says "no Codex account — add one").
 */
export function codexAuthPathFor(accountId) {
  const cands = [getAccount(accountId), getAccount(store.activeIds.codex)];
  for (const a of cands) {
    if (!a || a.provider !== 'codex') continue;
    const p = path.join(codexHomeOfAccount(a), 'auth.json');
    if (fs.existsSync(p)) return p;
  }
  // No codex account resolves (a store that was never seeded, or every codex
  // account removed): the machine's own `codex login` is still a valid login —
  // exactly what a codex session used before accounts had providers.
  const local = path.join(codexRealHome(), 'auth.json');
  return fs.existsSync(local) ? local : null;
}

// ---- seed -------------------------------------------------------------------
// First run: adopt whatever the host is already using so behaviour is
// unchanged until the user reorganizes. The macOS login becomes the "keychain"
// account, the machine's `codex login` becomes the "codex-home" account, and
// any CLAUDE_CODE_OAUTH_TOKEN already in the environment (the old .env work
// token) is captured as an explicit account and kept active — that's the
// account sessions run on today, so we preserve it.
function seed() {
  let dirty = false;
  const hasKeychain = hasLocalLogin();
  if (hasKeychain && !store.accounts.some((a) => a.type === 'keychain')) {
    store.accounts.push({
      id: uid(),
      label: process.platform === 'darwin' ? 'Default (macOS login)' : 'Default (Claude Code login)',
      provider: 'claude',
      type: 'keychain',
      pool: true,
      addedAt: new Date().toISOString(),
    });
    dirty = true;
  }
  if (hasLocalCodexLogin() && !store.accounts.some((a) => a.type === 'codex-home')) {
    store.accounts.push({
      id: uid(),
      label: 'Default (Codex login)',
      provider: 'codex',
      type: 'codex-home',
      pool: true,
      addedAt: new Date().toISOString(),
    });
    dirty = true;
  }
  const envTok = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  // Dedup on the sealed token OR the importedFromEnv marker: after a
  // ARIGAMI_SECRET rotation `open()` returns '' for every existing sealed
  // token, so a token-only check would append a fresh duplicate on every boot.
  if (
    envTok &&
    !store.accounts.some(
      (a) => a.type === 'oauth-token' && (a.importedFromEnv || open(a.token) === envTok)
    )
  ) {
    const acc = {
      id: uid(),
      label: 'Work (imported from .env)',
      provider: 'claude',
      type: 'oauth-token',
      pool: true,
      addedAt: new Date().toISOString(),
      token: seal(envTok),
      importedFromEnv: true,
    };
    store.accounts.push(acc);
    // Preserve current reality: the env token is what sessions use today.
    if (!store.activeIds.claude) store.activeIds.claude = acc.id;
    dirty = true;
  }
  // Prefer a usable account when picking a default per provider — an imported
  // archive can leave the active id null with only a needsReauth (former
  // keychain) entry ahead of a fresh one this seed() call just pushed above.
  for (const p of Object.keys(PROVIDERS)) {
    if (store.activeIds[p]) continue;
    const mine = store.accounts.filter((a) => a.provider === p);
    if (!mine.length) continue;
    store.activeIds[p] = (mine.find((a) => !a.needsReauth) || mine[0]).id;
    dirty = true;
  }
  if (dirty) save();
}

export function initAccounts() {
  load();
  seed();
  return listAccounts();
}

// ---- B4 backup portability (#2) ----------------------------------------------
// A `keychain` account is a live pointer into THIS machine's OS credential
// store (macOS Keychain, or ~/.claude/.credentials.json) — it cannot travel;
// a `codex-home` account is the same kind of pointer into ~/.codex. Shipping
// either as-is in a backup is a dead reference that only fails once a session
// on the new machine tries to authenticate. exportFull() (backup.ts) calls this
// to rewrite accounts.json before it goes into the archive: the record is KEPT
// (not silently dropped — the human should see it needs reconnecting) but
// renamed off its local type so seed()'s "already have one" guard doesn't
// shadow a real login the importing machine may have of its own, and
// `pool: false` so auto-pick never round-robins into it. `oauth-token`,
// `chatgpt` and `api-key` accounts are untouched — their credential travels
// (the codex-accounts/ directory rides in the same archive).
const LOCAL_TYPES = new Set(['keychain', 'codex-home']);
export function sanitizeAccountsForExport(raw) {
  if (!raw || !Array.isArray(raw.accounts)) return raw;
  if (!raw.accounts.some((a) => a && LOCAL_TYPES.has(a.type))) return raw; // nothing to rewrite — same reference, byte-identical on re-serialize
  let activeId = raw.activeId ?? null;
  const activeIds = { ...(raw.activeIds || {}) };
  const accounts = raw.accounts.map((a) => {
    if (!a || !LOCAL_TYPES.has(a.type)) return a;
    if (activeId === a.id) activeId = null;
    for (const p of Object.keys(activeIds)) if (activeIds[p] === a.id) activeIds[p] = null;
    const { type, pool, ...rest } = a;
    return { ...rest, type: `${type}-stale`, pool: false, needsReauth: true };
  });
  return { ...raw, activeId, ...(raw.activeIds ? { activeIds } : {}), accounts };
}

// ---- queries ----------------------------------------------------------------
/** The active account of a provider (claude when unspecified — the pre-provider meaning). */
export function getActiveId(provider = DEFAULT_PROVIDER) {
  return store.activeIds[normalizeProvider(provider)] || null;
}

export function getAccount(id) {
  return store.accounts.find((a) => a.id === id) || null;
}

/** Public view — never leaks token material. */
function redact(a) {
  return {
    id: a.id,
    label: a.label,
    provider: a.provider,
    type: a.type,
    pool: !!a.pool,
    addedAt: a.addedAt,
    active: a.id === store.activeIds[a.provider],
    quarantineUntil: a.quarantineUntil || null,
    available: isAvailable(a),
    email: a.email || null,
    org: a.org || null,
    plan: a.plan || null,
    lastUsage: a.lastUsage || null,
  };
}

export function listAccounts() {
  return { activeId: store.activeIds[DEFAULT_PROVIDER] || null, activeIds: { ...store.activeIds }, accounts: store.accounts.map(redact) };
}

// Resolve the raw bearer token for a CLAUDE account (keychain read is live).
// Codex accounts have no bearer token to hand out — their credential is the
// auth.json codex reads itself (codexAuthPathFor).
export function resolveToken(idOrAccount) {
  const a = typeof idOrAccount === 'string' ? getAccount(idOrAccount) : idOrAccount;
  if (!a || a.provider !== 'claude') return null;
  if (a.type === 'keychain') return keychainToken();
  return open(a.token) || null;
}

// The token to inject when spawning a claude session. Falls back to the active
// claude account when the session has no explicit assignment, its account
// vanished, or its account belongs to another provider. Returns
// { account, token } for oauth-token accounts, or null for keychain accounts —
// null means DON'T inject CLAUDE_CODE_OAUTH_TOKEN, so Claude uses its own native
// keychain login (auto-refreshing). Injecting the keychain's short-lived access
// token would freeze it (it expires) and wrongly flip authMethod to oauth_token.
export function tokenForSession(accountId) {
  let a = getAccount(accountId);
  if (!a || a.provider !== 'claude') a = getAccount(store.activeIds.claude);
  if (!a || a.type === 'keychain') return null;
  const token = resolveToken(a);
  if (!token) return null;
  return { account: a, token };
}

// True if the host can resolve at least one usable credential for a provider —
// claude: a live macOS keychain login OR a stored oauth-token; codex: any codex
// account whose auth.json exists. On macOS the keychain login is NOT a file/env
// var, so onboarding's auth gate must ask here instead of just probing
// ~/.claude/.credentials.json (which would falsely report "unauthed" for a
// subscription login that lives only in the keychain).
export function hasCredentials(provider = DEFAULT_PROVIDER) {
  if (!store.accounts.length) load();
  if (normalizeProvider(provider) === 'codex') {
    return store.accounts.some((a) => a.provider === 'codex' && fs.existsSync(path.join(codexHomeOfAccount(a), 'auth.json')));
  }
  if (keychainToken()) return true;
  return store.accounts.some((a) => a.provider === 'claude' && a.type !== 'keychain' && !!open(a.token));
}

// ---- quarantine (auto-switch support) --------------------------------------
export function isAvailable(a) {
  if (!a) return false;
  if (!a.quarantineUntil) return true;
  return Date.parse(a.quarantineUntil) <= Date.now();
}

export function quarantine(id, until) {
  const a = getAccount(id);
  if (!a) return null;
  a.quarantineUntil = until || null;
  save();
  broadcast({ type: 'accounts-updated', accounts: listAccounts() });
  return redact(a);
}

// Next pooled, available account of the SAME provider other than `exceptId`
// (round-robins by order). The provider is the excluded account's, so a switch
// can never hop a claude session onto a codex login or vice versa.
export function nextAvailable(exceptId, provider) {
  const p = normalizeProvider(provider || getAccount(exceptId)?.provider);
  const pool = store.accounts.filter((a) => a.provider === p && a.pool && a.id !== exceptId && isAvailable(a));
  return pool[0] || null;
}

// Which account a NEW session should run on: the provider's active account if
// it's available, otherwise the next available pooled account (so a new session
// never starts on an account we already know is rate-limited/quarantined).
// Falls back to the active id even if quarantined when nothing else is free —
// better to try and hit the limit than to have no account at all.
export function pickSessionAccount(provider = DEFAULT_PROVIDER) {
  const p = normalizeProvider(provider);
  const activeId = store.activeIds[p] || null;
  const active = getAccount(activeId);
  if (active && isAvailable(active)) return activeId;
  return nextAvailable(activeId, p)?.id || activeId;
}

// ---- mutations --------------------------------------------------------------
function pushAccount(acc) {
  store.accounts.push(acc);
  if (!store.activeIds[acc.provider]) store.activeIds[acc.provider] = acc.id;
  save();
  broadcast({ type: 'accounts-updated', accounts: listAccounts() });
  return redact(acc);
}

export function addTokenAccount({ label, token, trusted = false, refreshToken = null, expiresAt = null, email = null, org = null, plan = null }) {
  if (!token || !/^sk-ant-/.test(token)) throw new Error('invalid OAuth token');
  // Prefix does NOT reliably indicate lifetime, and the OAuth-login path supplies
  // a refresh token so short-lived access tokens are fine (auto-refreshed). Only
  // reject a bare `at…` on the UNTRUSTED manual-paste path with NO refresh token
  // (best-effort catch of a mis-pasted keychain access token that would just die).
  if (!trusted && !refreshToken && /^sk-ant-at\d/.test(token)) {
    throw new Error('that looks like a short-lived access token — use “Authenticate with browser”, or run `claude setup-token` and paste the result');
  }
  const acc = {
    id: uid(),
    label: label || email || 'Account',
    provider: 'claude',
    type: 'oauth-token',
    pool: true,
    addedAt: new Date().toISOString(),
    token: seal(token),
    // OAuth-login accounts carry a refresh token + expiry so the 8-hour access
    // token can be auto-renewed (see refreshOAuthAccounts). null for legacy
    // paste/setup-token accounts (no refresh — they live or die on their own).
    refreshToken: refreshToken ? seal(refreshToken) : null,
    expiresAt: expiresAt || null,
    ...(email ? { email } : {}),
    ...(org ? { org } : {}),
    ...(plan ? { plan } : {}),
  };
  return pushAccount(acc);
}

/**
 * Adopt a codex login that was minted into `pendingDir` (a directory holding
 * the auth.json `codex login` wrote — see codex-account.ts). The directory is
 * MOVED under codex-accounts/<id>/ so the account owns it; nothing from
 * auth.json is copied into accounts.json.
 * @param {{ label?: string|null, type: string, pendingDir: string, email?: string|null, plan?: string|null }} opts
 */
export function addCodexAccount({ label, type, pendingDir, email = null, plan = null }) {
  if (type !== 'chatgpt' && type !== 'api-key') throw new Error(`unknown codex account type: ${type}`);
  if (!pendingDir || !fs.existsSync(path.join(pendingDir, 'auth.json'))) throw new Error('no auth.json to adopt');
  const id = uid();
  const home = path.join(CODEX_ACCOUNTS_DIR, id);
  fs.mkdirSync(CODEX_ACCOUNTS_DIR, { recursive: true, mode: 0o700 });
  fs.renameSync(pendingDir, home);
  try { fs.chmodSync(path.join(home, 'auth.json'), 0o600); } catch {}
  const acc = {
    id,
    label: label || email || (type === 'api-key' ? 'OpenAI API key' : 'ChatGPT'),
    provider: 'codex',
    type,
    pool: true,
    addedAt: new Date().toISOString(),
    ...(email ? { email } : {}),
    ...(plan ? { plan } : {}),
  };
  return pushAccount(acc);
}

// Resolve an account's refresh token (decrypted), or null.
export function resolveRefreshToken(id) {
  const a = getAccount(id);
  return a?.refreshToken ? open(a.refreshToken) || null : null;
}

// Store a freshly-refreshed access/refresh token pair + new expiry for an
// oauth-token account. Called by the token refresher.
export function updateOAuthTokens(id, { access, refresh, expiresAt }) {
  const a = getAccount(id);
  if (!a) return null;
  if (access) a.token = seal(access);
  if (refresh) a.refreshToken = seal(refresh);
  if (expiresAt !== undefined) a.expiresAt = expiresAt;
  save();
  return redact(a);
}

// Accounts whose short-lived access token is at/near expiry and CAN be renewed
// (have a refresh token). `withinMs` = renew this far ahead of expiry.
export function oauthAccountsToRefresh(withinMs = 60 * 60_000) {
  const cutoff = Date.now() + withinMs;
  return store.accounts.filter(
    (a) => a.type === 'oauth-token' && a.refreshToken && a.expiresAt && Date.parse(a.expiresAt) <= cutoff,
  );
}

/** Make `id` the active account OF ITS PROVIDER (the other providers' actives are untouched). */
export function setActive(id) {
  const a = getAccount(id);
  if (!a) throw new Error('no such account');
  store.activeIds[a.provider] = id;
  save();
  broadcast({ type: 'accounts-updated', accounts: listAccounts() });
  return listAccounts();
}

export function setPool(id, pool) {
  const a = getAccount(id);
  if (!a) throw new Error('no such account');
  a.pool = !!pool;
  save();
  broadcast({ type: 'accounts-updated', accounts: listAccounts() });
  return redact(a);
}

export function patchAccount(id, patch = {}) {
  const a = getAccount(id);
  if (!a) throw new Error('no such account');
  for (const k of ['label', 'email', 'org', 'plan', 'lastUsage']) {
    if (patch[k] !== undefined) a[k] = patch[k];
  }
  save();
  broadcast({ type: 'accounts-updated', accounts: listAccounts() });
  return redact(a);
}

export function removeAccount(id) {
  const i = store.accounts.findIndex((a) => a.id === id);
  if (i < 0) return false;
  const [a] = store.accounts.splice(i, 1);
  // A codex account owns its auth.json directory — take it along. codex-home
  // is the machine's own login and is never deleted from here.
  if (a.provider === 'codex' && a.type !== 'codex-home') {
    try { fs.rmSync(path.join(CODEX_ACCOUNTS_DIR, a.id), { recursive: true, force: true }); } catch {}
  }
  if (store.activeIds[a.provider] === id) {
    store.activeIds[a.provider] = store.accounts.find((x) => x.provider === a.provider)?.id || null;
  }
  save();
  broadcast({ type: 'accounts-updated', accounts: listAccounts() });
  return true;
}
