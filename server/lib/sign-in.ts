// sign_in — ONE tool for getting a session into a service, with the order decided HERE, in code, not in a prompt
// (docs/LOGIN.md). Before it the model ran a ~25-line decision tree over eleven tools and got it wrong where it
// mattered: Google was a circular dead end (0/6 trials reached a working card), browser_logins called a visitor cookie
// a login, and an agent refused the owner's own Chrome because "the vault fills only in the CDP browser".
//
// The ladder (ladder() below — pure, tested):
//   0. a CLI sign-in (gcloud): reuse a credential that still works; else its browser step runs in the shared Chrome
//   1. a connection the host already has (MCP / Composio) — no browser at all
//   2. a SAVED login that is genuinely signed in (a session cookie, never a visitor one) in the owner's Chrome or in
//      My browser → carried into the session's browser (the owner's one-time "always" or a card)
//   3. a NEW sign-in in the owner's everyday Chrome on the shared desktop (:99) — their real profile, driven with real
//      mouse and keyboard (XTEST), never DevTools: CDP trips bot checks (Facebook's reCAPTCHA, Google's "this browser
//      may not be secure"). The model looks and clicks (desktop_* with shared:true); the HOST types vault values into
//      the focused field (sign_in({fill})) — the model never sees one. A CAPTCHA or a push only a person can do is the
//      one hand-over (sign_in({human})).
//
// The signed-in profile of the owner's Chrome is the one place a login lives: sessions get a copy of ONE site from it
// (login-vault.ts transfer), nothing is written back, and a site the owner has under two accounts lives in two profiles.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { siteOf, providerOf } from './sso.js';
import { hostOf, resolve as resolveSite } from './login-sites.js';
import type { OwnerProfile } from './owner-chrome.js';
import type { ActiveWindow } from './desktop-control.js';

// ---- the ladder (pure) --------------------------------------------------------------------------------------------

/** Services the host reaches through a connection rather than a browser. The capability id per site / name. */
const CONNECTIONS: { cap: string; names: RegExp }[] = [
  { cap: 'mcp:linear', names: /^(linear|linear\.app)$/ },
  { cap: 'mcp:notion', names: /^(notion|notion\.so|notion\.com)$/ },
  { cap: 'mcp:sentry', names: /^(sentry|sentry\.io)$/ },
  { cap: 'mcp:figma', names: /^(figma|figma\.com)$/ },
  { cap: 'mcp:vercel', names: /^(vercel|vercel\.com)$/ },
  { cap: 'mcp:stripe', names: /^(stripe|stripe\.com|dashboard\.stripe\.com)$/ },
  { cap: 'mcp:cloudflare', names: /^(cloudflare|cloudflare\.com|dash\.cloudflare\.com)$/ },
  { cap: 'mcp:supabase', names: /^(supabase|supabase\.com)$/ },
  { cap: 'mcp:atlassian', names: /^(atlassian|jira|confluence|atlassian\.net|[a-z0-9-]+\.atlassian\.net)$/ },
  { cap: 'mcp:asana', names: /^(asana|asana\.com|app\.asana\.com)$/ },
  { cap: 'composio:gmail', names: /^(gmail|gmail\.com|mail\.google\.com)$/ },
  { cap: 'composio:googlecalendar', names: /^(google calendar|calendar|calendar\.google\.com)$/ },
  { cap: 'composio:googledrive', names: /^(google drive|drive|drive\.google\.com)$/ },
  { cap: 'composio:googledocs', names: /^(google docs|docs\.google\.com)$/ },
  { cap: 'composio:slack', names: /^(slack|slack\.com|app\.slack\.com|[a-z0-9-]+\.slack\.com)$/ },
  { cap: 'git', names: /^(github|github\.com|gh)$/ },
];

