// B4-lite: the restart state machine + upgrade guards in server/host-control.ts.
// The controller is driven with injected clock/timers/busy-count/exit so no
// server, no signals and no real time are involved.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runInChild } from './_child.js';

// Importing host-control.ts pulls in state.js/config.js which bind their store
// paths at import time — point them at a scratch dir so nothing touches a real
// ~/.arigami.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-hc-'));
process.env.ARIGAMI_DIR = scratch;
process.env.ARIGAMI_STATE_FILE = path.join(scratch, 'state.json');
const hc = await import('../server/host-control.ts');
const { RestartController, NoSupervisorError, detectManager, isDirtyStatus, dirtyFiles, upgradePlan, NOT_FF_ERROR } = hc;

// Fake timers: `fire()` runs the earliest armed timer.
function harness(opts: { manager?: string; busy?: number } = {}) {
  let busy = opts.busy ?? 0;
  let t = 1_000_000;
  const timers: { id: number; at: number; fn: () => void }[] = [];
  let seq = 0;
  const exits: string[] = [];
  const events: any[] = [];
  let drains = 0;
  const c = new RestartController({
    manager: () => (opts.manager ?? 'systemd') as any,
    busyCount: () => busy,
    exit: (r) => exits.push(r),
    now: () => t,
    setTimer: (fn, ms) => { const id = ++seq; timers.push({ id, at: t + ms, fn }); return id; },
    clearTimer: (h) => { const i = timers.findIndex((x) => x.id === h); if (i >= 0) timers.splice(i, 1); },
    drainTimeoutMs: 1000,
    idleTimeoutMs: 60_000,
    onDrainStart: () => { drains++; },
    emit: (e) => events.push(e),
  });
  const fire = () => { timers.sort((a, b) => a.at - b.at); const x = timers.shift(); if (!x) throw new Error('no timer armed'); t = x.at; x.fn(); };
  return { c, exits, events, timers, fire, setBusy: (n: number) => { busy = n; }, drains: () => drains };
}

test('restart now with nothing busy → exits immediately, drain handler called once', () => {
  const h = harness();
  const r = h.c.request('now');
  expect(r.scheduled).toBe('now');
  expect(h.exits).toEqual(['requested']);
  expect(h.drains()).toBe(1);
  expect(h.c.status().phase).toBe('exiting');
  expect(h.events.map((e) => e.kind)).toEqual(['restart-draining', 'restarting']);
  // A second request while exiting is a no-op (still one exit).
  h.c.request('now');
  expect(h.exits.length).toBe(1);
});

test('restart now with busy sessions → drains, exits when they go idle', () => {
  const h = harness({ busy: 2 });
  h.c.request('now');
  expect(h.c.status().phase).toBe('draining');
  expect(h.exits).toEqual([]);
  h.setBusy(1); h.c.onSessionIdle();
  expect(h.exits).toEqual([]);
  h.setBusy(0); h.c.onSessionIdle();
  expect(h.exits).toEqual(['drained']);
  expect(h.timers.length).toBe(0); // drain timer disarmed
});

test('restart now with a stuck session → drain timeout forces the exit', () => {
  const h = harness({ busy: 1 });
  h.c.request('now');
  expect(h.exits).toEqual([]);
  h.fire();
  expect(h.exits).toEqual(['drain-timeout']);
});

test('restart when idle: queues while busy, restarts on the last idle, cancel works', () => {
  const h = harness({ busy: 1 });
  const r = h.c.request('idle');
  expect(r.scheduled).toBe('idle');
  expect(h.c.status()).toMatchObject({ phase: 'pending-idle', pendingRestart: 'idle', busySessions: 1 });
  expect(h.c.cancel()).toBe(true);
  expect(h.c.status()).toMatchObject({ phase: 'idle', pendingRestart: null });
  expect(h.timers.length).toBe(0);
  expect(h.events.map((e) => e.kind)).toEqual(['restart-scheduled', 'restart-cancelled']);

  h.c.request('idle');
  h.c.onSessionIdle(); // still busy → nothing
  expect(h.exits).toEqual([]);
  h.setBusy(0); h.c.onSessionIdle();
  expect(h.exits).toEqual(['idle']);
  expect(h.c.cancel()).toBe(false); // too late
});

