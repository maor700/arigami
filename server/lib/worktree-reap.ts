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
//     a remote-tracking branch, a tag, a local refs/pull/* ref, or a local
//     branch other than the one checked out here. Merged into local master
//     counts as safe; pushed counts as safe; committed-and-forgotten does not.
// Otherwise it is kept and reported, with the reason. Losing a day of
// unpushed work is worse than 2 GB of disk. (Seen in practice: a feature
// branch whose upstream was still origin/main — it had never been pushed — with
// a real uncommitted edit in it.)
//
// "Some other ref" alone missed two common cases, each leaving ~1.6 GB of
// node_modules behind:
//   - a PR review worktree, detached at the PR head fetched from
//     refs/pull/<n>/head into FETCH_HEAD — never a remote-tracking branch;
//   - a ticket branch whose PR was squash-merged and whose remote branch was
//     auto-deleted: its commits now live only in the PR on GitHub.
// So when a clean tree still has such commits, GitHub is asked whether HEAD
// ITSELF belongs to a pull request. GitHub keeps refs/pull/<n>/head for every
// PR — merged, closed or open — so a HEAD found there exists on the server
// together with all its ancestors. A local commit on top of what was pushed is
// not on GitHub, so it still keeps the worktree. No `gh`, no network, no clear
// answer: keep.
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

/** What the session knows about the PR its worktree is for (its metadata). */
export interface ReapHints {
  /** `owner/name` on GitHub. Defaults to the worktree's origin URL. */
  repo?: string;
  prNumber?: number;
  /** The PR head the session checked out. Only honoured together with prNumber. */
  reviewedSha?: string;
}

/** A pull request GitHub says contains the worktree's HEAD. */
export interface PrHit {
  number: number;
  state: string;
  merged: boolean;
}

/**
 * Which PRs on GitHub contain `sha`. `ok: false` means "could not tell", and
 * the worktree is kept. Injectable so tests never touch the network.
 */
export type GitHubProbe = (q: {
  slug: string;
  sha: string;
  prNumber: number | null;
}) => Promise<{ ok: true; prs: PrHit[] } | { ok: false; err: string }>;

export interface InspectOptions {
  hints?: ReapHints;
  /** Defaults to the `gh` CLI. null = local proof only, never ask GitHub. */
  github?: GitHubProbe | null;
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

/** Session metadata → hints. Tolerates anything. */
export function hintsFrom(md: any): ReapHints {
  const h: ReapHints = {};
  const m = /github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/.exec(String(md?.pr || ''));
  if (m) {
    h.repo = `${m[1]}/${m[2]}`;
    h.prNumber = Number(m[3]);
  }
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(md?.repo || ''))) h.repo = String(md.repo);
  const n = Number(md?.prNumber);
  if (Number.isInteger(n) && n > 0) h.prNumber = n;
  if (/^[0-9a-f]{7,64}$/i.test(String(md?.reviewedSha || ''))) h.reviewedSha = String(md.reviewedSha);
  return h;
}