const norm = (input: string): string => {
  const s = String(input || '').trim().toLowerCase();
  if (/^[a-z]+:\/\//.test(s)) return hostOf(s).replace(/^www\./, '');
  return s.replace(/^www\./, '').replace(/\/+$/, '');
};

/** Pure: the host connection that serves `input`, if there is one. */
export function connectionFor(input: string): string | null {
  const s = norm(input);
  return CONNECTIONS.find((c) => c.names.test(s))?.cap || null;
}

export type Cli = 'gcloud';

/** Pure: a command-line tool's sign-in rather than a website's. */
export function cliFor(input: string): Cli | null {
  return /^(gcloud|gcloud cli|google cloud sdk|google cloud cli|gcloud auth)$/.test(norm(input)) ? 'gcloud' : null;
}

/** Pure: the site a sign-in is FOR — its registrable domain ("www.facebook.com/login" → facebook.com). */
export function siteKey(input: string): string {
  const s = String(input || '').trim();
  // a bare name ("facebook", "microsoft") is a site the host knows by name, not a host called "microsoft"
  if (s && !/[./:]/.test(s)) return resolveSite(s).id;
  const host = hostOf(/^[a-z]+:\/\//i.test(s) ? s : `https://${s.replace(/^\/+/, '')}`);
  return siteOf(host) || resolveSite(s).id;
}

/** Pure: the page a fresh sign-in starts on. A url given keeps its path; a bare site gets its home page. */
export function startUrl(input: string, signInUrl?: string): string {
  const s = String(input || '').trim();
  // just a site (no path) of an account provider: its sign-in page, not its home page
  if (signInUrl && !/^[a-z]+:\/\/[^/]+\/./i.test(s) && !/^[^/]+\/./.test(s)) return signInUrl;
  if (/^https:\/\//i.test(s)) return s;
  if (/^http:\/\//i.test(s)) return s.replace(/^http:/i, 'https:');
  return `https://${s.replace(/^\/+/, '')}${s.includes('/') ? '' : '/'}`;
}

export interface LadderFacts {
  cli: Cli | null;
  /** The CLI already holds a working credential. */
  cliSignedIn?: boolean;
  /** The host connection for the site and whether it is connected right now. */
  connection: { capability: string; connected: boolean } | null;
  /** The caller needs the site in its browser, not its API. */
  wantBrowser?: boolean;
  /** A genuinely signed-in saved login: where, and whether it may be copied at all. */
  saved: { present: boolean; policy: 'copy' | 'cookies' | 'never'; inOwnerChrome: boolean } | null;
  /** This host has a shared desktop with the owner's everyday Chrome on it. */
  sharedChrome: boolean;
}

export type Rung =
  | { rung: 'cli-ok' }
  | { rung: 'connection'; capability: string }
  | { rung: 'saved' }
  /** Signed in in the owner's Chrome, but the site does not take a copied session (Google): work there. */
  | { rung: 'owner-chrome-only' }
  | { rung: 'shared-chrome' }
  | { rung: 'blocked'; reason: string };

/** Pure: the first rung that applies. The order is the product; tests pin it. */
export function ladder(f: LadderFacts): Rung {
  if (f.cli) {
    if (f.cliSignedIn) return { rung: 'cli-ok' };
    return f.sharedChrome ? { rung: 'shared-chrome' } : { rung: 'blocked', reason: `${f.cli} needs a browser sign-in and this host has no shared desktop with the owner's Chrome` };
  }
  if (f.connection?.connected && !f.wantBrowser) return { rung: 'connection', capability: f.connection.capability };
  if (f.saved?.present) {
    if (f.saved.policy !== 'never') return { rung: 'saved' };
    if (f.saved.inOwnerChrome) return { rung: 'owner-chrome-only' };
  }
  if (f.sharedChrome) return { rung: 'shared-chrome' };
  return { rung: 'blocked', reason: "this host has no shared desktop with the owner's Chrome, so a new sign-in cannot happen here — ask the owner to sign in once in My browser" };
}

// ---- which of the owner's accounts (pure) -------------------------------------------------------------------------

export type ProfilePick = { ok: true; profile: OwnerProfile } | { ok: false; reason: string };

/**
 * Pure: the profile a sign-in uses. An `account` hint wins (matchProfile). Else the one profile that already holds the
 * site; two that do = two accounts, and the caller must say which. Else the profile signed in to the owner's identity
 * (Google SSO works there), else the first (the one Chrome last used).
 */
export function chooseProfile(
  profiles: OwnerProfile[],
  o: { account?: string | null; signedInIn: string[]; identityEmail?: string | null; identityProfile?: string | null; match: (ps: OwnerProfile[], a: string) => OwnerProfile | null; label: (p: OwnerProfile) => string }
): ProfilePick {
  if (!profiles.length) return { ok: false, reason: "the owner's everyday Chrome has no profile on this host" };
  if (o.account) {
    const p = o.match(profiles, o.account);
    return p ? { ok: true, profile: p } : { ok: false, reason: `no Chrome profile for "${o.account}" — the owner's are: ${profiles.map(o.label).join(', ')}` };
  }
  const holding = profiles.filter((p) => o.signedInIn.includes(p.profileDir));
  if (holding.length === 1) return { ok: true, profile: holding[0] };
  if (holding.length > 1) return { ok: false, reason: `signed in under two accounts (${holding.map(o.label).join('; ')}) — call sign_in again with account: one of them` };
  const id = (o.identityEmail || '').toLowerCase();
  const byDir = o.identityProfile ? profiles.find((p) => p.profileDir === o.identityProfile) : undefined;
  return { ok: true, profile: byDir || (id && profiles.find((p) => (p.email || '').toLowerCase() === id)) || profiles[0] };
}

// ---- the vault fill on the shared desktop (pure guard) ------------------------------------------------------------

export type FillField = 'username' | 'password' | 'otp';
export const FILL_FIELDS: FillField[] = ['username', 'password', 'otp'];
/** A login page older than this in the profile's history is not "the page you are on". */
export const LAST_URL_MAX_AGE_MS = 20 * 60_000;

export interface FillFacts {
  sessionId: string;
  /** The shared desktop's lease: who holds it and for which site. */
  holder: { sessionId: string; site: string | null } | null;
  /** The sign-in this session runs: the site and the Chrome profile. */
  job: { site: string; profileDir: string } | null;
  /** The focused window on the shared desktop. */
  active: ActiveWindow | null;
  /** Pids of the owner's everyday Chrome (its browser process — never one with a DevTools port). */
  ownerPids: number[];
  /** The last page the profile navigated to (its History), and how long ago. */
  lastUrl: { url: string; ageMs: number } | null;
}

export type FillGate = { ok: true; origin: string; host: string } | { ok: false; reason: string };

/**
 * Pure: may the host type a vault value into the focused field on the shared desktop now? The owner's Chrome has no
 * DevTools port (on purpose), so the page is known from the outside: the focused window must be the owner's own
 * Chrome, and the page its profile last navigated to must be the site of this sign-in or a sign-in provider. The vault
 * then matches entries for exactly that origin (the cockpit, vault.worker.js), so a value can only go to its own site.
 */
export function sharedFillGuard(f: FillFacts): FillGate {
  if (!f.job) return { ok: false, reason: 'no sign-in is running for this session — call sign_in({site}) first' };
  if (f.holder?.sessionId !== f.sessionId) return { ok: false, reason: 'you do not hold the shared desktop any more — call sign_in({site}) again' };
  if (!f.active) return { ok: false, reason: 'cannot tell which window has the focus on the shared desktop — click into the sign-in field first' };
  if (!f.active.pid || !f.ownerPids.includes(f.active.pid))
    return { ok: false, reason: "the focused window is not the owner's Chrome — click into the sign-in field of the page sign_in opened" };
  if (!f.lastUrl) return { ok: false, reason: "cannot read which page the owner's Chrome is on — reload the sign-in page (F5) and try again" };
  let u: URL;
  try {
    u = new URL(f.lastUrl.url);
  } catch {
    return { ok: false, reason: 'the page is not a web page' };
  }
  if (u.protocol !== 'https:') return { ok: false, reason: `${u.host || 'the page'} is not https — nothing is typed there` };
  if (f.lastUrl.ageMs > LAST_URL_MAX_AGE_MS) return { ok: false, reason: 'the sign-in page was loaded too long ago — reload it (F5) and try again' };
  const onSite = siteOf(u.hostname) === f.job.site;
  if (!onSite && !providerOf(u.href)) return { ok: false, reason: `the page is on ${u.hostname}, outside ${f.job.site} and the sign-in providers — nothing is typed there` };
  return { ok: true, origin: u.origin, host: u.hostname };
}

// ---- did THIS sign-in land? (pure) ------------------------------------------------------------------------------------

/**
 * Pure: the httpOnly cookies that appeared during this sign-in (before = when sign_in opened the page, after = at done),
 * minus visitor / CSRF ones. A site whose session cookie has no telling name (Todoist's `todoistd`) still shows it here:
 * it was not there before the agent signed in, and it is there once the page shows the agent signed in.
 */
export function newSessionCookies(before: string[], after: string[], visitor: Set<string>): string[] {
  const had = new Set(before);
  return [...new Set(after)].filter((n) => !had.has(n) && !visitor.has(n.toLowerCase()) && !/csrf|xsrf/i.test(n)).sort();
}

// ---- the owner's Chrome, from the outside -------------------------------------------------------------------------

/**
 * Pure: is this command line the owner's everyday Chrome browser process? The main process (no --type=), no DevTools
 * port, and its user-data dir is the owner's (or unset = the default, which is the owner's).
 */
export function isOwnerChromeCmd(argv: string[], userDataDir: string, defaultDir: string): boolean {
  if (!argv.length || !/(?:^|\/)(google-chrome(?:-stable|-beta|-unstable)?|chrome|chromium(?:-browser)?|arigami-chrome)$/.test(argv[0])) return false;
  if (argv.some((a) => a.startsWith('--type=') || a.startsWith('--remote-debugging') || a === '--headless' || a.startsWith('--headless='))) return false;
  const ud = argv.find((a) => a.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length);
  return path.resolve(ud || defaultDir) === path.resolve(userDataDir);
}

/** Pids of the owner's everyday Chrome browser process(es) on this host (Linux /proc). */
export function ownerChromePids(userDataDir: string): number[] {
  const out: number[] = [];
  const def = path.join(os.homedir(), '.config', 'google-chrome');
  let ids: string[] = [];
  try {
    ids = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d));
  } catch {
    return out;
  }
  for (const id of ids) {
    try {
      const argv = fs.readFileSync(`/proc/${id}/cmdline`, 'utf8').split('\0').filter(Boolean);
      if (isOwnerChromeCmd(argv, userDataDir, def)) out.push(Number(id));
    } catch {
      /* gone */
    }
  }
  return out;
}

// Chrome stores times as microseconds since 1601-01-01.
const CHROME_EPOCH_OFFSET_MS = 11644473600_000;

/** Pure: the page title in a Chrome window title ("Log in to Facebook - Google Chrome" → "Log in to Facebook"). */
export const pageTitleOf = (windowTitle: string): string => String(windowTitle || '').replace(/ - (Google Chrome|Chromium)( \(.*\))?$/, '').trim();

/**
 * Pure: of a profile's recent visits (newest first), the page the focused tab shows — the newest whose title is the
 * window's page title. The profile's history is shared by all its tabs (another tab's redirect is "the newest visit"),
 * so the title ties it to the tab that has the focus; without a match, the newest visit.
 */
export function focusedVisit(visits: { url: string; title: string; t: number }[], windowTitle: string | null | undefined): { url: string; t: number; matched: boolean } | null {
  if (!visits.length) return null;
  const want = pageTitleOf(windowTitle || '');
  const hit = want ? visits.find((v) => v.title && v.title.trim() === want) : undefined;
  const v = hit || visits[0];
  return { url: v.url, t: v.t, matched: !!hit };
}

/**
 * The page a profile's focused tab is on (its History db, read from a copy), or null. Chrome commits it within ~10 s.
 * `windowTitle` = the focused window's title (xprop), to pick that tab's visit out of the profile's history.
 */
export function lastVisit(profilePath: string, now = Date.now(), windowTitle?: string | null): { url: string; ageMs: number } | null {
  const src = path.join(profilePath, 'History');
  if (!fs.existsSync(src)) return null;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-history-'));
  try {
    const copy = path.join(tmp, 'History');
    fs.copyFileSync(src, copy);
    for (const ext of ['-journal', '-wal']) if (fs.existsSync(src + ext)) fs.copyFileSync(src + ext, copy + ext);
    const { Database } = require('bun:sqlite') as typeof import('bun:sqlite');
    const db = new Database(copy, { readonly: true });
    try {
      const rows = db.query('select u.url as url, u.title as title, v.visit_time as t from visits v join urls u on u.id = v.url order by v.visit_time desc limit 50').all() as { url: string; title: string | null; t: number }[];
      const v = focusedVisit(rows.map((r) => ({ url: String(r.url), title: String(r.title || ''), t: Number(r.t) })), windowTitle);
      if (!v) return null;
      return { url: v.url, ageMs: Math.max(0, now - (v.t / 1000 - CHROME_EPOCH_OFFSET_MS)) };
    } finally {
      db.close();
    }
  } catch {
    return null;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---- gcloud: its browser step in the owner's Chrome ---------------------------------------------------------------

const GCLOUD_PATHS = ['/snap/bin', '/usr/lib/google-cloud-sdk/bin', path.join(os.homedir(), 'google-cloud-sdk', 'bin'), '/usr/local/bin', '/usr/bin'];

export function gcloudBin(): string | null {
  for (const d of [...(process.env.PATH || '').split(':'), ...GCLOUD_PATHS]) {
    const p = path.join(d, 'gcloud');
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      /* next */
    }
  }
  return null;
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const kill = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} }, timeoutMs);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', () => {}); // a token never goes anywhere; neither does its error text
    p.on('close', (code) => { clearTimeout(kill); resolve({ code: code ?? 1, out }); });
    p.on('error', () => { clearTimeout(kill); resolve({ code: 1, out: '' }); });
  });
}

