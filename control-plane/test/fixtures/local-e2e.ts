// The whole signup experience, end to end, WITHOUT Kubernetes.
//
// Everything a user touches is the real thing: the real OIDC round-trip
// (test/fixtures/mock-idp.ts, full PKCE + RS256 validation), the real
// control-plane app (src/server.ts createApp), the real waiting page and its
// progress logic, the real handoff mint → the real `server/handoff.ts`
// verification → a real session cookie in a real Arigami host. The ONLY thing
// simulated is Kubernetes itself — a fake provisioner and a scripted pod
// snapshot — because that is the part that costs a cluster and ~300MB of RAM,
// and it is also the part K8S-3's live k3d run already proved.
//
// So this exercises exactly the two things the live run did NOT: what the wait
// looks like, and whether the user lands signed in.
//
//   bun test/fixtures/local-e2e.ts
//   → prints ONE url to open; Ctrl-C tears everything down.
//
// Costs roughly 200MB (two bun processes, no desktop, no container). Check
// `free -m` first: this repo's rule is to stay well clear of ~400MB available.
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../src/config.js';
import { openDb, createStore, type Store, type Tenant } from '../../src/db.js';
import { createApp, type Provisioner, type AdminOps } from '../../src/server.js';
import { EMPTY_SNAPSHOT, type PodSnapshot } from '../../src/progress.js';

const CP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const REPO_ROOT = path.resolve(CP_ROOT, '..');
const HANDOFF_SECRET = crypto.randomBytes(32).toString('base64url');
/** How long the fake "provision" takes — long enough to watch the steps move. */
const PROVISION_MS = 18_000;

const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(url: string, ms = 30_000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(1500) })).ok) return;
    } catch {}
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${url}`);
}

const children: ChildProcess[] = [];
const tmpDirs: string[] = [];
function cleanup(): void {
  for (const c of children) { try { c.kill('SIGTERM'); } catch {} }
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
}
process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });
process.on('exit', cleanup);

const idpPort = await freePort();
const hostPort = await freePort();
const cpPort = await freePort();

// 1. the IdP
children.push(spawn('bun', ['test/fixtures/mock-idp.ts', String(idpPort)], { cwd: CP_ROOT, stdio: ['ignore', 'ignore', 'inherit'] }));
await waitFor(`http://127.0.0.1:${idpPort}/.well-known/openid-configuration`);

// 2. the "tenant": a real Arigami host holding the handoff secret. No desktop,
//    throwaway dir — this is the process a pod would be running.
const hostDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-e2e-tenant-'));
tmpDirs.push(hostDir);
fs.mkdirSync(path.join(hostDir, 'home'), { recursive: true });
children.push(
  spawn('bun', ['server/index.ts'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: path.join(hostDir, 'home'),
      ARIGAMI_DIR: hostDir,
      ARIGAMI_PORT: String(hostPort),
      ARIGAMI_AUTH: 'pairing', // exactly what a tenant runs — the handoff must beat this
      ARIGAMI_HANDOFF_SECRET: HANDOFF_SECRET,
      ARIGAMI_SCREEN_ENABLED: '0',
      ARIGAMI_TELEMETRY: '0',
      ARIGAMI_DEFAULT_CWD: path.join(hostDir, 'workspace'),
      COMPOSIO_API_KEY: '',
      GH_TOKEN: '',
      GITHUB_TOKEN: '',
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  }),
);
await waitFor(`http://127.0.0.1:${hostPort}/__health`);

// 3. the control-plane, real app. `localtest.me` resolves every subdomain to
//    127.0.0.1, so the REAL tenantUrl code path (u-<id>.<domain>) lands on the
//    host above with no special-casing anywhere in src/.
const cfg = {
  ...loadConfig({
    CP_PORT: String(cpPort),
    CP_PUBLIC_URL: `http://127.0.0.1:${cpPort}`,
    CP_OIDC_ISSUER: `http://127.0.0.1:${idpPort}`,
    CP_OIDC_CLIENT_ID: 'arigami-local-e2e',
    CP_OIDC_CLIENT_SECRET: 'local-e2e',
    ALLOWED_EMAIL_DOMAINS: 'fake-org.test',
    CP_ORG_DOMAIN: `localtest.me:${hostPort}`,
    CP_ORG_NAME: 'Fake Org',
    CP_URL_SCHEME: 'http',
    CP_IMAGE_TAG: 'local-e2e',
    CP_RECONCILE_SEC: '0',
    CP_BACKUP_INTERVAL_SEC: '0',
  } as unknown as NodeJS.ProcessEnv),
};

const base = createStore(openDb(':memory:'));
// Every tenant in this run is the one host we started, so it must carry that
// host's secret rather than a fresh random one.
const store: Store = {
  ...base,
  createTenant: (subject, email, opts) => base.createTenant(subject, email, { ...opts, handoffSecret: HANDOFF_SECRET }),
};

const startedAt = new Map<string, number>();
const provisioner: Provisioner = {
  async provisionTenant(_c, t: Tenant) {
    startedAt.set(t.ns, Date.now());
    await sleep(PROVISION_MS);
    return { url: `http://${t.ns}.localtest.me:${hostPort}` };
  },
  async deleteTenant() {},
  async suspendTenant() {},
  async resumeTenant() {},
};

// The scripted pod: the same states `podSnapshot` reads off a real pod, on the
// timeline a real first boot follows (pull → boot → bundle → ready).
const adminOps: AdminOps = {
  async backupTenant() { return { name: 'not-in-this-fixture.tgz', bytes: 0 }; },
  listBackups: () => [],
  async podSnapshot(_c, t): Promise<PodSnapshot> {
    const t0 = startedAt.get(t.ns);
    if (!t0) return { ...EMPTY_SNAPSHOT };
    const e = Date.now() - t0;
    if (e < 3000) return { ...EMPTY_SNAPSHOT };
    if (e < 9000) return { ...EMPTY_SNAPSHOT, exists: true, phase: 'Pending', waitingReason: 'ContainerCreating' };
    if (e < 15000) return { ...EMPTY_SNAPSHOT, exists: true, phase: 'Running' };
    return { ...EMPTY_SNAPSHOT, exists: true, phase: 'Running', bundleApplied: true };
  },
};

const app = createApp(cfg, store, provisioner, (m) => console.log(m), adminOps);
Bun.serve({ port: cpPort, hostname: '127.0.0.1', idleTimeout: 60, fetch: app.handle });

const startUrl = `http://127.0.0.1:${cpPort}/`;
console.log(`
─────────────────────────────────────────────────────────────
  START HERE:  ${startUrl}

  1. "Sign in"  → the mock IdP signs you in. Append
     &email=you@fake-org.test to its URL to choose who you are;
     the default is user@fake-org.test.
  2. Watch the steps move for ~${PROVISION_MS / 1000}s (real page, real logic,
     simulated pod).
  3. You land INSIDE a real Arigami cockpit, signed in — no
     pairing code. That is the thing being tested.

  Tenant host : http://127.0.0.1:${hostPort}/__host/   (pairing-gated; the
                handoff is what gets you past it)
  Mock IdP    : http://127.0.0.1:${idpPort}
  NOT real    : Kubernetes. Everything else is production code.

  Ctrl-C tears it all down.
─────────────────────────────────────────────────────────────
`);