test('restart when idle with nothing busy → behaves like now', () => {
  const h = harness();
  expect(h.c.request('idle').scheduled).toBe('now');
  expect(h.exits.length).toBe(1);
});

test('restart when idle: 30-min style timeout restarts anyway', () => {
  const h = harness({ busy: 1 });
  h.c.request('idle');
  h.fire(); // idle timeout → drain (busy still 1 → arms drain timeout)
  expect(h.c.status().phase).toBe('draining');
  expect(h.c.status().reason).toBe('idle-timeout');
  h.fire(); // drain timeout
  expect(h.exits).toEqual(['drain-timeout']);
});

test('no supervisor → NoSupervisorError (409), state untouched', () => {
  const h = harness({ manager: 'none' });
  expect(() => h.c.request('now')).toThrow(NoSupervisorError);
  try { h.c.request('idle'); } catch (e: any) { expect(e.status).toBe(409); }
  expect(h.c.status().phase).toBe('idle');
  expect(h.exits).toEqual([]);
});

test('detectManager: env precedence, and the env alone is not enough — THIS process must be the supervisor\'s child (F4 #3)', () => {
  const shell = { ppid: 4242, parentCommand: '/bin/bash' };
  expect(detectManager({}, shell)).toBe('none');
  // inherited pm2/systemd env in a process started from a shell → none
  expect(detectManager({ PM2_HOME: '/x/.pm2', pm_id: '0' }, shell)).toBe('none');
  expect(detectManager({ INVOCATION_ID: 'abc' }, shell)).toBe('none');
  // real supervisors
  expect(detectManager({ INVOCATION_ID: 'abc' }, { ppid: 1, parentCommand: '/sbin/init' })).toBe('systemd');
  expect(detectManager({ INVOCATION_ID: 'abc' }, { ppid: 900, parentCommand: '/lib/systemd/systemd --user' })).toBe('systemd');
  expect(detectManager({ PM2_HOME: '/x/.pm2' }, { ppid: 77, parentCommand: 'PM2 v5.4.2: God Daemon (/home/x/.pm2)' })).toBe('pm2');
  expect(detectManager({ pm_id: '0' }, { ppid: 77, parentCommand: 'node /usr/lib/node_modules/pm2/lib/Daemon.js' })).toBe('pm2');
  // pm2 env but parent is not pm2 → none
  expect(detectManager({ pm_id: '0' }, { ppid: 77, parentCommand: 'bun server/index.ts' })).toBe('none');
  if (process.platform === 'darwin') {
    expect(detectManager({ XPC_SERVICE_NAME: 'io.arigami.host' }, { ppid: 1, parentCommand: '/sbin/launchd' })).toBe('launchd');
    expect(detectManager({ XPC_SERVICE_NAME: 'io.arigami.host' }, shell)).toBe('none');
  }
  expect(detectManager({ XPC_SERVICE_NAME: '0' }, { ppid: 1 })).toBe('none');
  // explicit override still wins both ways
  expect(detectManager({ ARIGAMI_SUPERVISOR: 'none', INVOCATION_ID: 'abc' }, { ppid: 1 })).toBe('none');
  expect(detectManager({ ARIGAMI_SUPERVISOR: 'systemd', PM2_HOME: '/x' }, shell)).toBe('systemd');
  // the default (this test process) is a bun child of the test runner, never a supervisor
  expect(detectManager({ PM2_HOME: '/x', pm_id: '1', INVOCATION_ID: 'q', ARIGAMI_SUPERVISOR: '' })).toBe('none');
});

test('isDirtyStatus: tracked changes are dirty, untracked-only is clean', () => {
  expect(isDirtyStatus('')).toBe(false);
  expect(isDirtyStatus('?? .env.bak\n?? notes/\n')).toBe(false);
  expect(isDirtyStatus(' M server/api.ts\n')).toBe(true);
  expect(isDirtyStatus('?? x\nA  new.ts\n')).toBe(true);
  expect(isDirtyStatus('UU conflict.ts\n')).toBe(true);
});

