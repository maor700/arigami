// server/triggers.ts's `type:'cron'` trigger: creation/validation, the
// create-guard against runaway scheduling loops, and persistence across
// restart. Runs each case in a fresh child process (see test/_child.js) since
// triggers.js/state.js bind their store paths from env at import time.
//
// Deliberately does NOT fire an 'isolated' cron trigger end-to-end — that
// calls api.ts's startEmptySession → claude.ensureRunning, which spawns a
// real `claude` subprocess. Firing logic is exercised only through paths that
// don't reach that spawn (validation, the guard, and the 'existing' mode's
// target-not-found branch).
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInChild } from './_child.js';

function isolatedEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-cron-'));
  return { dir, env: { ARIGAMI_DIR: dir, ARIGAMI_STATE_FILE: path.join(dir, 'state.json') } };
}

test('createCronTrigger validates schedule.kind and prompt', () => {
  const { env } = isolatedEnv();
  const r = runInChild(
    `
    const t = await import('./server/triggers.js');
    t.load();
    for (const bad of [
      { prompt: '', schedule: { kind: 'interval', value: '5m' } },
      { prompt: 'hi', schedule: { kind: 'bogus', value: '5m' } },
      { prompt: 'hi', schedule: { kind: 'interval', value: 'not-a-duration' } },
      { prompt: 'hi', schedule: { kind: 'cron', value: '99 * * * *' } },
      { prompt: 'hi', schedule: { kind: 'at', value: 'not-a-date' } },
      { prompt: 'hi', schedule: { kind: 'interval', value: '5m' }, sessionMode: 'bogus' },
      { prompt: 'hi', schedule: { kind: 'interval', value: '5m' }, sessionMode: 'existing:' },
    ]) {
      let threw = false;
      try { await t.createCronTrigger(bad); } catch { threw = true; }
      emit({ bad, threw });
    }
    `,
    env
  );
  expect(r.ok).toBe(true);
  for (const { threw } of r.out) expect(threw).toBe(true);
});

test('createCronTrigger accepts a valid interval/cron/at schedule and defaults deliver.push to true', () => {
  const { env } = isolatedEnv();
  const r = runInChild(
    `
    const t = await import('./server/triggers.js');
    t.load();
    const interval = await t.createCronTrigger({ name: 'Every 5m', prompt: 'check inbox', schedule: { kind: 'interval', value: '5m' } });
    const cron = await t.createCronTrigger({ name: 'Weekdays 9am', prompt: 'standup', schedule: { kind: 'cron', value: '0 9 * * 1-5' } });
    const at = await t.createCronTrigger({ name: 'Once', prompt: 'one-shot', schedule: { kind: 'at', value: '2030-01-01T00:00:00Z' } });
    emit({ interval, cron, at });
    `,
    env
  );
  expect(r.ok).toBe(true);
  const { interval, cron, at } = r.out[0];
  for (const t of [interval, cron, at]) {
    expect(t.type).toBe('cron');
    expect(t.enabled).toBe(true);
    expect(t.deliver.push).toBe(true); // decision: push is the default delivery channel
    expect(t.runs).toEqual([]);
    expect(t.lastRun).toBeNull();
  }
});

test('guard: a session spawned by a cron trigger cannot create a new cron trigger', () => {
  const { env } = isolatedEnv();
  const r = runInChild(
    `
    const t = await import('./server/triggers.js');
    const state = await import('./server/state.js');
    t.load();
    const cronChild = state.createSession({ title: 'from-cron' });
    state.patchSession(cronChild.id, { metadata: { fromCronTrigger: 'trig_parent' } });
    const plainSession = state.createSession({ title: 'human-launched' });

    let blockedThrew = false, blockedMessage = '';
    try {
      await t.createCronTrigger({ prompt: 'loop', schedule: { kind: 'interval', value: '1m' }, createdBySessionId: cronChild.id });
    } catch (e) { blockedThrew = true; blockedMessage = e.message; }

    let allowedOk = false;
    try {
      const created = await t.createCronTrigger({ prompt: 'fine', schedule: { kind: 'interval', value: '1m' }, createdBySessionId: plainSession.id });
      allowedOk = created.type === 'cron';
    } catch {}

    let noCreatorOk = false;
    try {
      const created = await t.createCronTrigger({ prompt: 'fine too', schedule: { kind: 'interval', value: '1m' } });
      noCreatorOk = created.type === 'cron';
    } catch {}

    emit({ blockedThrew, blockedMessage, allowedOk, noCreatorOk });
    `,
    env
  );
  expect(r.ok).toBe(true);
  const { blockedThrew, blockedMessage, allowedOk, noCreatorOk } = r.out[0];
  expect(blockedThrew).toBe(true);
  expect(blockedMessage).toMatch(/cannot create new cron jobs/);
  expect(allowedOk).toBe(true);
  expect(noCreatorOk).toBe(true);
});

test('patchTrigger re-validates a cron schedule patch and rejects a bad one', () => {
  const { env } = isolatedEnv();
  const r = runInChild(
    `
    const t = await import('./server/triggers.js');
    t.load();
    const created = await t.createCronTrigger({ name: 'X', prompt: 'p', schedule: { kind: 'interval', value: '10m' } });
    const patched = t.patchTrigger(created.id, { schedule: { kind: 'interval', value: '1h' }, prompt: 'new prompt', deliver: { master: 'sess_x' } });
    let threw = false;
    try { t.patchTrigger(created.id, { schedule: { kind: 'cron', value: 'garbage' } }); } catch { threw = true; }
    const afterBadPatch = t.listTriggers().find((x) => x.id === created.id);
    emit({ patched, threw, afterBadPatch });
    `,
    env
  );
  expect(r.ok).toBe(true);
  const { patched, threw, afterBadPatch } = r.out[0];
  expect(patched.schedule).toEqual({ kind: 'interval', value: '1h' });
  expect(patched.prompt).toBe('new prompt');
  expect(patched.deliver.master).toBe('sess_x');
  expect(patched.deliver.push).toBe(true); // merge, not replace
  expect(threw).toBe(true);
  // The rejected patch must not have partially applied.
  expect(afterBadPatch.schedule).toEqual({ kind: 'interval', value: '1h' });
});