/** Does gcloud hold a credential that works right now? The account only — the token is read and dropped. */
export async function gcloudStatus(): Promise<{ bin: string | null; ok: boolean; account: string | null }> {
  const bin = gcloudBin();
  if (!bin) return { bin: null, ok: false, account: null };
  const env = { ...process.env, CLOUDSDK_CORE_DISABLE_PROMPTS: '1' };
  const acct = await run(bin, ['config', 'get-value', 'account'], env, 20_000);
  const account = acct.out.trim().split('\n').pop()?.trim() || null;
  const tok = await run(bin, ['auth', 'print-access-token', '--quiet'], env, 30_000);
  return { bin, ok: tok.code === 0 && tok.out.trim().length > 20, account: account && account !== '(unset)' ? account : null };
}

/**
 * `gcloud auth login` with its browser opened in ONE profile of the owner's Chrome on the shared desktop: BROWSER is a
 * tiny opener that hands the URL to that Chrome, and the OAuth redirect lands on gcloud's own localhost listener, so
 * there is no code to copy. Resolves when gcloud exits.
 */
export function startGcloudLogin(bin: string, o: { display: string; chrome: string; profileDir: string; dir: string }): { proc: ChildProcess; done: Promise<{ ok: boolean }> } {
  fs.mkdirSync(o.dir, { recursive: true });
  const opener = path.join(o.dir, 'sign-in-open.sh');
  fs.writeFileSync(opener, '#!/bin/sh\n# sign_in (lib/sign-in.ts): open one URL in the owner\'s Chrome profile named by ARIGAMI_SIGNIN_PROFILE\nexec "$ARIGAMI_SIGNIN_CHROME" --profile-directory="$ARIGAMI_SIGNIN_PROFILE" "$1" >/dev/null 2>&1\n', { mode: 0o700 });
  const env: NodeJS.ProcessEnv = { ...process.env, DISPLAY: o.display, BROWSER: opener, ARIGAMI_SIGNIN_CHROME: o.chrome, ARIGAMI_SIGNIN_PROFILE: o.profileDir };
  for (const k of ['SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY', 'WAYLAND_DISPLAY']) delete env[k];
  const proc = spawn(bin, ['auth', 'login', '--brief', '--launch-browser', '--quiet'], { env, stdio: ['ignore', 'ignore', 'ignore'], detached: false });
  const done = new Promise<{ ok: boolean }>((resolve) => {
    proc.on('close', (code) => resolve({ ok: code === 0 }));
    proc.on('error', () => resolve({ ok: false }));
  });
  return { proc, done };
}