test('upgradePlan: fetch → ancestry check → ff-only pull → frozen install → web build, in the right dirs', () => {
  const plan = upgradePlan('/r');
  expect(plan.map((s) => s.name)).toEqual(['fetch', 'check', 'pull', 'install', 'build']);
  expect(plan[0].cmd).not.toContain('--prune'); // VER1: pruning is how a rewritten remote loses its merge base
  expect(plan[1].cmd).toEqual(['git', 'merge-base', '--is-ancestor', 'HEAD', '@{u}']);
  expect(plan[1].failMessage).toBe(NOT_FF_ERROR);
  expect(plan[2].cmd).toContain('--ff-only');
  expect(plan[3].cmd).toContain('--frozen-lockfile');
  expect(plan[4].cwd).toBe(path.join('/r', 'web'));
});

// VER1: the dirty list the card shows — status code + path, untracked skipped.
test('dirtyFiles: "XY path" per tracked change, untracked dropped', () => {
  expect(dirtyFiles('')).toEqual([]);
  expect(dirtyFiles('?? new.txt\n')).toEqual([]);
  expect(dirtyFiles(' M server/a.ts\nM  b.ts\n?? c\nUU d.ts\nR  old -> new\n')).toEqual(['M server/a.ts', 'M b.ts', 'UU d.ts', 'R old -> new']);
});

// End-to-end refusal: a real git repo with a modified tracked file. Runs in a
// child so the module's cfg/manager come from a controlled env.
test('startUpgrade refuses a dirty worktree (409) and never runs a step', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-upg-'));
  const g = (...a: string[]) => spawnSync('git', a, { cwd: repo, stdio: 'ignore' });
  g('init', '-q'); g('config', 'user.email', 'test@example.invalid'); g('config', 'user.name', 'test');
  fs.writeFileSync(path.join(repo, 'a.txt'), '1\n');
  g('add', 'a.txt'); g('commit', '-q', '-m', 'init');
  fs.writeFileSync(path.join(repo, 'a.txt'), '2\n'); // dirty (tracked)
  fs.writeFileSync(path.join(repo, 'untracked.txt'), 'x\n');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-upg-dir-'));
  const r = runInChild(
    `
    const hc = await import('./server/host-control.ts');
    let dirtyErr = null;
    try { await hc.startUpgrade('now', ${JSON.stringify(repo)}); } catch (e) { dirtyErr = { msg: e.message, status: e.status, dirty: e.dirty }; }
    emit({ dirtyErr, job: hc.currentUpgrade(), status: await hc.hostStatus() });
    `,
    { ARIGAMI_DIR: dir, ARIGAMI_STATE_FILE: path.join(dir, 'state.json'), ARIGAMI_PORT: '', ARIGAMI_SUPERVISOR: 'systemd' }
  );
  if (!r.ok) throw new Error(r.error);
  const { dirtyErr, job, status } = r.out[0];
  expect(dirtyErr.status).toBe(409);
  expect(dirtyErr.msg).toMatch(/uncommitted/);
  expect(dirtyErr.dirty).toEqual(['M a.txt']); // VER1: the refusal names the files
  expect(Array.isArray(status.dirty)).toBe(true); // hostStatus carries the list for the running checkout
  expect(job).toBeNull();
  expect(fs.existsSync(path.join(dir, 'logs', 'upgrade.log'))).toBe(false);
});

test('startUpgrade: 409 without a supervisor, 403 when host.allowUpgrade=false — before touching git', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-upg-dir-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ host: { allowUpgrade: false } }));
  const r = runInChild(
    `
    const hc = await import('./server/host-control.ts');
    const out = {};
    try { await hc.startUpgrade('now', '/nonexistent/repo'); } catch (e) { out.disabled = e.status; }
    emit(out);
    `,
    { ARIGAMI_DIR: dir, ARIGAMI_STATE_FILE: path.join(dir, 'state.json'), ARIGAMI_PORT: '', ARIGAMI_SUPERVISOR: 'systemd' }
  );
  if (!r.ok) throw new Error(r.error);
  expect(r.out[0].disabled).toBe(403);

  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-upg-dir-'));
  const r2 = runInChild(
    `
    const hc = await import('./server/host-control.ts');
    const out = {};
    try { await hc.startUpgrade('now', '/nonexistent/repo'); } catch (e) { out.nosup = e.status; }
    emit(out);
    `,
    { ARIGAMI_DIR: dir2, ARIGAMI_STATE_FILE: path.join(dir2, 'state.json'), ARIGAMI_PORT: '', ARIGAMI_SUPERVISOR: 'none', INVOCATION_ID: '', PM2_HOME: '' }
  );
  if (!r2.ok) throw new Error(r2.error);
  expect(r2.out[0].nosup).toBe(409);
});

