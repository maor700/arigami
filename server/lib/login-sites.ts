// Which sites a login can be handed to an agent for, and how.
//
// A login lives in the owner's own browser profile (login-vault.ts). An agent
// never inherits that profile wholesale: it asks for ONE site, the owner
// approves, and only that site's state is carried into the session's browser.
// Whether that is even possible depends on the site:
//
//   copy     cookies AND the site's own storage (IndexedDB, localStorage) move.
//            Needed by sites that keep the session in the browser — every
//            Firebase Auth app (firebaseLocalStorageDb), Supabase, Cognito.
//   cookies  cookies alone carry the session (Google, Facebook, GitHub …).
//   never    must not be copied: the session is a linked DEVICE (WhatsApp Web,
//            Telegram Web — two browsers holding the same keys can get both
//            logged out), or copying reads as session theft (banks).
//
// Three layers decide it, fastest first (see decide()):
//   1. this built-in list, overlaid by the owner's own `login-sites.json`
//   2. what the host LEARNED from earlier attempts (a copy that did not log the
//      agent in, or that logged the owner out, is recorded there)
//   3. for a site on neither: the storage it actually has — the export itself
//      refuses a non-extractable CryptoKey, which is the browser-level mark of
//      a device-bound session (login-vault.ts)
//
// Nothing organization-specific belongs in the built-in list; a workspace's
// own sites go in the owner's login-sites.json.
import fs from 'node:fs';
import path from 'node:path';
import { ARIGAMI_DIR } from './instance.js';

export type LoginPolicy = 'copy' | 'cookies' | 'never';

export interface SiteDef {
  /** Stable id — the registrable domain for anything not in the list. */
  id: string;
  label: string;
  /** Cookie host suffixes that belong to the login (".google.com" matches accounts.google.com). */
  domains: string[];
  /** Hosts matched by pattern — Google signs you in on every country domain too. */
  patterns?: RegExp[];
  policy: LoginPolicy;
  /** Origins whose IndexedDB/localStorage move under `copy`. Default: https://<each domain>. */
  origins?: string[];
  /** Only these IndexedDB databases move (the rest is cache). Omitted = all, under a size cap. */
  authDbs?: string[];
  /** A page that shows a logged-in view, used to check a copy actually worked. */
  checkUrl?: string;
  /** Where this site sends a signed-out visitor, when the generic login-wall match misses it. */
  loggedOut?: RegExp;
  /** Why a site is `never`, for the agent and the approval card. */
  note?: string;
  /** True for the built-in list; false for a site derived on the fly. */
  known: boolean;
}

const B = (d: Omit<SiteDef, 'known'>): SiteDef => ({ ...d, known: true });