// ---- what the model is told (one place) ---------------------------------------------------------------------------

export type Outcome =
  | { status: 'signed_in'; site: string; via: 'connection' | 'saved' | 'shared-chrome' | 'cli'; account?: string; profile?: string; next: string }
  | { status: 'blocked'; site: string; reason: string }
  /** The owner's Chrome on the shared desktop shows the site's sign-in: your hands (clicks), the host's typing. */
  | { status: 'driving'; site: string; account: string; profile?: string; next: string };

/**
 * Pure: an OAuth / consent page a connect playbook hands to sign_in({site, url}) — it is finished in the owner's Chrome
 * (signed in to Google there) instead of the session's empty browser. https only.
 */
export function consentUrl(url: unknown): string | null {
  const s = String(url || '').trim();
  if (!/^https:\/\//i.test(s)) return null;
  try {
    return new URL(s).href;
  } catch {
    return null;
  }
}

export const DRIVE_HOW =
  "Look with desktop_screenshot({shared:true}) and click with desktop_pointer({shared:true}) — that is the owner's own Chrome, use it like a person. " +
  'A username / password / one-time-code field: click into it, then sign_in({site, fill:"username"|"password"|"otp"}) — the host types it from the vault; ' +
  'you never type a secret and never see one. Your own text there: only the account email (desktop_keyboard). Enter / Tab with desktop_keyboard({key, shared:true}). ' +
  'A CAPTCHA, an SMS code or a push approval only the owner can do: sign_in({site, human:"<exactly what to do>"}). ' +
  'When the page shows you signed in: sign_in({site, done:true}).';

export const blocked = (site: string, reason: string): Outcome => ({ status: 'blocked', site, reason: reason.replace(/\s+/g, ' ').trim() });
