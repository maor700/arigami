// Live integration proof against a REAL (disposable) k3d cluster — exercises
// src/provisioner.ts's actual helm/kubectl commands, not a mock. Slow and
// requires docker + k3d/kubectl/helm on PATH, so it's OFF by default:
//
//   RUN_K3D_TESTS=1 bun test test/provisioner.k3d.test.ts
//
// What this proves live: two tenants provisioned into separate namespaces,
// cross-tenant NetworkPolicy isolation holds, deleting one tenant's
// namespace does not touch the other's pod/PVC data. See
// docs/CONTROL-PLANE.md "Proof on k3d" for the captured run this produced.
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, type Config } from '../src/config.js';
import { openDb, createStore, type Store, type Tenant } from '../src/db.js';
import { provisionTenant, deleteTenant, tenantUrl, fullname } from '../src/provisioner.js';

// StatefulSet/pod name is `arigami-<tenant.id>` (chart's fullname helper) —
// NOT `<helm release name>-0`. See provisioner.ts `fullname()` doc comment.
const podName = (ns: string) => `${fullname(ns)}-0`;

const RUN = process.env.RUN_K3D_TESTS === '1';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLUSTER = 'arigami-cp-k8s2';
const STUB_IMAGE = 'arigami-cp-stub:k8s2';

async function sh(cmd: string[], opts: { timeoutMs?: number; allowFail?: boolean } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' });
  const timer = opts.timeoutMs
    ? setTimeout(() => {
        try {
          proc.kill();
        } catch {}
      }, opts.timeoutMs)
    : null;
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (timer) clearTimeout(timer);
  if (code !== 0 && !opts.allowFail) throw new Error(`${cmd.join(' ')} failed (${code}): ${stderr}`);
  return { code, stdout, stderr };
}

async function freeMb(): Promise<string> {
  const r = await sh(['free', '-m'], { allowFail: true });
  return r.stdout.split('\n')[1] || '';
}

