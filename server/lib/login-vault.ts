// The owner's own browser profile ("my browser") and the one controlled way a
// login gets out of it: per site, with the owner's approval, through Chrome.
//
// Before this, every session's browser was a full copy of chrome-base taken on
// first open, and logins flowed back by copying whole Cookies files over it —
// so logins overwrote each other, and on a real host chrome-base held almost
// nothing (496 KB) while seven 400 MB session copies each held their own. Now:
//
//   - a session's browser starts EMPTY (agent profiles excepted: an agent keeps
//     its own identity, see chrome.ts)
//   - `detect()` / `list()` read the vault from disk, without starting Chrome,
//     and never return a cookie value — only which sites have a login
//   - `transfer()` carries ONE site into a session's running browser
//   - `saveToVault()` carries one site back, and only after the owner said yes
//
// The vault Chrome is driven headless when nobody has it open; when the owner
// has "my browser" open, the same running instance is used over its DevTools
// port (Chrome allows one process per profile).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { CHROME_BASE_DIR, chromeBin, chromeExtraFlags, openChrome, isChromeRunning } from './chrome.js';
import { cdpPort } from './chrome-cdp.js';
import { pidAlive } from './platform.js';
import { supervise, killTree } from './children.js';
import * as sites from './login-sites.js';
import { Cdp, exportSite, importSite, landing, type SiteState } from './site-state.js';

export const VAULT_DIR = CHROME_BASE_DIR;

// Chrome stores times as microseconds since 1601-01-01.
const CHROME_EPOCH_OFFSET_US = 11644473600n * 1000000n;
const nowChromeUs = () => BigInt(Date.now()) * 1000n + CHROME_EPOCH_OFFSET_US;

interface CookieRow {
  host_key: string;
  name: string;
  expires_utc: bigint | number;
  is_httponly: number;
  is_secure: number;
}

/** Non-expired cookie rows of the vault, read from a copy (Chrome locks the live db). */
export function vaultCookies(dir = VAULT_DIR): CookieRow[] {
  const src = path.join(dir, 'Default', 'Cookies');
  if (!fs.existsSync(src)) return [];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-vault-'));
  try {
    const copy = path.join(tmp, 'Cookies');
    fs.copyFileSync(src, copy);
    for (const ext of ['-wal', '-journal']) if (fs.existsSync(src + ext)) fs.copyFileSync(src + ext, copy + ext);
    const { Database } = require('bun:sqlite') as typeof import('bun:sqlite');
    const db = new Database(copy, { readonly: true, safeIntegers: true });
    try {
      const now = nowChromeUs();
      const rows = db.query('select host_key, name, expires_utc, is_httponly, is_secure from cookies').all() as CookieRow[];
      // expires_utc 0 = a session cookie (lives until the browser closes).
      return rows.filter((r) => BigInt(r.expires_utc) === 0n || BigInt(r.expires_utc) > now);
    } finally {
      db.close();
    }
  } catch {
    return [];
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* temp */
    }
  }
}

/** Origins that have IndexedDB in the vault, from the on-disk directory names. */
export function vaultIdbOrigins(dir = VAULT_DIR): string[] {
  try {
    return fs
      .readdirSync(path.join(dir, 'Default', 'IndexedDB'))
      .map((n) => /^(https?)_(.+)_(\d+)\.indexeddb\.leveldb$/.exec(n))
      .filter((m): m is RegExpExecArray => !!m)
      .map((m) => `${m[1]}://${m[2]}${m[3] === '0' ? '' : ':' + m[3]}`);
  } catch {
    return [];
  }
}

export interface Detection {
  site: sites.SiteDef;
  /** Cookies of the site that have not expired. */
  cookies: number;
  /** Of those, the ones a login usually is (httpOnly + secure). */
  authCookies: number;
  /** Origins of the site that hold IndexedDB. */
  storageOrigins: string[];
  present: boolean;
}

