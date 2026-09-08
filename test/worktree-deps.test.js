// A git worktree is a sibling directory, not a subdirectory of the parent
// checkout, so a fresh one has no node_modules anywhere until addWorktree()
// installs it. These tests run against THIS repo (the worktree bun test is
// executing in) because it's the one with a real package.json + bun.lock at
// both the root and web/ — a synthetic fixture repo has neither, so it can't
// exercise the install path.
import { test, expect, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { addWorktree, removeWorktree } = await import('../server/git.js');

const parentDir = process.cwd();
const created = [];

afterEach(async () => {
  delete process.env.ARIGAMI_WORKTREE_INSTALL;
  while (created.length) {
    const dir = created.pop();
    await removeWorktree(parentDir, dir);
  }
});

function newWorktreeDir(tag) {
  const dir = path.join(os.tmpdir(), `wt-deps-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  created.push(dir);
  return dir;
}

test('addWorktree installs deps into root and web/ node_modules', async () => {
  const dir = newWorktreeDir('on');
  const r = await addWorktree(parentDir, dir, `test/wt-deps-on-${Date.now()}`, 'HEAD');
  expect(r.ok).toBe(true);
  expect(fs.existsSync(path.join(dir, 'node_modules'))).toBe(true);
  expect(fs.existsSync(path.join(dir, 'web', 'node_modules'))).toBe(true);
  expect(r.install?.root?.ran).toBe(true);
  expect(r.install?.root?.ok).toBe(true);
  expect(r.install?.web?.ran).toBe(true);
  expect(r.install?.web?.ok).toBe(true);
});

test('ARIGAMI_WORKTREE_INSTALL=0 skips dependency install', async () => {
  process.env.ARIGAMI_WORKTREE_INSTALL = '0';
  const dir = newWorktreeDir('off');
  const r = await addWorktree(parentDir, dir, `test/wt-deps-off-${Date.now()}`, 'HEAD');
  expect(r.ok).toBe(true);
  expect(r.install).toBeUndefined();
  expect(fs.existsSync(path.join(dir, 'node_modules'))).toBe(false);
  expect(fs.existsSync(path.join(dir, 'web', 'node_modules'))).toBe(false);
});
