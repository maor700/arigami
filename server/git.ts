import fs from 'node:fs';
import path from 'node:path';
import { HOME } from './lib/platform.js';

// Local copy of state.ts's untildify — kept here so git helpers don't import the
// state singleton (and so test files can import git.js without racing the
// ARIGAMI_STATE_FILE binding, per the convention in test/listeners.test.js).
const untildify = (p: string | null | undefined): string | null | undefined =>
  p && p.startsWith('~') ? path.join(HOME, p.slice(1)) : p;

// ---- Type Definitions ----

interface GitResult {
  out: string;
  code: number;
}

interface FileStat {
  additions: number | null;
  deletions: number | null;
}

interface ChangesFile {
  path: string;
  status: string;
  staged: boolean;
  additions: number | null;
  deletions: number | null;
  // 'work' mode only: whether this file's delta includes a committed part
  // (differs between base and HEAD) and/or a working-tree part (unstaged,
  // staged, or untracked). A file can be both — committed once, then edited
  // again without a new commit.
  committed?: boolean;
  uncommitted?: boolean;
}

interface PRStatusResult {
  available: boolean;
  branch: string | null;
  defaultBranch?: string | null;
  baseRef?: string | null;
  // true when baseRef had to fall back to origin/<default> because no local
  // ref of that name exists — the UI flags this so a stale remote base isn't
  // silently trusted.
  baseIsRemote?: boolean;
  mergeBase?: string;
  headSha?: string;
  ahead?: number;
  reason?: string;
  error?: string;
}

interface ChangesForResult {
  worktree: string | null;
  branch: string | null;
  mode: 'pr' | 'uncommitted' | 'work';
  files: ChangesFile[];
  baseRef?: string | null;
  baseIsRemote?: boolean;
  // 'work' mode only: whether baseRef came from the session's stamped
  // metadata.base or the repo's ordinary default-branch resolution.
  baseSource?: 'metadata' | 'default';
  defaultBranch?: string | null;
  mergeBase?: string;
  headSha?: string;
  ahead?: number;
  identity?: string;
  // Distinguishes an empty file list: a real git/worktree failure (see
  // `error`) vs. a clean tree vs. a branch with no commits yet at all.
  emptyReason?: 'no-repo' | 'no-worktree' | 'unborn' | 'clean';
  error?: string;
}

interface ChangeDiffResult {
  path?: string;
  mode?: 'pr' | 'uncommitted' | 'work';
  diff?: string;
  error?: string;
}

interface WorktreeInfoResult {
  dir: string | null;
  branch: string | null;
  linked: boolean;
}

interface Session {
  metadata?: Record<string, unknown>;
  cwd: string;
}

// ---- Git Helper ----