test('cron triggers survive a restart (persisted fields round-trip through flush/load)', () => {
  const { env } = isolatedEnv();
  const first = runInChild(
    `
    const t = await import('./server/triggers.js');
    t.load();
    const created = await t.createCronTrigger({
      name: 'Nightly', prompt: 'summarize the day', schedule: { kind: 'cron', value: '0 22 * * *' },
      sessionMode: 'isolated', deliver: { push: true, master: 'sess_m' }, autonomous: true,
    });
    t.flush();
    emit({ id: created.id });
    `,
    env
  );
  expect(first.ok).toBe(true);
  const { id } = first.out[0];

  const second = runInChild(
    `
    const t = await import('./server/triggers.js');
    t.load();
    const reloaded = t.listTriggers().find((x) => x.id === ${JSON.stringify(id)});
    emit({ reloaded });
    `,
    env
  );
  expect(second.ok).toBe(true);
  const { reloaded } = second.out[0];
  expect(reloaded.type).toBe('cron');
  expect(reloaded.name).toBe('Nightly');
  expect(reloaded.prompt).toBe('summarize the day');
  expect(reloaded.schedule).toEqual({ kind: 'cron', value: '0 22 * * *' });
  expect(reloaded.sessionMode).toBe('isolated');
  expect(reloaded.deliver).toEqual({ push: true, master: 'sess_m' });
  expect(reloaded.autonomous).toBe(true);
  expect(reloaded.runs).toEqual([]);
});

test("runCronNow on 'existing' mode reports+records failure when the target session is gone", () => {
  const { env } = isolatedEnv();
  const r = runInChild(
    `
    const t = await import('./server/triggers.js');
    t.load();
    const created = await t.createCronTrigger({
      name: 'Nudge PM', prompt: 'status update please',
      schedule: { kind: 'interval', value: '1h' }, sessionMode: 'existing:sess_does_not_exist',
    });
    const result = await t.runCronNow(created.id);
    const after = t.listTriggers().find((x) => x.id === created.id);
    emit({ result, runs: after.runs, log: t.getTriggerLog(created.id) });
    `,
    env
  );
  expect(r.ok).toBe(true);
  const { result, runs, log } = r.out[0];
  expect(result.ok).toBe(false);
  expect(result.reason).toBe('target-not-found');
  expect(runs.length).toBe(1);
  expect(runs[0].state).toBe('error');
  expect(log.some((l) => l.level === 'error')).toBe(true);
});

test('runCronNow on an unknown trigger id fails cleanly', () => {
  const { env } = isolatedEnv();
  const r = runInChild(
    `
    const t = await import('./server/triggers.js');
    t.load();
    const result = await t.runCronNow('trig_nope');
    emit({ result });
    `,
    env
  );
  expect(r.ok).toBe(true);
  expect(r.out[0].result).toEqual({ ok: false, reason: 'no such cron trigger' });
});

test('nextRunFor: interval trigger has a next run; an already-fired one-shot "at" trigger does not', () => {
  const { env } = isolatedEnv();
  const r = runInChild(
    `
    const t = await import('./server/triggers.js');
    t.load();
    const interval = await t.createCronTrigger({ prompt: 'p', schedule: { kind: 'interval', value: '5m' } });
    const at = await t.createCronTrigger({ prompt: 'p', schedule: { kind: 'at', value: '2030-01-01T00:00:00Z' } });
    const beforeFire = t.nextRunFor(at);
    at.lastRun = Date.now(); // simulate having already fired, without spawning a session
    const afterFire = t.nextRunFor(at);
    emit({ intervalNext: t.nextRunFor(interval), beforeFire, afterFire });
    `,
    env
  );
  expect(r.ok).toBe(true);
  const { intervalNext, beforeFire, afterFire } = r.out[0];
  expect(intervalNext).toBeGreaterThan(Date.now() - 5000);
  expect(beforeFire).toBe(Date.parse('2030-01-01T00:00:00Z'));
  expect(afterFire).toBeNull();
});

test('isRunningQueueSession: only a queue-started session that is running a turn takes a budget slot', () => {
  const { env } = isolatedEnv();
  const r = runInChild(
    `
    const t = await import('./server/triggers.js');
    const q = (state, fromQueue = true) => ({ metadata: fromQueue ? { fromQueue: true } : {}, claude: { state } });
    emit({
      running: t.isRunningQueueSession(q('running')),
      starting: t.isRunningQueueSession(q('starting')),
      idle: t.isRunningQueueSession(q('idle')),      // waiting on a PR / the human: not working
      dead: t.isRunningQueueSession(q('dead')),
      notQueue: t.isRunningQueueSession(q('running', false)), // direct launcher session
      bare: t.isRunningQueueSession({}),
    });
    `,
    env
  );
  expect(r.ok).toBe(true);
  expect(r.out[0]).toEqual({ running: true, starting: true, idle: false, dead: false, notQueue: false, bare: false });
});
