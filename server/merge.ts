// F7 — host-executed merge of an approved child branch into its base. Pure git,
// no state import (testable on a throwaway repo). The HOST runs this — never a
// claude turn — so responsibility is unambiguous: the child never merges, the
// human approves, then the human (one click) or the master (one tool call)
// merges through here.
import path from 'node:path';

interface GitResult { out: string; code: number }

async function git(cwd: string, args: string[]): Promise<GitResult> {
  const proc = Bun.spawn(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const code = await proc.exited;
  return { out: code === 0 ? out : (err || out), code };
}

export type MergeStrategy = 'no-ff' | 'squash';

export interface BaseStatus {
  repo: boolean;
  head: string | null;        // branch checked out in repoRoot
  checkedOut: boolean;        // head === base
  dirty: boolean;             // tracked modifications (untracked files ignored)
  dirtyFiles: string[];
  branchExists: boolean;
  ahead: number | null;       // commits on branch not in base
}

// What the UI/route need to decide "can merge?" and to explain a disabled
// button: is `base` the checkout in repoRoot, is it dirty, does `branch` exist.
export async function baseStatus(repoRoot: string, base: string, branch: string): Promise<BaseStatus> {
  const empty: BaseStatus = { repo: false, head: null, checkedOut: false, dirty: false, dirtyFiles: [], branchExists: false, ahead: null };
  if ((await git(repoRoot, ['rev-parse', '--is-inside-work-tree'])).code !== 0) return empty;
  const head = (await git(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])).out.trim() || null;
  const st = await git(repoRoot, ['status', '--porcelain', '--untracked-files=no']);
  const dirtyFiles = st.out.split('\n').filter(Boolean).map((l) => l.slice(3).trim());
  const branchExists = (await git(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0;
  let ahead: number | null = null;
  if (branchExists) {
    const c = await git(repoRoot, ['rev-list', '--count', `${base}..${branch}`]);
    if (c.code === 0) ahead = Number(c.out.trim()) || 0;
  }
  return { repo: true, head, checkedOut: head === base, dirty: dirtyFiles.length > 0, dirtyFiles, branchExists, ahead };
}

export interface MergeOpts {
  repoRoot: string;       // the checkout where `base` is checked out (master's repo)
  branch: string;
  approvedSha?: string; // immutable reviewed commit, rechecked immediately before git merge
  base: string;
  strategy?: MergeStrategy;
  message: string;
}

export type MergeResult =
  | { ok: true; sha: string; strategy: MergeStrategy }
  | { ok: false; conflict: true; files: string[] }
  | { ok: false; conflict?: false; reason: 'not-a-repo' | 'base-not-checked-out' | 'dirty' | 'no-branch' | 'nothing-to-merge' | 'approval-stale' | 'git'; error: string; files?: string[] };

// Merge `branch` into `base` inside repoRoot. Refuses (without touching the
// tree) when repoRoot isn't on `base` or has tracked modifications. On a
// conflict the merge is aborted and the conflicting paths returned.
export async function mergeBranch(o: MergeOpts): Promise<MergeResult> {
  const strategy: MergeStrategy = o.strategy === 'squash' ? 'squash' : 'no-ff';
  const st = await baseStatus(o.repoRoot, o.base, o.branch);
  if (!st.repo) return { ok: false, reason: 'not-a-repo', error: `not a git repository: ${o.repoRoot}` };
  if (!st.branchExists) return { ok: false, reason: 'no-branch', error: `branch not found: ${o.branch}` };
  if (!st.checkedOut)
    return { ok: false, reason: 'base-not-checked-out', error: `${path.basename(o.repoRoot)} has ${st.head || 'nothing'} checked out, not ${o.base}` };
  if (st.dirty) return { ok: false, reason: 'dirty', error: `base worktree has uncommitted changes (${st.dirtyFiles.length} file${st.dirtyFiles.length === 1 ? '' : 's'})`, files: st.dirtyFiles };
  if (st.ahead === 0) return { ok: false, reason: 'nothing-to-merge', error: `${o.branch} has no commits on top of ${o.base}` };

  const tip = await git(o.repoRoot, ['rev-parse', '--verify', `refs/heads/${o.branch}^{commit}`]);
  if (o.approvedSha && (tip.code !== 0 || tip.out.trim() !== o.approvedSha))
    return { ok: false, reason: 'approval-stale', error: 'branch changed since approval; request a new review' };
  const target = o.approvedSha || tip.out.trim();
  const args = strategy === 'squash'
    ? ['merge', '--squash', target]
    : ['merge', '--no-ff', '--no-edit', '-m', o.message, target];
  const r = await git(o.repoRoot, args);
  if (r.code !== 0) {
    const u = await git(o.repoRoot, ['diff', '--name-only', '--diff-filter=U']);
    const files = u.out.split('\n').map((l) => l.trim()).filter(Boolean);
    // undo whatever git left half-done (MERGE_HEAD or a squashed index)
    if ((await git(o.repoRoot, ['merge', '--abort'])).code !== 0) await git(o.repoRoot, ['reset', '--merge']);
    if (files.length) return { ok: false, conflict: true, files };
    return { ok: false, reason: 'git', error: r.out.trim() || `git merge failed (${r.code})` };
  }
  if (strategy === 'squash') {
    const c = await git(o.repoRoot, ['commit', '--no-verify', '-m', o.message]);
    if (c.code !== 0) {
      await git(o.repoRoot, ['reset', '--merge']);
      return { ok: false, reason: 'git', error: c.out.trim() || 'squash commit failed' };
    }
  }
  const sha = (await git(o.repoRoot, ['rev-parse', 'HEAD'])).out.trim();
  return { ok: true, sha, strategy };
}

// Delete a merged branch (safe -d: refuses if unmerged; force only when asked).
export async function deleteBranch(repoRoot: string, branch: string, force = false): Promise<{ ok: boolean; error?: string }> {
  const r = await git(repoRoot, ['branch', force ? '-D' : '-d', branch]);
  return r.code === 0 ? { ok: true } : { ok: false, error: r.out.trim() };
}

export function mergeMessage(o: { branch: string; base: string; title?: string | null; subtask?: string | null; sessionId: string; strategy: MergeStrategy }): string {
  const what = o.title || o.subtask || o.branch;
  const head = `Merge ${o.branch}: ${what}`.slice(0, 120);
  return `${head}\n\n${o.strategy === 'squash' ? 'Squash-merged' : 'Merged'} into ${o.base} by the Arigami host after human approval (session ${o.sessionId}).`;
}
