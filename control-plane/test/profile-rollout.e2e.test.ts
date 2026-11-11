// Profile rollout, end to end WITHOUT Kubernetes: everything is the real thing
// except kubectl itself.
//
//   real reconcile tick (src/reconcile.ts realOps, run as a child by
//   test/fixtures/reconcile-once.ts with the env contract of src/config.ts)
//     → real `git ls-remote` of a real git repo (the "org profile repo")
//     → real operator tokens (src/handoff.ts) on stdin of
//     → a FAKE kubectl (test/fixtures/fake-kubectl.sh) that runs the in-pod
//       `curl` against
//     → two REAL Arigami hosts (bun server/index.ts), each booted with
//       ARIGAMI_BUNDLE + ARIGAMI_BUNDLE_REF + its own handoff secret, like a pod
//
// It walks one profile through its life: boot → confirm (no re-apply) → a new
// version rolls out canary-first → a broken version fails on the canary, the
// other tenant is never touched and both stay healthy, the failure backs off →
// a fixed version releases the halt and everyone converges.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openDb, createStore, type Tenant } from '../src/db.js';

const CP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(CP_ROOT, '..');
const TENANT_PORT = '3099'; // the in-pod port the control-plane believes in; fake kubectl maps it per tenant

let dir: string;
let work: string;
let bare: string;
let dbPath: string;
let kubectlLog: string;
let store: ReturnType<typeof createStore>;
const hosts: ChildProcess[] = [];
const tenants: Record<'alpha' | 'beta', Tenant> = {} as any;
const homes: Record<string, string> = {};
const ports: Record<string, number> = {};
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
function publish(label: string, files: Record<string, string>): string {
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(work, rel)), { recursive: true });
    fs.writeFileSync(path.join(work, rel), body);
  }
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', label);
  git(work, 'push', '-q', bare, 'HEAD:main');
  return (commits[label] = git(work, 'rev-parse', 'HEAD'));
}
const skill = (name: string) => `---\nname: ${name}\ndescription: ${name} skill\n---\n\n# ${name}\n`;

/** A clean env for children: none of the live host's ARIGAMI_* leaks into a test host or tick. */
function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('ARIGAMI_') && !k.startsWith('CP_')) env[k] = v;
  return { ...env, ...extra };
}

/** One real reconcile tick, in a child that sees the fake kubectl first on PATH. */
function tick(): { sum: any; logs: string[] } {
  const r = spawnSync('bun', ['test/fixtures/reconcile-once.ts'], {
    cwd: CP_ROOT,
    encoding: 'utf8',
    timeout: 120_000,
    env: cleanEnv({
      PATH: `${path.join(dir, 'bin')}:${process.env.PATH}`,
      FAKE_KUBECTL_MAP: path.join(dir, 'kubectl-map'),
      FAKE_KUBECTL_LOG: kubectlLog,
      CP_DB_PATH: dbPath,
      CP_TENANT_PORT: TENANT_PORT,
      CP_RECONCILE_SEC: '0',
      CP_BACKUP_INTERVAL_SEC: '0',
      CP_IMAGE_TAG: 'img-1',
      CP_ARIGAMI_BUNDLE: bare,
      CP_ARIGAMI_BUNDLE_REF: 'main',
      CP_PROFILE_RETRY_BASE_SEC: '300',
      CP_PROFILE_RECHECK_SEC: '0',
    }),
  });
  if (r.status !== 0) throw new Error(`tick failed (${r.status}): ${r.stderr}`);
  return JSON.parse(r.stdout);
}

/** The tenant host's own provenance, read straight off its data dir. */
const provenance = (who: 'alpha' | 'beta') => JSON.parse(fs.readFileSync(path.join(homes[who], 'profile.json'), 'utf8'));
const row = (who: 'alpha' | 'beta') => store.findTenantBySubject(tenants[who].subject)!;

