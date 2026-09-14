// dispatch/update-backend: server/lib/update-backend.ts's channel-detection
// and per-backend guards. Style matches test/host-control.test.ts: pure
// pickBackend()/plan() calls run in-process, anything that touches cfg
// (preflight()'s allowUpgrade check) or a real git checkout runs in a child
// so a scratch ARIGAMI_DIR/config.json never leaks into the shared module
// registry other test files rely on.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runInChild } from './_child.js';
import { isolate } from './_isolate.js';
isolate(); // restore globalThis/process.env after this file (bun test shares them)

// Same reason as test/host-control.test.ts: config.js/state.js bind their
// store paths from ARIGAMI_DIR at import time.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-ub-'));
process.env.ARIGAMI_DIR = scratch;
process.env.ARIGAMI_STATE_FILE = path.join(scratch, 'state.json');
const hc = await import('../server/host-control.ts');
const ub = await import('../server/lib/update-backend.ts');
const { upgradePlan, detectManager, ALLOW_ERROR, DIRTY_ERROR, NOT_FF_ERROR } = hc;
const { pickBackend } = ub;

function gitRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-ub-repo-'));
  const g = (...a: string[]) => spawnSync('git', a, { cwd: repo, stdio: 'ignore' });
  g('init', '-q'); g('config', 'user.email', 't@example.invalid'); g('config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'a.txt'), '1\n');
  g('add', 'a.txt'); g('commit', '-q', '-m', 'init');
  return repo;
}

test('pickBackend: packaged when compiled, docker when containerized, else git — via injected deps, never real env', () => {
  const packaged = pickBackend('/r', { isCompiledBinary: () => true, inContainer: () => false });
  expect(packaged.channel).toBe('packaged');
  expect(packaged.finish).toBe('relaunch-app');
  expect(packaged.plan()).toBeNull();

  const docker = pickBackend('/r', { isCompiledBinary: () => false, inContainer: () => true });
  expect(docker.channel).toBe('docker');
  expect(docker.finish).toBe('recreate-container');
  expect(docker.plan()).toBeNull();

  const git = pickBackend('/r', { isCompiledBinary: () => false, inContainer: () => false });
  expect(git.channel).toBe('git');
  expect(git.finish).toBe('restart-self');
  expect(git.plan()).not.toBeNull();

  // compiled-binary check runs first: both true → still packaged, not docker.
  const both = pickBackend('/r', { isCompiledBinary: () => true, inContainer: () => true });
  expect(both.channel).toBe('packaged');

  // default deps (no injection) fall back to the real isCompiledBinary()/inContainer() —
  // neither is true for a plain `bun test` process, so this must still be git.
  expect(pickBackend('/r').channel).toBe('git');
});

test('git backend plan() is exactly upgradePlan(root) — the "zero semantic change" claim', () => {
  const backend = pickBackend('/some/root', { isCompiledBinary: () => false, inContainer: () => false });
  expect(backend.plan()).toEqual(upgradePlan('/some/root'));
  // and the 'check' step (fast-forward ancestry) is still IN the plan — preflight()
  // below is an extra early check, not a replacement for it.
  expect(backend.plan()!.map((s) => s.name)).toContain('check');
});

test('git backend preflight(): host.allowUpgrade=false blocks before anything else', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-ub-dir-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ host: { allowUpgrade: false } }));
  const repo = gitRepo();
  const r = runInChild(
    `
    const ub = await import('./server/lib/update-backend.ts');
    const backend = ub.pickBackend(${JSON.stringify(repo)}, { isCompiledBinary: () => false, inContainer: () => false });
    emit(await backend.preflight());
    `,
    { ARIGAMI_DIR: dir, ARIGAMI_STATE_FILE: path.join(dir, 'state.json'), ARIGAMI_PORT: '' },
  );
  if (!r.ok) throw new Error(r.error);
  expect(r.out[0]).toEqual({ ok: false, reason: ALLOW_ERROR });
});

test('git backend preflight(): a dirty checkout blocks, with the tracked files listed as blockers', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-ub-dir-'));
  const repo = gitRepo();
  fs.writeFileSync(path.join(repo, 'a.txt'), '2\n'); // dirty (tracked)
  fs.writeFileSync(path.join(repo, 'untracked.txt'), 'x\n'); // must NOT show up in blockers
  const r = runInChild(
    `
    const ub = await import('./server/lib/update-backend.ts');
    const backend = ub.pickBackend(${JSON.stringify(repo)}, { isCompiledBinary: () => false, inContainer: () => false });
    emit(await backend.preflight());
    `,
    { ARIGAMI_DIR: dir, ARIGAMI_STATE_FILE: path.join(dir, 'state.json'), ARIGAMI_PORT: '' },
  );
  if (!r.ok) throw new Error(r.error);
  expect(r.out[0]).toEqual({ ok: false, reason: DIRTY_ERROR, blockers: ['M a.txt'] });
});