/** Does the vault hold a login for `input`? Reads disk only; never returns a value. */
export function detect(input: string, dir = VAULT_DIR): Detection {
  const site = sites.resolve(input);
  const rows = vaultCookies(dir).filter((r) => sites.cookieBelongs(r.host_key, site));
  const storageOrigins = vaultIdbOrigins(dir).filter((o) => sites.cookieBelongs(new URL(o).hostname, site));
  const authCookies = rows.filter((r) => Number(r.is_httponly) === 1 && Number(r.is_secure) === 1).length;
  return { site, cookies: rows.length, authCookies, storageOrigins, present: authCookies > 0 || storageOrigins.length > 0 };
}

/**
 * The sites the vault has a login for — names only. Known sites by name; any
 * other registrable domain only when it has an httpOnly+secure cookie or its
 * own storage, so ad and analytics cookies don't show up as "logins".
 */
export function list(dir = VAULT_DIR): { id: string; label: string; known: boolean; policy: sites.LoginPolicy }[] {
  const rows = vaultCookies(dir);
  const idb = vaultIdbOrigins(dir).map((o) => new URL(o).hostname);
  const hosts = new Set<string>([...rows.filter((r) => Number(r.is_httponly) === 1 && Number(r.is_secure) === 1).map((r) => r.host_key), ...idb]);
  const seen = new Map<string, sites.SiteDef>();
  for (const h of hosts) {
    const s = sites.resolve(h.replace(/^\./, ''));
    if (!seen.has(s.id)) seen.set(s.id, s);
  }
  return [...seen.values()]
    .map((s) => ({ id: s.id, label: s.label, known: s.known, policy: sites.decide(s).policy }))
    .sort((a, b) => Number(b.known) - Number(a.known) || a.id.localeCompare(b.id));
}

// ---- the vault Chrome ------------------------------------------------------------

let visible: ChildProcess | null = null;

function vaultPort(dir = VAULT_DIR): number | null {
  return cdpPort('vault', dir);
}

async function waitPort(dir: string, proc: ChildProcess, timeoutMs = 20_000): Promise<number> {
  const start = Date.now();
  for (;;) {
    const p = vaultPort(dir);
    if (p) {
      try {
        const r = await fetch(`http://127.0.0.1:${p}/json/version`, { signal: AbortSignal.timeout(800) });
        if (r.ok) return p;
      } catch {
        /* not listening yet */
      }
    }
    if (proc.exitCode !== null) throw new Error('the vault browser exited on start');
    if (Date.now() - start > timeoutMs) throw new Error('the vault browser did not start');
    await new Promise((r) => setTimeout(r, 150));
  }
}

function vaultArgs(dir: string, headless: boolean): string[] {
  return [
    `--user-data-dir=${dir}`,
    '--password-store=basic',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-port=0',
    '--disk-cache-size=52428800',
    ...(headless ? ['--headless=new'] : []),
  ];
}

let busy: Promise<unknown> = Promise.resolve();

/**
 * Run `fn` against the vault's Chrome: the owner's visible one if it is open,
 * else a headless instance started for the job and stopped after. Serialized:
 * Chrome allows one process per profile.
 */
export async function withVault<T>(fn: (cdp: Cdp) => Promise<T>, dir = VAULT_DIR): Promise<T> {
  const run = async () => {
    fs.mkdirSync(dir, { recursive: true });
    if (visible && visible.exitCode === null) {
      const port = await waitPort(dir, visible);
      const cdp = await Cdp.connect(port);
      try {
        return await fn(cdp);
      } finally {
        cdp.close();
      }
    }
    try {
      fs.rmSync(path.join(dir, 'DevToolsActivePort'), { force: true });
    } catch {
      /* none */
    }
    const proc = spawn(chromeBin(), chromeExtraFlags().concat(vaultArgs(dir, true), ['about:blank']), { stdio: 'ignore' });
    supervise(proc, 'browser:vault-headless');
    try {
      const port = await waitPort(dir, proc);
      const cdp = await Cdp.connect(port);
      try {
        return await fn(cdp);
      } finally {
        // A clean exit flushes cookies and storage to disk before we return.
        await cdp.send('Browser.close').catch(() => {});
        cdp.close();
      }
    } finally {
      const t0 = Date.now();
      while (proc.exitCode === null && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 100));
      if (proc.exitCode === null && proc.pid && pidAlive(proc.pid)) killTree(proc.pid);
    }
  };
  const p = busy.then(run, run);
  busy = p.catch(() => {});
  return p;
}

