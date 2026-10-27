// sign_in (server/lib/sign-in.ts) — the pure parts that decide what happens:
//   - the ladder's order: CLI → connection → a REAL saved login → a new sign-in in the owner's Chrome
//   - a "login" is a session cookie, never a visitor one (Facebook's datr/fr/sb listed Facebook as signed in)
//   - which of the owner's accounts (Chrome profiles); two accounts = say which
//   - the vault fill on the shared desktop: only into the owner's Chrome, only on the site, one field per card
//   - a secret never comes back in a result, a log line or an argv
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import * as si from '../server/lib/sign-in.ts';
import * as ls from '../server/lib/login-sites.ts';
import * as lv from '../server/lib/login-vault.ts';
import * as cr from '../server/lib/credentials.ts';
import { resolveOwnerProfile, listProfiles, matchProfile, profileLabel, type OwnerProfile } from '../server/lib/owner-chrome.ts';
import { SharedDesktopLease } from '../server/lib/shared-desktop.ts';
import { totp, totpSpec, base32Decode } from '../web/src/lib/totp.js';
import { tmpDir } from './_tmp.js';

const root = path.resolve(import.meta.dir, '..');
const read = (f: string) => fs.readFileSync(path.join(root, f), 'utf8');

// ---- the ladder ----------------------------------------------------------------------------------------------------

const base: si.LadderFacts = { cli: null, connection: null, saved: null, sharedChrome: true };

test('ladder: a connected host connection wins over everything but a CLI; browser:true skips it', () => {
  const f = { ...base, connection: { capability: 'mcp:linear', connected: true }, saved: { present: true, policy: 'copy' as const, inOwnerChrome: true } };
  expect(si.ladder(f)).toEqual({ rung: 'connection', capability: 'mcp:linear' });
  expect(si.ladder({ ...f, wantBrowser: true })).toEqual({ rung: 'saved' });
  expect(si.ladder({ ...f, connection: { capability: 'mcp:linear', connected: false } })).toEqual({ rung: 'saved' }); // not connected = not a rung
});

test('ladder: a saved login only when it is really signed in; never-copy sites are worked in the owner Chrome', () => {
  expect(si.ladder({ ...base, saved: { present: false, policy: 'cookies', inOwnerChrome: true } })).toEqual({ rung: 'shared-chrome' });
  expect(si.ladder({ ...base, saved: { present: true, policy: 'cookies', inOwnerChrome: true } })).toEqual({ rung: 'saved' });
  // Google: signed in in the owner's Chrome, not copyable → work there, not a dead end
  expect(si.ladder({ ...base, saved: { present: true, policy: 'never', inOwnerChrome: true } })).toEqual({ rung: 'owner-chrome-only' });
  // never-copy and only in My browser → a new sign-in in the owner's Chrome
  expect(si.ladder({ ...base, saved: { present: true, policy: 'never', inOwnerChrome: false } })).toEqual({ rung: 'shared-chrome' });
});

test('ladder: no shared desktop = one blocked reason, never a loop of cards', () => {
  const r = si.ladder({ ...base, sharedChrome: false });
  expect(r.rung).toBe('blocked');
  expect((r as any).reason).toMatch(/no shared desktop/);
});

test('ladder: gcloud reuses a working credential, else its browser step goes to the owner Chrome', () => {
  expect(si.ladder({ ...base, cli: 'gcloud', cliSignedIn: true, connection: { capability: 'x', connected: true } })).toEqual({ rung: 'cli-ok' });
  expect(si.ladder({ ...base, cli: 'gcloud', cliSignedIn: false })).toEqual({ rung: 'shared-chrome' });
  expect(si.ladder({ ...base, cli: 'gcloud', cliSignedIn: false, sharedChrome: false }).rung).toBe('blocked');
});

