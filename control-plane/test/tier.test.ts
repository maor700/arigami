// Hardware tiers: config validation, overlay layering, the guarded set-tier path (fake deps, no cluster),
// the admin route, the DB migration, and the charts' rendering (`helm template` works offline).
import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import { loadConfig, parseTiers } from '../src/config.js';
import { openDb, createStore, type Tenant } from '../src/db.js';
import { buildHelmArgs, tierOverlay } from '../src/provisioner.js';
import { setTier, parseQuantity, TierError, type TierDeps } from '../src/tier.js';
import { UpgradeBlockedError } from '../src/upgrade.js';
import { createApp, type Provisioner } from '../src/server.js';
import { adminPage } from '../src/templates.js';

const TIERS = {
  standard: { persistence: { size: '10Gi' } },
  large: {
    resources: { limits: { cpu: '8' } },
    persistence: { size: '50Gi' },
    nodeSelector: { pool: 'large' },
    tolerations: [{ key: 'dedicated', operator: 'Equal', value: 'large', effect: 'NoSchedule' }],
  },
};
const env = (over: Record<string, string> = {}) => ({ CP_ORG_DOMAIN: 'example.test', CP_TIERS: JSON.stringify(TIERS), ...over }) as unknown as NodeJS.ProcessEnv;

const tenant = (over: Partial<Tenant> = {}): Tenant => ({
  subject: 's1', email: 'a@example.com', ns: 'u-abc', release: 'u-abc',
  desired_digest: 'd1', running_digest: 'd1', ring: 'stable', state: 'running', created_at: '', last_seen_at: '', handoff_secret: 'x'.repeat(20),
  profile_commit: '', profile_ref: '', profile_checked_at: 0, profile_failed_commit: '', profile_failures: 0, profile_next_at: 0, profile_error: '',
  ...over,
});

describe('config', () => {
  test('no CP_TIERS: no tiers, default "standard", nothing to apply', () => {
    const cfg = loadConfig({} as NodeJS.ProcessEnv);
    expect(cfg.tiers).toEqual({});
    expect(cfg.defaultTier).toBe('standard');
    expect(tierOverlay(cfg, tenant())).toBeNull();
  });
  test('inline JSON and a JSON file both load', () => {
    expect(loadConfig(env()).tiers.large).toEqual(TIERS.large);
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tiers-')), 't.json');
    fs.writeFileSync(f, JSON.stringify(TIERS));
    expect(loadConfig(env({ CP_TIERS: f })).tiers.standard).toEqual(TIERS.standard);
  });
  test('bad input refuses to boot with a clear message', () => {
    expect(() => loadConfig(env({ CP_TIERS: '{nope' }))).toThrow(/not valid JSON/);
    expect(() => loadConfig(env({ CP_TIERS: '/no/such/file.json' }))).toThrow(/neither inline JSON nor a readable file/);
    expect(() => loadConfig(env({ CP_TIERS: '[1]' }))).toThrow(/must be a JSON object/);
    expect(() => parseTiers('{"a b":{}}')).toThrow(/tier name "a b" is invalid/);
    expect(() => parseTiers('{"a":5}')).toThrow(/tier "a" must be an object/);
    expect(() => parseTiers('{"a":{"tenant":{"id":"x"}}}')).toThrow(/sets "tenant"/);
    expect(() => parseTiers('{"a":{"persistence":{"size":"big"}}}')).toThrow(/Kubernetes quantity/);
  });
  test('an unknown default tier refuses to start', () => {
    expect(() => loadConfig(env({ CP_DEFAULT_TIER: 'huge' }))).toThrow(/CP_DEFAULT_TIER "huge" is not a tier/);
    expect(() => loadConfig(env({ CP_TIERS: '{"large":{}}' }))).toThrow(/CP_DEFAULT_TIER "standard"/); // default "standard" missing
    expect(() => loadConfig({ CP_DEFAULT_TIER: 'large' } as unknown as NodeJS.ProcessEnv)).toThrow(/defines no tiers/);
    expect(loadConfig(env({ CP_DEFAULT_TIER: 'large' })).defaultTier).toBe('large');
  });
});

