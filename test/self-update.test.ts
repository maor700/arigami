// server/lib/self-update.ts — the "notice a new release on our own" policy.
// Every dependency is injected, so none of this fetches, spawns git, or
// upgrades anything: the point is the decisions (announce once per version,
// never apply unless asked, never restart a channel that cannot self-upgrade).
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSelfUpdater, isNewer, shouldAnnounce, CHECK_EVERY_MS } from '../server/lib/self-update.ts';

const version = (over: Record<string, any> = {}) => ({
  version: '0.1.0', tag: null, commit: 'abc1234', commitDate: null, branch: 'master', upstream: 'origin/master',
  ahead: 0, behind: 0, updateAvailable: false, sharedBase: true, image: null, fetchedAt: null, checkedAt: Date.now(),
  available: { version: null, tag: null, release: null },
  ...over,
}) as any;

/** A harness with a movable clock and recording sinks. */
function harness(over: Record<string, any> = {}) {
  const events: any[] = [];
  const notes: any[] = [];
  const logs: string[] = [];
  const upgrades: string[] = [];
  let clock = 1_000_000;
  const d = {
    now: () => clock,
    store: null,
    enabled: () => true,
    auto: () => false,
    version: async () => version(),
    backend: async () => ({ channel: 'git', preflight: async () => ({ ok: true }) }),
    upgrade: async (when: 'idle') => { upgrades.push(when); },
    emit: (e: any) => events.push(e),
    notify: (title: string, body: string) => notes.push({ title, body }),
    log: (l: string) => logs.push(l),
    ...over,
  };
  return { u: createSelfUpdater(d as any), events, notes, logs, upgrades, tickClock: (ms: number) => { clock += ms; }, now: () => clock };
}

test('isNewer: strictly greater semver only; unparseable or equal is not an update', () => {
  expect(isNewer('0.2.0', '0.1.0')).toBe(true);
  expect(isNewer('v0.2.0', '0.1.9')).toBe(true);
  expect(isNewer('1.0.0', '0.9.9')).toBe(true);
  expect(isNewer('0.1.0', '0.1.0')).toBe(false);
  expect(isNewer('0.1.0', '0.2.0')).toBe(false); // a checkout ahead of the release is not "behind"
  expect(isNewer(null, '0.1.0')).toBe(false);
  expect(isNewer('0.2.0', null)).toBe(false);
  expect(isNewer('not-a-version', '0.1.0')).toBe(false);
});

test('shouldAnnounce: once per version, and never without an update', () => {
  const upd = { updateAvailable: true, available: '0.2.0', tag: 'v0.2.0' };
  expect(shouldAnnounce(upd, null)).toBe(true);
  expect(shouldAnnounce(upd, { version: '0.2.0', tag: 'v0.2.0', at: 1 })).toBe(false); // already told them
  expect(shouldAnnounce(upd, { version: '0.1.9', tag: 'v0.1.9', at: 1 })).toBe(true); // a newer one arrived
  expect(shouldAnnounce({ ...upd, updateAvailable: false }, null)).toBe(false);
  // no version number on either side → the tag carries the identity
  expect(shouldAnnounce({ updateAvailable: true, available: null, tag: 'v0.3.0' }, { version: null, tag: 'v0.3.0', at: 1 })).toBe(false);
  expect(shouldAnnounce({ updateAvailable: true, available: null, tag: 'v0.4.0' }, { version: null, tag: 'v0.3.0', at: 1 })).toBe(true);
});

test('tick: no update → silence (no event, no notification, no upgrade)', async () => {
  const h = harness();
  await h.u.tick();
  expect(h.events).toEqual([]);
  expect(h.notes).toEqual([]);
  expect(h.upgrades).toEqual([]);
  expect(h.u.status().updateAvailable).toBe(false);
  expect(h.u.status().lastCheck).not.toBeNull();
});

test('tick: an update announces exactly once, however many times it beats', async () => {
  const h = harness({ version: async () => version({ updateAvailable: true, ahead: 7, available: { version: '0.2.0', tag: 'v0.2.0', release: null } }) });
  await h.u.tick();
  expect(h.events).toHaveLength(1);
  expect(h.events[0]).toMatchObject({ kind: 'self-update-available', current: '0.1.0', available: '0.2.0', channel: 'git', auto: false });
  expect(h.notes[0].body).toBe('0.1.0 → 0.2.0');

  // the check window has not lapsed → the next beat does not even look
  await h.u.tick();
  expect(h.events).toHaveLength(1);

  // even once it does look again, the same version stays quiet
  h.tickClock(CHECK_EVERY_MS + 1);
  await h.u.tick();
  expect(h.events).toHaveLength(1);
  expect(h.notes).toHaveLength(1);
});

