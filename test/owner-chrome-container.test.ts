// The owner's everyday Chrome in a CONTAINER (a Docker host, a Kubernetes tenant):
//   - a container with its own shared desktop (screen on, display up) has one — the desktop's Chrome, on the default
//     user-data dir, the one its dock icon opens — so sign_in's new sign-in is not `blocked` there, with no config
//   - a container without a desktop still has none; config / env still win; ARIGAMI_OWNER_CHROME=0 still turns it off
//   - a brand-new container gets its profile seeded before the first sign-in
//   - it starts at all: `--no-sandbox` in a container (and only that), still the owner's Chrome to the fill guard
//   - My browser and the sessions' own Chromes are never it; a Linux machine behaves exactly as before
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runInChild } from './_child.js';
import * as si from '../server/lib/sign-in.ts';
import { resolveOwnerProfile, shouldSeedOwnerChrome, containerHasDesktop, ownerChromeLaunchFlags, ownsSharedDesktop, OWNER_CHROME_FLAGS } from '../server/lib/owner-chrome.ts';
import { tmpDir } from './_tmp.js';

/** A user-data dir as Chrome leaves it: Local State naming the last profile, and that profile's Cookies file. */
function fakeChrome(ud: string, profile = 'Default'): void {
  fs.mkdirSync(path.join(ud, profile), { recursive: true });
  fs.writeFileSync(path.join(ud, 'Local State'), JSON.stringify({ profile: { last_used: profile } }));
  fs.writeFileSync(path.join(ud, profile, 'Cookies'), '');
}

function home(): { home: string; ud: string } {
  const h = tmpDir('owner-ctr-home-');
  const ud = path.join(h, '.config', 'google-chrome');
  fakeChrome(ud);
  return { home: h, ud };
}

test('resolveOwnerProfile in a container: the desktop Chrome when it has its own desktop, nothing without one', () => {
  const { home: h, ud } = home();
  const pod = { home: h, platform: 'linux' as const, inContainer: true, env: {} };
  expect(resolveOwnerProfile({ ...pod, desktop: true })).toEqual({ userDataDir: ud, profileDir: 'Default', profilePath: path.join(ud, 'Default') });
  expect(resolveOwnerProfile({ ...pod, desktop: false })).toBe(null); // screen off / display down: no everyday Chrome
  expect(resolveOwnerProfile(pod)).toBe(null); // not said = no desktop
  // a fresh container: the desktop is up but nobody opened Chrome yet → nothing (the seed opens it, below)
  expect(resolveOwnerProfile({ ...pod, home: tmpDir('owner-ctr-empty-'), desktop: true })).toBe(null);
});

test('resolveOwnerProfile in a container: config / env win, the off-switch wins over the desktop', () => {
  const { home: h, ud } = home();
  const other = path.join(tmpDir('owner-ctr-other-'), 'chrome');
  fakeChrome(other, 'Profile 2');
  const pod = { home: h, platform: 'linux' as const, inContainer: true };
  // explicit dir: used with or without a desktop, never the default one
  expect(resolveOwnerProfile({ ...pod, desktop: true, env: { ARIGAMI_OWNER_CHROME: other } })?.userDataDir).toBe(other);
  expect(resolveOwnerProfile({ ...pod, desktop: false, env: { ARIGAMI_OWNER_CHROME: other } })?.userDataDir).toBe(other);
  expect(resolveOwnerProfile({ ...pod, desktop: true, env: {}, config: { userDataDir: other } })?.profileDir).toBe('Profile 2');
  expect(resolveOwnerProfile({ ...pod, desktop: true, env: { ARIGAMI_OWNER_CHROME_PROFILE: 'Nope' } })).toBe(null); // a pinned profile that is not there
  // off
  expect(resolveOwnerProfile({ ...pod, desktop: true, env: { ARIGAMI_OWNER_CHROME: '0' } })).toBe(null);
  expect(resolveOwnerProfile({ ...pod, desktop: true, env: { ARIGAMI_OWNER_CHROME: 'false' } })).toBe(null);
  expect(resolveOwnerProfile({ ...pod, desktop: true, env: {}, config: false })).toBe(null);
  // "1" = on, the default dir
  expect(resolveOwnerProfile({ ...pod, desktop: true, env: { ARIGAMI_OWNER_CHROME: '1' } })?.userDataDir).toBe(ud);
});