describe('overlay layering', () => {
  test('base --set < CP_HELM_EXTRA_VALUES < tier overlay (last -f)', () => {
    const cfg = loadConfig(env({ CP_HELM_EXTRA_VALUES: '/x/extra.yaml' }));
    const args = buildHelmArgs(cfg, tenant({ tier: 'large' }), '/x/tier.yaml');
    const files = args.flatMap((a, i) => (args[i - 1] === '-f' ? [a] : []));
    expect(files).toEqual(['/x/extra.yaml', '/x/tier.yaml']);
    expect(args.indexOf('--set-string')).toBeLessThan(args.indexOf('-f'));
    expect(tierOverlay(cfg, tenant({ tier: 'large' }))).toEqual(TIERS.large);
  });
  test('empty tier = the default tier; with no tier file the args are today\'s', () => {
    const cfg = loadConfig(env({ CP_DEFAULT_TIER: 'large' }));
    expect(tierOverlay(cfg, tenant())).toEqual(TIERS.large);
    expect(buildHelmArgs(loadConfig({} as NodeJS.ProcessEnv), tenant())).not.toContain('-f');
  });
  test('a tenant on a tier that is gone fails loudly', () => {
    expect(() => tierOverlay(loadConfig(env()), tenant({ tier: 'retired' }))).toThrow(/not in CP_TIERS/);
  });
});

describe('db', () => {
  test('adds the tier column to an old database; default is the empty string', () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'db-')), 'old.db');
    const old = new Database(f, { create: true });
    old.exec(`CREATE TABLE users (subject TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, role TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE tenants (subject TEXT PRIMARY KEY, email TEXT NOT NULL, ns TEXT NOT NULL UNIQUE, release TEXT NOT NULL, desired_digest TEXT NOT NULL DEFAULT '', running_digest TEXT NOT NULL DEFAULT '', ring TEXT NOT NULL DEFAULT 'stable', state TEXT NOT NULL, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL);
      INSERT INTO users VALUES ('s','a@b.c','user','x'); INSERT INTO tenants VALUES ('s','a@b.c','u-1','u-1','','','stable','running','x','x');`);
    old.close();
    const store = createStore(openDb(f));
    expect(store.findTenantBySubject('s')?.tier).toBe('');
    store.setTier('s', 'large');
    expect(store.findTenantBySubject('s')?.tier).toBe('large');
  });
});

function deps(over: Partial<TierDeps> & { calls?: string[] } = {}): { d: TierDeps; calls: string[] } {
  const calls = over.calls ?? [];
  const d: TierDeps = {
    busySessions: async () => 0,
    revision: async () => 7,
    provision: async (t) => { calls.push(`provision:${t.tier}`); return { url: 'u' }; },
    verifyHealth: async () => { calls.push('verify'); },
    rollback: async (_t, rev) => { calls.push(`rollback:${rev}`); },
    pvcInfo: async () => ({ size: '10Gi', expandable: true, storageClass: 'fast' }),
    expandPvc: async (_t, size) => { calls.push(`expand:${size}`); },
    orphanStatefulSet: async () => { calls.push('orphan'); },
    ...over,
  };
  return { d, calls };
}

