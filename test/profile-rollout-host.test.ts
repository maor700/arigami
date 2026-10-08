// Profile rollout, tenant side (server/profile-rollout.ts), against an ISOLATED
// host in the auth mode a tenant runs (`pairing`), booted with ARIGAMI_BUNDLE
// pointing at a local git repo — the shape of an org tenant.
//
// What this pins:
//   - first boot honours ARIGAMI_BUNDLE_REF and records the commit in the provenance
//   - /__api/profiles/rollout opens ONLY with an operator token signed by the
//     tenant's handoff secret: no credential, a signed-in admin's cookie, a
//     sign-in (handoff) token, a token for the other action, a wrong secret,
//     a replayed apply token — all refused
//   - a valid apply re-applies the configured bundle at the signed commit as
//     TRUSTED (its extension installs — an untrusted apply would skip it) and
//     the new commit is readable back through the status call
//   - a broken profile fails the call, changes nothing, and is recorded
//   - the source is not the caller's to choose, and a busy host refuses
import { test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as ho from '../server/handoff.ts';
import { runInChild } from './_child.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = 'profile-rollout-host-secret-32ch';

let host: ChildProcess;
let dir: string;
let base: string;
let work: string;
let bare: string;
const commits: Record<string, string> = {};

const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', ['-c', 'user.email=bot@example.com', '-c', 'user.name=bot', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** Write one profile version into the work tree, commit, push; returns the commit sha. */
function publish(label: string, files: Record<string, string>): string {
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(work, rel)), { recursive: true });
    fs.writeFileSync(path.join(work, rel), body);
  }
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', label);
  git(work, 'push', '-q', bare, 'HEAD:main', '--tags');
  return (commits[label] = git(work, 'rev-parse', 'HEAD'));
}

const skill = (name: string) => `---\nname: ${name}\ndescription: ${name} skill for the rollout test\n---\n\n# ${name}\n`;
const call = (method: 'GET' | 'POST', headers: Record<string, string> = {}) =>
  fetch(base + '/__api/profiles/rollout', { method, headers, redirect: 'manual' });
const op = (action: ho.OperatorAction, claims: { ref?: string; commit?: string } = {}) => ({ 'x-arigami-operator': ho.mintOperator(SECRET, { action, ...claims }) });

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-rollout-host-'));
  work = path.join(dir, 'work');
  bare = path.join(dir, 'org-profile.git');
  fs.mkdirSync(work);
  git(dir, 'init', '-q', '--bare', bare);
  git(work, 'init', '-q');
  publish('v1', {
    'profile.json': JSON.stringify({ name: 'org-profile', version: '1.0.0' }),
    'README.md': '# org profile\n',
    'skills/org-one/SKILL.md': skill('org-one'),
  });
  git(work, 'tag', 'v1');
  git(work, 'push', '-q', bare, '--tags');
  publish('v2-unpinned', { 'skills/org-later/SKILL.md': skill('org-later') }); // main moves past v1

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(dir, 'workspace'), { recursive: true });
  const adir = path.join(dir, 'arigami');
  host = spawn('bun', ['server/index.ts'], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOME: home,
      ARIGAMI_DIR: adir,
      ARIGAMI_PORT: String(port),
      ARIGAMI_AUTH: 'pairing',
      ARIGAMI_HANDOFF_SECRET: SECRET,
      ARIGAMI_BUNDLE: bare,
      ARIGAMI_BUNDLE_REF: 'v1',
      ARIGAMI_SCREEN_ENABLED: '0',
      ARIGAMI_TELEMETRY: '0',
      ARIGAMI_DEFAULT_CWD: path.join(dir, 'workspace'),
      COMPOSIO_API_KEY: '',
      GH_TOKEN: '',
      GITHUB_TOKEN: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let err = '';
  host.stderr!.on('data', (d) => (err += d));
  const t0 = Date.now();
  for (;;) {
    try {
      if ((await fetch(base + '/__health', { signal: AbortSignal.timeout(2000) })).ok) break;
    } catch {}
    if (Date.now() - t0 > 40_000) throw new Error('host did not start: ' + err.slice(-2000));
    await sleep(100);
  }
}, 60_000);

afterAll(() => {
  try {
    host?.kill('SIGTERM');
  } catch {}
  fs.rmSync(dir, { recursive: true, force: true });
});

test('first boot applied ARIGAMI_BUNDLE at ARIGAMI_BUNDLE_REF and recorded the commit', async () => {
  const r = await call('GET', op('profile-status'));
  expect(r.status).toBe(200);
  const s = await r.json();
  expect(s.configured).toBe(true);
  expect(s.current.name).toBe('org-profile');
  expect(s.current.ref).toBe('v1');
  expect(s.current.commit).toBe(commits.v1); // the tag, not main's newer tip
  expect(s.busySessions).toBe(0);
});

test('no credential, or an admin cookie, does not open the rollout routes', async () => {
  expect((await call('GET')).status).toBe(401);
  expect((await call('POST')).status).toBe(401);
  // A real signed-in admin of this tenant (the user the control-plane hands off) is still not the org operator.
  const signIn = await fetch(`${base}/__api/auth/handoff?t=${encodeURIComponent(ho.mint(SECRET, 'alice@example.com'))}`, { redirect: 'manual' });
  const cookie = (signIn.headers.get('set-cookie') || '').split(';')[0];
  expect(cookie).toMatch(/arigami_sid=/);
  expect((await fetch(base + '/__api/sessions', { headers: { cookie } })).status).toBe(200); // the cookie works…
  expect((await call('POST', { cookie })).status).toBe(401); // …but not here
});

