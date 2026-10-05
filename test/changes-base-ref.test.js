// The Changes tab must diff against origin/<default branch> by default — a
// stale local main once made a PR review show 225 files vs GitHub's 14 — and
// accept an explicit user-chosen base.
import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { changesFor, changeDiff, listBaseRefs, prStatus } = await import(path.join(ROOT, 'server/git.ts'));

const run = (cwd, cmd) => {
  const r = Bun.spawnSync(['bash', '-c', cmd], { cwd });
  if (r.exitCode !== 0) throw new Error(`${cmd}: ${r.stderr}`);
};

// origin has main = A,B ; local main is stale at A ; feature branches off B.
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'chgbase-'));
  const origin = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  run(root, `git init -q --bare -b main ${origin} && git clone -q ${origin} work`);
  const g = 'git -c user.email=t@t -c user.name=t';
  writeFileSync(path.join(work, 'a.txt'), 'a');
  run(work, `git add . && ${g} commit -qm A && git push -q origin main`);
  writeFileSync(path.join(work, 'b.txt'), 'b');
  run(work, `git add . && ${g} commit -qm B && git push -q origin main && git reset -q --hard HEAD~1`);
  run(work, `git fetch -q && git checkout -q -b feat origin/main`);
  writeFileSync(path.join(work, 'c.txt'), 'c');
  run(work, `git add . && ${g} commit -qm C`);
  return { cwd: work, s: { cwd: work, metadata: {} } };
}

test('default base is origin/<default>, not the stale local main', async () => {
  const { s } = fixture();
  const r = await changesFor(s, 'pr');
  expect(r.baseRef).toBe('origin/main');
  expect(r.baseIsRemote).toBe(true);
  expect(r.files.map((f) => f.path)).toEqual(['c.txt']);
});

test('explicit base override wins; invalid/unsafe overrides fall back to the default', async () => {
  const { s } = fixture();
  const local = await changesFor(s, 'pr', 'main');
  expect(local.baseRef).toBe('main');
  expect(local.files.map((f) => f.path).sort()).toEqual(['b.txt', 'c.txt']);
  for (const bad of ['--output=/tmp/x', 'nope/missing', 'main..feat', '']) {
    expect((await changesFor(s, 'pr', bad)).baseRef).toBe('origin/main');
  }
  expect((await prStatus(s, 'main')).baseRef).toBe('main');
});

test('listBaseRefs lists local and remote branches and the default ref', async () => {
  const { s } = fixture();
  const refs = await listBaseRefs(s);
  expect(refs.local).toEqual(expect.arrayContaining(['main', 'feat']));
  expect(refs.remote).toContain('origin/main');
  expect(refs.remote).not.toContain('origin/HEAD');
  expect(refs.defaultRef).toBe('origin/main');
});

test('a PR session\'s metadata.prBase is the default base — not the repo default branch', async () => {
  const { cwd } = fixture();
  // a release branch that the PR targets, 1 commit ahead of origin/main
  run(cwd, 'git checkout -q -b release origin/main && echo r > r.txt && git add . && git -c user.email=t@t -c user.name=t commit -qm R && git push -q origin release && git checkout -q feat');
  const s = { cwd, metadata: { prBase: 'release' } };
  const r = await changesFor(s, 'pr');
  expect(r.baseRef).toBe('origin/release');
  // Compare with the merge-base: release-only changes must not appear as deletions.
  expect(r.files.map(f => f.path)).toEqual(['c.txt']);
  const plain = await changesFor({ cwd, metadata: {} }, 'pr');
  expect(plain.baseRef).toBe('origin/main');
  expect((await listBaseRefs(s)).defaultRef).toBe('origin/release');
  // An unavailable recorded target must not silently become main.
  expect((await changesFor({ cwd, metadata: { prBase: 'nope' } }, 'pr')).baseRef).toBeNull();
});

test('child PR and work views share the original local parent, even when origin is stale', async () => {
  const { cwd } = fixture();
  run(cwd, 'git branch parent && git worktree add -q -b child ../child parent');
  const child = path.join(cwd, '../child');
  run(child, 'echo child > child.txt && git add . && git -c user.email=t@t -c user.name=t commit -qm child');
  const s = { cwd, metadata: { worktree: child, base: 'parent' } };
  for (const mode of ['pr', 'work']) {
    const result = await changesFor(s, mode);
    expect(result.baseRef).toBe('parent');
    expect(result.files.map(f => f.path)).toEqual(['child.txt']);
    expect((await changeDiff(s, 'child.txt', mode)).diff).toContain('+child');
  }
  expect((await listBaseRefs(s)).defaultRef).toBe('parent');
});

test('PR target wins over child base in both modes and excludes target-only commits', async () => {
  const { cwd } = fixture();
  run(cwd, 'git branch parent main && git checkout -q -b release origin/main && echo r > r.txt && git add . && git -c user.email=t@t -c user.name=t commit -qm R && git push -q origin release && git checkout -q feat');
  const s = { cwd, metadata: { worktree: cwd, base: 'parent', prBase: 'release' } };
  for (const mode of ['pr', 'work']) {
    const result = await changesFor(s, mode);
    expect(result.baseRef).toBe('origin/release');
    expect(result.files.map(f => f.path)).toEqual(['c.txt']);
  }
});

test('missing recorded child base is unavailable, while an explicit override still works', async () => {
  const { cwd } = fixture();
  const s = { cwd, metadata: { base: 'deleted-parent', worktree: cwd } };
  for (const mode of ['pr', 'work']) {
    expect((await changesFor(s, mode)).error).toBe('no base branch');
    expect((await changesFor(s, mode, 'origin/main')).files.map(f => f.path)).toEqual(['c.txt']);
  }
  expect((await listBaseRefs(s)).defaultRef).toBeNull();
});