describe('setTier', () => {
  const cfg = loadConfig(env());
  const rec = () => { const rows: string[] = []; return { rows, store: { setTier: (_s: string, t: string) => { rows.push(t); } } }; };

  test('happy path: expand + detach + helm upgrade on the new tier, health, then record', async () => {
    const { d, calls } = deps();
    const { rows, store } = rec();
    const r = await setTier(cfg, store, d, tenant(), 'large');
    expect(calls).toEqual(['expand:50Gi', 'orphan', 'provision:large', 'verify']);
    expect(r.disk).toEqual({ from: '10Gi', to: '50Gi', grew: true });
    expect(rows).toEqual(['large']);
  });
  test('same disk: no PVC work', async () => {
    const { d, calls } = deps({ pvcInfo: async () => ({ size: '50Gi', expandable: false, storageClass: 'x' }) });
    await setTier(cfg, rec().store, d, tenant(), 'large');
    expect(calls).toEqual(['provision:large', 'verify']);
  });
  test('refuses to shrink the disk, touching nothing', async () => {
    const { d, calls } = deps({ pvcInfo: async () => ({ size: '50Gi', expandable: true, storageClass: 'x' }) });
    const { rows, store } = rec();
    const err = await setTier(cfg, store, d, tenant({ tier: 'large' }), 'standard').catch((e) => e);
    expect(err).toBeInstanceOf(TierError);
    expect(err.message).toMatch(/can only grow/);
    expect(calls).toEqual([]);
    expect(rows).toEqual([]);
  });
  test('refuses when the StorageClass cannot expand, before changing anything', async () => {
    const { d, calls } = deps({ pvcInfo: async () => ({ size: '10Gi', expandable: false, storageClass: 'local' }) });
    const err = await setTier(cfg, rec().store, d, tenant(), 'large').catch((e) => e);
    expect(err.message).toMatch(/does not allow volume expansion/);
    expect(calls).toEqual([]);
  });
  test('refuses while a turn is in flight; nothing is touched and nothing recorded', async () => {
    const { d, calls } = deps({ busySessions: async () => 1 });
    const { rows, store } = rec();
    await expect(setTier(cfg, store, d, tenant(), 'large')).rejects.toBeInstanceOf(UpgradeBlockedError);
    expect(calls).toEqual([]);
    expect(rows).toEqual([]);
  });
  test('unknown tier / not running are refused', async () => {
    await expect(setTier(cfg, rec().store, deps().d, tenant(), 'nope')).rejects.toThrow(/unknown tier/);
    await expect(setTier(cfg, rec().store, deps().d, tenant({ state: 'dormant' }), 'large')).rejects.toThrow(/needs a running tenant/);
    await expect(setTier(loadConfig({} as NodeJS.ProcessEnv), rec().store, deps().d, tenant(), 'large')).rejects.toThrow(/no tiers are configured/);
  });
  test('a failed upgrade rolls back (detaching the grown StatefulSet first) and records nothing', async () => {
    const { d, calls } = deps({ verifyHealth: async () => { throw new Error('not ready'); } });
    const { rows, store } = rec();
    const err = await setTier(cfg, store, d, tenant(), 'large').catch((e) => e);
    expect(err.name).toBe('UpgradeFailedError'); // verify fails again after the rollback too
    expect(calls).toContain('rollback:7');
    expect(calls.indexOf('orphan')).toBeLessThan(calls.indexOf('provision:large'));
    expect(calls.filter((c) => c === 'orphan').length).toBe(2);
    expect(rows).toEqual([]);
  });
  test('quantities', () => {
    expect(parseQuantity('50Gi')).toBeGreaterThan(parseQuantity('10Gi'));
    expect(parseQuantity('1Gi')).toBe(1024 ** 3);
    expect(parseQuantity('junk')).toBeNaN();
  });
});