test('what a site name maps to: connections, CLIs, the site key, the start page', () => {
  expect(si.connectionFor('linear')).toBe('mcp:linear');
  expect(si.connectionFor('https://linear.app/team')).toBe('mcp:linear');
  expect(si.connectionFor('mail.google.com')).toBe('composio:gmail');
  expect(si.connectionFor('facebook.com')).toBe(null); // a timeline comment needs the site, not an API
  expect(si.connectionFor('accounts.google.com')).toBe(null);
  expect(si.cliFor('gcloud')).toBe('gcloud');
  expect(si.cliFor('Google Cloud SDK')).toBe('gcloud');
  expect(si.cliFor('cloud.google.com')).toBe(null);
  expect(si.siteKey('https://www.facebook.com/login.php')).toBe('facebook.com');
  expect(si.siteKey('app.todoist.com')).toBe('todoist.com');
  expect(si.startUrl('facebook.com')).toBe('https://facebook.com/');
  expect(si.startUrl('https://app.todoist.com/auth/login')).toBe('https://app.todoist.com/auth/login');
  expect(si.startUrl('http://x.com/a')).toBe('https://x.com/a');
});

// ---- a session, not a visitor --------------------------------------------------------------------------------------

const row = (name: string, httpOnly = 1, secure = 1) => ({ name, is_httponly: httpOnly, is_secure: secure });

test('sessionIndicator: Facebook visitor cookies are not a login; c_user + xs is', () => {
  const fb = ls.resolve('facebook.com');
  const visitor = [row('datr'), row('fr'), row('sb'), row('wd', 0)];
  const v = ls.sessionIndicator(fb, visitor);
  expect(v.signedIn).toBe(false);
  expect((v as any).why).toMatch(/c_user\+xs/);
  expect(ls.sessionIndicator(fb, [...visitor, row('c_user', 0), row('xs')])).toEqual({ signedIn: true, by: 'c_user+xs' });
  expect(ls.sessionIndicator(fb, [...visitor, row('c_user', 0)]).signedIn).toBe(false); // half a session is none
  expect(ls.sessionIndicator(ls.resolve('google.com'), [row('NID'), row('AEC')]).signedIn).toBe(false);
  expect(ls.sessionIndicator(ls.resolve('google.com'), [row('NID'), row('__Secure-1PSID')]).signedIn).toBe(true);
  expect(ls.sessionIndicator(ls.resolve('reddit.com'), [row('loid'), row('token_v2'), row('session_tracker')]).signedIn).toBe(false);
});

test('sessionIndicator: a site without a list — an auth-named httpOnly cookie; a plain framework session only after a seen sign-in', () => {
  const s = ls.resolve('notes.example');
  expect(ls.sessionIndicator(s, [row('__Secure-next-auth.session-token')]).signedIn).toBe(true);
  expect(ls.sessionIndicator(s, [row('auth_token')]).signedIn).toBe(true);
  expect(ls.sessionIndicator(s, [row('remember_user_token')]).signedIn).toBe(true);
  // bench S3: one visit to a login page sets rack.session for an anonymous visitor — not "already signed in"
  for (const n of ['rack.session', 'PHPSESSID', 'JSESSIONID', 'connect.sid', 'session', 'sid', 'laravel_session']) {
    expect(`${n}:${ls.sessionIndicator(s, [row(n)]).signedIn}`).toBe(`${n}:false`);
    expect(`${n}:${ls.sessionIndicator(s, [row(n)], { weak: true }).signedIn}`).toBe(`${n}:true`);
  }
  for (const n of ['__cf_bm', 'cf_clearance', '_ga', 'csrftoken', 'XSRF-TOKEN', 'datr', '_cfuvid'])
    expect(`${n}:${ls.sessionIndicator(s, [row(n)], { weak: true }).signedIn}`).toBe(`${n}:false`);
  expect(ls.sessionIndicator(s, [row('auth_token', 0)]).signedIn).toBe(false); // readable by page script = not the session
});

function fakeChrome(ud: string, profiles: Record<string, { name?: string; email?: string; cookies: [string, string, number, number][] }>, lastUsed: string): void {
  const cache: Record<string, unknown> = {};
  for (const [dir, p] of Object.entries(profiles)) {
    fs.mkdirSync(path.join(ud, dir), { recursive: true });
    fs.rmSync(path.join(ud, dir, 'Cookies'), { force: true });
    const db = new Database(path.join(ud, dir, 'Cookies'));
    db.run('create table cookies (host_key text, name text, expires_utc integer, is_httponly integer, is_secure integer, encrypted_value blob)');
    for (const [host, name, h, s] of p.cookies) db.run('insert into cookies values (?, ?, 0, ?, ?, ?)', [host, name, h, s, Buffer.from('v10SECRETVALUE')]);
    db.close();
    cache[dir] = { name: p.name || dir, user_name: p.email || '' };
  }
  fs.writeFileSync(path.join(ud, 'Local State'), JSON.stringify({ profile: { last_used: lastUsed, info_cache: cache } }));
}

