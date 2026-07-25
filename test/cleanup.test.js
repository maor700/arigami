// cleanupPlan must never derive an rm-rf plan for a dispatch WORKER from the
// on-disk worktree: a read-only worker runs IN the master's worktree, so the
// worktreeInfo fallback would target the master's live workspace and destroy a
// sibling session (a real incident). Only an explicit recorded cleanup
// (mutating workers) is removable. Runs in a child because api.js pulls in
// state.js and would otherwise pollute the shared state-file path.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInChild } from './_child.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-cleanup-'));
const r = runInChild(
  "const api=await import('./server/api.js');" +
    "const ro=await api.cleanupPlan({metadata:{role:'worker',kind:'readonly'},cwd:'/some/master/worktree'});" +
    "const mut=await api.cleanupPlan({metadata:{role:'worker',kind:'mutating'},cwd:'/some/master/worktree'});" +
    "const rec=await api.cleanupPlan({metadata:{role:'worker',kind:'mutating',cleanup:['git worktree remove --force /tmp/wt'],worktree:'/tmp/wt',branch:'dispatch/x'},cwd:'/tmp/wt'});" +
    "emit({ro,mut,rec});",
  { ARIGAMI_DIR: dir, ARIGAMI_STATE_FILE: path.join(dir, 'state.json') }
);

test('child computed all three cleanup plans', () => {
  expect(r.ok).toBe(true);
});

test('read-only worker is never removable (no worktree fallback)', () => {
  expect(r.out[0].ro.removable).toBe(false);
  expect(r.out[0].ro.cmds).toEqual([]);
  expect(r.out[0].ro.worktree).toBeNull();
});

test('worker with no recorded cleanup is never removable', () => {
  expect(r.out[0].mut.removable).toBe(false);
});

test('worker WITH a recorded cleanup uses exactly the recorded commands', () => {
  expect(r.out[0].rec.removable).toBe(true);
  expect(r.out[0].rec.recorded).toBe(true);
  expect(r.out[0].rec.cmds).toEqual(['git worktree remove --force /tmp/wt']);
});