async function startHost(who: 'alpha' | 'beta'): Promise<void> {
  const port = await freePort();
  const adir = path.join(dir, who);
  fs.mkdirSync(path.join(adir, 'home'), { recursive: true });
  fs.mkdirSync(path.join(adir, 'workspace'), { recursive: true });
  homes[who] = path.join(adir, 'data');
  ports[who] = port;
  const h = spawn('bun', ['server/index.ts'], {
    cwd: REPO_ROOT,
    env: cleanEnv({
      NODE_ENV: 'test',
      HOME: path.join(adir, 'home'),
      ARIGAMI_DIR: homes[who],
      ARIGAMI_PORT: String(port),
      ARIGAMI_AUTH: 'pairing',
      ARIGAMI_HANDOFF_SECRET: tenants[who].handoff_secret,
      ARIGAMI_BUNDLE: bare,
      ARIGAMI_BUNDLE_REF: 'main',
      ARIGAMI_SCREEN_ENABLED: '0',
      ARIGAMI_TELEMETRY: '0',
      ARIGAMI_DEFAULT_CWD: path.join(adir, 'workspace'),
      COMPOSIO_API_KEY: '',
      GH_TOKEN: '',
      GITHUB_TOKEN: '',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  hosts.push(h);
  let err = '';
  h.stderr!.on('data', (d) => (err += d));
  const t0 = Date.now();
  for (;;) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/__health`, { signal: AbortSignal.timeout(2000) })).ok) return;
    } catch {}
    if (Date.now() - t0 > 45_000) throw new Error(`${who} host did not start: ${err.slice(-2000)}`);
    await sleep(100);
  }
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-profile-e2e-'));
  work = path.join(dir, 'work');
  bare = path.join(dir, 'org-profile.git');
  dbPath = path.join(dir, 'cp.db');
  kubectlLog = path.join(dir, 'kubectl.log');
  fs.mkdirSync(work);
  fs.mkdirSync(path.join(dir, 'bin'));
  fs.symlinkSync(path.join(CP_ROOT, 'test', 'fixtures', 'fake-kubectl.sh'), path.join(dir, 'bin', 'kubectl'));
  git(dir, 'init', '-q', '--bare', bare);
  git(work, 'init', '-q');
  publish('v1', {
    'profile.json': JSON.stringify({ name: 'org-profile', version: '1.0.0' }),
    'README.md': '# org profile\n',
    'skills/org-one/SKILL.md': skill('org-one'),
  });

  store = createStore(openDb(dbPath));
  for (const [who, ring] of [['alpha', 'stable'], ['beta', 'canary']] as const) {
    store.createUser(`sub-${who}`, `${who}@example.com`, 'user');
    store.createTenant(`sub-${who}`, `${who}@example.com`, { desiredDigest: 'img-1', ring });
    store.setRunningDigest(`sub-${who}`, 'img-1');
    store.setTenantState(`sub-${who}`, 'running');
    tenants[who] = store.findTenantBySubject(`sub-${who}`)!;
  }
  await Promise.all([startHost('alpha'), startHost('beta')]);
  fs.writeFileSync(path.join(dir, 'kubectl-map'), `${tenants.alpha.ns}=${ports.alpha}\n${tenants.beta.ns}=${ports.beta}\n`);
}, 90_000);

afterAll(() => {
  for (const h of hosts) {
    try {
      h.kill('SIGTERM');
    } catch {}
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('boot: both tenants applied v1 themselves; the first tick confirms it without re-applying', () => {
  expect(provenance('alpha').commit).toBe(commits.v1);
  expect(provenance('beta').commit).toBe(commits.v1);
  const { sum } = tick();
  expect(sum.profile.commit).toBe(commits.v1);
  expect(sum.profile.confirmed.sort()).toEqual([tenants.alpha.ns, tenants.beta.ns].sort());
  expect(sum.profile.applied).toEqual([]);
  expect(row('alpha').profile_commit).toBe(commits.v1);
  expect(row('beta').profile_commit).toBe(commits.v1);
  expect(provenance('alpha').history).toEqual([]); // nothing was re-applied
}, 60_000);

test('a new version rolls out canary first, as TRUSTED (its extension installs), and is read back', () => {
  publish('v2', {
    'profile.json': JSON.stringify({ name: 'org-profile', version: '2.0.0' }),
    'skills/org-two/SKILL.md': skill('org-two'),
    'extensions/org-tab/manifest.json': JSON.stringify({ name: 'org-tab', version: '1.0.0', apiVersion: 1, description: 'org tab' }),
    'extensions/org-tab/README.md': 'v2',
  });
  const { sum, logs } = tick();
  expect(sum.profile.applied).toEqual([tenants.beta.ns, tenants.alpha.ns]); // canary ring first
  expect(logs.findIndex((l) => l.includes(tenants.beta.ns))).toBeLessThan(logs.findIndex((l) => l.includes(tenants.alpha.ns)));
  for (const who of ['alpha', 'beta'] as const) {
    const p = provenance(who);
    expect(p.commit).toBe(commits.v2);
    expect(p.ref).toBe('main');
    expect(p.version).toBe('2.0.0');
    expect(p.extensions).toEqual([{ name: 'org-tab', status: 'installed' }]);
    expect(p.skills.find((s: any) => s.name === 'org-two').status).toBe('applied');
    expect(row(who).profile_commit).toBe(commits.v2);
  }
}, 60_000);

test('the operator token never appears in kubectl argv (it rides on stdin)', () => {
  const argv = fs.readFileSync(kubectlLog, 'utf8');
  expect(argv).toContain('exec -i');
  expect(argv).toContain('-H @-');
  expect(argv).not.toMatch(/x-arigami-operator/i);
  for (const who of ['alpha', 'beta'] as const) expect(argv).not.toContain(tenants[who].handoff_secret);
});

test('a broken version fails on the canary, the other tenant is never touched, both stay healthy', async () => {
  publish('v3-bad', { 'profile.json': JSON.stringify({ name: 'Not A Valid Name', version: '3.0.0' }) });
  fs.writeFileSync(kubectlLog, '');
  const { sum } = tick();
  expect(sum.profile.failed).toEqual([tenants.beta.ns]);
  expect(sum.profile.halted).toBe(tenants.beta.ns);
  expect(sum.profile.applied).toEqual([]);
  // alpha was not even asked
  expect(fs.readFileSync(kubectlLog, 'utf8')).not.toContain(tenants.alpha.ns);
  const beta = row('beta');
  expect(beta.profile_commit).toBe(commits.v2);
  expect(beta.profile_failed_commit).toBe(commits['v3-bad']);
  expect(beta.profile_failures).toBe(1);
  expect(beta.profile_error).toMatch(/invalid bundle/);
  expect(beta.profile_next_at).toBeGreaterThan(Date.now() + 200_000);
  for (const who of ['alpha', 'beta'] as const) {
    expect(provenance(who).commit).toBe(commits.v2);
    expect((await fetch(`http://127.0.0.1:${ports[who]}/__health`)).ok).toBe(true);
  }

  // next tick, inside the backoff: nobody is touched
  fs.writeFileSync(kubectlLog, '');
  const again = tick();
  expect(again.sum.profile.halted).toBe(tenants.beta.ns);
  expect(again.sum.profile.failed).toEqual([]);
  expect(fs.readFileSync(kubectlLog, 'utf8')).toBe('');
}, 60_000);

test('publishing a fix releases the halt and the whole fleet converges', () => {
  publish('v4', { 'profile.json': JSON.stringify({ name: 'org-profile', version: '4.0.0' }) });
  const { sum } = tick();
  expect(sum.profile.halted).toBe(null);
  expect(sum.profile.applied).toEqual([tenants.beta.ns, tenants.alpha.ns]);
  for (const who of ['alpha', 'beta'] as const) {
    expect(provenance(who).commit).toBe(commits.v4);
    expect(row(who)).toMatchObject({ profile_commit: commits.v4, profile_failures: 0, profile_error: '' });
  }
  // and v4 is idempotent: the next tick is a no-op
  fs.writeFileSync(kubectlLog, '');
  const again = tick();
  expect(again.sum.profile.applied).toEqual([]);
  expect(fs.readFileSync(kubectlLog, 'utf8')).toBe('');
}, 60_000);