test('detect / list: the scratch-13 false positive — a datr-only Facebook is NOT listed; a real session is, per profile', () => {
  const vault = tmpDir('si-vault-');
  const ud = tmpDir('si-ud-');
  fakeChrome(ud, {
    Default: { name: 'Your Chrome', cookies: [['.facebook.com', 'datr', 1, 1], ['.facebook.com', 'fr', 1, 1], ['.facebook.com', 'sb', 1, 1]] },
    'Profile 1': { name: 'work.example', email: 'me@work.example', cookies: [['.facebook.com', 'datr', 1, 1], ['.google.com', 'SID', 0, 0], ['.google.com', 'NID', 1, 1]] },
  }, 'Default');
  const own = listProfiles(resolveOwnerProfile({ platform: 'linux', env: { ARIGAMI_OWNER_CHROME: ud } })!);
  expect(own.map((p) => p.profileDir)).toEqual(['Default', 'Profile 1']);
  expect(own[1].email).toBe('me@work.example');
  const d = lv.detect('facebook', vault, own);
  expect(d.present).toBe(false);
  expect(d.why).toMatch(/visitor/);
  const ids = lv.list(vault, own).map((s) => s.id);
  expect(ids).not.toContain('facebook.com');
  expect(ids).toContain('google.com');
  // the owner signs in to Facebook in their personal profile → listed, from that profile only
  fakeChrome(ud, {
    Default: { name: 'Your Chrome', cookies: [['.facebook.com', 'datr', 1, 1], ['.facebook.com', 'c_user', 0, 1], ['.facebook.com', 'xs', 1, 1]] },
    'Profile 1': { name: 'work.example', email: 'me@work.example', cookies: [['.facebook.com', 'datr', 1, 1]] },
  }, 'Default');
  const d2 = lv.detect('facebook', vault, own);
  expect(d2.present).toBe(true);
  expect(d2.by).toBe('c_user+xs');
  expect(d2.profiles).toEqual(['Default']);
  expect(JSON.stringify([d, d2, lv.list(vault, own)])).not.toContain('SECRETVALUE'); // names only, ever
});

// ---- which account ---------------------------------------------------------------------------------------------------

const P = (dir: string, name?: string, email?: string): OwnerProfile => ({ userDataDir: '/u', profileDir: dir, profilePath: `/u/${dir}`, name, email });
const pick = (ps: OwnerProfile[], o: Partial<Parameters<typeof si.chooseProfile>[1]>) =>
  si.chooseProfile(ps, { signedInIn: [], match: matchProfile, label: profileLabel, ...o } as any);

test('chooseProfile: an account hint wins; one holder; two holders = say which; else the identity profile', () => {
  const ps = [P('Default', 'Your Chrome'), P('Profile 1', 'work.example', 'me@work.example')];
  expect((pick(ps, { account: 'work.example' }) as any).profile.profileDir).toBe('Profile 1');
  expect((pick(ps, { account: 'me@work.example' }) as any).profile.profileDir).toBe('Profile 1');
  expect((pick(ps, { account: '@work.example' }) as any).profile.profileDir).toBe('Profile 1');
  expect((pick(ps, { account: 'Default' }) as any).profile.profileDir).toBe('Default');
  expect(pick(ps, { account: 'someone@else.example' })).toMatchObject({ ok: false });
  expect((pick(ps, { signedInIn: ['Default'] }) as any).profile.profileDir).toBe('Default');
  const two = pick(ps, { signedInIn: ['Default', 'Profile 1'] });
  expect(two.ok).toBe(false);
  expect((two as any).reason).toMatch(/two accounts.*account/);
  expect((pick(ps, { identityEmail: 'me@work.example' }) as any).profile.profileDir).toBe('Profile 1'); // Google SSO works there
  expect((pick(ps, {}) as any).profile.profileDir).toBe('Default'); // the one Chrome last used
  expect(pick([], {})).toMatchObject({ ok: false });
});

// ---- the vault fill on the shared desktop ----------------------------------------------------------------------------