test("resolveOwnerProfile: never My browser or a session's own Chrome, configured or not", () => {
  const arigami = tmpDir('owner-ctr-arigami-');
  const base = path.join(arigami, 'chrome-base');
  const sessions = path.join(arigami, 'chrome-sessions');
  const one = path.join(sessions, 'sess_x');
  fakeChrome(base);
  fakeChrome(one);
  const exclude = [base, sessions];
  for (const desktop of [true, false]) {
    expect(resolveOwnerProfile({ platform: 'linux', inContainer: true, desktop, env: { ARIGAMI_OWNER_CHROME: base }, exclude })).toBe(null);
    expect(resolveOwnerProfile({ platform: 'linux', inContainer: true, desktop, env: { ARIGAMI_OWNER_CHROME: one }, exclude })).toBe(null);
  }
  // a HOME inside the excluded tree does not slip through the default dir either
  const h = path.join(sessions, 'home');
  fakeChrome(path.join(h, '.config', 'google-chrome'));
  expect(resolveOwnerProfile({ home: h, platform: 'linux', inContainer: true, desktop: true, env: {}, exclude })).toBe(null);
  // a sibling whose name merely starts the same is not inside it
  const sib = path.join(arigami, 'chrome-base-not');
  fakeChrome(sib);
  expect(resolveOwnerProfile({ platform: 'linux', env: { ARIGAMI_OWNER_CHROME: sib }, exclude })?.userDataDir).toBe(sib);
});

test('resolveOwnerProfile on a machine: unchanged — the desktop flag means nothing outside a container', () => {
  const { home: h, ud } = home();
  for (const desktop of [undefined, true, false]) {
    expect(resolveOwnerProfile({ home: h, platform: 'linux', env: {}, desktop })?.userDataDir).toBe(ud);
    expect(resolveOwnerProfile({ home: h, platform: 'darwin', env: {}, desktop })).toBe(null);
    expect(resolveOwnerProfile({ home: h, platform: 'win32', inContainer: true, env: {}, desktop })).toBe(null);
  }
});

test('the ladder in a container: a new sign-in in the desktop Chrome with a desktop, blocked without one', () => {
  const { home: h } = home();
  const decide = (desktop: boolean) => {
    const own = resolveOwnerProfile({ home: h, platform: 'linux', inContainer: true, desktop, env: {} });
    return si.ladder({ cli: null, connection: null, saved: { present: false, policy: 'cookies', inOwnerChrome: false }, sharedChrome: !!own });
  };
  expect(decide(true)).toEqual({ rung: 'shared-chrome' });
  expect(decide(false)).toMatchObject({ rung: 'blocked', reason: expect.stringMatching(/no shared desktop/) });
});

test('shouldSeedOwnerChrome in a container: a brand-new one with a desktop gets its profile; nothing else changes', () => {
  const pod = { platform: 'linux' as const, inContainer: true, desktop: true, config: {}, env: {}, hasProfile: false, displayUp: true, chromeRunning: false };
  expect(shouldSeedOwnerChrome(pod)).toEqual({ seed: true });
  expect(shouldSeedOwnerChrome({ ...pod, desktop: false })).toMatchObject({ seed: false, why: 'no everyday Chrome on this kind of host' });
  expect(shouldSeedOwnerChrome({ ...pod, desktop: undefined })).toMatchObject({ seed: false });
  expect(shouldSeedOwnerChrome({ ...pod, hasProfile: true })).toMatchObject({ seed: false, why: 'the profile is there' });
  expect(shouldSeedOwnerChrome({ ...pod, chromeRunning: true })).toMatchObject({ seed: false });
  expect(shouldSeedOwnerChrome({ ...pod, displayUp: false })).toMatchObject({ seed: false });
  expect(shouldSeedOwnerChrome({ ...pod, env: { ARIGAMI_OWNER_CHROME: '0' } })).toMatchObject({ seed: false, why: 'owner Chrome turned off' });
  expect(shouldSeedOwnerChrome({ ...pod, config: false })).toMatchObject({ seed: false, why: 'owner Chrome turned off' });
  expect(shouldSeedOwnerChrome({ ...pod, env: { ARIGAMI_OWNER_CHROME: '/x' } })).toMatchObject({ seed: false, why: 'an explicit owner Chrome is configured' });
  expect(shouldSeedOwnerChrome({ ...pod, config: { userDataDir: '/x' } })).toMatchObject({ seed: false, why: 'an explicit owner Chrome is configured' });
  // a machine: as before, whatever `desktop` says
  const vm = { ...pod, inContainer: false };
  for (const desktop of [undefined, true, false]) {
    expect(shouldSeedOwnerChrome({ ...vm, desktop })).toEqual({ seed: true });
    expect(shouldSeedOwnerChrome({ ...vm, desktop, platform: 'darwin' })).toMatchObject({ seed: false });
  }
});

