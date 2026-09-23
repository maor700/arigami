// Remove a session's git worktree — deterministically, and never at the cost
// of work that exists nowhere else.
//
// This replaces running `metadata.cleanup`: shell commands an agent wrote for
// itself while provisioning. Whether a worktree was removed depended on the
// agent having remembered to write them, having written them right, and on
// whoever deleted the session passing a flag. A worktree the pr-review
// launcher created was never recorded at all, so nothing ever removed it.
//
// The rule is conservative on purpose. A worktree is removed only when git can
// show that nothing in it is unique:
//   - no local changes, tracked or untracked (`git status --porcelain`)
//   - no commit reachable from HEAD that isn't reachable from some OTHER ref —
//     a remote-tracking branch, a tag, or a local branch other than the one
//     checked out here. Merged into local master counts as safe; pushed counts
//     as safe; committed-and-forgotten does not.
// Otherwise it is kept and reported, with the reason. Losing a day of
// unpushed work is worse than 2 GB of disk. (Seen on the cloud host: a ticket
// branch whose upstream was origin/main — it had never been pushed — with a
// real edit in chart.tsx.)
import fs from 'node:fs';
import path from 'node:path';

export type WorktreeVerdict =
  | { action: 'remove'; dir: string; branch: string | null; main: string }
  | { action: 'keep'; dir: string; branch: string | null; reasons: string[] }
  | { action: 'absent'; dir: string }
  | { action: 'not-a-worktree'; dir: string };

export interface WorktreeResult {
  dir: string;
  outcome: 'removed' | 'kept' | 'absent' | 'not-a-worktree' | 'failed';
  reasons?: string[];
  branchDeleted?: boolean;
  error?: string;
}

function git(cwd: string, args: string[]): { ok: boolean; out: string; err: string } {
  try {
    const r = Bun.spawnSync(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'pipe', timeout: 30_000 });
    return {
      ok: r.success,
      out: new TextDecoder().decode(r.stdout).trim(),
      err: new TextDecoder().decode(r.stderr).trim(),
    };
  } catch (e) {
    return { ok: false, out: '', err: (e as Error).message };
  }
}

/** What would happen to this worktree. Pure inspection — changes nothing. */
export function inspect(dir: string): WorktreeVerdict {
  if (!dir || !fs.existsSync(dir)) return { action: 'absent', dir };
  // A LINKED worktree has a `.git` FILE pointing at the main repo. A `.git`
  // directory is a main checkout, which no session cleanup may ever remove.
  const dotGit = path.join(dir, '.git');
  let isLinked = false;
  try {
    isLinked = fs.statSync(dotGit).isFile();
  } catch {
    /* no .git at all */
  }
  if (!isLinked) return { action: 'not-a-worktree', dir };

  const common = git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!common.ok || !common.out) return { action: 'not-a-worktree', dir };
  const main = path.dirname(common.out);

  const branchR = git(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const branch = branchR.ok && branchR.out ? branchR.out : null;

  const reasons: string[] = [];
  const st = git(dir, ['status', '--porcelain']);
  if (!st.ok) reasons.push(`git status failed: ${st.err || 'unknown error'}`);
  else if (st.out) {
    const n = st.out.split('\n').length;
    reasons.push(`${n} uncommitted change${n === 1 ? '' : 's'}`);
  }

  // `--exclude` applies to the NEXT --branches only; the branch checked out here
  // must not vouch for its own commits.
  const refs = ['--remotes', '--tags', ...(branch ? [`--exclude=${branch}`] : []), '--branches'];
  const uniq = git(dir, ['rev-list', '--count', 'HEAD', '--not', ...refs]);
  if (!uniq.ok) reasons.push(`could not tell whether HEAD is pushed: ${uniq.err || 'unknown error'}`);
  else if (Number(uniq.out) > 0) {
    const n = Number(uniq.out);
    reasons.push(`${n} commit${n === 1 ? '' : 's'} not on any remote or other branch`);
  }

  return reasons.length ? { action: 'keep', dir, branch, reasons } : { action: 'remove', dir, branch, main };
}

/** Apply `inspect()`: remove the worktree and its branch, or keep and say why. */
export function reap(dir: string): WorktreeResult {
  const v = inspect(dir);
  if (v.action === 'absent') return { dir, outcome: 'absent' };
  if (v.action === 'not-a-worktree') return { dir, outcome: 'not-a-worktree' };
  if (v.action === 'keep') return { dir, outcome: 'kept', reasons: v.reasons };

  const rm = git(v.main, ['worktree', 'remove', '--force', dir]);
  if (!rm.ok) {
    // git refuses on a locked or half-registered worktree. Only fall back to a
    // plain delete once inspect() has already proven there is nothing unique.
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      return { dir, outcome: 'failed', error: `${rm.err}; rm: ${(e as Error).message}` };
    }
  }
  git(v.main, ['worktree', 'prune']);

  let branchDeleted = false;
  if (v.branch) {
    // Safe by the same proof: every commit on it is reachable from elsewhere.
    // -D rather than -d because "merged" to git means merged into the MAIN
    // checkout's HEAD, which says nothing about a pushed feature branch.
    branchDeleted = git(v.main, ['branch', '-D', v.branch]).ok;
  }
  return { dir, outcome: 'removed', branchDeleted };
}
