// The owner's OWN Chrome — the everyday browser on the shared desktop, with its own profile and no DevTools port —
// as a second place a login can come from (login-vault.ts), next to "My browser" (chrome-base).
//
// Why: Google signs in without a CAPTCHA in a long-lived everyday profile where it may refuse the automated vault
// one, so a sign-in done there (by the owner, or by an agent through the shared-desktop lease) is the one that
// works. It is never driven over DevTools and never written to: a login is READ from a snapshot copy of the few
// files that hold it (Cookies, Local Storage, the site's IndexedDB), opened by a headless Chrome of our own, and the
// copy is deleted after. That works because Chrome on Linux with the basic password store encrypts cookies with a
// fixed key ("v10"); a profile whose cookies are tied to a keyring ("v11") is not offered.
//
// Optional: on by default only where it can exist — Linux, not in a container, an existing user-data dir. Config
// `ownerChrome: false | { userDataDir?, profile? }`, env ARIGAMI_OWNER_CHROME=0 | <user-data-dir>,
// ARIGAMI_OWNER_CHROME_PROFILE=<profile dir name>.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cfg } from './config.js';
import { CHROME_BASE_DIR } from './chrome.js';

export interface OwnerProfile {
  /** The user-data dir (~/.config/google-chrome). */
  userDataDir: string;
  /** The profile dir name inside it ("Default", "Profile 1"). */
  profileDir: string;
  /** Its path. */
  profilePath: string;
  /** Chrome's name for it ("Your Chrome", "work.example") and the Google account signed in to Chrome there, if any. */
  name?: string;
  email?: string;
}

export interface OwnerChromeConfig {
  userDataDir?: string;
  profile?: string;
}

/** Pure: which profile, if any — from config, env and what is on disk. */
export function resolveOwnerProfile(o: {
  config?: OwnerChromeConfig | false | null;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  inContainer?: boolean;
  home?: string;
  exclude?: string[];
}): OwnerProfile | null {
  const env = o.env || {};
  if (o.config === false || env.ARIGAMI_OWNER_CHROME === '0' || env.ARIGAMI_OWNER_CHROME === 'false') return null;
  const explicitDir = (env.ARIGAMI_OWNER_CHROME && env.ARIGAMI_OWNER_CHROME !== '1' ? env.ARIGAMI_OWNER_CHROME : '') || (o.config && o.config.userDataDir) || '';
  // Without an explicit dir: only where an everyday Chrome can live next to the host.
  if (!explicitDir && ((o.platform || process.platform) !== 'linux' || o.inContainer)) return null;
  const home = o.home || os.homedir();
  const userDataDir = path.resolve((explicitDir || path.join(home, '.config', 'google-chrome')).replace(/^~(?=$|\/)/, home));
  if ((o.exclude || []).some((x) => path.resolve(x) === userDataDir)) return null;
  let profileDir = env.ARIGAMI_OWNER_CHROME_PROFILE || (o.config && o.config.profile) || '';
  if (!profileDir) {
    try {
      const ls = JSON.parse(fs.readFileSync(path.join(userDataDir, 'Local State'), 'utf8'));
      profileDir = String(ls?.profile?.last_used || '') || 'Default';
    } catch {
      return null; // no Chrome there
    }
  }
  if (/[\\/]|^\.\.?$/.test(profileDir)) return null;
  const profilePath = path.join(userDataDir, profileDir);
  if (!fs.existsSync(path.join(profilePath, 'Cookies'))) return null;
  return { userDataDir, profileDir, profilePath };
}

/**
 * Every profile of the user-data dir that `base` (resolveOwnerProfile's answer) lives in — the owner may keep a work
 * and a personal account of the same site in two profiles, and a login is read from (and a sign-in done in) ONE of
 * them, never merged. `base`'s own profile first. Pure apart from reading Local State.
 */
export function listProfiles(base: OwnerProfile): OwnerProfile[] {
  let cache: Record<string, any> = {};
  try {
    cache = JSON.parse(fs.readFileSync(path.join(base.userDataDir, 'Local State'), 'utf8'))?.profile?.info_cache || {};
  } catch {
    /* no Local State: the base profile alone */
  }
  const dirs = [base.profileDir, ...Object.keys(cache).filter((d) => d !== base.profileDir).sort()];
  const out: OwnerProfile[] = [];
  for (const d of dirs) {
    if (/[\\/]|^\.\.?$/.test(d)) continue;
    const profilePath = path.join(base.userDataDir, d);
    if (!fs.existsSync(path.join(profilePath, 'Cookies'))) continue;
    const info = cache[d] || {};
    out.push({ userDataDir: base.userDataDir, profileDir: d, profilePath, ...(info.name ? { name: String(info.name) } : {}), ...(info.user_name ? { email: String(info.user_name) } : {}) });
  }
  return out;
}

/**
 * Pure: which profile an `account` hint names — a profile dir ("Profile 1"), its name ("work.example"), the email signed in
 * to Chrome there, or the email's domain. Null when nothing matches (or the hint is empty).
 */
export function matchProfile(profiles: OwnerProfile[], account: string | null | undefined): OwnerProfile | null {
  const a = String(account || '').trim().toLowerCase();
  if (!a) return null;
  return (
    profiles.find((p) => p.profileDir.toLowerCase() === a) ||
    profiles.find((p) => (p.email || '').toLowerCase() === a) ||
    profiles.find((p) => (p.name || '').toLowerCase() === a) ||
    profiles.find((p) => !!p.email && (p.email.toLowerCase().endsWith('@' + a.replace(/^@/, '')) || a.endsWith('@' + p.email.split('@')[1].toLowerCase()))) ||
    null
  );
}

