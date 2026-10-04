// CHG1 — the Changes tab must show what a host-managed child actually did.
// Repro (see SPEC-ARIGAMI-CHANGES-TAB.md): 'uncommitted' mode shows only the
// working tree (0 files once a child commits, which every dispatch child
// does); 'pr' mode resolved its base to origin/<default>, which lands on a
// stale merge-base once local master has moved on without a push, showing
// everything merged into master since — not the child's own work. This file
// covers the fix: a 'work' mode (metadata.base..HEAD + working tree, LOCAL
// ref only) and honest base resolution (origin/<default> preferred for 'pr',
// local only as a fallback or explicit user pick) for 'pr' too.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { changesFor, changeDiff, changeIdentity, prStatus, safeMode, provisionChildWorktree, removeWorktree } =
  await import('../server/git.js');

const out = (b: Buffer) => Buffer.from(b).toString().trim();
function sh(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'pipe' });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(' ')} → ${out(p.stderr)}`);
  return out(p.stdout);
}
function write(dir: string, file: string, content: string) {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), content);
}
function commit(dir: string, file: string, content: string, msg: string) {
  write(dir, file, content);
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', msg);
}
function initRepo(dir: string, branch = 'master') {
  fs.mkdirSync(dir, { recursive: true });
  sh(dir, 'init', '-q', '-b', branch);
  sh(dir, 'config', 'user.email', 't@t.io');
  sh(dir, 'config', 'user.name', 'T');
}

let repos: string, origin: string, main: string;

beforeAll(() => {
  repos = fs.mkdtempSync(path.join(os.tmpdir(), 'chg1-'));
  origin = path.join(repos, 'origin');
  initRepo(origin);
  commit(origin, 'README.md', '# hi\n', 'init');

  main = path.join(repos, 'main');
  sh(repos, 'clone', '-q', origin, main);
  sh(main, 'config', 'user.email', 't@t.io');
  sh(main, 'config', 'user.name', 'T');
});
afterAll(() => { try { fs.rmSync(repos, { recursive: true, force: true }); } catch {} });

// A session shape as git.ts sees it: {metadata:{worktree,base,...}, cwd}.
const sessionFor = (worktree: string, base?: string) => ({
  metadata: { worktree, ...(base ? { base } : {}) },
  cwd: worktree,
});

// ---- safeMode: default selection ------------------------------------------

test('safeMode: an explicit mode always wins; the default is "work" only for a session with base+worktree', () => {
  expect(safeMode('pr')).toBe('pr');
  expect(safeMode('uncommitted')).toBe('uncommitted');
  expect(safeMode('work')).toBe('work');
  expect(safeMode(null, sessionFor('/x', 'master') as any)).toBe('work');
  expect(safeMode(undefined, { metadata: { worktree: '/x' } } as any)).toBe('uncommitted'); // no base
  expect(safeMode(undefined, { metadata: { base: 'master' } } as any)).toBe('uncommitted'); // no worktree
  expect(safeMode(undefined, undefined)).toBe('uncommitted'); // no session at all
});

// ---- child with only uncommitted work --------------------------------------

test('child with only uncommitted work: "work" and "uncommitted" both show it; nothing is committed', async () => {
  const r = await provisionChildWorktree({ parentDir: main, subtask: 'only-dirty', reposDir: repos, suffix: 'c1' });
  write(r.dir, 'a.txt', 'A\n');
  const s = sessionFor(r.dir, r.base);

  const work = await changesFor(s, 'work');
  expect(work.files.map((f) => f.path)).toEqual(['a.txt']);
  expect(work.files[0]).toMatchObject({ committed: false, uncommitted: true, status: '??' });
  expect(work.ahead).toBe(0);
  expect(work.baseRef).toBe('master');
  expect(work.baseIsRemote).toBe(false);

  const unc = await changesFor(s, 'uncommitted');
  expect(unc.files.map((f) => f.path)).toEqual(['a.txt']);

  await removeWorktree(main, r.dir);
});

// ---- child with commits and a clean tree — the original bug ---------------

test('child with commits + clean tree: "uncommitted" shows 0 files (the bug), "work" shows the committed range', async () => {
  const r = await provisionChildWorktree({ parentDir: main, subtask: 'committed-clean', reposDir: repos, suffix: 'c2' });
  commit(r.dir, 'b.txt', 'B\n', 'child commit');
  const s = sessionFor(r.dir, r.base);

  const unc = await changesFor(s, 'uncommitted');
  expect(unc.files).toEqual([]);
  expect(unc.emptyReason).toBe('clean');

  const work = await changesFor(s, 'work');
  expect(work.files.map((f) => f.path)).toEqual(['b.txt']);
  expect(work.files[0]).toMatchObject({ committed: true, uncommitted: false });
  expect(work.ahead).toBe(1);
  expect(work.emptyReason).toBeUndefined();

  await removeWorktree(main, r.dir);
});

// ---- child with both committed AND uncommitted work ------------------------

test('child with both: overlapping file gets both markers and summed stats; non-overlapping files get one marker each', async () => {
  const r = await provisionChildWorktree({ parentDir: main, subtask: 'both', reposDir: repos, suffix: 'c3' });
  commit(r.dir, 'shared.txt', 'line1\n', 'commit shared');
  commit(r.dir, 'committed-only.txt', 'x\n', 'commit only');
  write(r.dir, 'shared.txt', 'line1\nline2\n'); // further uncommitted edit on top
  write(r.dir, 'uncommitted-only.txt', 'y\n');
  const s = sessionFor(r.dir, r.base);

  const work = await changesFor(s, 'work');
  const byPath = Object.fromEntries(work.files.map((f) => [f.path, f]));
  expect(byPath['shared.txt']).toMatchObject({ committed: true, uncommitted: true });
  expect(byPath['shared.txt'].additions).toBe(2); // 1 from the commit + 1 from the working-tree edit
  expect(byPath['committed-only.txt']).toMatchObject({ committed: true, uncommitted: false });
  expect(byPath['uncommitted-only.txt']).toMatchObject({ committed: false, uncommitted: true, status: '??' });
  expect(work.ahead).toBe(2);

  // the file diff for the overlapping file is base vs the WORKING TREE — both parts in one diff
  const d = await changeDiff(s, 'shared.txt', 'work');
  expect(d.diff).toContain('+line1');
  expect(d.diff).toContain('+line2');

  await removeWorktree(main, r.dir);
});

// ---- identity must move with either half of "work" --------------------------

test('work mode identity changes when the committed range changes, and separately when the working tree changes', async () => {
  const r = await provisionChildWorktree({ parentDir: main, subtask: 'identity', reposDir: repos, suffix: 'c4' });
  const s = sessionFor(r.dir, r.base);

  const id0 = await changeIdentity(s, 'work');
  commit(r.dir, 'f1.txt', '1\n', 'one');
  const id1 = await changeIdentity(s, 'work');
  expect(id1).not.toBe(id0);

  write(r.dir, 'f2.txt', 'untracked\n');
  const id2 = await changeIdentity(s, 'work');
  expect(id2).not.toBe(id1); // working tree changed, HEAD didn't

  commit(r.dir, 'f2.txt', 'untracked\n', 'two'); // same content, now committed
  const id3 = await changeIdentity(s, 'work');
  expect(id3).not.toBe(id2); // committed range moved again

  await removeWorktree(main, r.dir);
});

// ---- the case that broke: a local base that's ahead of (newer than) origin -

test('base resolution: PR mode defaults to origin/<default> (never a stale/diverged local), and an explicit base override still selects the local branch', async () => {
  // main's local master gets commits that are never pushed. The default must
  // be origin/<default> — GitHub compares against the remote — and the user
  // can still pick the local branch explicitly.
  commit(main, 'unrelated-1.txt', '1\n', 'unrelated landed on local master');
  commit(main, 'unrelated-2.txt', '2\n', 'more unrelated');
  expect(sh(main, 'rev-parse', 'master')).not.toBe(sh(main, 'rev-parse', 'origin/master'));

  const r = await provisionChildWorktree({ parentDir: main, subtask: 'stale-origin', reposDir: repos, suffix: 'c5' });
  commit(r.dir, 'child.txt', 'c\n', 'child work only');
  const s = sessionFor(r.dir, r.base);

  const st = await prStatus(s);
  expect(st.baseRef).toBe('origin/master');
  expect(st.baseIsRemote).toBe(true);

  const viaLocal = await changesFor(s, 'pr', 'master');
  expect(viaLocal.baseRef).toBe('master');
  expect(viaLocal.baseIsRemote).toBe(false);
  expect(viaLocal.files.map((f) => f.path)).toEqual(['child.txt']);

  await removeWorktree(main, r.dir);
});

test('a session with no local base ref at all falls back to origin/<default> and SAYS so (baseIsRemote)', async () => {
  const bare = path.join(repos, 'no-local-base');
  sh(repos, 'clone', '-q', origin, bare);
  sh(bare, 'config', 'user.email', 't@t.io');
  sh(bare, 'config', 'user.name', 'T');
  sh(bare, 'checkout', '-q', '--detach'); // leave master so it can be deleted
  sh(bare, 'branch', '-D', 'master'); // remove the local branch; only origin/master remains
  sh(bare, 'checkout', '-q', '-b', 'detached-work', 'origin/master');
  const s = sessionFor(bare);

  const st = await prStatus(s);
  expect(st.baseRef).toBe('origin/master');
  expect(st.baseIsRemote).toBe(true);
});

// ---- metadata.base is the source of truth for 'work', even with a different default branch ----

test('work mode prefers metadata.base over the repo default branch', async () => {
  sh(main, 'checkout', '-q', '-b', 'feature-parent');
  commit(main, 'parent-only.txt', 'p\n', 'lives only on feature-parent');
  sh(main, 'checkout', '-q', 'master'); // leave main back where other tests expect it

  const r = await provisionChildWorktree({ parentDir: main, subtask: 'meta-base', base: 'feature-parent', reposDir: repos, suffix: 'c6' });
  expect(r.base).toBe('feature-parent');
  commit(r.dir, 'child-only.txt', 'x\n', 'child work');
  const s = sessionFor(r.dir, r.base);

  const work = await changesFor(s, 'work');
  expect(work.baseRef).toBe('feature-parent');
  expect(work.baseSource).toBe('metadata');
  // must NOT include parent-only.txt (that's on feature-parent, the base) — only the child's own commit
  expect(work.files.map((f) => f.path)).toEqual(['child-only.txt']);

  await removeWorktree(main, r.dir);
});

// ---- no worktree / no repo / unborn ----------------------------------------

test('no worktree: distinct error and emptyReason, no git ever runs', async () => {
  const r = await changesFor({ metadata: {}, cwd: '' } as any, 'uncommitted');
  expect(r.error).toBe('no worktree');
  expect(r.emptyReason).toBe('no-worktree');
  expect(r.worktree).toBeNull();
});

test('not a git repository: distinct from "no worktree"', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chg1-plain-'));
  const r = await changesFor(sessionFor(dir), 'uncommitted');
  expect(r.error).toBe('not a git repository');
  expect(r.emptyReason).toBe('no-repo');
});

test('unborn branch (no commits yet): distinct from "clean" for uncommitted, work, and pr', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chg1-unborn-'));
  initRepo(dir);
  const s = sessionFor(dir, 'master');

  const unc = await changesFor(s, 'uncommitted');
  expect(unc.files).toEqual([]);
  expect(unc.emptyReason).toBe('unborn');

  const work = await changesFor(s, 'work');
  expect(work.files).toEqual([]);
  expect(work.emptyReason).toBe('unborn');

  const pr = await changesFor(s, 'pr');
  expect(pr.files).toEqual([]);
  expect(pr.emptyReason).toBe('unborn');

  // an untracked file IS something to show even before the first commit
  write(dir, 'new.txt', 'x\n');
  const unc2 = await changesFor(s, 'uncommitted');
  expect(unc2.files.map((f) => f.path)).toEqual(['new.txt']);
  expect(unc2.emptyReason).toBeUndefined();
});

test('a repo with no remote at all still resolves a local default branch for pr/work', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chg1-noremote-'));
  initRepo(dir, 'main');
  commit(dir, 'README.md', '# hi\n', 'init');
  sh(dir, 'checkout', '-q', '-b', 'work-branch');
  commit(dir, 'x.txt', 'x\n', 'work');
  const s = sessionFor(dir);

  const st = await prStatus(s);
  expect(st.available).toBe(true);
  expect(st.defaultBranch).toBe('main');
  expect(st.baseRef).toBe('main');
  expect(st.baseIsRemote).toBe(false);
});
