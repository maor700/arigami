// M4: server/brain.ts — the singleton `metadata.kind:'brain'` session and its
// optional heartbeat cron. Runs each case in a fresh child process (see
// test/_child.js) since state.js/triggers.js/config.js bind their store paths
// from env at import time.
//
// Deliberately never calls ensureBrainSession() on a store with NO brain
// session yet — that path spawns a real `claude` subprocess via api.js's
// startEmptySession (same reason test/cron-trigger.test.js avoids firing an
// 'isolated' cron end-to-end). Every case here pre-seeds a brain session
// directly via state.createSession + patchSession instead, so ensureBrainSession
// always takes its "already exists" branch.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInChild } from './_child.js';

function isolatedEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-brain-'));
  return { dir, env: { ARIGAMI_DIR: dir, ARIGAMI_STATE_FILE: path.join(dir, 'state.json'), ARIGAMI_PORT: '' } };
}

test('findBrainSession: null with no sessions; finds a metadata.kind:"brain" session once seeded', () => {
  const { env } = isolatedEnv();
  const r = runInChild(
    `
    const state = await import('./server/state.js');
    const brain = await import('./server/brain.js');
    const beforeAny = brain.findBrainSession();
    const other = state.createSession({ title: 'not-brain' });
    const beforeSeed = brain.findBrainSession();
    const seeded = state.createSession({ title: brain.BRAIN_TITLE });
    state.patchSession(seeded.id, { metadata: { kind: 'brain' } });
    const found = brain.findBrainSession();
    emit({ beforeAny, beforeSeed, foundId: found?.id, seededId: seeded.id });
    `,
    env
  );
  if (!r.ok) throw new Error(r.error);
  const { beforeAny, beforeSeed, foundId, seededId } = r.out[0];
  expect(beforeAny).toBeNull();
  expect(beforeSeed).toBeNull(); // a same-title, non-tagged session must not match
  expect(foundId).toBe(seededId);
});

test('findBrainSession prefers a live session over an archived one', () => {
  const { env } = isolatedEnv();
  const r = runInChild(
    `
    const state = await import('./server/state.js');
    const brain = await import('./server/brain.js');
    const dead = state.createSession({ title: 'old brain' });
    state.patchSession(dead.id, { metadata: { kind: 'brain' }, archived: true });
    const live = state.createSession({ title: 'new brain' });
    state.patchSession(live.id, { metadata: { kind: 'brain' } });
    const found = brain.findBrainSession();
    emit({ foundId: found?.id, liveId: live.id, foundArchived: found?.archived });
    `,
    env
  );
  if (!r.ok) throw new Error(r.error);
  const { foundId, liveId, foundArchived } = r.out[0];
  expect(foundId).toBe(liveId);
  expect(foundArchived).toBe(false);
});

test('ensureBrainSession reuses an already-seeded session (unarchiving it) instead of creating a new one', () => {
  const { env } = isolatedEnv();
  const r = runInChild(
    `
    const state = await import('./server/state.js');
    const brain = await import('./server/brain.js');
    const seeded = state.createSession({ title: brain.BRAIN_TITLE });
    state.patchSession(seeded.id, { metadata: { kind: 'brain' }, archived: true });
    const r = await brain.ensureBrainSession();
    const after = state.getSession(seeded.id);
    emit({ r, seededId: seeded.id, afterArchived: after.archived });
    `,
    env
  );
  if (!r.ok) throw new Error(r.error);
  const { r: result, seededId, afterArchived } = r.out[0];
  expect(result).toEqual({ id: seededId, created: false });
  expect(afterArchived).toBe(false); // re-activated, not left archived
});

test('setHeartbeat(true) creates a cron trigger targeting the brain session; setHeartbeat(false) removes it', () => {
  const { env } = isolatedEnv();
  const r = runInChild(
    `
    const state = await import('./server/state.js');
    const triggers = await import('./server/triggers.js');
    const brain = await import('./server/brain.js');
    triggers.load();
    const seeded = state.createSession({ title: brain.BRAIN_TITLE });
    state.patchSession(seeded.id, { metadata: { kind: 'brain' } });

    const statusBefore = brain.getHeartbeatStatus();
    const on = await brain.setHeartbeat(true, '10m');
    const afterOn = triggers.listTriggers().filter((t) => t.type === 'cron' && t.name === brain.HEARTBEAT_TRIGGER_NAME);

    const off = await brain.setHeartbeat(false);
    const afterOff = triggers.listTriggers().filter((t) => t.type === 'cron' && t.name === brain.HEARTBEAT_TRIGGER_NAME);

    emit({ statusBefore, on, afterOn, off, afterOff, seededId: seeded.id });
    `,
    env
  );
  if (!r.ok) throw new Error(r.error);
  const { statusBefore, on, afterOn, off, afterOff, seededId } = r.out[0];
  expect(statusBefore.enabled).toBe(false);
  expect(statusBefore.triggerId).toBeNull();

  expect(on.enabled).toBe(true);
  expect(on.every).toBe('10m');
  expect(afterOn.length).toBe(1);
  expect(afterOn[0].sessionMode).toBe(`existing:${seededId}`);
  expect(afterOn[0].schedule).toEqual({ kind: 'interval', value: '10m' });
  expect(afterOn[0].deliver.push).toBe(true);
  expect(on.triggerId).toBe(afterOn[0].id);

  expect(off.enabled).toBe(false);
  expect(off.triggerId).toBeNull();
  expect(afterOff.length).toBe(0); // removed, not just disabled — spec M4.3
});

test('setHeartbeat(true) called twice does not create a second trigger (updates the existing one instead)', () => {
  const { env } = isolatedEnv();
  const r = runInChild(
    `
    const state = await import('./server/state.js');
    const triggers = await import('./server/triggers.js');
    const brain = await import('./server/brain.js');
    triggers.load();
    const seeded = state.createSession({ title: brain.BRAIN_TITLE });
    state.patchSession(seeded.id, { metadata: { kind: 'brain' } });

    await brain.setHeartbeat(true, '30m');
    await brain.setHeartbeat(true, '15m');
    const jobs = triggers.listTriggers().filter((t) => t.type === 'cron' && t.name === brain.HEARTBEAT_TRIGGER_NAME);
    emit({ count: jobs.length, value: jobs[0]?.schedule?.value });
    `,
    env
  );
  if (!r.ok) throw new Error(r.error);
  const { count, value } = r.out[0];
  expect(count).toBe(1);
  expect(value).toBe('15m'); // second call's interval won
});

test('heartbeat config persists across a reload (config.brain round-trips through flush/load)', () => {
  const { dir, env } = isolatedEnv();
  const first = runInChild(
    `
    const state = await import('./server/state.js');
    const triggers = await import('./server/triggers.js');
    const brain = await import('./server/brain.js');
    triggers.load();
    const seeded = state.createSession({ title: brain.BRAIN_TITLE });
    state.patchSession(seeded.id, { metadata: { kind: 'brain' } });
    await brain.setHeartbeat(true, '20m');
    emit({ ok: true });
    `,
    env
  );
  if (!first.ok) throw new Error(first.error);

  const second = runInChild(
    `
    const { cfg } = await import('./server/lib/config.js');
    emit({ brain: cfg.brain });
    `,
    env
  );
  if (!second.ok) throw new Error(second.error);
  expect(second.out[0].brain).toEqual({ heartbeatEnabled: true, heartbeatEvery: '20m' });
});