/** A profile's label for a card or a tool result: "work.example (me@work.example)" / "Your Chrome". */
export const profileLabel = (p: OwnerProfile): string => (p.name || p.profileDir) + (p.email ? ` (${p.email})` : '');

/**
 * Pure: should the host open the owner's everyday Chrome once on the shared desktop, so it HAS a profile? sign_in signs
 * new sites in there and copies logins out of it; a fresh install has the browser and the display but no profile until
 * someone opens Chrome on it. Only where an everyday Chrome is auto-detected (Linux, not a container, not turned off)
 * and nothing is there yet.
 */
export function shouldSeedOwnerChrome(o: { platform: NodeJS.Platform; inContainer: boolean; config: OwnerChromeConfig | false | null | undefined; env: NodeJS.ProcessEnv; hasProfile: boolean; displayUp: boolean; chromeRunning: boolean }): { seed: true } | { seed: false; why: string } {
  if (o.config === false || o.env.ARIGAMI_OWNER_CHROME === '0' || o.env.ARIGAMI_OWNER_CHROME === 'false') return { seed: false, why: 'owner Chrome turned off' };
  if (o.env.ARIGAMI_OWNER_CHROME && o.env.ARIGAMI_OWNER_CHROME !== '1') return { seed: false, why: 'an explicit owner Chrome is configured' };
  if (o.config && o.config.userDataDir) return { seed: false, why: 'an explicit owner Chrome is configured' };
  if (o.platform !== 'linux' || o.inContainer) return { seed: false, why: 'no everyday Chrome on this kind of host' };
  if (!o.displayUp) return { seed: false, why: 'no shared desktop' };
  if (o.hasProfile) return { seed: false, why: 'the profile is there' };
  if (o.chromeRunning) return { seed: false, why: 'Chrome is starting' };
  return { seed: true };
}

/** The flags the owner's everyday Chrome is started with when the HOST starts it — no DevTools port, ever. */
export const OWNER_CHROME_FLAGS = ['--password-store=basic', '--no-first-run', '--no-default-browser-check'];

const inContainer = (): boolean => fs.existsSync('/.dockerenv') || !!process.env.KUBERNETES_SERVICE_HOST;

export const ownerChromeInContainer = (): boolean => inContainer();

/** The owner's everyday Chrome profile on this host, or null. Read fresh: the owner may switch profiles. */
export function ownerProfile(): OwnerProfile | null {
  return resolveOwnerProfile({ config: cfg.ownerChrome ?? null, env: process.env, inContainer: inContainer(), exclude: [CHROME_BASE_DIR] });
}

/** Every profile of the owner's everyday Chrome (the configured / last-used one first), or [] when there is none. */
export function ownerProfiles(): OwnerProfile[] {
  const base = ownerProfile();
  if (!base) return [];
  // A profile pinned by config/env is the only one offered: the owner chose it.
  if (process.env.ARIGAMI_OWNER_CHROME_PROFILE || (cfg.ownerChrome && (cfg.ownerChrome as OwnerChromeConfig).profile)) return [base];
  return listProfiles(base);
}

const copyIf = (src: string, dst: string): void => {
  if (fs.existsSync(src)) fs.cpSync(src, dst, { recursive: true, force: true, errorOnExist: false });
};

/**
 * A throw-away user-data dir holding ONE site's share of the owner's profile, as "Default": its Cookies database
 * (cookies of other sites are in it too — Chrome is asked only for the site's, see login-vault.ts), Local Storage
 * and the IndexedDB of `idbOrigins`. Never touches the original. The caller removes it (removeSnapshot).
 */
export function snapshot(p: OwnerProfile, idbOrigins: string[], withLocal: boolean): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-owner-chrome-'));
  const dst = path.join(root, 'Default');
  fs.mkdirSync(dst, { recursive: true });
  for (const f of ['Cookies', 'Cookies-journal', 'Cookies-wal']) copyIf(path.join(p.profilePath, f), path.join(dst, f));
  if (withLocal) copyIf(path.join(p.profilePath, 'Local Storage'), path.join(dst, 'Local Storage'));
  if (idbOrigins.length) {
    const want = new Set(idbOrigins.map(idbDirName));
    const idb = path.join(p.profilePath, 'IndexedDB');
    let names: string[] = [];
    try {
      names = fs.readdirSync(idb);
    } catch {
      /* none */
    }
    for (const n of names) {
      const base = n.replace(/\.indexeddb\.(leveldb|blob)$/, '');
      if (want.has(base)) copyIf(path.join(idb, n), path.join(dst, 'IndexedDB', n));
    }
  }
  // A leveldb copied from under a running Chrome still holds its LOCK file; the copy's own Chrome takes a fresh one.
  for (const lock of walk(dst).filter((f) => path.basename(f) === 'LOCK')) fs.rmSync(lock, { force: true });
  return root;
}

/** "https://app.example.com" → "https_app.example.com_0" (Chrome's IndexedDB dir naming). */
export function idbDirName(origin: string): string {
  const u = new URL(origin);
  return `${u.protocol.replace(':', '')}_${u.hostname}_${u.port || '0'}`;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(f));
    else out.push(f);
  }
  return out;
}

export function removeSnapshot(root: string): void {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* temp */
  }
}