test("the seed runs on the instance the shared desktop belongs to — a container's own (ARIGAMI_DIR + opt-in) too", () => {
  // the image sets ARIGAMI_DIR (a non-default instance) and ARIGAMI_GLOBAL_DESKTOP=1: the pod's desktop is its own
  expect(ownsSharedDesktop(false, { ARIGAMI_GLOBAL_DESKTOP: '1' })).toBe(true);
  expect(ownsSharedDesktop(true, {})).toBe(true); // a machine's default instance, as before
  expect(ownsSharedDesktop(false, {})).toBe(false); // a second instance on a machine: not its desktop
  expect(ownsSharedDesktop(true, { ARIGAMI_GLOBAL_DESKTOP: '0' })).toBe(false);
  expect(ownsSharedDesktop(false, { ARIGAMI_GLOBAL_DESKTOP: '0' })).toBe(false);
  // the seed's gate is the same one the desktop starts by (desktops.ts ensureGlobalDesktop)
  const src = fs.readFileSync(path.join(import.meta.dir, '..', 'server', 'index.ts'), 'utf8');
  expect(src).toMatch(/if \(!oc\.ownsSharedDesktop\(IS_DEFAULT_INSTANCE, process\.env\)\) return;/);
  expect(src).not.toMatch(/if \(!IS_DEFAULT_INSTANCE\) return;\s*const oc = await import\('\.\/lib\/owner-chrome\.js'\)/);
});

test('containerHasDesktop: the screen on AND its display up', () => {
  const up = (p: string) => p === '/tmp/.X11-unix/X99';
  expect(containerHasDesktop({ screenEnabled: true, display: ':99', socketExists: up })).toBe(true);
  expect(containerHasDesktop({ screenEnabled: false, display: ':99', socketExists: up })).toBe(false); // ARIGAMI_SCREEN_ENABLED=0
  expect(containerHasDesktop({ screenEnabled: true, display: ':98', socketExists: up })).toBe(false); // not up (yet)
  for (const display of ['', 'host:0', ':99.0', ':x', 'wayland-0']) expect(containerHasDesktop({ screenEnabled: true, display, socketExists: () => true })).toBe(false);
});

test('ownerChromeLaunchFlags: --no-sandbox in a container and nothing else; a machine gets the flags as before', () => {
  expect(ownerChromeLaunchFlags({ KUBERNETES_SERVICE_HOST: 'kubernetes.default.svc' }, false)).toEqual([...OWNER_CHROME_FLAGS, '--no-sandbox']);
  expect(ownerChromeLaunchFlags({}, true)).toEqual([...OWNER_CHROME_FLAGS, '--no-sandbox']); // Docker
  expect(ownerChromeLaunchFlags({}, false)).toEqual(OWNER_CHROME_FLAGS); // a machine: unchanged
  expect(ownerChromeLaunchFlags({ KUBERNETES_SERVICE_HOST: 'kubernetes.default.svc', CHROME_NO_SANDBOX: '0' }, false)).toEqual(OWNER_CHROME_FLAGS);
  const pod = ownerChromeLaunchFlags({ KUBERNETES_SERVICE_HOST: 'kubernetes.default.svc' }, false);
  expect(pod.join(' ')).not.toMatch(/remote-debugging|user-data-dir|headless|disable-gpu|dev-shm/);
  // still the owner's own Chrome to the fill guard (and a DevTools one still is not)
  const def = '/data/home/.config/google-chrome';
  expect(si.isOwnerChromeCmd(['/usr/local/bin/arigami-chrome', ...pod, '--profile-directory=Default', 'https://x.example/login'], def, def)).toBe(true);
  expect(si.isOwnerChromeCmd(['/usr/local/bin/arigami-chrome', ...pod, '--remote-debugging-port=0'], def, def)).toBe(false);
});