/**
 * Open "my browser": the vault profile in a visible window — on the shared
 * desktop on Linux (the cockpit's global screen view shows it), natively
 * elsewhere. The owner signs in to sites here, once.
 */
export async function openVisible(env: NodeJS.ProcessEnv, url?: string, dir = VAULT_DIR): Promise<{ pid: number; alreadyOpen: boolean }> {
  if (visible && visible.exitCode === null) return { pid: visible.pid!, alreadyOpen: true };
  await busy; // never race a headless job for the profile lock
  fs.mkdirSync(dir, { recursive: true });
  const proc = spawn(chromeBin(), chromeExtraFlags().concat(vaultArgs(dir, false), url ? [url] : []), { env, stdio: 'ignore' });
  supervise(proc, 'browser:vault');
  proc.on('exit', () => {
    if (visible === proc) visible = null;
  });
  visible = proc;
  return { pid: proc.pid!, alreadyOpen: false };
}

export function isVisibleOpen(): boolean {
  return !!(visible && visible.exitCode === null);
}

// ---- moving one site ---------------------------------------------------------

async function sessionCdp(sessionId: string): Promise<Cdp> {
  if (!isChromeRunning(sessionId)) await openChrome(sessionId);
  for (let i = 0; i < 80; i++) {
    const port = cdpPort(sessionId);
    if (port) {
      try {
        return await Cdp.connect(port);
      } catch {
        /* still starting */
      }
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("this session's browser did not start");
}

function originsFor(site: sites.SiteDef, storageOrigins: string[]): string[] {
  const set = new Set<string>([...(site.origins || []), ...storageOrigins]);
  return [...set];
}

export interface TransferResult {
  ok: boolean;
  site: string;
  policy: sites.LoginPolicy;
  moved?: { cookies: number; dbs: number; rows: number; local: number };
  /** Where a check url landed, when there was one to check. */
  check?: { url: string; loggedIn: boolean } | null;
  error?: string;
}

/** Carry ONE site's login from the vault into a session's browser. */
export async function transfer(sessionId: string, input: string, dir = VAULT_DIR): Promise<TransferResult> {
  const d = detect(input, dir);
  const site = d.site;
  // Before the vault is opened we only know THAT the site has storage, not the
  // database names; decide() refines once they are read (see dbNames below).
  let decision = sites.decide(site, d.storageOrigins.length ? ['(unread)'] : []);
  if (decision.policy === 'never') return { ok: false, site: site.id, policy: 'never', error: decision.reason || 'this site must not be copied — sign in fresh' };
  if (!d.present) return { ok: false, site: site.id, policy: decision.policy, error: 'there is no login for this site in your browser' };

  let state: SiteState;
  try {
    state = await withVault(async (cdp) => {
      // Name the databases first: a Firebase database narrows the copy to it.
      const origins = decision.policy === 'copy' ? originsFor(site, d.storageOrigins) : [];
      if (origins.length && !site.known) {
        const names = await dbNames(cdp, origins);
        decision = sites.decide(site, names);
      }
      return exportSite(cdp, (dom) => sites.cookieBelongs(dom, site), decision.policy === 'copy' ? origins : [], decision.authDbs || null);
    }, dir);
  } catch (e) {
    const msg = (e as Error).message;
    if (/DEVICE_BOUND/.test(msg)) {
      sites.learn(site.id, 'never', 'holds a key that cannot leave the browser — the session is tied to this device');
      return { ok: false, site: site.id, policy: 'never', error: 'this site ties its session to your browser (a key that cannot be exported) — sign in fresh' };
    }
    if (/TOO_LARGE/.test(msg)) return { ok: false, site: site.id, policy: decision.policy, error: "this site's browser storage is too large to copy — sign in fresh" };
    return { ok: false, site: site.id, policy: decision.policy, error: `reading your browser failed: ${msg}` };
  }

  const cdp = await sessionCdp(sessionId);
  try {
    const moved = await importSite(cdp, state);
    let check: TransferResult['check'] = null;
    if (site.checkUrl) {
      const l = await landing(cdp, site.checkUrl).catch(() => null);
      if (l) {
        check = { url: l.url, loggedIn: !l.loggedOut };
        if (l.loggedOut) sites.learn(site.id, 'never', `a copied login landed on ${l.url} — the site did not accept it`);
      }
    }
    return { ok: check ? check.loggedIn : true, site: site.id, policy: decision.policy, moved, check, ...(check && !check.loggedIn ? { error: 'the site did not accept the copied login — sign in fresh' } : {}) };
  } finally {
    cdp.close();
  }
}

async function dbNames(cdp: Cdp, origins: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const o of origins) {
    try {
      const r = await cdp.send('IndexedDB.requestDatabaseNames', { securityOrigin: o });
      out.push(...(r?.databaseNames || []));
    } catch {
      /* origin without storage */
    }
  }
  return out;
}

/**
 * Some sites allow one session only: a copy logs the ORIGINAL out. After a
 * transfer, look at the vault again; if the owner lost the login, stop offering
 * this site. Returns null when there is nothing to check against.
 */
export async function vaultStillLoggedIn(input: string, dir = VAULT_DIR): Promise<boolean | null> {
  const site = sites.resolve(input);
  if (!site.checkUrl) return null;
  const l = await withVault((cdp) => landing(cdp, site.checkUrl!), dir).catch(() => null);
  if (!l) return null;
  if (l.loggedOut) sites.learn(site.id, 'never', 'copying this login logged the original out — the site allows one session');
  return !l.loggedOut;
}

/** Carry one site back from a session's browser into the vault — only after the owner approved. */
export async function saveToVault(sessionId: string, input: string, dir = VAULT_DIR): Promise<TransferResult> {
  const site = sites.resolve(input);
  const decision = sites.decide(site);
  if (decision.policy === 'never') return { ok: false, site: site.id, policy: 'never', error: decision.reason || 'this site must not be copied' };
  const cdp = await sessionCdp(sessionId);
  let state: SiteState;
  try {
    const origins = decision.policy === 'copy' ? (site.origins?.length ? site.origins : site.domains.map((d) => `https://${d.replace(/^\./, '')}`)) : [];
    state = await exportSite(cdp, (dom) => sites.cookieBelongs(dom, site), origins, decision.authDbs || null);
  } catch (e) {
    return { ok: false, site: site.id, policy: decision.policy, error: (e as Error).message };
  } finally {
    cdp.close();
  }
  const moved = await withVault((v) => importSite(v, state), dir);
  return { ok: true, site: site.id, policy: decision.policy, moved };
}

// ---- standing grants ---------------------------------------------------------

export const GRANTS_FILE = path.join(path.dirname(CHROME_BASE_DIR), 'login-grants.json');

/** Sites the owner said "always" for — request_login hands them over without asking. */
export function grants(): Record<string, { at: string }> {
  try {
    const v = JSON.parse(fs.readFileSync(GRANTS_FILE, 'utf8'));
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

export function grantAlways(siteId: string): void {
  const g = grants();
  g[siteId] = { at: new Date().toISOString() };
  fs.mkdirSync(path.dirname(GRANTS_FILE), { recursive: true });
  fs.writeFileSync(GRANTS_FILE, JSON.stringify(g, null, 2));
}