const okFacts = (): si.FillFacts => ({
  sessionId: 's1',
  holder: { sessionId: 's1', site: 'facebook.com' },
  job: { site: 'facebook.com', profileDir: 'Default' },
  active: { pid: 4242, wmClass: '"google-chrome", "Google-chrome"', title: 'Log in to Facebook - Google Chrome' },
  ownerPids: [4242],
  lastUrl: { url: 'https://www.facebook.com/login/?next=x', ageMs: 5_000 },
});

test('sharedFillGuard: only into the owner Chrome, only on the site or a sign-in provider, only while holding the desktop', () => {
  expect(si.sharedFillGuard(okFacts())).toEqual({ ok: true, origin: 'https://www.facebook.com', host: 'www.facebook.com' });
  const no = (patch: Partial<si.FillFacts>, re: RegExp) => {
    const g = si.sharedFillGuard({ ...okFacts(), ...patch });
    expect(g.ok).toBe(false);
    expect((g as any).reason).toMatch(re);
  };
  no({ job: null }, /no sign-in is running/);
  no({ holder: { sessionId: 'other', site: 'facebook.com' } }, /do not hold/);
  no({ holder: null }, /do not hold/);
  no({ active: null }, /focus/);
  no({ active: { pid: 999, wmClass: 'google-chrome', title: 'Facebook' } }, /not the owner's Chrome/); // a CDP Chrome, a terminal
  no({ lastUrl: null }, /cannot read/);
  no({ lastUrl: { url: 'http://www.facebook.com/login', ageMs: 1 } }, /not https/);
  no({ lastUrl: { url: 'https://evil.example/facebook.com/login', ageMs: 1 } }, /outside facebook\.com/);
  no({ lastUrl: { url: 'https://www.facebook.com/login', ageMs: si.LAST_URL_MAX_AGE_MS + 1 } }, /too long ago/);
  // Google's own sign-in page during "Continue with Google" is a provider: allowed
  expect(si.sharedFillGuard({ ...okFacts(), lastUrl: { url: 'https://accounts.google.com/v3/signin', ageMs: 1 } })).toMatchObject({ ok: true, origin: 'https://accounts.google.com' });
});

test('focusedVisit: the focused tab\'s page, not another tab\'s newer redirect (bench S3-t1)', () => {
  const visits = [
    { url: 'https://www.reddit.com/?rdt=1', title: 'Reddit - The heart of the internet', t: 3 },
    { url: 'https://the-internet.herokuapp.com/login', title: 'The Internet', t: 2 },
    { url: 'https://www.facebook.com/', title: 'Facebook', t: 1 },
  ];
  expect(si.pageTitleOf('The Internet - Google Chrome')).toBe('The Internet');
  expect(si.focusedVisit(visits, 'The Internet - Google Chrome')).toEqual({ url: 'https://the-internet.herokuapp.com/login', t: 2, matched: true });
  expect(si.focusedVisit(visits, 'Untitled thing - Google Chrome')).toMatchObject({ url: 'https://www.reddit.com/?rdt=1', matched: false });
  expect(si.focusedVisit(visits, null)).toMatchObject({ matched: false, t: 3 });
  expect(si.focusedVisit([], 'x')).toBe(null);
});

test('newSessionCookies: what a sign-in added (Todoist todoistd), not visitor / CSRF cookies or ones there before', () => {
  const before = ['__cf_bm', 'csrf'];
  expect(si.newSessionCookies(before, ['__cf_bm', 'csrf', 'todoistd', 'tduser', '_ga', 'XSRF-TOKEN'], ls.VISITOR_COOKIES)).toEqual(['tduser', 'todoistd']);
  expect(si.newSessionCookies(['todoistd'], ['todoistd'], ls.VISITOR_COOKIES)).toEqual([]); // nothing new: not this sign-in's doing
  expect(ls.sessionIndicator(ls.resolve('app.todoist.com'), [row('todoistd')]).signedIn).toBe(true);
});

test("isOwnerChromeCmd: the owner's everyday Chrome, not a CDP / headless / session Chrome", () => {
  const def = '/home/o/.config/google-chrome';
  expect(si.isOwnerChromeCmd(['/usr/bin/google-chrome-stable', '--no-sandbox'], def, def)).toBe(true);
  expect(si.isOwnerChromeCmd(['/opt/google/chrome/chrome', `--user-data-dir=${def}`], def, def)).toBe(true);
  expect(si.isOwnerChromeCmd(['/usr/bin/google-chrome', '--remote-debugging-port=0'], def, def)).toBe(false);
  expect(si.isOwnerChromeCmd(['/usr/bin/google-chrome', '--user-data-dir=/x/chrome-sessions/s1'], def, def)).toBe(false);
  expect(si.isOwnerChromeCmd(['/opt/google/chrome/chrome', '--type=renderer'], def, def)).toBe(false);
  expect(si.isOwnerChromeCmd(['/usr/bin/google-chrome', '--headless=new'], def, def)).toBe(false);
  expect(si.isOwnerChromeCmd(['/usr/bin/python3', 'x'], def, def)).toBe(false);
});

const SECRET = 'S3cr3t-Pa55-never-shown';

test('vault fill gating: one field per card, typed only after the page is checked again, nothing typed when it moved', async () => {
  const typed: string[] = [];
  cr._setSharedTyper(async (v) => { typed.push(v); return { ok: true }; });
  let moved: string | null = null;
  const req = cr.requestShared('sess-a', { origin: 'https://www.facebook.com', field: 'password', reason: 'comment', account: 'Your Chrome', recheck: async () => moved });
  expect(req.status).toBe('pending');
  const r = (req as any).request as cr.CredentialRequest;
  expect(r).toMatchObject({ target: 'shared', fields: ['password'], host: 'www.facebook.com', account: 'Your Chrome' });
  const waiting = cr.waitSettled(r.requestId, 5000);
  expect(cr.hasWaiter(r.requestId)).toBe(true);
  // the cockpit sends more than the card asked for: only the card's one field is typed
  const out = await cr.fill('sess-a', r.requestId, { username: 'me@site.example', password: SECRET });
  expect(out).toEqual({ filled: ['password'], submitted: false, origin: 'https://www.facebook.com' });
  expect(typed).toEqual([SECRET]);
  expect(await waiting).toBe('filled');
  // a second card; the page moves before the keys go out → nothing typed, the waiter hears "cancel"
  const req2 = (cr.requestShared('sess-a', { origin: 'https://www.facebook.com', field: 'username', recheck: async () => moved }) as any).request;
  const w2 = cr.waitSettled(req2.requestId, 5000);
  moved = 'the page moved to evil.example';
  await expect(cr.fill('sess-a', req2.requestId, { username: 'me@site.example' })).rejects.toThrow(/nothing was typed: the page moved/);
  expect(typed).toHaveLength(1);
  expect(await w2).toBe('cancel');
  // a card for another session's request id is not this session's to fill
  const req3 = (cr.requestShared('sess-b', { origin: 'https://www.facebook.com', field: 'otp', recheck: async () => null }) as any).request;
  await expect(cr.fill('sess-a', req3.requestId, { otp: '123456' })).rejects.toThrow(/no longer open/);
  cr.forgetSession('sess-b');
});

test('vault fill gating: "always type it myself" for a site skips the card; Google is not refused in the owner Chrome', () => {
  cr.setPref('https://manual.example', 'manual');
  expect(cr.requestShared('sess-c', { origin: 'https://manual.example', field: 'password', recheck: async () => null }).status).toBe('manual');
  cr.setPref('https://manual.example', null);
  expect(cr.requestShared('sess-c', { origin: 'https://accounts.google.com', field: 'password', recheck: async () => null }).status).toBe('pending');
  cr.forgetSession('sess-c');
});

test('never a secret in a result, a log line or an argv', async () => {
  const lines: string[] = [];
  const orig = { log: console.log, error: console.error, warn: console.warn };
  for (const k of ['log', 'error', 'warn'] as const) (console as any)[k] = (...a: unknown[]) => lines.push(a.map(String).join(' '));
  try {
    cr._setSharedTyper(async () => ({ ok: false, error: 'the value has a character that cannot be typed here (printable ASCII only)' }));
    const r = (cr.requestShared('sess-d', { origin: 'https://www.facebook.com', field: 'password', recheck: async () => null }) as any).request;
    let err = '';
    try { await cr.fill('sess-d', r.requestId, { password: SECRET }); } catch (e) { err = String((e as Error).message); }
    expect(err).toMatch(/typing on the shared desktop failed/);
    expect(err).not.toContain(SECRET);
    expect(JSON.stringify(r)).not.toContain(SECRET);
    cr.forgetSession('sess-d');
  } finally {
    Object.assign(console, orig);
  }
  expect(lines.join('\n')).not.toContain(SECRET);
  // the keys: xinput.py gets the value on stdin, never in argv (argv shows in `ps`); its errors never name a character
  const dc = read('server/lib/desktop-control.ts');
  expect(dc).toContain("spawn('python3', [XINPUT, 'type-secret']");
  expect(dc).toContain('p.stdin.end(value)');
  const xi = read('skills/_lib/xinput.py');
  const ts = xi.slice(xi.indexOf('def type_secret'), xi.indexOf('def main'));
  expect(ts).not.toMatch(/die\(f'/); // no f-string error that could carry a character
  // the sign_in route never puts a value in what it says: no `values` in any template of the sign-in section
  const api = read('server/api.ts');
  const sec = api.slice(api.indexOf('// ---- sign_in (lib/sign-in.ts)'), api.indexOf('// Outbound cards (lib/outbound.ts)'));
  expect(sec.length).toBeGreaterThan(1000);
  expect(sec).not.toMatch(/\$\{[^}]*(values|password|secret)[^}]*\}/i);
});

test('the internal login tools are not listed to the model, and refuse a call with "use sign_in"', () => {
  const mcp = read('mcp/host-mcp.js');
  const set = /LOGIN_INTERNAL = new Set\(\[(.*)\]\);/.exec(mcp)![1];
  for (const t of ['browser_logins', 'request_login', 'request_credentials', 'sso_login', 'sso_look', 'sso_click', 'sso_navigate', 'sso_done', 'save_login']) expect(set).toContain(`'${t}'`);
  expect(set).toContain("env.ARIGAMI_AGENT ? [] : ['save_browser_logins']"); // an agent keeps its own identity
  expect(mcp).toContain('is internal to sign_in now');
});

// ---- the lease: sign_in waits for its turn itself -----------------------------------------------------------------------

test('lease: a host-side waiter (sign_in) is woken directly, not messaged "[host] Your turn"', async () => {
  let t = 0;
  const notes: string[] = [];
  const L = new SharedDesktopLease({ now: () => t, notify: (id, text) => notes.push(`${id}:${text.slice(0, 20)}`), waitingOnHuman: () => false });
  expect(L.acquire('a', 'x.com')).toMatchObject({ granted: true });
  expect(L.acquire('b', 'facebook.com')).toMatchObject({ queued: true, position: 1 });
  const woke = L.waitForGrant('b', 10_000);
  L.release('a');
  expect(await woke).toBe(true);
  expect(L.holder?.sessionId).toBe('b');
  expect(notes).toEqual([]);
  expect(await L.waitForGrant('b', 10)).toBe(true); // already the holder
  expect(L.acquire('c', 'y.com')).toMatchObject({ queued: true });
  expect(await L.waitForGrant('c', 20)).toBe(false); // timed out, still queued, nobody messaged
});

// ---- TOTP ---------------------------------------------------------------------------------------------------------------

test('TOTP (RFC 6238 test vectors) and the two ways an entry holds its secret', async () => {
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // "12345678901234567890"
  expect(new TextDecoder().decode(base32Decode(secret))).toBe('12345678901234567890');
  const spec = { secret, digits: 8, period: 30, algorithm: 'SHA1' };
  expect(await totp(spec, 59_000)).toBe('94287082');
  expect(await totp(spec, 1111111109_000)).toBe('07081804');
  expect(await totp(spec, 20000000000_000)).toBe('65353130');
  expect(totpSpec({ otp: `otpauth://totp/x:me?secret=${secret}&digits=8&period=30` })).toMatchObject({ secret, digits: 8, period: 30 });
  expect(totpSpec({ 'TOTP Seed': secret, 'TOTP Settings': '30;6' })).toMatchObject({ secret, digits: 6, period: 30 });
  expect(totpSpec({ Password: 'x' })).toBe(null);
  expect((await totp({ secret, digits: 6, period: 30, algorithm: 'SHA1' }, 59_000))).toBe('287082');
});