test('git backend preflight(): no shared merge-base with upstream blocks (the realign case); a clean repo with NO upstream at all is NOT blocked by it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-ub-dir-'));
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-ub-base-'));
  const up = path.join(base, 'up');
  const local = path.join(base, 'local');
  const g = (cwd: string, ...a: string[]) => {
    const res = spawnSync('git', a, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
    if (res.status !== 0) throw new Error(`git ${a.join(' ')}: ${res.stderr}`);
    return res.stdout.trim();
  };
  fs.mkdirSync(up);
  g(up, 'init', '-q', '-b', 'main'); g(up, 'config', 'user.email', 't@example.invalid'); g(up, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(up, 'a.txt'), '1\n'); g(up, 'add', '.'); g(up, 'commit', '-q', '-m', 'one');
  g(base, 'clone', '-q', up, local);
  g(local, 'config', 'user.email', 't@example.invalid'); g(local, 'config', 'user.name', 't');
  // rewrite local history from scratch, still tracking origin/main — no common ancestor
  // (same technique as test/version.test.ts's sharedBase=false case).
  g(local, 'checkout', '-q', '--orphan', 'fresh');
  g(local, 'commit', '-q', '-m', 'rewritten root');
  g(local, 'branch', '-q', '--set-upstream-to=origin/main');

  const noUpstream = gitRepo(); // plain repo, never cloned/tracked — v.upstream is null

  // Two separate child processes on purpose: version.ts's getVersion() cache is
  // keyed by TTL only, not by root — calling it twice for different roots in
  // the same process would silently reuse the first root's stale result.
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-ub-dir-'));
  const rApart = runInChild(
    `
    const ub = await import('./server/lib/update-backend.ts');
    const backend = ub.pickBackend(${JSON.stringify(local)}, { isCompiledBinary: () => false, inContainer: () => false });
    emit(await backend.preflight());
    `,
    { ARIGAMI_DIR: dir, ARIGAMI_STATE_FILE: path.join(dir, 'state.json'), ARIGAMI_PORT: '' },
  );
  const rPlain = runInChild(
    `
    const ub = await import('./server/lib/update-backend.ts');
    const backend = ub.pickBackend(${JSON.stringify(noUpstream)}, { isCompiledBinary: () => false, inContainer: () => false });
    emit(await backend.preflight());
    `,
    { ARIGAMI_DIR: dir2, ARIGAMI_STATE_FILE: path.join(dir2, 'state.json'), ARIGAMI_PORT: '' },
  );
  if (!rApart.ok) throw new Error(rApart.error);
  if (!rPlain.ok) throw new Error(rPlain.error);
  expect(rApart.out[0]).toEqual({ ok: false, reason: NOT_FF_ERROR });
  // no upstream configured at all → the ff-check has nothing to compare, so a case
  // that passes today (no @{u}) must keep passing.
  expect(rPlain.out[0]).toEqual({ ok: true });
});

test('docker backend: cannot self-upgrade — plan() null, preflight() explains why, finish recreates the container', async () => {
  const backend = pickBackend('/r', { isCompiledBinary: () => false, inContainer: () => true });
  expect(backend.plan()).toBeNull();
  expect(backend.finish).toBe('recreate-container');
  const pf = await backend.preflight();
  expect(pf.ok).toBe(false);
  expect(typeof pf.reason).toBe('string');
  expect(pf.reason!.length).toBeGreaterThan(0);
});

test('packaged backend: scaffold only — plan() null, preflight() explains why, run() rejects not-implemented, finish relaunches the app', async () => {
  const backend = pickBackend('/r', { isCompiledBinary: () => true, inContainer: () => false });
  expect(backend.plan()).toBeNull();
  expect(backend.finish).toBe('relaunch-app');
  const pf = await backend.preflight();
  expect(pf.ok).toBe(false);
  expect(typeof pf.reason).toBe('string');
  expect(pf.reason!.length).toBeGreaterThan(0);
  await expect(backend.run!(() => {})).rejects.toThrow(/not implemented/);
});

test("detectManager: ARIGAMI_SUPERVISOR=self is override-only, and does not disturb systemd/launchd/pm2/docker/none", () => {
  const shell = { ppid: 4242, parentCommand: '/bin/bash' };
  expect(detectManager({ ARIGAMI_SUPERVISOR: 'self' }, shell)).toBe('self');
  expect(detectManager({ ARIGAMI_SUPERVISOR: 'self' }, { ppid: 1, parentCommand: '/sbin/init' })).toBe('self');
  // a shell parent that never loops looks identical to one that does — no auto-detection.
  expect(detectManager({}, shell)).toBe('none');
  expect(detectManager({ ARIGAMI_SUPERVISOR: 'systemd' }, shell)).toBe('systemd');
  expect(detectManager({ ARIGAMI_SUPERVISOR: 'docker' }, shell)).toBe('docker');
  expect(detectManager({ ARIGAMI_SUPERVISOR: 'none' }, { ppid: 1 })).toBe('none');
});