export const BUILTIN: SiteDef[] = [
  // Measured: copying a Google session into a second browser got the ORIGINAL
  // signed out too — Google revokes a session it sees in two browsers. So a
  // copy costs the owner their own login; never offer it.
  B({ id: 'google.com', label: 'Google', domains: ['.google.com', '.youtube.com', '.googleusercontent.com'], patterns: [/(^|\.)google\.(com?\.)?[a-z]{2,3}$/], policy: 'never', checkUrl: 'https://myaccount.google.com/', loggedOut: /google\.[a-z.]+\/account\/about|accounts\.google\.com\/.*(signin|accountchooser)/i, note: 'Google revokes a session it sees in two browsers — copying it signs YOU out as well. Sign in fresh in the session.' }),
  B({ id: 'facebook.com', label: 'Facebook', domains: ['.facebook.com'], policy: 'cookies', checkUrl: 'https://www.facebook.com/me' }),
  B({ id: 'instagram.com', label: 'Instagram', domains: ['.instagram.com'], policy: 'cookies', checkUrl: 'https://www.instagram.com/accounts/edit/' }),
  B({ id: 'github.com', label: 'GitHub', domains: ['.github.com', 'github.com'], policy: 'cookies', checkUrl: 'https://github.com/settings/profile' }),
  B({ id: 'linkedin.com', label: 'LinkedIn', domains: ['.linkedin.com'], policy: 'cookies', checkUrl: 'https://www.linkedin.com/feed/' }),
  B({ id: 'x.com', label: 'X', domains: ['.x.com', '.twitter.com'], policy: 'cookies', checkUrl: 'https://x.com/home' }),
  B({ id: 'amazon.com', label: 'Amazon', domains: ['.amazon.com'], policy: 'cookies', checkUrl: 'https://www.amazon.com/gp/css/homepage.html' }),
  B({ id: 'notion.so', label: 'Notion', domains: ['.notion.so', '.notion.com'], policy: 'cookies' }),
  B({ id: 'figma.com', label: 'Figma', domains: ['.figma.com'], policy: 'cookies', checkUrl: 'https://www.figma.com/files/recents-and-sharing' }),
  B({ id: 'slack.com', label: 'Slack', domains: ['.slack.com'], policy: 'copy', origins: ['https://app.slack.com'] }),
  B({ id: 'linear.app', label: 'Linear', domains: ['.linear.app', 'linear.app'], policy: 'copy', origins: ['https://linear.app'] }),
  B({ id: 'whatsapp.com', label: 'WhatsApp Web', domains: ['.whatsapp.com'], policy: 'never', note: 'WhatsApp Web is a linked device: two browsers holding the same keys can get both logged out. Sign in fresh by scanning the QR code.' }),
  B({ id: 'telegram.org', label: 'Telegram Web', domains: ['.telegram.org'], policy: 'never', note: 'Telegram Web is a linked session: copying it can end the original. Sign in fresh.' }),
  B({ id: 'paypal.com', label: 'PayPal', domains: ['.paypal.com'], policy: 'never', note: 'A payment account: a copied session reads as theft and can lock the account. Sign in fresh.' }),
];

/**
 * Ad and analytics hosts. They set the same httpOnly+secure cookies a login
 * does, so without this list they show up as "sites you are signed in to".
 */
export const TRACKERS = new Set([
  'doubleclick.net', 'googlesyndication.com', 'google-analytics.com', 'googletagmanager.com', 'googleadservices.com',
  'clarity.ms', 'rubiconproject.com', 'company-target.com', 'adnxs.com', 'criteo.com', 'criteo.net',
  'hotjar.com', 'hs-analytics.net', 'facebook.net', 'ads-twitter.com', 'adsrvr.org', 'casalemedia.com',
  'pubmatic.com', 'openx.net', 'taboola.com', 'outbrain.com', 'quantserve.com', 'scorecardresearch.com', 'demdex.net',
  'everesttech.net', 'bidswitch.net', 'agkn.com', 'mathtag.com', '3lift.com', 'sharethrough.com',
]);

/**
 * IndexedDB databases that are a login by themselves, whoever the site is.
 * Seeing one of these on an unknown site upgrades it to `copy` and narrows the
 * copy to just that database.
 */
export const AUTH_DB_SIGNATURES: { db: string; stack: string }[] = [
  { db: 'firebaseLocalStorageDb', stack: 'Firebase Auth' },
];

// ---- registrable domain ------------------------------------------------------