describe('admin route and page', () => {
  function setup() {
    const cfg = loadConfig(env({ CP_PUBLIC_URL: 'http://localhost:8090', ALLOWED_EMAIL_DOMAINS: 'example.com' }));
    const store = createStore(openDb(':memory:'));
    const p: Provisioner = { provisionTenant: async () => ({ url: 'u' }), deleteTenant: async () => {}, suspendTenant: async () => {}, resumeTenant: async () => {} };
    const { d, calls } = deps();
    const app = createApp(cfg, store, p, () => {}, { backupTenant: async () => ({ name: '', bytes: 0 }), listBackups: () => [], podSnapshot: async () => ({}) as any, tierDeps: d });
    store.createUser('admin', 'admin@example.com', 'admin');
    store.createUser('u1', 'u1@example.com', 'user');
    const t = store.createTenant('u1', 'u1@example.com', { desiredDigest: 'd1' });
    store.setRunningDigest('u1', 'd1');
    store.setTenantState('u1', 'running');
    const cookie = (s: string) => `arigami_cp_sid=${store.createSession(s, 1).token}`;
    const post = (who: string | null, tier = 'large') =>
      app.handle(new Request(`http://localhost:8090/admin/tenants/u1/tier`, {
        method: 'POST', body: new URLSearchParams({ tier }), headers: who ? { cookie: cookie(who) } : {},
      }));
    return { store, app, calls, post, cookie, t };
  }
  test('requires an org-admin', async () => {
    const { post, calls, store } = setup();
    expect((await post(null)).status).toBe(302);
    expect((await post('u1')).status).toBe(403);
    expect(calls).toEqual([]);
    expect(store.findTenantBySubject('u1')?.tier).toBe('');
  });
  test('an admin changes the tier and lands back on /admin', async () => {
    const { post, store, calls } = setup();
    const res = await post('admin');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/admin');
    expect(store.findTenantBySubject('u1')?.tier).toBe('large');
    expect(calls).toContain('provision:large');
  });
  test('unknown tier is a 400 page', async () => {
    expect((await setup().post('admin', 'nope')).status).toBe(400);
  });
  test('the page has a select, a confirm and the current tier; with no tiers there is no column', async () => {
    const { app, cookie } = setup();
    const res = await app.handle(new Request('http://localhost:8090/admin', { headers: { cookie: cookie('admin') } }));
    const html = await res.text();
    expect(html).toContain('<select name="tier"');
    expect(html).toContain('confirm(');
    expect(html).toContain('pod restarts');
    expect(html).toContain('<option value="standard" selected>');
    expect(adminPage([tenant()], 'a@b.c')).not.toContain('name="tier"');
  });
});

describe('helm charts render tiers', () => {
  const root = path.join(import.meta.dir, '..', '..', 'deploy', 'helm');
  const helm = (chart: string, args: string[]) => {
    const r = Bun.spawnSync(['helm', 'template', 'x', path.join(root, chart), ...args]);
    return { ok: r.exitCode === 0, out: r.stdout.toString() + r.stderr.toString() };
  };
  const haveHelm = Bun.spawnSync(['helm', 'version']).exitCode === 0;
  const t = haveHelm ? test : test.skip;
  const np = ['--set', 'networkPolicy.ingressNamespaces={ingress}'];

  t('tenant chart: defaults render no scheduling constraints', () => {
    const r = helm('arigami-tenant', np);
    expect(r.ok).toBe(true);
    expect(r.out).not.toMatch(/nodeSelector|tolerations|priorityClassName/);
  });
  t('tenant chart: nodeSelector, tolerations and priorityClassName reach the StatefulSet', () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ov-')), 'o.json');
    fs.writeFileSync(f, JSON.stringify(TIERS.large));
    const r = helm('arigami-tenant', [...np, '-f', f, '--set', 'priorityClassName=big']);
    expect(r.ok).toBe(true);
    expect(r.out).toMatch(/nodeSelector:\n\s+pool: large/);
    expect(r.out).toMatch(/tolerations:\n\s+- effect: NoSchedule\n\s+key: dedicated/);
    expect(r.out).toContain('priorityClassName: "big"');
    expect(r.out).toContain('storage: 50Gi');
  });
  t('control-plane chart: tiers become CP_TIERS + a ConfigMap; a bad default fails the render', () => {
    const base = ['--set', 'config.tenantIngressNamespaces=ingress', '--set', 'ingress.host=cp.example.test', '--set', 'config.orgDomain=example.test'];
    expect(helm('arigami-control-plane', base).out).not.toContain('CP_TIERS');
    const ok = helm('arigami-control-plane', [...base, '--set-json', `tiers=${JSON.stringify(TIERS)}`]);
    expect(ok.ok).toBe(true);
    expect(ok.out).toContain('CP_TIERS');
    expect(ok.out).toContain('"nodeSelector":{"pool":"large"}');
    const bad = helm('arigami-control-plane', [...base, '--set-json', `tiers=${JSON.stringify(TIERS)}`, '--set', 'defaultTier=huge']);
    expect(bad.ok).toBe(false);
    expect(bad.out).toContain('defaultTier "huge"');
  });
});
