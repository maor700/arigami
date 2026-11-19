// The tenant chart's `isolation` block, rendered with `helm template` (skipped when helm is not installed).
// Off: none of it renders. On: the gatekeeper's identities exist only in the sidecar, the host container cannot
// escalate, and the pod's only way out is its own egress proxy.
import { test, expect, describe } from 'bun:test';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const CHART = path.resolve(import.meta.dir, '..', 'deploy/helm/arigami-tenant');
const HELM = Bun.which('helm');
const BASE = ['--namespace', 'u-1234', '--set-string', 'tenant.id=1234', '--set-string', 'networkPolicy.ingressNamespaces[0]=edge'];
const ON = ['--set', 'isolation.enabled=true', '--set-string', 'isolation.gatekeeper.identitiesSecret=gk-ids', '--set-string', 'isolation.gatekeeper.config.github.repo=o/app'];

function render(extra: string[] = []): any[] {
  const r = spawnSync(HELM!, ['template', 'u-1234', CHART, ...BASE, ...extra], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return (Bun.YAML.parse(r.stdout) as any[]).filter(Boolean);
}
const find = (docs: any[], kind: string, pred: (d: any) => boolean = () => true) => docs.filter((d) => d.kind === kind && pred(d));
const sts = (docs: any[]) => find(docs, 'StatefulSet')[0];
const container = (docs: any[], name: string) => sts(docs).spec.template.spec.containers.find((c: any) => c.name === name);

describe.skipIf(!HELM)('tenant chart: isolation', () => {
  test('off (the default): no sidecar, no proxy, the usual sudo context and egress', () => {
    const d = render();
    const s = sts(d);
    expect(s.spec.template.spec.containers.map((c: any) => c.name)).toEqual(['arigami']);
    expect(s.spec.template.metadata.annotations).toBeUndefined();
    expect(container(d, 'arigami').securityContext.allowPrivilegeEscalation).toBe(true);
    expect(container(d, 'arigami').env.map((e: any) => e.name)).not.toContain('HTTPS_PROXY');
    expect(d.filter((x) => x.metadata?.namespace === 'edge')).toEqual([]);
    expect(find(d, 'PersistentVolumeClaim')).toEqual([]);
    const np = find(d, 'NetworkPolicy')[0];
    expect(JSON.stringify(np.spec.egress)).toContain('0.0.0.0/0');
  });

  test('on: the identities are mounted into the sidecar only, never into the host container or any env', () => {
    const d = render(ON);
    const s = sts(d);
    expect(s.spec.template.metadata.annotations['kubectl.kubernetes.io/default-container']).toBe('arigami');
    expect(s.spec.template.spec.containers[0].name).toBe('arigami');
    const host = container(d, 'arigami');
    const gk = container(d, 'gatekeeper');
    const vol = s.spec.template.spec.volumes.find((v: any) => v.secret?.secretName === 'gk-ids');
    expect(vol).toBeDefined();
    expect(gk.volumeMounts.find((m: any) => m.name === vol.name)).toMatchObject({ readOnly: true });
    expect((host.volumeMounts || []).some((m: any) => m.name.startsWith('gatekeeper'))).toBe(false);
    expect(JSON.stringify(host)).not.toContain('gk-ids');
    expect(JSON.stringify(host)).not.toContain('egress-auth');
    expect(host.env.find((e: any) => e.name === 'ARIGAMI_EXT_REMOTE').value).toBe('gatekeeper=http://127.0.0.1:3199');
    // the sidecar: no escalation, read-only root, the host's data only read-only
    expect(gk.securityContext).toMatchObject({ allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } });
    expect(gk.volumeMounts.find((m: any) => m.name === 'data')).toMatchObject({ readOnly: true });
    expect(gk.env.find((e: any) => e.name === 'GATEKEEPER_IDENTITIES_FILE').value).toBe('/run/gatekeeper/identities/identities.json');
    const cm = find(d, 'ConfigMap', (x) => x.metadata.name === 'arigami-1234-gatekeeper')[0];
    expect(JSON.parse(cm.data['config.json'])).toEqual({ github: { repo: 'o/app' } });
  });

  test('on: no sudo in the host container', () => {
    expect(container(render(ON), 'arigami').securityContext).toEqual({ allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } });
    // noSudo can be left off on purpose, which keeps the chart's usual context
    expect(container(render([...ON, '--set', 'isolation.noSudo=false']), 'arigami').securityContext.allowPrivilegeEscalation).toBe(true);
  });

  test('on: the pod reaches only DNS and its own proxy; the proxy is reachable only from this tenant and reaches only public 443', () => {
    const d = render(ON);
    const np = find(d, 'NetworkPolicy', (x) => !x.metadata.namespace)[0];
    const egress = JSON.stringify(np.spec.egress);
    expect(egress).not.toContain('ipBlock');
    expect(np.spec.egress.at(-1)).toEqual({
      to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'edge' } }, podSelector: { matchLabels: { 'arigami.dev/egress-proxy': '1234' } } }],
      ports: [{ protocol: 'TCP', port: 3128 }],
    });
    const host = container(d, 'arigami');
    expect(host.env.find((e: any) => e.name === 'HTTPS_PROXY').value).toBe('http://arigami-egress-1234.edge.svc.cluster.local:3128');
    const edge = d.filter((x) => x.metadata?.namespace === 'edge');
    expect(edge.map((x) => `${x.kind}/${x.metadata.name}`).sort()).toEqual(['ConfigMap/arigami-egress-1234', 'Deployment/arigami-egress-1234', 'NetworkPolicy/arigami-egress-1234', 'Secret/arigami-egress-1234', 'Service/arigami-egress-1234']);
    const pnp = edge.find((x) => x.kind === 'NetworkPolicy');
    expect(pnp.spec.podSelector.matchLabels).toEqual({ 'arigami.dev/egress-proxy': '1234' }); // only the proxy pods
    expect(pnp.spec.ingress).toEqual([{ from: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'u-1234' } } }], ports: [{ protocol: 'TCP', port: 3128 }] }]);
    const conf = edge.find((x) => x.kind === 'ConfigMap').data['squid.conf'];
    const out = pnp.spec.egress.at(-1);
    expect(out.ports).toEqual([{ protocol: 'TCP', port: 443 }]);
    // every private range the tenant's own restricted policy subtracts, plus all of link-local (metadata) and loopback
    const privateRanges = find(render(), 'NetworkPolicy')[0].spec.egress.at(-1).to[0].ipBlock.except.filter((c: string) => !c.startsWith('169.254.'));
    expect(privateRanges.length).toBeGreaterThan(2);
    expect(out.to[0].ipBlock.except).toEqual(expect.arrayContaining([...privateRanges, '169.254.0.0/16', '127.0.0.0/8']));
    expect(conf).toContain(`acl private_dst dst ${privateRanges.join(' ')}`);
    expect(conf).toContain('http_access deny !CONNECT');
    expect(conf).toContain('http_access deny ip_literal');
    expect(conf.trim().split('\n').filter((l: string) => l.startsWith('http_access')).at(-1)).toBe('http_access deny all');
  });

  test('on: the proxy password exists only in the sidecar env and, hashed, for the proxy', () => {
    const d = render(ON);
    const pw = atob(find(d, 'Secret', (x) => x.metadata.name === 'arigami-1234-egress-auth')[0].data.password);
    expect(pw).toMatch(/^[A-Za-z0-9]{40}$/);
    const passwd = atob(find(d, 'Secret', (x) => x.metadata.namespace === 'edge')[0].data.passwd);
    expect(passwd).toMatch(/^gatekeeper:\$2[aby]\$/);
    expect(passwd).not.toContain(pw);
    const gk = container(d, 'gatekeeper');
    expect(gk.env.find((e: any) => e.name === 'EGRESS_PROXY_PASSWORD').valueFrom.secretKeyRef.name).toBe('arigami-1234-egress-auth');
    expect(gk.env.find((e: any) => e.name === 'HTTPS_PROXY').value).toContain('gatekeeper:$(EGRESS_PROXY_PASSWORD)@');
  });

  test('on without an identities Secret: the render fails instead of starting a gatekeeper with nothing', () => {
    expect(() => render(['--set', 'isolation.enabled=true'])).toThrow(/identitiesSecret/);
    // an isolated tenant without the gatekeeper is fine (no sidecar at all)
    const d = render(['--set', 'isolation.enabled=true', '--set', 'isolation.gatekeeper.enabled=false']);
    expect(sts(d).spec.template.spec.containers.map((c: any) => c.name)).toEqual(['arigami']);
    expect(container(d, 'arigami').env.map((e: any) => e.name)).not.toContain('ARIGAMI_EXT_REMOTE');
  });

  const SB = ['--set', 'isolation.enabled=true', '--set', 'isolation.noSudo=false', '--set', 'isolation.egressProxy.enabled=false', '--set', 'isolation.sandbox.enabled=true', '--set-string', 'isolation.gatekeeper.identitiesSecret=gk-ids'];

  test('sandbox: the host container keeps today\'s sudo context and egress; restricted sessions go to the sandbox', () => {
    const d = render(SB);
    const host = container(d, 'arigami');
    expect(host.securityContext.allowPrivilegeEscalation).toBe(true); // Full sessions keep sudo
    const env = Object.fromEntries(host.env.map((e: any) => [e.name, e.value]));
    expect(env.HTTPS_PROXY).toBeUndefined();
    expect(env.ARIGAMI_SANDBOX).toBe('sidecar');
    expect(env.ARIGAMI_SANDBOX_WORK_ROOTS).toBe('/data/sandbox-work');
    expect(env.ARIGAMI_X_NOLISTEN_LOCAL).toBe('1');
    expect(JSON.stringify(find(d, 'NetworkPolicy')[0].spec.egress)).toContain('0.0.0.0/0'); // the pod's usual restricted egress
    expect(d.filter((x) => x.metadata?.namespace === 'edge')).toEqual([]);
  });

  test('sandbox: no secrets, no sudo, no state dir — only the work roots, the session homes and read-only code', () => {
    const d = render(SB);
    const sb = container(d, 'sandbox');
    expect(sb.securityContext).toMatchObject({ runAsUser: 1000, runAsGroup: 2000, allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } });
    expect(sb.envFrom).toBeUndefined();
    expect(JSON.stringify(sb.env)).not.toMatch(/secretKeyRef|TOKEN|KEY|PASSWORD/);
    const mounts = sb.volumeMounts.map((m: any) => `${m.mountPath}${m.readOnly ? ':ro' : ''}`);
    expect(mounts.sort()).toEqual(['/data/.arigami/ext-plugin:ro', '/data/.arigami/sandbox/sessions', '/data/.arigami/skills:ro', '/data/.arigami/user-plugin:ro', '/data/.arigami/user/skills:ro', '/data/home/.local/share/claude/versions:ro', '/data/sandbox-work', '/dev/shm', '/tmp'].sort());
    for (const m of sb.volumeMounts) if (m.name === 'data') expect(m.subPath).toBeTruthy(); // never the whole disk
    // the gatekeeper writes github_checkout into a session's folder: the work roots rw, the rest of the disk ro
    const gkm = container(d, 'gatekeeper').volumeMounts.filter((m: any) => m.name === 'data');
    expect(gkm.map((m: any) => `${m.mountPath}${m.readOnly ? ':ro' : ''}`)).toEqual(['/data:ro', '/data/sandbox-work']);
    const eg = container(d, 'egress');
    expect(eg.securityContext).toMatchObject({ runAsGroup: 3000, allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } });
    expect(eg.volumeMounts.filter((m: any) => m.name === 'data').map((m: any) => m.subPath)).toEqual(['.arigami/sandbox/egress']);
  });

  test("sandbox: the packet filter confines the sandbox's group to the host API and the egress proxy on loopback", () => {
    const d = render(SB);
    const init = sts(d).spec.template.spec.initContainers[0];
    expect(init.securityContext.capabilities.add).toContain('NET_ADMIN');
    const script = init.args[0];
    expect(script).toContain('--gid-owner 2000 -j ARIGAMI-SANDBOX');
    expect(script).toContain('-o lo -d 127.0.0.1 -p tcp --dport 3099 -j ACCEPT');
    expect(script).toContain('-o lo -d 127.0.0.1 -p tcp --dport 3128 -j ACCEPT');
    expect(script.trim().split('\n').filter((l: string) => /-A ARIGAMI-SANDBOX/.test(l)).at(-1)).toContain('-j REJECT');
    expect(script).not.toMatch(/--dport 53|udp/); // no DNS for the sandbox
    // its own servers: only the pod's own addresses, only its own port range
    expect(script).toContain('-m addrtype --dst-type LOCAL -p tcp --dport 20000:20099 -j ACCEPT');
    expect(container(d, 'arigami').env.find((e: any) => e.name === 'ARIGAMI_SANDBOX_SERVER_PORTS').value).toBe('20000-20099');
    expect(container(d, 'sandbox').command.slice(0, 3)).toEqual(['tini', '-s', '--']);
  });

  test('sandbox: a work root outside the data disk fails the render', () => {
    expect(() => render([...SB, '--set', 'isolation.sandbox.workRoots={/etc}'])).toThrow(/not under \/data/);
  });
});