test('a sign-in token, a token for the other action, or a wrong secret is refused', async () => {
  expect((await call('POST', { 'x-arigami-operator': ho.mint(SECRET, 'alice@example.com') })).status).toBe(403);
  expect((await call('POST', op('profile-status'))).status).toBe(403);
  expect((await call('GET', op('profile-apply'))).status).toBe(403);
  const forged = ho.mintOperator('a-totally-different-secret!!!!!', { action: 'profile-apply', commit: commits.v1 });
  expect((await call('POST', { 'x-arigami-operator': forged })).status).toBe(403);
  // and an operator token is not a sign-in
  const asSignIn = await fetch(`${base}/__api/auth/handoff?t=${encodeURIComponent(ho.mintOperator(SECRET, { action: 'profile-status' }))}`, { redirect: 'manual' });
  expect(asSignIn.status).toBe(403);
  expect(asSignIn.headers.get('set-cookie')).toBeNull();
});

test('a signed apply re-applies the configured bundle at that commit, TRUSTED (its extension installs)', async () => {
  const c = publish('v3', {
    'profile.json': JSON.stringify({ name: 'org-profile', version: '3.0.0' }),
    'skills/org-two/SKILL.md': skill('org-two'),
    'extensions/org-tab/manifest.json': JSON.stringify({ name: 'org-tab', version: '1.0.0', apiVersion: 1, description: 'org tab' }),
    'extensions/org-tab/README.md': 'v3',
  });
  const r = await call('POST', op('profile-apply', { ref: 'main', commit: c }));
  const body = await r.json();
  expect(r.status).toBe(200);
  expect(body.ok).toBe(true);
  expect(body.commit).toBe(c);
  expect(body.extensions).toEqual([{ name: 'org-tab', status: 'installed' }]);
  expect(body.skills.find((s: any) => s.name === 'org-two').status).toBe('applied'); // new skill, trusted → active
  const s = await (await call('GET', op('profile-status'))).json();
  expect(s.current.commit).toBe(c);
  expect(s.current.version).toBe('3.0.0');
  expect(s.lastAttempt.ok).toBe(true);
  // idempotent: the same commit again changes nothing
  const again = await (await call('POST', op('profile-apply', { ref: 'main', commit: c }))).json();
  expect(again.ok).toBe(true);
  expect(again.extensions).toEqual([{ name: 'org-tab', status: 'unchanged' }]);
}, 30_000);

test('an apply token is single-use', async () => {
  const headers = op('profile-apply', { ref: 'main', commit: commits.v3 });
  expect((await call('POST', headers)).status).toBe(200);
  const replay = await call('POST', headers);
  expect(replay.status).toBe(403);
  expect((await replay.json()).error).toMatch(/already used/);
});

test('a broken profile fails the call and leaves the tenant on what it had', async () => {
  const bad = publish('v4-bad', { 'profile.json': JSON.stringify({ name: 'Not A Valid Name', version: '4.0.0' }) });
  const r = await call('POST', op('profile-apply', { ref: 'main', commit: bad }));
  expect(r.status).toBe(422);
  expect((await r.json()).error).toMatch(/invalid bundle/);
  const s = await (await call('GET', op('profile-status'))).json();
  expect(s.current.commit).toBe(commits.v3);
  expect(s.current.version).toBe('3.0.0');
  expect(s.lastAttempt).toMatchObject({ ok: false, commit: bad });
  expect((await fetch(base + '/__health')).ok).toBe(true);
});

test('an unknown commit is a clean failure, not a crash', async () => {
  const r = await call('POST', op('profile-apply', { ref: 'main', commit: 'f'.repeat(40) }));
  expect(r.status).toBe(422);
  expect((await r.json()).ok).toBe(false);
});

test('a busy host refuses, and the source is always ARIGAMI_BUNDLE (never the caller\'s)', () => {
  const adir = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-rollout-unit-'));
  const r = runInChild(
    `const ro = await import('./server/profile-rollout.ts');
     emit(await ro.apply({ commit: '${commits.v1}' }, { busySessions: () => 2, env: { ARIGAMI_BUNDLE: '${bare}' } }));
     emit(await ro.apply({}, { busySessions: () => 0, env: {} }));
     emit(await ro.apply({ ref: 'main' }, { busySessions: () => 0, env: { ARIGAMI_BUNDLE: 'some-shipped-name' } }));`,
    { ARIGAMI_DIR: adir, ARIGAMI_PORT: '' },
  );
  fs.rmSync(adir, { recursive: true, force: true });
  expect(r.ok).toBe(true);
  const [busy, none, notGit] = r.out;
  expect(busy.status).toBe(409);
  expect(busy.body.busySessions).toBe(2);
  expect(none.status).toBe(400);
  expect(notGit.status).toBe(422);
  expect(notGit.body.error).toMatch(/not a git source/);
});
