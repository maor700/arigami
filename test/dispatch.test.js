// Tests for the dispatcher's git worktree helpers (mutating-worker isolation).
import { test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// git.js / watchdog.js are intentionally free of the state singleton (see
// test/listeners.test.js), so importing them here doesn't race the
// ARIGAMI_STATE_FILE binding.
const { addWorktree, removeWorktree, repoCommonRoot } = await import('../server/git.js');
const { evaluateWorker } = await import('../server/watchdog.js');

const out = (buf) => Buffer.from(buf).toString().trim();

const NOW = 1_000_000_000_000;
const ago = (sec) => new Date(NOW - sec * 1000).toISOString();
const wm = (over = {}) => ({ lastState: null, lastStallActivity: 0, ...over });
const ev = (worker, watermark = wm(), stallMs = 600_000) =>
  evaluateWorker({ worker, watermark, stallMs, now: NOW });

let repo;

function sh(cwd, ...args) {
  const p = Bun.spawnSync(args, { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (p.exitCode !== 0) throw new Error(`${args.join(' ')} → ${out(p.stderr)}`);
}

beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-repo-'));
  sh(repo, 'git', 'init', '-q', '-b', 'main');
  sh(repo, 'git', 'config', 'user.email', 't@t.io');
  sh(repo, 'git', 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(repo, 'README.md'), '# hi\n');
  sh(repo, 'git', 'add', '-A');
  sh(repo, 'git', 'commit', '-q', '-m', 'init');
});

afterAll(() => {
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch {}
});

// git reports paths with forward slashes on every platform, so on Windows its
// answer differs from Node's only by separator. The value is only ever fed back
// to `git -C`, which accepts either — compare on the native separator.
const samePath = (p) => path.normalize(p);

test('repoCommonRoot resolves a repo, null for a non-repo', async () => {
  expect(samePath(await repoCommonRoot(repo))).toBe(samePath(fs.realpathSync(repo)));
  const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'norepo-'));
  expect(await repoCommonRoot(notRepo)).toBeNull();
});

test('addWorktree creates a new branch + worktree off base, then removeWorktree tears it down', async () => {
  const dir = path.join(os.tmpdir(), `wt-${Date.now()}`);
  const r = await addWorktree(repo, dir, 'dispatch/feature-x', 'main');
  expect(r.ok).toBe(true);
  expect(fs.existsSync(path.join(dir, 'README.md'))).toBe(true);
  // the worktree is on its own branch
  const br = Bun.spawnSync(['git', '-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD']);
  expect(out(br.stdout)).toBe('dispatch/feature-x');

  const rm = await removeWorktree(repo, dir);
  expect(rm.ok).toBe(true);
  expect(fs.existsSync(dir)).toBe(false);
});

test('addWorktree fails cleanly on a non-repo parent', async () => {
  const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'norepo2-'));
  const r = await addWorktree(notRepo, path.join(os.tmpdir(), 'wt-x'), 'dispatch/y', 'main');
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/not a git repository/);
});

// ---- watchdog decision (evaluateWorker) -----------------------------------

test('watchdog: retires when the worker reports a terminal result', () => {
  for (const st of ['done', 'blocked', 'error']) {
    const d = ev({ claudeState: 'working', updatedAt: ago(5), result: { state: st } });
    expect(d.action).toBe('retire');
    expect(d.reason).toBe(st);
  }
  // milestone is NOT terminal — keep watching
  expect(ev({ claudeState: 'working', updatedAt: ago(5), result: { state: 'milestone' } }).action).toBe('none');
});

test('watchdog: retires on status "In Review" even with no report_to_master result', () => {
  // request_review sets status directly and is a valid "told a human" signal on
  // its own — a worker that only called it (no report_to_master) must not be
  // treated as hung/stalled.
  const d = ev({ claudeState: 'idle', updatedAt: ago(5), result: null, status: 'In Review' });
  expect(d.action).toBe('retire');
  expect(d.reason).toBe('in-review');
  // an old idle "In Review" worker must not fall through to a stall either
  const old = ev({ claudeState: 'idle', updatedAt: ago(9000), result: null, status: 'In Review' });
  expect(old.action).toBe('retire');
});

test('watchdog: fires crash once on transition to dead, then de-dupes', () => {
  const first = ev({ claudeState: 'dead', updatedAt: ago(5) }, wm({ lastState: 'working' }));
  expect(first.action).toBe('crash');
  expect(first.nextWatermark.lastState).toBe('dead');
  // already reported dead → no re-fire
  expect(ev({ claudeState: 'dead', updatedAt: ago(5) }, wm({ lastState: 'dead' })).action).toBe('none');
});

test('watchdog: stalls when idle beyond the threshold, de-duped per activity', () => {
  // idle 700s > 600s threshold, fresh activity → stall
  const stalled = ev({ claudeState: 'working', updatedAt: ago(700), result: null });
  expect(stalled.action).toBe('stall');
  expect(stalled.reason).toBe('700s');
  expect(stalled.nextWatermark.lastStallActivity).toBe(Date.parse(ago(700)));

  // same activity timestamp already fired → no re-fire
  const again = ev(
    { claudeState: 'working', updatedAt: ago(700) },
    wm({ lastStallActivity: Date.parse(ago(700)) })
  );
  expect(again.action).toBe('none');

  // within threshold → no stall
  expect(ev({ claudeState: 'working', updatedAt: ago(120) }).action).toBe('none');
  // a dead worker is a crash, never a stall
  expect(ev({ claudeState: 'dead', updatedAt: ago(700) }, wm({ lastState: 'dead' })).action).toBe('none');
});

test('watchdog: none advances lastState', () => {
  const d = ev({ claudeState: 'working', updatedAt: ago(5) }, wm({ lastState: 'idle' }));
  expect(d.action).toBe('none');
  expect(d.nextWatermark.lastState).toBe('working');
});