/** `owner/name` of a github.com remote URL, or null. */
export function githubSlug(url: string): string | null {
  const m = /github\.com[:/]+([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

async function gh(args: string[]): Promise<{ ok: boolean; out: string }> {
  try {
    const p = Bun.spawn(['gh', ...args], { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
    const timer = setTimeout(() => {
      try {
        p.kill();
      } catch {}
    }, 15_000);
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    clearTimeout(timer);
    return code === 0 ? { ok: true, out } : { ok: false, out: (err || out).trim() };
  } catch (e) {
    return { ok: false, out: (e as Error).message };
  }
}

/** The real probe, through the `gh` CLI. */
export const ghProbe: GitHubProbe = async ({ slug, sha, prNumber }) => {
  // Every PR whose commits include `sha`; 404/422 when GitHub never saw it.
  const r = await gh(['api', `repos/${slug}/commits/${sha}/pulls`]);
  if (r.ok) {
    try {
      const prs = (JSON.parse(r.out) as any[]).map((p) => ({
        number: Number(p.number),
        state: String(p.state),
        merged: !!p.merged_at,
      }));
      if (prs.length) return { ok: true, prs };
    } catch {
      return { ok: false, err: 'unreadable answer from GitHub' };
    }
  }
  // That listing follows the PR's CURRENT commits. A review checkout of an
  // older PR head (the author pushed again since) is an ancestor of it.
  if (prNumber) {
    const pr = await gh(['api', `repos/${slug}/pulls/${prNumber}`, '--jq', '[.head.sha, .state, (.merged_at != null)] | @tsv']);
    const [head, state, merged] = pr.out.trim().split('\t');
    if (pr.ok && /^[0-9a-f]{40,64}$/.test(head || '')) {
      const cmp = await gh(['api', `repos/${slug}/compare/${sha}...${head}`, '--jq', '.behind_by']);
      if (cmp.ok && cmp.out.trim() === '0') return { ok: true, prs: [{ number: prNumber, state, merged: merged === 'true' }] };
    }
  }
  // 422 "No commit found" is GitHub's definite answer: it has never seen it.
  if (r.ok || /No commit found/i.test(r.out)) return { ok: true, prs: [] };
  return { ok: false, err: r.out.split('\n')[0] || 'gh api failed' };
};

/** true when GitHub has HEAD in a PR; otherwise why not (null = not asked). */
async function onGitHub(dir: string, hints: ReapHints, probe: GitHubProbe | null): Promise<true | string | null> {
  if (!probe) return null;
  const sha = git(dir, ['rev-parse', 'HEAD']).out;
  if (!/^[0-9a-f]{40,64}$/.test(sha)) return null;
  const slug = hints.repo || githubSlug(git(dir, ['remote', 'get-url', 'origin']).out);
  if (!slug) return null;
  const r = await probe({ slug, sha, prNumber: hints.prNumber || null });
  if (!r.ok) return `GitHub could not confirm: ${r.err}`;
  return r.prs.length ? true : 'HEAD is in no pull request on GitHub';
}

/** What would happen to this worktree. Pure inspection — changes nothing. */
export async function inspect(dir: string, opts: InspectOptions = {}): Promise<WorktreeVerdict> {
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
  const hints = opts.hints || {};

  const reasons: string[] = [];
  const st = git(dir, ['status', '--porcelain']);
  if (!st.ok) reasons.push(`git status failed: ${st.err || 'unknown error'}`);
  else if (st.out) {
    const n = st.out.split('\n').length;
    reasons.push(`${n} uncommitted change${n === 1 ? '' : 's'}`);
  }

  // `--exclude` applies to the NEXT --branches only; the branch checked out here
  // must not vouch for its own commits.
  const refs = ['--remotes', '--tags', '--glob=refs/pull/*', ...(branch ? [`--exclude=${branch}`] : []), '--branches'];
  if (hints.prNumber && hints.reviewedSha) {
    const v = git(dir, ['rev-parse', '--verify', '--quiet', `${hints.reviewedSha}^{commit}`]);
    if (v.ok && v.out) refs.push(v.out);
  }
  const uniq = git(dir, ['rev-list', '--count', 'HEAD', '--not', ...refs]);
  if (!uniq.ok) reasons.push(`could not tell whether HEAD is pushed: ${uniq.err || 'unknown error'}`);
  else if (Number(uniq.out) > 0) {
    const n = Number(uniq.out);
    const local = `${n} commit${n === 1 ? '' : 's'} not on any remote or other branch`;
    // A dirty tree is kept anyway — no network round-trip for it.
    const why = reasons.length ? null : await onGitHub(dir, hints, opts.github === undefined ? ghProbe : opts.github);
    if (why !== true) reasons.push(why ? `${local} (${why})` : local);
  }

  return reasons.length ? { action: 'keep', dir, branch, reasons } : { action: 'remove', dir, branch, main };
}

/** Apply `inspect()`: remove the worktree and its branch, or keep and say why. */
export async function reap(dir: string, opts: InspectOptions = {}): Promise<WorktreeResult> {
  const v = await inspect(dir, opts);
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
    // Safe by the same proof: every commit on it is reachable from elsewhere
    // (or is in a PR on GitHub). -D rather than -d because "merged" to git
    // means merged into the MAIN checkout's HEAD, which says nothing about a
    // pushed feature branch.
    branchDeleted = git(v.main, ['branch', '-D', v.branch]).ok;
  }
  return { dir, outcome: 'removed', branchDeleted };
}