describe('provisioner on a live k3d cluster', () => {
  if (!RUN) {
    test.skip('set RUN_K3D_TESTS=1 to run the live k3d integration proof', () => {});
    return;
  }

  let cfg: Config;
  let store: Store;
  let tenantA: Tenant;
  let tenantB: Tenant;

  beforeAll(async () => {
    console.log('[k3d-test] free before anything:', await freeMb());

    await sh(
      [
        'k3d', 'cluster', 'create', CLUSTER,
        '--servers', '1', '--agents', '0', '--no-lb',
        '--k3s-arg', '--disable=metrics-server@server:0',
        '--k3s-arg', '--disable=servicelb@server:0',
        '--wait', '--timeout', '180s',
      ],
      { timeoutMs: 200_000 },
    );
    console.log('[k3d-test] free after cluster create:', await freeMb());

    await sh(['docker', 'build', '-t', STUB_IMAGE, '-f', path.join(HERE, 'fixtures', 'stub.Dockerfile'), path.join(HERE, 'fixtures')]);
    await sh(['k3d', 'image', 'import', STUB_IMAGE, '-c', CLUSTER], { timeoutMs: 60_000 });
    console.log('[k3d-test] free after stub image built+imported:', await freeMb());

    cfg = loadConfig({
      CP_PUBLIC_URL: 'http://localhost:8090',
      CP_ORG_DOMAIN: 'localtest.me',
      CP_URL_SCHEME: 'http',
      ALLOWED_EMAIL_DOMAINS: 'example.com',
      CP_IMAGE_REPOSITORY: 'arigami-cp-stub',
      CP_IMAGE_TAG: 'k8s2',
      CP_HELM_CHART_PATH: path.resolve(HERE, '..', '..', 'deploy', 'helm', 'arigami-tenant'),
      CP_HELM_EXTRA_VALUES: path.join(HERE, 'fixtures', 'cp-stub-values.yaml'),
      CP_HELM_TIMEOUT_SEC: '120',
    } as unknown as NodeJS.ProcessEnv);

    store = createStore(openDb(':memory:'));
    tenantA = store.createTenant('subject-a', 'alice@example.com', { desiredDigest: 'k8s2' });
    tenantB = store.createTenant('subject-b', 'bob@example.com', { desiredDigest: 'k8s2' });
  }, 240_000);

  afterAll(async () => {
    await sh(['k3d', 'cluster', 'delete', CLUSTER], { allowFail: true, timeoutMs: 60_000 });
    await sh(['docker', 'rmi', '-f', STUB_IMAGE], { allowFail: true });
    for (const img of ['rancher/k3s', 'ghcr.io/k3d-io/k3d-tools', 'ghcr.io/k3d-io/k3d-proxy']) {
      const r = await sh(['docker', 'images', '-q', img], { allowFail: true });
      for (const id of r.stdout.split('\n').map((s) => s.trim()).filter(Boolean)) {
        await sh(['docker', 'rmi', '-f', id], { allowFail: true });
      }
    }
    const ps = await sh(['docker', 'ps', '-aq'], { allowFail: true });
    console.log('[k3d-test] docker ps -a after teardown (should be empty):', JSON.stringify(ps.stdout));
    console.log('[k3d-test] free after teardown:', await freeMb());
  }, 90_000);

  test('provisions two tenants into separate, running namespaces', async () => {
    // allSettled, not all: a plain Promise.all would fail-fast on the first
    // rejection and return control to the test while the OTHER tenant's
    // `helm upgrade --install` child process is still running in the
    // background (Bun.spawn isn't cancelled just because nobody's awaiting
    // it anymore) — the next test would then race a second helm operation
    // against that same still-locked release. Waiting for both to fully
    // settle here avoids leaking a dangling helm process into later tests.
    const [ra, rb] = await Promise.allSettled([provisionTenant(cfg, tenantA), provisionTenant(cfg, tenantB)]);
    if (ra.status === 'rejected') throw ra.reason;
    if (rb.status === 'rejected') throw rb.reason;
    expect(ra.value.url).toBe(tenantUrl(cfg, tenantA.ns));
    expect(rb.value.url).toBe(tenantUrl(cfg, tenantB.ns));

    const podA = await sh(['kubectl', '-n', tenantA.ns, 'get', 'pod', podName(tenantA.ns), '-o', 'jsonpath={.status.phase}']);
    const podB = await sh(['kubectl', '-n', tenantB.ns, 'get', 'pod', podName(tenantB.ns), '-o', 'jsonpath={.status.phase}']);
    expect(podA.stdout).toBe('Running');
    expect(podB.stdout).toBe('Running');
    expect(tenantA.ns).not.toBe(tenantB.ns);
  }, 180_000);

  test('re-provisioning the same tenant is idempotent — no duplicate pod, same PVC', async () => {
    const pvcBefore = await sh(['kubectl', '-n', tenantA.ns, 'get', 'pvc', '-o', 'jsonpath={.items[0].metadata.name}']);
    await provisionTenant(cfg, tenantA);
    const pods = await sh(['kubectl', '-n', tenantA.ns, 'get', 'pods', '-o', 'jsonpath={.items[*].metadata.name}']);
    const pvcAfter = await sh(['kubectl', '-n', tenantA.ns, 'get', 'pvc', '-o', 'jsonpath={.items[0].metadata.name}']);
    expect(pods.stdout.trim().split(/\s+/)).toEqual([podName(tenantA.ns)]); // still exactly one pod
    expect(pvcAfter.stdout).toBe(pvcBefore.stdout);
  }, 180_000);

  test('cross-tenant NetworkPolicy blocks A from reaching B; same-namespace still works', async () => {
    const podIpB = (await sh(['kubectl', '-n', tenantB.ns, 'get', 'pod', podName(tenantB.ns), '-o', 'jsonpath={.status.podIP}'])).stdout;
    const podIpA = (await sh(['kubectl', '-n', tenantA.ns, 'get', 'pod', podName(tenantA.ns), '-o', 'jsonpath={.status.podIP}'])).stdout;

    // A → B: a DIFFERENT tenant namespace. Must be blocked.
    const crossNs = await sh(
      ['kubectl', '-n', tenantA.ns, 'exec', podName(tenantA.ns), '--', 'wget', '-qO-', '-T', '5', `http://${podIpB}:3099/__health`],
      { allowFail: true },
    );
    expect(crossNs.code).not.toBe(0);

    // A → A: same namespace. Must still work (proves the policy discriminates, isn't a blanket deny).
    const sameNs = await sh(['kubectl', '-n', tenantA.ns, 'exec', podName(tenantA.ns), '--', 'wget', '-qO-', '-T', '5', `http://${podIpA}:3099/__health`]);
    expect(sameNs.stdout).toContain('"ok":true');
  }, 60_000);

  test('deleting tenant A removes its namespace and leaves tenant B untouched', async () => {
    await deleteTenant(cfg, tenantA);

    const nsA = await sh(['kubectl', 'get', 'namespace', tenantA.ns], { allowFail: true });
    expect(nsA.code).not.toBe(0); // gone

    const podB = await sh(['kubectl', '-n', tenantB.ns, 'get', 'pod', podName(tenantB.ns), '-o', 'jsonpath={.status.phase}']);
    expect(podB.stdout).toBe('Running');
    const health = await sh(['kubectl', '-n', tenantB.ns, 'exec', podName(tenantB.ns), '--', 'wget', '-qO-', 'http://127.0.0.1:3099/__health']);
    expect(health.stdout).toContain('"ok":true');
  }, 120_000);
});
