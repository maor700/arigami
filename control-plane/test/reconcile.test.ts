// The reconcile tick (src/reconcile.ts) over fake ops: digest convergence,
// busy-skip, park-on-rollback, and backup scheduling — no k8s, no timers.
import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { openDb, createStore } from '../src/db.js';
import { reconcileTick, type ReconcileOps } from '../src/reconcile.js';
import { UpgradeBlockedError, UpgradeRolledBackError } from '../src/upgrade.js';
import { listBackups, pruneBackups, tenantBackupDir } from '../src/backup.js';

function setup(env: Record<string, string> = {}) {
  const cfg = loadConfig({ CP_IMAGE_TAG: 'digest-a', CP_RECONCILE_SEC: '0', ...env } as unknown as NodeJS.ProcessEnv);
  const store = createStore(openDb(':memory:'));
  return { cfg, store };
}

function ops(over: Partial<ReconcileOps['upgradeDeps']> = {}, extra: Partial<ReconcileOps> = {}): { o: ReconcileOps; calls: string[] } {
  const calls: string[] = [];
  const o: ReconcileOps = {
    upgradeDeps: {
      busySessions: async () => 0,
      revision: async () => 1,
      provision: async (t) => { calls.push(`provision:${t.ns}:${t.desired_digest}`); return { url: 'http://x' }; },
      verifyHealth: async () => {},
      rollback: async (t, rev) => { calls.push(`rollback:${t.ns}:${rev}`); },
      ...over,
    },
    backup: async (t) => { calls.push(`backup:${t.ns}`); },
    newestBackupMs: () => Date.now(), // fresh — no backup due
    ...extra,
  };
  return { o, calls };
}

function mkTenant(store: ReturnType<typeof createStore>, subject: string, state: 'running' | 'provisioning' = 'running', running = 'digest-a') {
  store.createUser(subject, `${subject}@x.test`, 'user');
  const t = store.createTenant(subject, `${subject}@x.test`, { desiredDigest: 'digest-a' });
  if (state === 'running') {
    store.setRunningDigest(subject, running);
    store.setTenantState(subject, 'running');
  }
  return t;
}

describe('reconcileTick', () => {
  test('upgrades a running tenant whose desired != running, records running_digest', async () => {
    const { cfg, store } = setup({ CP_BACKUP_INTERVAL_SEC: '0' });
    mkTenant(store, 's1');
    store.setDesiredDigest('s1', 'digest-b');
    const { o, calls } = ops();
    const sum = await reconcileTick(cfg, store, o, () => {});
    expect(sum.upgraded).toEqual([store.findTenantBySubject('s1')!.ns]);
    expect(store.findTenantBySubject('s1')!.running_digest).toBe('digest-b');
    expect(calls.some((c) => c.startsWith('provision:') && c.endsWith(':digest-b'))).toBe(true);
  });

  test('a busy tenant is skipped, not failed — and running_digest is untouched', async () => {
    const { cfg, store } = setup({ CP_BACKUP_INTERVAL_SEC: '0' });
    mkTenant(store, 's1');
    store.setDesiredDigest('s1', 'digest-b');
    const { o } = ops({ busySessions: async () => 1 });
    const sum = await reconcileTick(cfg, store, o, () => {});
    expect(sum.blocked.length).toBe(1);
    expect(sum.failed).toEqual([]);
    expect(store.findTenantBySubject('s1')!.running_digest).toBe('digest-a');
    expect(store.findTenantBySubject('s1')!.desired_digest).toBe('digest-b'); // still wanted — next tick retries
  });

  test('a rolled-back upgrade PARKS the tenant (desired reset to running) so it cannot flap', async () => {
    const { cfg, store } = setup({ CP_BACKUP_INTERVAL_SEC: '0' });
    mkTenant(store, 's1');
    store.setDesiredDigest('s1', 'digest-bad');
    const { o } = ops({ provision: async () => { throw new Error('pull failed'); } });
    const sum = await reconcileTick(cfg, store, o, () => {});
    expect(sum.rolledBack.length).toBe(1);
    const t = store.findTenantBySubject('s1')!;
    expect(t.running_digest).toBe('digest-a');
    expect(t.desired_digest).toBe('digest-a'); // parked — an operator sets a new digest to retry
  });

  test('non-running tenants are never touched', async () => {
    const { cfg, store } = setup({ CP_BACKUP_INTERVAL_SEC: '0' });
    mkTenant(store, 's1', 'provisioning');
    store.setDesiredDigest('s1', 'digest-b');
    const { o, calls } = ops();
    const sum = await reconcileTick(cfg, store, o, () => {});
    expect(sum.upgraded).toEqual([]);
    expect(calls).toEqual([]);
  });

  test('backup runs when the newest archive is stale (or absent), skips when fresh', async () => {
    const { cfg, store } = setup({ CP_BACKUP_INTERVAL_SEC: '3600' });
    mkTenant(store, 's1');
    const { o, calls } = ops({}, { newestBackupMs: () => null });
    const sum = await reconcileTick(cfg, store, o, () => {});
    expect(sum.backedUp.length).toBe(1);
    expect(calls.filter((c) => c.startsWith('backup:')).length).toBe(1);

    const { o: fresh, calls: calls2 } = ops({}, { newestBackupMs: () => Date.now() });
    const sum2 = await reconcileTick(cfg, store, fresh, () => {});
    expect(sum2.backedUp).toEqual([]);
    expect(calls2.filter((c) => c.startsWith('backup:'))).toEqual([]);
  });

  test('an upgrade and a backup never run in the same tick for one tenant', async () => {
    const { cfg, store } = setup({ CP_BACKUP_INTERVAL_SEC: '3600' });
    mkTenant(store, 's1');
    store.setDesiredDigest('s1', 'digest-b');
    const { o, calls } = ops({}, { newestBackupMs: () => null });
    await reconcileTick(cfg, store, o, () => {});
    expect(calls.some((c) => c.startsWith('provision:'))).toBe(true);
    expect(calls.some((c) => c.startsWith('backup:'))).toBe(false);
  });
});

describe('backup listing/pruning', () => {
  test('listBackups sorts newest-first; pruneBackups keeps N', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-backups-'));
    const { cfg } = setup({ CP_BACKUP_DIR: dir, CP_BACKUP_KEEP: '2' });
    const ns = 'u-test';
    fs.mkdirSync(tenantBackupDir(cfg, ns), { recursive: true });
    for (const [i, n] of ['a', 'b', 'c'].entries()) {
      const f = path.join(tenantBackupDir(cfg, ns), `arigami-backup-${n}.tgz`);
      fs.writeFileSync(f, n);
      fs.utimesSync(f, new Date(2026, 0, i + 1), new Date(2026, 0, i + 1));
    }
    fs.writeFileSync(path.join(tenantBackupDir(cfg, ns), 'not-a-backup.txt'), 'x');
    const list = listBackups(cfg, ns);
    expect(list.map((b) => b.name)).toEqual(['arigami-backup-c.tgz', 'arigami-backup-b.tgz', 'arigami-backup-a.tgz']);
    const removed = pruneBackups(cfg, ns);
    expect(removed.length).toBe(1);
    expect(removed[0]).toContain('arigami-backup-a.tgz');
    expect(listBackups(cfg, ns).length).toBe(2);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