test('tick: a NEWER version than the one already announced speaks up again', async () => {
  let avail = { version: '0.2.0', tag: 'v0.2.0', release: null };
  const h = harness({ version: async () => version({ updateAvailable: true, ahead: 3, available: avail }) });
  await h.u.tick();
  expect(h.events).toHaveLength(1);

  avail = { version: '0.3.0', tag: 'v0.3.0', release: null };
  h.tickClock(CHECK_EVERY_MS + 1);
  await h.u.tick();
  expect(h.events).toHaveLength(2);
  expect(h.events[1]).toMatchObject({ available: '0.3.0' });
});

test('auto off (the default): it tells you, it does not touch the host', async () => {
  const h = harness({ version: async () => version({ updateAvailable: true, ahead: 2, available: { version: '0.2.0', tag: 'v0.2.0', release: null } }) });
  await h.u.tick();
  expect(h.notes).toHaveLength(1);
  expect(h.upgrades).toEqual([]); // the whole point
  expect(h.u.status().auto).toBe(false);
});

test('auto on: queues the upgrade for when the host is idle, never "now"', async () => {
  const h = harness({
    auto: () => true,
    version: async () => version({ updateAvailable: true, ahead: 2, available: { version: '0.2.0', tag: 'v0.2.0', release: null } }),
  });
  await h.u.tick();
  expect(h.upgrades).toEqual(['idle']);
  expect(h.events.map((e) => e.kind)).toEqual(['self-update-available', 'self-update-started']);
  expect(h.u.status().lastApply).toMatchObject({ ok: true, to: '0.2.0' });
});

test('auto on but the channel cannot upgrade in place (docker) → announce, refuse to try', async () => {
  const h = harness({
    auto: () => true,
    backend: async () => ({ channel: 'docker', preflight: async () => ({ ok: false, reason: 'a container cannot recreate itself' }) }),
    version: async () => version({ updateAvailable: true, ahead: 1, available: { version: '0.2.0', tag: 'v0.2.0', release: null } }),
  });
  await h.u.tick();
  expect(h.notes).toHaveLength(1); // the human still finds out
  expect(h.upgrades).toEqual([]); // but nothing is attempted
  expect(h.logs.join('\n')).toContain('cannot recreate itself');
  expect(h.u.status().channel).toBe('docker');
});

test('auto on: a failed start is recorded, never retried in a storm, retried next window', async () => {
  let calls = 0;
  const h = harness({
    auto: () => true,
    upgrade: async () => { calls++; throw new Error('checkout is dirty'); },
    version: async () => version({ updateAvailable: true, ahead: 1, available: { version: '0.2.0', tag: 'v0.2.0', release: null } }),
  });
  await h.u.tick();
  expect(calls).toBe(1);
  expect(h.u.status().lastApply).toMatchObject({ ok: false, error: 'checkout is dirty' });
  expect(h.events.map((e) => e.kind)).toContain('self-update-failed');

  // Beating every TICK_MS inside the check window must not hammer the upgrade.
  for (let i = 0; i < 5; i++) { h.tickClock(30 * 60 * 1000); await h.u.tick(); }
  expect(calls).toBe(1);

  // Once the window lapses it is allowed to try again — a dirty checkout gets
  // cleaned up, a busy host goes idle; giving up forever would be wrong.
  h.tickClock(CHECK_EVERY_MS + 1);
  await h.u.tick();
  expect(calls).toBe(2);
});

test('disabled: the timer beats but nothing is checked at all', async () => {
  let asked = 0;
  const h = harness({ enabled: () => false, version: async () => { asked++; return version({ updateAvailable: true }); } });
  await h.u.tick();
  expect(asked).toBe(0);
  expect(h.u.status().enabled).toBe(false);
});

test('a failing version probe is recorded, not thrown, and does not announce', async () => {
  const h = harness({ version: async () => { throw new Error('no upstream'); } });
  await h.u.tick();
  expect(h.u.status().lastError).toBe('no upstream');
  expect(h.events).toEqual([]);
  expect(h.notes).toEqual([]);
});

test('the announcement survives a restart: what was already said is not said twice', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-selfupd-'));
  const store = path.join(dir, 'self-update.json');
  const v = async () => version({ updateAvailable: true, ahead: 4, available: { version: '0.2.0', tag: 'v0.2.0', release: null } });

  const first = harness({ store, version: v });
  await first.u.tick();
  expect(first.events).toHaveLength(1);
  expect(JSON.parse(fs.readFileSync(store, 'utf8')).announced).toMatchObject({ version: '0.2.0' });

  // a fresh process, same data dir, same pending version → stays quiet
  const second = harness({ store, version: v });
  await second.u.tick();
  expect(second.events).toEqual([]);
  expect(second.notes).toEqual([]);
});

test('start/stop arms an unref-ed timer and is idempotent', () => {
  const h = harness();
  h.u.start({ bootDelayMs: 60_000, tickMs: 60_000 });
  h.u.start({ bootDelayMs: 60_000, tickMs: 60_000 }); // second call is a no-op, not a second timer
  h.u.stop();
  h.u.stop();
  expect(h.u.status().lastCheck).toBeNull(); // nothing ran synchronously
});