// K8S-3: /__health tells loopback callers (kubectl exec, bin/host) the busy
// count so an orchestrator can gate upgrades on "no turn in flight" — and
// tells everyone else (the ingress / open internet) nothing but {ok}.
test('healthBody: busySessions for loopback peers only', () => {
  const busy = () => 3;
  expect(hc.healthBody('127.0.0.1', busy)).toEqual({ ok: true, busySessions: 3 });
  expect(hc.healthBody('::1', busy)).toEqual({ ok: true, busySessions: 3 });
  expect(hc.healthBody('::ffff:127.0.0.1', busy)).toEqual({ ok: true, busySessions: 3 });
  expect(hc.healthBody('203.0.113.9', busy)).toEqual({ ok: true });
  expect(hc.healthBody(undefined, busy)).toEqual({ ok: true });
});

// VER1: when='confirm' → the steps run, the job parks in `await-restart` with
// needsRestart, the upgrade-done event says so, and NO restart is requested —
// the click on the card is what restarts. when='now' keeps the old one-shot.
test('startUpgrade confirm mode: builds, then waits for the restart click; a failing check step reports NOT_FF_ERROR', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-upg-'));
  const g = (...a: string[]) => spawnSync('git', a, { cwd: repo, stdio: 'ignore' });
  g('init', '-q'); g('config', 'user.email', 'test@example.invalid'); g('config', 'user.name', 'test');
  fs.writeFileSync(path.join(repo, 'VERSION'), '1.2.3\n');
  g('add', 'VERSION'); g('commit', '-q', '-m', 'init');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-upg-dir-'));
  const r = runInChild(
    `
    const hc = await import('./server/host-control.ts');
    const bus = await import('./server/bus.js');
    const events = [];
    bus.subscribe((m) => { if (m.type === 'host') events.push(m.event); });
    const repo = ${JSON.stringify(repo)};
    const fs = await import('node:fs');
    // a "pull" that bumps VERSION, so from/to differ
    const plan = [
      { name: 'fetch', cmd: ['true'], cwd: repo },
      { name: 'pull', cmd: ['sh', '-c', 'echo 1.2.4 > VERSION'], cwd: repo },
    ];
    const job = await hc.startUpgrade('confirm', repo, plan);
    await new Promise((r) => setTimeout(r, 400));
    const done = hc.currentUpgrade();
    const status = await hc.hostStatus();
    // the fake pull dirtied VERSION — commit it, or the next call is refused as dirty
    const { spawnSync } = await import('node:child_process');
    spawnSync('git', ['commit', '-q', '-am', 'pulled'], { cwd: repo });
    let ffErr = null;
    try {
      await hc.startUpgrade('confirm', repo, [{ name: 'check', cmd: ['false'], cwd: repo, failMessage: hc.NOT_FF_ERROR }]);
      await new Promise((r) => setTimeout(r, 300));
      ffErr = hc.currentUpgrade().error;
    } catch (e) { ffErr = 'threw: ' + e.message; }
    emit({ accepted: { when: job.when, from: job.from }, done, phase: status.phase, pending: status.pendingRestart, ffErr, events: events.map((e) => ({ kind: e.kind, needsRestart: e.needsRestart, from: e.from, to: e.to })) });
    `,
    { ARIGAMI_DIR: dir, ARIGAMI_STATE_FILE: path.join(dir, 'state.json'), ARIGAMI_PORT: '', ARIGAMI_SUPERVISOR: 'systemd' }
  );
  if (!r.ok) throw new Error(r.error);
  const o = r.out[0];
  expect(o.accepted).toEqual({ when: 'confirm', from: '1.2.3' });
  expect(o.done.ok).toBe(true);
  expect(o.done.needsRestart).toBe(true);
  expect(o.done.step).toBe('await-restart');
  expect(o.done.to).toBe('1.2.4');
  expect(o.phase).toBe('idle'); // nothing restarted
  expect(o.pending).toBeNull();
  expect(o.ffErr).toBe(NOT_FF_ERROR);
  expect(o.events.filter((e: any) => e.kind === 'upgrade-done')).toEqual([{ kind: 'upgrade-done', needsRestart: true, from: '1.2.3', to: '1.2.4' }]);
});