// Second-level public suffixes common enough to matter; anything else is taken
// as a one-label TLD. A wrong guess only widens or narrows WHICH cookies count
// as the site's — the owner still approves the site by name.
const SLD = new Set(['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'co.il', 'org.il', 'ac.il', 'gov.il', 'com.au', 'net.au', 'co.jp', 'com.br', 'co.in', 'com.mx', 'co.nz', 'co.za']);

export function registrable(host: string): string {
  const h = String(host || '').toLowerCase().replace(/^\.+/, '').replace(/\.+$/, '');
  const parts = h.split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  const last2 = parts.slice(-2).join('.');
  return SLD.has(last2) ? parts.slice(-3).join('.') : last2;
}

/** A url, a host or a bare name → a host. */
export function hostOf(input: string): string {
  const s = String(input || '').trim();
  try {
    return new URL(/^[a-z]+:\/\//i.test(s) ? s : `https://${s}`).hostname.toLowerCase();
  } catch {
    return s.toLowerCase();
  }
}

/** Does a cookie host (".x.com", "x.com", "sub.x.com") belong to this site? */
export function cookieBelongs(cookieHost: string, site: SiteDef): boolean {
  const h = String(cookieHost || '').toLowerCase().replace(/^\./, '');
  if (site.patterns?.some((re) => re.test(h))) return true;
  return site.domains.some((d) => {
    const dd = d.toLowerCase().replace(/^\./, '');
    return h === dd || h.endsWith('.' + dd);
  });
}

// ---- owner overrides + learned outcomes -------------------------------------

export const SITES_FILE = path.join(ARIGAMI_DIR, 'login-sites.json');

interface SitesFile {
  sites?: Partial<SiteDef>[];
  learned?: Record<string, { policy: LoginPolicy; reason: string; at: string }>;
}

function readFile(): SitesFile {
  try {
    const v = JSON.parse(fs.readFileSync(SITES_FILE, 'utf8'));
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

function writeFile(f: SitesFile): void {
  fs.mkdirSync(path.dirname(SITES_FILE), { recursive: true });
  fs.writeFileSync(SITES_FILE, JSON.stringify(f, null, 2));
}

/** Record what an attempt taught us about a site — it wins over the built-in list. */
export function learn(id: string, policy: LoginPolicy, reason: string): void {
  const f = readFile();
  f.learned = { ...(f.learned || {}), [id]: { policy, reason, at: new Date().toISOString() } };
  writeFile(f);
}

export function learned(id: string): { policy: LoginPolicy; reason: string; at: string } | null {
  return readFile().learned?.[id] || null;
}

function ownerSites(): SiteDef[] {
  const out: SiteDef[] = [];
  for (const s of readFile().sites || []) {
    if (!s?.id || !Array.isArray(s.domains) || !s.domains.length) continue;
    const policy = s.policy === 'copy' || s.policy === 'cookies' || s.policy === 'never' ? s.policy : 'copy';
    out.push({ ...s, id: String(s.id).toLowerCase(), label: String(s.label || s.id), domains: s.domains.map(String), policy, known: true } as SiteDef);
  }
  return out;
}

/** Every site the host knows by name: the owner's entries override built-ins with the same id. */
export function allKnown(): SiteDef[] {
  const own = ownerSites();
  const ids = new Set(own.map((s) => s.id));
  return [...own, ...BUILTIN.filter((s) => !ids.has(s.id))];
}

/**
 * Resolve what the agent asked for — "facebook", "facebook.com", a url — to a
 * site definition. Unknown hosts get a derived one keyed by registrable domain.
 */
export function resolve(input: string): SiteDef {
  const raw = String(input || '').trim().toLowerCase();
  const known = allKnown();
  const byName = known.find((s) => s.id === raw || s.label.toLowerCase() === raw || s.id.split('.')[0] === raw);
  if (byName) return byName;
  const host = hostOf(raw);
  const hit = known.find((s) => cookieBelongs(host, s));
  if (hit) return hit;
  const id = registrable(host);
  return { id, label: id, domains: ['.' + id], policy: 'copy', known: false };
}

export interface Decision {
  policy: LoginPolicy;
  /** Where the policy came from — shown on the approval card. */
  source: 'owner' | 'builtin' | 'learned' | 'storage' | 'default';
  reason?: string;
  /** Narrowed IndexedDB list when a signature matched. */
  authDbs?: string[];
}

/**
 * The policy for `site`, given the IndexedDB names its origins actually hold in
 * the owner's profile. Learned outcomes win; then the named list; then storage.
 */
export function decide(site: SiteDef, idbNames: string[] = []): Decision {
  const l = learned(site.id);
  if (l) return { policy: l.policy, source: 'learned', reason: l.reason };
  if (site.known) {
    const own = ownerSites().some((s) => s.id === site.id);
    return { policy: site.policy, source: own ? 'owner' : 'builtin', reason: site.note, authDbs: site.authDbs };
  }
  const sig = AUTH_DB_SIGNATURES.filter((s) => idbNames.includes(s.db));
  if (sig.length) return { policy: 'copy', source: 'storage', reason: `${sig.map((s) => s.stack).join(', ')} keeps the session in the browser`, authDbs: sig.map((s) => s.db) };
  return { policy: idbNames.length ? 'copy' : 'cookies', source: 'default', reason: 'not a site the host knows — a first attempt may ask you to sign in again in your own browser' };
}
