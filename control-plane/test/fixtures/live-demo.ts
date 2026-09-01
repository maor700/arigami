// One-off script to capture human-readable evidence for docs/CONTROL-PLANE.md
// "Proof on k3d" — drives the REAL provisioner.ts functions (not raw
// kubectl/helm reimplemented) against a live k3d cluster, printing kubectl
// output at each step. Not part of the test suite; run manually, then the
// containing cluster/images are torn down by hand same as any other k3d run.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../src/config.js';
import { openDb, createStore } from '../../src/db.js';
import { provisionTenant, deleteTenant, fullname } from '../../src/provisioner.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

async function sh(cmd: string[]): Promise<string> {
  const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) console.error(`$ ${cmd.join(' ')}\n(exit ${code}) ${err}`);
  return out.trim();
}
async function show(label: string, cmd: string[]) {
  console.log(`\n$ ${cmd.join(' ')}`);
  console.log(await sh(cmd));
}

const cfg = loadConfig({
  CP_PUBLIC_URL: 'http://localhost:8090',
  CP_ORG_DOMAIN: 'localtest.me',
  CP_URL_SCHEME: 'http',
  ALLOWED_EMAIL_DOMAINS: 'example.com',
  CP_IMAGE_REPOSITORY: 'arigami-cp-stub',
  CP_IMAGE_TAG: 'k8s2',
  CP_HELM_CHART_PATH: path.resolve(HERE, '..', '..', '..', 'deploy', 'helm', 'arigami-tenant'),
  CP_HELM_EXTRA_VALUES: path.join(HERE, 'cp-stub-values.yaml'),
  CP_HELM_TIMEOUT_SEC: '120',
} as unknown as NodeJS.ProcessEnv);

const store = createStore(openDb(':memory:'));
const tenantA = store.createTenant('subject-a', 'alice@example.com', { desiredDigest: 'k8s2' });
const tenantB = store.createTenant('subject-b', 'bob@example.com', { desiredDigest: 'k8s2' });

console.log(`tenant A: ${tenantA.ns} (release ${tenantA.release})`);
console.log(`tenant B: ${tenantB.ns} (release ${tenantB.release})`);

console.log('\n=== provisionTenant(A) ===');
console.log(await provisionTenant(cfg, tenantA));
console.log('\n=== provisionTenant(B) ===');
console.log(await provisionTenant(cfg, tenantB));

await show('objects in A', ['kubectl', '-n', tenantA.ns, 'get', 'all,pvc,resourcequota,networkpolicy']);
await show('objects in B', ['kubectl', '-n', tenantB.ns, 'get', 'all,pvc,resourcequota,networkpolicy']);

const ipB = await sh(['kubectl', '-n', tenantB.ns, 'get', 'pod', `${fullname(tenantB.ns)}-0`, '-o', 'jsonpath={.status.podIP}']);
console.log(`\n=== isolation probe: A -> B (${ipB}), expect BLOCKED ===`);
await show('cross-tenant probe', ['kubectl', '-n', tenantA.ns, 'exec', `${fullname(tenantA.ns)}-0`, '--', 'wget', '-qO-', '-T', '5', `http://${ipB}:3099/__health`]);

console.log('\n=== deleteTenant(A) ===');
await deleteTenant(cfg, tenantA);
await show('namespace A after delete (expect NotFound)', ['kubectl', 'get', 'namespace', tenantA.ns]);
await show('tenant B pod after A deleted (expect Running, untouched)', ['kubectl', '-n', tenantB.ns, 'get', 'pod', `${fullname(tenantB.ns)}-0`]);

console.log('\ndone.');