test("gcloud's opener hands the container's launch flags to Chrome, and nothing a shell would expand", () => {
  expect(si.gcloudOpenerFlags([...OWNER_CHROME_FLAGS, '--no-sandbox'])).toBe('--password-store=basic --no-first-run --no-default-browser-check --no-sandbox');
  expect(si.gcloudOpenerFlags(['--a=$(id)', '--b=`x`', '--c *', 'plain', '--d=x;y'])).toBe('');
  const dir = tmpDir('owner-ctr-opener-');
  const opener = path.join(dir, 'open.sh');
  const fake = path.join(dir, 'chrome');
  const log = path.join(dir, 'argv');
  fs.writeFileSync(opener, si.gcloudOpenerScript(), { mode: 0o700 });
  fs.writeFileSync(fake, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > "${log}"\n`, { mode: 0o700 });
  const run = (flags: string) => {
    const r = spawnSync('sh', [opener, 'https://accounts.example/o?x=1&y=2'], { env: { PATH: process.env.PATH, ARIGAMI_SIGNIN_CHROME: fake, ARIGAMI_SIGNIN_FLAGS: flags, ARIGAMI_SIGNIN_PROFILE: 'Profile 1' } });
    expect(r.status).toBe(0);
    return fs.readFileSync(log, 'utf8').trim().split('\n');
  };
  expect(run('--no-sandbox --no-first-run')).toEqual(['--no-sandbox', '--no-first-run', '--profile-directory=Profile 1', 'https://accounts.example/o?x=1&y=2']);
  expect(run('')).toEqual(['--profile-directory=Profile 1', 'https://accounts.example/o?x=1&y=2']); // a machine, as before
});

test('ownerProfile() in a container process: off with the screen off or the display down', () => {
  const { home: h } = home();
  const arigami = tmpDir('owner-ctr-dir-');
  const probe = `const oc = await import('./server/lib/owner-chrome.ts'); emit({ p: oc.ownerProfile()?.profileDir ?? null, desktop: oc.ownerChromeDesktopHere() });`;
  const env = { HOME: h, ARIGAMI_DIR: arigami, KUBERNETES_SERVICE_HOST: 'kubernetes.default.svc', ARIGAMI_OWNER_CHROME: '', ARIGAMI_OWNER_CHROME_PROFILE: '' };
  const off = runInChild(probe, { ...env, ARIGAMI_SCREEN_ENABLED: '0', DISPLAY: ':99' });
  expect(off.out[0]).toEqual({ p: null, desktop: false });
  const down = runInChild(probe, { ...env, ARIGAMI_SCREEN_ENABLED: '1', DISPLAY: ':65533' }); // no such X server
  expect(down.out[0]).toEqual({ p: null, desktop: false });
});

// A live X server on this machine (a dev box / an Arigami host): the same container process finds the desktop Chrome.
const liveDisplay = (() => {
  try {
    return fs.readdirSync('/tmp/.X11-unix').map((f) => /^X(\d+)$/.exec(f)?.[1]).find(Boolean) ?? null;
  } catch {
    return null;
  }
})();
test.skipIf(!liveDisplay)('ownerProfile() in a container process with its display up: the desktop Chrome, no config', () => {
  const { home: h, ud } = home();
  const r = runInChild(`const oc = await import('./server/lib/owner-chrome.ts'); emit({ ud: oc.ownerProfile()?.userDataDir ?? null, desktop: oc.ownerChromeDesktopHere() });`, {
    HOME: h, ARIGAMI_DIR: tmpDir('owner-ctr-dir-'), KUBERNETES_SERVICE_HOST: 'kubernetes.default.svc', ARIGAMI_OWNER_CHROME: '', ARIGAMI_OWNER_CHROME_PROFILE: '', ARIGAMI_SCREEN_ENABLED: '1', DISPLAY: `:${liveDisplay}`,
  });
  expect(r.out[0]).toEqual({ ud, desktop: true });
});
