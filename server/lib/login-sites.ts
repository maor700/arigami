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
  /** Where a fresh sign-in starts when sign_in is given just the site (an identity provider's sign-in page). */
  signInUrl?: string;
  /**
   * The cookies that ARE a signed-in session, as alternatives of all-of groups: [['c_user', 'xs']] = both;
   * [['SID'], ['__Secure-1PSID']] = either. A site with this list counts as signed in only when one group is all there
   * (see sessionIndicator) — a visitor cookie like Facebook's `datr` is httpOnly+secure too and is not a login.
   */
  sessionCookies?: string[][];
  /** True for the built-in list; false for a site derived on the fly. */
  known: boolean;
}

const B = (d: Omit<SiteDef, 'known'>): SiteDef => ({ ...d, known: true });

export const BUILTIN: SiteDef[] = [
  // Measured on a real host, over several runs: Google does not reliably
  // accept its session in a second browser. A cookie copy never opened Gmail;
  // a copy of the raw Cookies file worked in some runs and not in later ones.
  // The owner's own browser stayed signed in throughout. A copy that works
  // sometimes is not one to hand an agent — Google is a fresh sign-in.
  B({ id: 'google.com', label: 'Google', domains: ['.google.com', '.youtube.com', '.googleusercontent.com'], patterns: [/(^|\.)google\.(com?\.)?[a-z]{2,3}$/], policy: 'never', sessionCookies: [['SID'], ['__Secure-1PSID'], ['__Secure-3PSID']], signInUrl: 'https://accounts.google.com/', checkUrl: 'https://myaccount.google.com/', loggedOut: /google\.[a-z.]+\/account\/about|accounts\.google\.com\/.*(signin|accountchooser)/i, note: 'Google does not reliably accept its session in a second browser. Sign in fresh in the session (request_screen).' }),
  // Account providers ("Continue with Microsoft / Apple"). Like Google, their session is the owner's identity: it stays in
  // the owner's Chrome, where every "Continue with …" uses it; nothing copies it out (not verified to survive a copy).
  B({ id: 'microsoft.com', label: 'Microsoft', domains: ['.microsoftonline.com', '.live.com', '.microsoft.com'], policy: 'never', sessionCookies: [['ESTSAUTHPERSISTENT'], ['ESTSAUTH'], ['__Host-MSAAUTH'], ['MSPAuth']], signInUrl: 'https://login.microsoftonline.com/', note: 'A Microsoft account is the owner\'s identity: it stays signed in in their own Chrome, where "Continue with Microsoft" uses it.' }),
  B({ id: 'apple.com', label: 'Apple', domains: ['.apple.com'], policy: 'never', sessionCookies: [['myacinfo']], signInUrl: 'https://account.apple.com/sign-in', note: 'An Apple Account is the owner\'s identity: it stays signed in in their own Chrome, where "Sign in with Apple" uses it.' }),
  B({ id: 'facebook.com', label: 'Facebook', domains: ['.facebook.com'], policy: 'cookies', sessionCookies: [['c_user', 'xs']], checkUrl: 'https://www.facebook.com/me' }),
  B({ id: 'instagram.com', label: 'Instagram', domains: ['.instagram.com'], policy: 'cookies', sessionCookies: [['sessionid']], checkUrl: 'https://www.instagram.com/accounts/edit/' }),
  B({ id: 'github.com', label: 'GitHub', domains: ['.github.com', 'github.com'], policy: 'cookies', sessionCookies: [['user_session'], ['__Host-user_session_same_site']], checkUrl: 'https://github.com/settings/profile' }),
  B({ id: 'linkedin.com', label: 'LinkedIn', domains: ['.linkedin.com'], policy: 'cookies', sessionCookies: [['li_at']], checkUrl: 'https://www.linkedin.com/feed/' }),
  B({ id: 'x.com', label: 'X', domains: ['.x.com', '.twitter.com'], policy: 'cookies', sessionCookies: [['auth_token']], checkUrl: 'https://x.com/home' }),
  B({ id: 'amazon.com', label: 'Amazon', domains: ['.amazon.com'], policy: 'cookies', sessionCookies: [['at-main'], ['sess-at-main']], checkUrl: 'https://www.amazon.com/gp/css/homepage.html' }),
  B({ id: 'reddit.com', label: 'Reddit', domains: ['.reddit.com'], policy: 'cookies', sessionCookies: [['reddit_session']], checkUrl: 'https://www.reddit.com/settings/account' }),
  B({ id: 'todoist.com', label: 'Todoist', domains: ['.todoist.com'], policy: 'cookies', sessionCookies: [['todoistd']] }),
  B({ id: 'notion.so', label: 'Notion', domains: ['.notion.so', '.notion.com'], policy: 'cookies', sessionCookies: [['token_v2']] }),
  B({ id: 'figma.com', label: 'Figma', domains: ['.figma.com'], policy: 'cookies', sessionCookies: [['figma.authn'], ['__Host-figma.authn']], checkUrl: 'https://www.figma.com/files/recents-and-sharing' }),
  B({ id: 'slack.com', label: 'Slack', domains: ['.slack.com'], policy: 'copy', sessionCookies: [['d']], origins: ['https://app.slack.com'] }),
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
    const sessionCookies = Array.isArray(s.sessionCookies) ? s.sessionCookies.filter((g) => Array.isArray(g) && g.length).map((g) => g.map(String)) : undefined;
    out.push({ ...s, id: String(s.id).toLowerCase(), label: String(s.label || s.id), domains: s.domains.map(String), policy, ...(sessionCookies?.length ? { sessionCookies } : { sessionCookies: undefined }), known: true } as SiteDef);
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

// ---- is it a signed-in SESSION, or a visitor? ---------------------------------------------------------------------
// A site sets httpOnly+secure cookies on every visitor (Facebook's datr/fr/sb, Cloudflare's __cf_bm, Google's NID), so
// "has an auth-looking cookie" listed Facebook as signed in when only a visitor id was there — and the approved login
// moved nothing that signs in. A site counts as signed in only with a SESSION indicator: its own list (sessionCookies),
// or for a site without one, a cookie whose name says session/auth/token and is not a known visitor cookie.

/** Cookies sites set on every visitor — never a login on their own. Lower-case names. */
export const VISITOR_COOKIES = new Set([
  'datr', 'sb', 'fr', 'wd', 'dpr', 'locale', 'presence', 'usida', 'ps_l', 'ps_n',
  '_ga', '_gid', '_gat', '_gcl_au', '_fbp', '_fbc', '__utma', '__utmb', '__utmc', '__utmz', 'ajs_anonymous_id',
  '__cf_bm', 'cf_clearance', '_cfuvid', '__cfruid', '__cflb', '__stripe_mid', '__stripe_sid',
  'nid', 'aec', 'consent', 'socs', '1p_jar', 'otz', '__secure-enid', 'search_samesite',
  'loid', 'session_tracker', 'edgebucket', 'csv', 'rdt', 'token_v2_anon',
  'guest_id', 'guest_id_ads', 'guest_id_marketing', 'personalization_id', 'bcookie', 'bscookie', 'lidc', 'lang',
  'csrftoken', 'csrf_token', '_csrf', 'xsrf-token', 'x-csrf-token', '_gh_sess_anon', 'tz', 'color_mode', 'preferred_color_mode',
]);

/**
 * For a site with no list of its own. AUTH-named cookies (auth, token, jwt, logged-in, remember-me, user id) are a
 * sign-in. A framework's plain session cookie (rack.session, PHPSESSID, JSESSIONID, connect.sid, `session`) is set for
 * ANONYMOUS visitors too — measured: one visit to a login page made the next session's sign_in think the owner was
 * signed in — so it is only WEAK evidence: enough after a sign-in the agent just finished and saw land (sign_in done),
 * never for "already signed in".
 */
const AUTHY = /auth|token|jwt|logged_?in|remember|(^|[._-])user[._-]?(id|session|token)?$|^sso|identity/i;
const SESSIONY = /sess|^sid$|[._-]sid$/i;

export interface CookieName { name: string; is_httponly?: number | bigint; is_secure?: number | bigint }

export type SessionVerdict = { signedIn: true; by: string } | { signedIn: false; why: string };

/**
 * Pure: do these (non-expired) cookies of `site` hold a signed-in session? Never looks at a value. `weak` accepts a
 * plain framework session cookie (see AUTHY / SESSIONY) — only right after a sign-in was seen to land.
 */
export function sessionIndicator(site: Pick<SiteDef, 'sessionCookies' | 'label'>, cookies: CookieName[], o: { weak?: boolean } = {}): SessionVerdict {
  const names = new Set(cookies.map((c) => String(c.name)));
  if (site.sessionCookies?.length) {
    const hit = site.sessionCookies.find((group) => group.length && group.every((n) => names.has(n)));
    if (hit) return { signedIn: true, by: hit.join('+') };
    return { signedIn: false, why: `no ${site.label} session cookie (${site.sessionCookies.map((g) => g.join('+')).join(' or ')}) — only visitor cookies` };
  }
  const usable = cookies.filter((c) => Number(c.is_httponly) === 1 && !VISITOR_COOKIES.has(String(c.name).toLowerCase()) && !/csrf|xsrf/i.test(String(c.name)));
  const strong = usable.find((c) => AUTHY.test(String(c.name)));
  if (strong) return { signedIn: true, by: String(strong.name) };
  const weak = usable.find((c) => SESSIONY.test(String(c.name)));
  if (weak && o.weak) return { signedIn: true, by: `${weak.name} (a session cookie; the sign-in was seen to land)` };
  if (weak) return { signedIn: false, why: `only a plain session cookie (${weak.name}), which anonymous visitors get too` };
  return { signedIn: false, why: cookies.length ? 'only visitor / tracking cookies, no session cookie' : 'no cookies' };
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