async function git(cwd: string, args: string[]): Promise<GitResult> {
  const proc = Bun.spawn(['git', '-C', cwd, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const code = await proc.exited;
  return { out, code };
}

// ---- Worktree mutation (dispatcher) ----

// A git worktree is a sibling directory, not a subdirectory of the parent
// checkout, so Bun's node_modules resolution never climbs into it — a fresh
// worktree has no node_modules anywhere until something installs one. Off
// switch for callers (tests) that create throwaway worktrees and don't want
// to pay for it. Read at call time, not module load, so tests can flip it
// mid-process.
const worktreeInstallEnabled = (): boolean => process.env.ARIGAMI_WORKTREE_INSTALL !== '0';

interface DepInstallResult {
  ran: boolean;
  ok: boolean;
  error?: string;
}

interface WorktreeAddResult {
  ok: boolean;
  dir: string;
  branch: string;
  base: string;
  error?: string;
  // Present only when the install step ran (worktreeInstallEnabled()); one
  // entry per location that has a package.json (root and/or web/). Absent
  // entries had none to install.
  install?: { root?: DepInstallResult; web?: DepInstallResult };
}

// `bun install --frozen-lockfile` in `dir`, skipped (ran:false) when there's
// no package.json there — a worktree may only have one at the root, only
// under web/, both, or neither. Measured at ~0.3s per location since Bun
// hardlinks from its global cache, so this never blocks worktree creation
// for long; a failure here is reported, not thrown, so a worktree without
// dependencies is still handed back usable.
async function installDeps(dir: string): Promise<DepInstallResult> {
  if (!fs.existsSync(path.join(dir, 'package.json'))) return { ran: false, ok: true };
  const proc = Bun.spawn(['bun', 'install', '--frozen-lockfile'], {
    cwd: dir,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return code === 0
    ? { ran: true, ok: true }
    : { ran: true, ok: false, error: stderr.trim() || `bun install failed (${code})` };
}

// Resolve the repo a worker should branch off. The dispatcher passes the master's
// cwd (or worktree) as the parent repo root; we resolve its common git dir so the
// new worktree attaches to the same repository even when the parent is itself a
// linked worktree.
export async function repoCommonRoot(dir: string): Promise<string | null> {
  if ((await git(dir, ['rev-parse', '--is-inside-work-tree'])).code !== 0)
    return null;
  const toplevel = await git(dir, ['rev-parse', '--show-toplevel']);
  return toplevel.code === 0 ? toplevel.out.trim() || null : null;
}

// `git worktree add` a fresh branch off `base`, used to isolate a mutating worker.
// Returns the absolute worktree dir + the branch name. Idempotent-ish: if the
// branch already exists we attach to it rather than failing the spawn.
export async function addWorktree(
  parentDir: string,
  dir: string,
  branch: string,
  base: string
): Promise<WorktreeAddResult> {
  const root = await repoCommonRoot(parentDir);
  const fail = (error: string): WorktreeAddResult => ({
    ok: false,
    dir,
    branch,
    base,
    error,
  });
  if (!root) return fail(`not a git repository: ${parentDir}`);
  // Pick a base ref that actually resolves — caller's branch, then origin/<base>,
  // then <base> — so a worktree off "main" works whether or not it's checked out.
  let baseRef = base;
  for (const cand of [base, `origin/${base}`]) {
    if ((await git(root, ['rev-parse', '--verify', '--quiet', cand])).code === 0) {
      baseRef = cand;
      break;
    }
  }
  const branchExists =
    (await git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]))
      .code === 0;
  const args = branchExists
    ? ['worktree', 'add', dir, branch]
    : ['worktree', 'add', '-b', branch, dir, baseRef];
  const r = await git(root, args);
  if (r.code !== 0) return fail(r.out.trim() || `git worktree add failed (${r.code})`);
  if (!worktreeInstallEnabled()) return { ok: true, dir, branch, base: baseRef };
  const [rootInstall, webInstall] = await Promise.all([
    installDeps(dir),
    installDeps(path.join(dir, 'web')),
  ]);
  const install: WorktreeAddResult['install'] = {};
  if (rootInstall.ran) install.root = rootInstall;
  if (webInstall.ran) install.web = webInstall;
  return { ok: true, dir, branch, base: baseRef, install };
}

export async function removeWorktree(
  parentDir: string,
  dir: string
): Promise<{ ok: boolean; error?: string }> {
  const root = (await repoCommonRoot(parentDir)) || parentDir;
  const r = await git(root, ['worktree', 'remove', '--force', dir]);
  if (r.code !== 0) return { ok: false, error: r.out.trim() };
  await git(root, ['worktree', 'prune']);
  return { ok: true };
}

// ---- Validators ----

export function safeRelPath(relPath: string | null | undefined): string | null {
  if (!relPath || typeof relPath !== 'string') return null;
  if (path.isAbsolute(relPath)) return null;
  const norm = path.normalize(relPath);
  if (path.isAbsolute(norm)) return null;
  if (
    norm === '..' ||
    norm.startsWith('../') ||
    norm.split('/').includes('..')
  )
    return null;
  return norm;
}

// `s` lets an omitted mode default to 'work' for a host-managed child worktree
// (metadata.base + metadata.worktree, stamped by F7's hostWorktree) — the only
// view that shows what the child actually did. A plain session (no base) still
// defaults to 'uncommitted', unchanged from before this mode existed.
export function safeMode(
  mode: string | null | undefined,
  s?: Session
): 'pr' | 'uncommitted' | 'work' {
  if (mode === 'pr' || mode === 'uncommitted' || mode === 'work') return mode;
  if (s?.metadata?.base && s?.metadata?.worktree) return 'work';
  return 'uncommitted';
}

// ---- Helpers ----

function djb2(str: string): string {
  let h = 5381;
  for (let i = 0; i < str.length; i++)
    h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

async function resolveBaseRef(cwd: string): Promise<{
  defaultBranch: string | null;
  baseRef: string | null;
  baseIsRemote: boolean;
}> {
  let def: string | null = null;
  const oh = await git(cwd, [
    'symbolic-ref',
    '--quiet',
    '--short',
    'refs/remotes/origin/HEAD',
  ]);
  if (oh.code === 0) def = oh.out.trim().replace(/^origin\//, '');
  if (!def) {
    for (const cand of ['main', 'master']) {
      if (
        (await git(cwd, ['rev-parse', '--verify', '--quiet', cand])).code ===
        0
      ) {
        def = cand;
        break;
      }
    }
  }
  if (!def) return { defaultBranch: null, baseRef: null, baseIsRemote: false };
  // Prefer the LOCAL branch — even when it's ahead of origin, it's the truth
  // on this host. Fall back to origin/<def> only when no local ref of that
  // name exists, and say so (baseIsRemote) so a stale remote base is never
  // silently trusted as if it were current.
  if (
    (await git(cwd, ['rev-parse', '--verify', '--quiet', def])).code === 0
  ) {
    return { defaultBranch: def, baseRef: def, baseIsRemote: false };
  }
  if (
    (await git(cwd, ['rev-parse', '--verify', '--quiet', `origin/${def}`]))
      .code === 0
  ) {
    return { defaultBranch: def, baseRef: `origin/${def}`, baseIsRemote: true };
  }
  return { defaultBranch: def, baseRef: null, baseIsRemote: false };
}

// 'work' mode's base: prefer the session's stamped metadata.base (a LOCAL ref
// name — F7's hostWorktree records exactly what it branched off) over the
// repo's ordinary default-branch resolution. Only fall back to origin/<base>
// when the local ref is gone, and only fall back to the repo default when
// metadata.base itself resolves nowhere (e.g. its branch was deleted).
async function resolveWorkBase(
  s: Session,
  cwd: string
): Promise<{
  baseRef: string | null;
  defaultBranch: string | null;
  baseIsRemote: boolean;
  baseSource: 'metadata' | 'default';
}> {
  const metaBase = s.metadata?.base ? String(s.metadata.base) : null;
  if (metaBase) {
    if (
      (await git(cwd, ['rev-parse', '--verify', '--quiet', metaBase])).code === 0
    ) {
      return { baseRef: metaBase, defaultBranch: metaBase, baseIsRemote: false, baseSource: 'metadata' };
    }
    const remote = `origin/${metaBase}`;
    if (
      (await git(cwd, ['rev-parse', '--verify', '--quiet', remote])).code === 0
    ) {
      return { baseRef: remote, defaultBranch: metaBase, baseIsRemote: true, baseSource: 'metadata' };
    }
  }
  const d = await resolveBaseRef(cwd);
  return { baseRef: d.baseRef, defaultBranch: d.defaultBranch, baseIsRemote: d.baseIsRemote, baseSource: 'default' };
}

// ---- PR & Changes ----

export async function prStatus(s: Session): Promise<PRStatusResult> {
  const cwd = untildify(
    (s.metadata?.worktree as string) || s.cwd
  );
  if (!cwd) return { available: false, branch: null, error: 'no worktree' };
  try {
    if (
      (await git(cwd, ['rev-parse', '--is-inside-work-tree'])).code !== 0
    ) {
      return { available: false, branch: null, error: 'not a git repository' };
    }
    const branch =
      (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).out.trim() ||
      null;
    const { defaultBranch, baseRef, baseIsRemote } = await resolveBaseRef(cwd);
    if (!baseRef)
      return { available: false, branch, defaultBranch, reason: 'no base branch' };
    const mergeBase = (await git(cwd, ['merge-base', baseRef, 'HEAD'])).out.trim();
    if (!mergeBase)
      return {
        available: false,
        branch,
        defaultBranch,
        baseRef,
        baseIsRemote,
        reason: 'no common history',
      };
    const headSha = (await git(cwd, ['rev-parse', 'HEAD'])).out.trim();
    const ahead =
      Number(
        (await git(cwd, ['rev-list', '--count', `${mergeBase}..HEAD`])).out.trim()
      ) || 0;
    return { available: true, branch, defaultBranch, baseRef, baseIsRemote, mergeBase, headSha, ahead };
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    return { available: false, branch: null, error: error.message };
  }
}

// Committed range: how `base` differs from `head` (name-status + numstat).
// Shared by 'pr' mode (base = the default branch) and 'work' mode (base =
// metadata.base).
async function committedDiff(
  cwd: string,
  base: string,
  head: string
): Promise<ChangesFile[]> {
  const stat = new Map<string, FileStat>();
  for (const line of (await git(cwd, ['diff', '--numstat', base, head]))
    .out.split('\n')) {
    if (!line.trim()) continue;
    const [a, d, ...rest] = line.split('\t');
    stat.set(rest.join('\t'), {
      additions: a === '-' ? null : Number(a) || 0,
      deletions: d === '-' ? null : Number(d) || 0,
    });
  }
  const files: ChangesFile[] = [];
  for (const line of (await git(cwd, ['diff', '--name-status', base, head]))
    .out.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const p = parts[parts.length - 1];
    const n = stat.get(p);
    files.push({
      path: p,
      status: parts[0][0],
      staged: false,
      additions: n ? n.additions : null,
      deletions: n ? n.deletions : null,
    });
  }
  return files;
}

// Working tree: unstaged + staged + untracked, vs HEAD/the index. Shared by
// 'uncommitted' mode (the whole story) and 'work' mode (the part on top of
// the committed range).
async function workingTreeDiff(cwd: string): Promise<ChangesFile[]> {
  const stat = new Map<string, FileStat>();
  for (const args of [['diff', '--numstat'], ['diff', '--cached', '--numstat']]) {
    const { out } = await git(cwd, args);
    for (const line of out.split('\n')) {
      if (!line.trim()) continue;
      const [a, d, ...rest] = line.split('\t');
      const p = rest.join('\t');
      const prev = stat.get(p) || { additions: 0, deletions: 0 };
      prev.additions = (prev.additions ?? 0) + (a === '-' ? 0 : Number(a) || 0);
      prev.deletions = (prev.deletions ?? 0) + (d === '-' ? 0 : Number(d) || 0);
      stat.set(p, prev);
    }
  }
  const { out: porc } = await git(cwd, [
    'status',
    '--porcelain=v1',
    '-uall',
  ]);
  const files: ChangesFile[] = [];
  for (const line of porc.split('\n')) {
    if (!line) continue;
    const X = line[0];
    const Y = line[1];
    let p = line.slice(3);
    if (p.includes(' -> ')) p = p.split(' -> ')[1];
    const untracked = X === '?';
    const staged = !untracked && X !== ' ';
    const status = untracked ? '??' : staged ? X : Y;
    const n = stat.get(p);
    files.push({
      path: p,
      status,
      staged,
      additions: n ? n.additions : null,
      deletions: n ? n.deletions : null,
    });
  }
  return files;
}

function workingTreeIdentity(files: ChangesFile[]): string {
  return djb2(
    files
      .map((f) => `${f.path}:${f.status}:${f.additions}:${f.deletions}`)
      .join('|')
  );
}

// null means "binary / unknown" (git prints "-" for numstat on binary files)
// — keep that distinct from a real 0, so a binary file with further text-only
// edits on top doesn't silently report 0 added/removed lines.
function sumOrNull(a: number | null, b: number | null): number | null {
  if (a == null && b == null) return null;
  if (a == null) return b;
  if (b == null) return a;
  return a + b;
}

export async function changesFor(
  s: Session,
  mode: string | null | undefined
): Promise<ChangesForResult> {
  const m = safeMode(mode, s);
  const cwd = untildify(
    (s.metadata?.worktree as string) || s.cwd
  );
  if (!cwd)
    return {
      worktree: null,
      branch: null,
      mode: m,
      files: [],
      error: 'no worktree',
      emptyReason: 'no-worktree',
    };
  try {
    if (
      (await git(cwd, ['rev-parse', '--is-inside-work-tree'])).code !== 0
    ) {
      return {
        worktree: cwd,
        branch: null,
        mode: m,
        files: [],
        error: 'not a git repository',
        emptyReason: 'no-repo',
      };
    }
    const branch =
      (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).out.trim() ||
      null;
    const hasCommits =
      (await git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD'])).code === 0;

    if (m === 'pr') {
      if (!hasCommits)
        return { worktree: cwd, branch, mode: 'pr', files: [], emptyReason: 'unborn' };
      const st = await prStatus(s);
      if (!st.available) {
        return {
          worktree: cwd,
          branch,
          mode: 'pr',
          files: [],
          baseRef: st.baseRef || null,
          baseIsRemote: st.baseIsRemote,
          defaultBranch: st.defaultBranch || null,
          error: st.reason || st.error || 'PR diff unavailable',
        };
      }
      const mb = st.mergeBase!;
      const files = await committedDiff(cwd, mb, 'HEAD');
      return {
        worktree: cwd,
        branch,
        mode: 'pr',
        files,
        baseRef: st.baseRef,
        baseIsRemote: st.baseIsRemote,
        defaultBranch: st.defaultBranch,
        mergeBase: mb,
        headSha: st.headSha,
        ahead: st.ahead,
        identity: `pr:${mb}..${st.headSha}`,
        emptyReason: files.length === 0 ? 'clean' : undefined,
      };
    }

    if (m === 'work') {
      if (!hasCommits)
        return { worktree: cwd, branch, mode: 'work', files: [], emptyReason: 'unborn' };
      const wb = await resolveWorkBase(s, cwd);
      if (!wb.baseRef)
        return {
          worktree: cwd,
          branch,
          mode: 'work',
          files: [],
          defaultBranch: wb.defaultBranch,
          error: 'no base branch',
        };
      const mergeBase = (await git(cwd, ['merge-base', wb.baseRef, 'HEAD'])).out.trim();
      if (!mergeBase)
        return {
          worktree: cwd,
          branch,
          mode: 'work',
          files: [],
          baseRef: wb.baseRef,
          baseIsRemote: wb.baseIsRemote,
          baseSource: wb.baseSource,
          defaultBranch: wb.defaultBranch,
          error: 'no common history',
        };
      const headSha = (await git(cwd, ['rev-parse', 'HEAD'])).out.trim();
      const ahead =
        Number(
          (await git(cwd, ['rev-list', '--count', `${mergeBase}..HEAD`])).out.trim()
        ) || 0;

      const committed = await committedDiff(cwd, mergeBase, 'HEAD');
      const uncommitted = await workingTreeDiff(cwd);

      const map = new Map<string, ChangesFile>();
      for (const f of committed) map.set(f.path, { ...f, committed: true, uncommitted: false });
      for (const f of uncommitted) {
        const prev = map.get(f.path);
        map.set(
          f.path,
          prev
            ? {
                ...prev,
                uncommitted: true,
                status: f.status, // the live status wins — it reflects the current tree
                staged: f.staged,
                additions: sumOrNull(prev.additions, f.additions),
                deletions: sumOrNull(prev.deletions, f.deletions),
              }
            : { ...f, committed: false, uncommitted: true }
        );
      }
      const files = [...map.values()];
      return {
        worktree: cwd,
        branch,
        mode: 'work',
        files,
        baseRef: wb.baseRef,
        baseIsRemote: wb.baseIsRemote,
        baseSource: wb.baseSource,
        defaultBranch: wb.defaultBranch,
        mergeBase,
        headSha,
        ahead,
        identity: `work:${mergeBase}..${headSha}:${workingTreeIdentity(uncommitted)}`,
        emptyReason: files.length === 0 ? 'clean' : undefined,
      };
    }

    const files = await workingTreeDiff(cwd);
    const identity = 'unc:' + workingTreeIdentity(files);
    return {
      worktree: cwd,
      branch,
      mode: 'uncommitted',
      files,
      identity,
      emptyReason: files.length === 0 ? (hasCommits ? 'clean' : 'unborn') : undefined,
    };
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    return {
      worktree: cwd,
      branch: null,
      mode: m,
      files: [],
      error: error.message,
    };
  }
}

export async function changeIdentity(
  s: Session,
  mode: string | null | undefined
): Promise<string | null> {
  return (await changesFor(s, mode)).identity || null;
}

export async function changeDiff(
  s: Session,
  relPath: string | null | undefined,
  mode: string | null | undefined
): Promise<ChangeDiffResult> {
  const m = safeMode(mode, s);
  const cwd = untildify(
    (s.metadata?.worktree as string) || s.cwd
  );
  if (!cwd) return { error: 'no worktree' };
  const safe = safeRelPath(relPath);
  if (!safe) return { error: 'invalid path' };
  try {
    if (m === 'pr') {
      const st = await prStatus(s);
      if (!st.available)
        return {
          path: safe,
          mode: 'pr',
          error:
            st.reason || st.error || 'PR diff unavailable',
        };
      const { out } = await git(cwd, [
        'diff',
        st.mergeBase!,
        'HEAD',
        '--',
        safe,
      ]);
      return { path: safe, mode: 'pr', diff: out };
    }
    if (m === 'work') {
      const wb = await resolveWorkBase(s, cwd);
      if (!wb.baseRef) return { path: safe, mode: 'work', error: 'no base branch' };
      const mergeBase = (await git(cwd, ['merge-base', wb.baseRef, 'HEAD'])).out.trim();
      if (!mergeBase) return { path: safe, mode: 'work', error: 'no common history' };
      // base vs the WORKING TREE (not HEAD) — this single diff already covers
      // both the committed range and any uncommitted edits on top.
      let { out } = await git(cwd, ['diff', mergeBase, '--', safe]);
      if (!out.trim()) {
        out = (await git(cwd, [
          'diff',
          '--no-index',
          '--',
          '/dev/null',
          safe,
        ])).out;
      }
      return { path: safe, mode: 'work', diff: out };
    }
    let { out } = await git(cwd, ['diff', 'HEAD', '--', safe]);
    if (!out.trim()) {
      out = (await git(cwd, [
        'diff',
        '--no-index',
        '--',
        '/dev/null',
        safe,
      ])).out;
    }
    return { path: safe, mode: 'uncommitted', diff: out };
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    return { path: safe, error: error.message };
  }
}

export async function worktreeInfo(
  s: Session
): Promise<WorktreeInfoResult> {
  const dir = untildify(
    (s.metadata?.worktree as string) || s.cwd
  );
  if (!dir) return { dir: null, branch: null, linked: false };
  try {
    if (
      (await git(dir, ['rev-parse', '--is-inside-work-tree'])).code !== 0
    ) {
      return { dir, branch: null, linked: false };
    }
    const gd = (await git(dir, ['rev-parse', '--git-dir'])).out.trim();
    const common = (await git(dir, ['rev-parse', '--git-common-dir'])).out.trim();
    const linked = !!gd && !!common && gd !== common;
    const br = await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
    return {
      dir,
      branch: br.code === 0 ? br.out.trim() : null,
      linked,
    };
  } catch {
    return { dir, branch: null, linked: false };
  }
}

// ---- Host-managed worktrees for FULL children (F7) ----
// `<reposDir>/<repo>-wt-<subtask>` on branch `<prefix>/<subtask>-<id>` off
// `base`. Shared by wireWorker (dispatch) and wireFullChild (project folders):
// the host creates it BEFORE the child starts so its Changes tab shows the
// child's diff without any child action. Pure git — no state import.
export interface ProvisionOpts {
  parentDir: string;           // any dir inside the repo (master's cwd/worktree)
  subtask: string;             // already sanitized by the caller
  prefix?: string;             // branch prefix (default 'child')
  base?: string | null;        // ref to fork off (default: parentDir's branch)
  dir?: string | null;         // explicit worktree path (default derived)
  reposDir?: string | null;    // where derived dirs go (default: repo's parent dir)
  suffix?: string | null;      // uniqueness suffix for the branch/dir (default nano-ish)
  branch?: string | null;      // explicit branch name (dispatch keeps `dispatch/<subtask>`)
}
export interface ProvisionResult extends WorktreeAddResult {
  root?: string;
}

export async function provisionChildWorktree(o: ProvisionOpts): Promise<ProvisionResult> {
  const root = await repoCommonRoot(o.parentDir);
  if (!root)
    return { ok: false, dir: o.dir || '', branch: '', base: o.base || '', error: `not a git repository: ${o.parentDir}` };
  const suffix = o.suffix || Math.random().toString(36).slice(2, 6);
  const safe = o.subtask.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 40) || 'work';
  let base = o.base || null;
  if (!base) {
    const br = await git(o.parentDir, ['rev-parse', '--abbrev-ref', 'HEAD']);
    base = br.code === 0 && br.out.trim() && br.out.trim() !== 'HEAD' ? br.out.trim() : 'main';
  }
  const branch = o.branch || `${o.prefix || 'child'}/${safe}-${suffix}`;
  let dir = o.dir ? untildify(o.dir)! : '';
  if (!dir) {
    const repoName = path.basename(root);
    const parent = o.reposDir ? untildify(o.reposDir)! : path.dirname(root);
    dir = path.join(parent, `${repoName}-wt-${safe}`);
    if (fs.existsSync(dir)) dir = `${dir}-${suffix}`;
  }
  const r = await addWorktree(root, dir, branch, base);
  return { ...r, root };
}
