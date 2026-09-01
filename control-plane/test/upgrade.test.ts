// The upgrade orchestrator (src/upgrade.ts) over fake deps — every path the
// k3d live proof exercises once, asserted here permanently: refuse-while-busy,
// happy path, rollback on failed provision, rollback on failed health check,
// and the double-failure that needs a human.
import { describe, test, expect } from 'bun:test';
import type { Tenant } from '../src/db.js';
import { upgradeTenant, UpgradeBlockedError, UpgradeRolledBackError, UpgradeFailedError, type UpgradeDeps } from '../src/upgrade.js';

const tenant = (over: Partial<Tenant> = {}): Tenant => ({
  subject: 's1', email: 'a@b.c', ns: 'u-abc', release: 'u-abc',
  desired_digest: 'digest-b', running_digest: 'digest-a', ring: 'stable',
  state: 'running', created_at: '', last_seen_at: '', handoff_secret: 'test-handoff-secret-16+', ...over,
});

function deps(over: Partial<UpgradeDeps> = {}): { d: UpgradeDeps; calls: string[] } {
  const calls: string[] = [];
  const d: UpgradeDeps = {
    busySessions: async () => { calls.push('busy'); return 0; },
    revision: async () => { calls.push('revision'); return 4; },
    provision: async (t) => { calls.push(`provision:${t.desired_digest}`); return { url: 'http://x' }; },
    verifyHealth: async (t) => { calls.push(`verify:${t.desired_digest}`); },
    rollback: async (_t, rev) => { calls.push(`rollback:${rev}`); },
    ...over,
  };
  return { d, calls };
}

describe('upgradeTenant', () => {
  test('happy path: busy-check → provision on the new digest → verify', async () => {
    const { d, calls } = deps();
    const r = await upgradeTenant(d, tenant(), 'digest-b');
    expect(r).toEqual({ from: 'digest-a', to: 'digest-b', revisionBefore: 4 });
    expect(calls).toEqual(['busy', 'revision', 'provision:digest-b', 'verify:digest-b']);
  });

  test('refuses while a turn is in flight — nothing else runs', async () => {
    const { d, calls } = deps({ busySessions: async () => 2 });
    await expect(upgradeTenant(d, tenant(), 'digest-b')).rejects.toBeInstanceOf(UpgradeBlockedError);
    expect(calls).toEqual([]);
  });

  test('an unreadable busy signal fails CLOSED (no upgrade attempt)', async () => {
    const { d, calls } = deps({ busySessions: async () => { throw new Error('exec failed'); } });
    await expect(upgradeTenant(d, tenant(), 'digest-b')).rejects.toThrow('exec failed');
    expect(calls).toEqual([]);
  });

  test('failed provision → rollback to the recorded revision, old digest verified', async () => {
    const { d, calls } = deps({ provision: async () => { throw new Error('ImagePullBackOff'); } });
    const err = await upgradeTenant(d, tenant(), 'digest-b').catch((e) => e);
    expect(err).toBeInstanceOf(UpgradeRolledBackError);
    expect(err.revision).toBe(4);
    expect(calls).toEqual(['busy', 'revision', 'rollback:4', 'verify:digest-a']);
  });

  test('provision ok but health check fails → still rolls back', async () => {
    const { d, calls } = deps({
      verifyHealth: async (t) => {
        calls.push(`verify:${t.desired_digest}`);
        if (t.desired_digest === 'digest-b') throw new Error('not healthy');
      },
    });
    await expect(upgradeTenant(d, tenant(), 'digest-b')).rejects.toBeInstanceOf(UpgradeRolledBackError);
    expect(calls).toEqual(['busy', 'revision', 'provision:digest-b', 'verify:digest-b', 'rollback:4', 'verify:digest-a']);
  });

  test('rollback failing too surfaces UpgradeFailedError (operator needed)', async () => {
    const { d } = deps({
      provision: async () => { throw new Error('bad digest'); },
      rollback: async () => { throw new Error('rollback exploded'); },
    });
    const err = await upgradeTenant(d, tenant(), 'digest-b').catch((e) => e);
    expect(err).toBeInstanceOf(UpgradeFailedError);
    expect(err.message).toContain('bad digest');
    expect(err.message).toContain('rollback exploded');
  });
});
