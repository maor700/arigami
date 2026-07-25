// Pure github-pr listener logic: error classification + event diffing against a
// watermark. No I/O, no state singleton — kept separate from listeners.ts so it
// can be unit-tested without booting the rest of the host.

export type GhErrorKind = 'transient' | 'auth' | 'gone';

// Classify a failed gh call. 403 is ambiguous on GitHub: a rate-limit (retry
// later) vs a real authz failure (re-auth). Disambiguate on the body text.
export function classifyGhError(status: number, stderr = ''): GhErrorKind {
  if (status === 404 || status === 410) return 'gone';
  if (/rate limit|secondary rate|abuse detection/i.test(stderr)) return 'transient';
  if (status === 401 || status === 403) return 'auth';
  return 'transient'; // 0/5xx/429/unknown
}

export interface PrSnapshot {
  meta: any; // /pulls/:n
  reviews: any[]; // /pulls/:n/reviews
  issueComments: any[]; // /issues/:n/comments
  reviewComments: any[]; // /pulls/:n/comments (inline)
  checkRuns?: any[]; // /commits/:sha/check-runs → check_runs[] (Actions, Chromatic…)
  statusContexts?: any[]; // /commits/:sha/status → statuses[] (legacy status API)
}

export interface PrWatermark {
  reviewId?: number;
  issueCommentId?: number;
  reviewCommentId?: number;
  // CI/conflict cursors — all scoped to headSha: a new push resets them, so a
  // check that fails again on fresh code fires again, but a red check never
  // re-fires every poll for the same commit.
  headSha?: string;
  firedChecks?: string[]; // check/context names already fired (ci_failed) for headSha
  ciPassedFired?: boolean; // ci_passed already fired for headSha
  conflictFired?: boolean; // conflicts already fired (resets when mergeable again)
}

export interface PrDiff {
  terminal: 'merged' | 'closed' | null;
  shouldFire: boolean;
  summary: string;
  nextWatermark: PrWatermark;
}

const maxId = (rows: any[], floor = 0): number =>
  rows.reduce((mx, r) => (typeof r?.id === 'number' && r.id > mx ? r.id : mx), floor);

// A check-run conclusion that should wake the session. `cancelled` is left out —
// it usually means a newer push superseded the run, which will report itself.
const FAILED_CONCLUSIONS = new Set(['failure', 'timed_out', 'action_required', 'startup_failure']);
const PASSED_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);

// Names of currently-failed checks: modern check-runs + legacy status contexts.
function failedCheckNames(snap: PrSnapshot): string[] {
  const names = new Set<string>();
  for (const c of snap.checkRuns || [])
    if (c?.status === 'completed' && FAILED_CONCLUSIONS.has(c?.conclusion)) names.add(c.name || 'check');
  for (const s of snap.statusContexts || [])
    if (s?.state === 'failure' || s?.state === 'error') names.add(s.context || 'status');
  return [...names];
}

// True when there ARE checks and every one of them finished green.
function allChecksPassed(snap: PrSnapshot): boolean {
  const runs = snap.checkRuns || [];
  const ctxs = snap.statusContexts || [];
  if (!runs.length && !ctxs.length) return false; // nothing to pass
  return (
    runs.every((c) => c?.status === 'completed' && PASSED_CONCLUSIONS.has(c?.conclusion)) &&
    ctxs.every((s) => s?.state === 'success')
  );
}

// Compute what's new past the watermark and whether it should wake the session.
// ignoreLogin (the PR author = usually us) is filtered for *firing* but still
// advances the watermark, so the agent's own comments never self-wake the loop.
export function diffPr(
  snap: PrSnapshot,
  wm: PrWatermark,
  opts: { fireOn: string[]; ignoreLogin?: string }
): PrDiff {
  const { fireOn, ignoreLogin } = opts;
  const o = snap.meta?.base?.repo?.owner?.login || snap.meta?.head?.repo?.owner?.login;
  const num = snap.meta?.number;
  const repo = snap.meta?.base?.repo?.name || snap.meta?.head?.repo?.name;
  const url = snap.meta?.html_url || '';
  const tag = `PR #${num}${o && repo ? ` (${o}/${repo})` : ''}`;

  // ---- CI + conflicts (all cursors scoped to the head SHA) ----
  const sha: string = snap.meta?.head?.sha || '';
  const sameSha = !!sha && wm.headSha === sha;
  const prevFired = sameSha ? wm.firedChecks || [] : [];

  const failed = failedCheckNames(snap);
  const newFailures = failed.filter((n) => !prevFired.includes(n));
  const ciFailedFires = fireOn.includes('ci_failed') && newFailures.length > 0;

  const passed = allChecksPassed(snap);
  const ciPassedFires = fireOn.includes('ci_passed') && passed && !(sameSha && wm.ciPassedFired);

  // `dirty` is GitHub's "has merge conflicts". The flag resets whenever the PR
  // is mergeable again (a rebase fixed it — or the base moved and broke it anew).
  const dirty = snap.meta?.mergeable_state === 'dirty';
  const conflictFires = fireOn.includes('conflicts') && dirty && !wm.conflictFired;

  const nextWatermark: PrWatermark = {
    reviewId: maxId(snap.reviews, wm.reviewId || 0),
    issueCommentId: maxId(snap.issueComments, wm.issueCommentId || 0),
    reviewCommentId: maxId(snap.reviewComments, wm.reviewCommentId || 0),
    headSha: sha || wm.headSha,
    firedChecks: [...new Set([...prevFired, ...failed])],
    ciPassedFired: (sameSha && wm.ciPassedFired) || passed,
    conflictFired: dirty,
  };

  // Terminal state always wakes once, then the listener stops.
  const terminal: PrDiff['terminal'] = snap.meta?.merged
    ? 'merged'
    : snap.meta?.state === 'closed'
      ? 'closed'
      : null;
  if (terminal) {
    return {
      terminal,
      shouldFire: true,
      nextWatermark,
      summary: `🔔 Listener: ${tag} was ${terminal}. ${url}\nThe watch has ended — wrap up or follow up as needed.`,
    };
  }

  const notMe = (x: any) => !ignoreLogin || x?.user?.login !== ignoreLogin;
  const newReviews = snap.reviews.filter((r) => (r.id || 0) > (wm.reviewId || 0)).filter(notMe);
  const newComments = [
    ...snap.issueComments.filter((c) => (c.id || 0) > (wm.issueCommentId || 0)),
    ...snap.reviewComments.filter((c) => (c.id || 0) > (wm.reviewCommentId || 0)),
  ].filter(notMe);

  const reviewFires = newReviews.filter((r) => {
    if (fireOn.includes('approved') && r.state === 'APPROVED') return true;
    if (fireOn.includes('changes_requested') && r.state === 'CHANGES_REQUESTED') return true;
    return fireOn.includes('new_review');
  });
  const commentFires = fireOn.includes('new_comment') ? newComments : [];
  const shouldFire =
    reviewFires.length > 0 || commentFires.length > 0 || ciFailedFires || ciPassedFires || conflictFires;

  const parts: string[] = [];
  for (const r of reviewFires) {
    const who = r.user?.login ? `@${r.user.login}` : 'someone';
    const verb =
      r.state === 'APPROVED'
        ? 'approved'
        : r.state === 'CHANGES_REQUESTED'
          ? 'requested changes'
          : 'left a review';
    parts.push(`${verb} by ${who}`);
  }
  if (commentFires.length) parts.push(`${commentFires.length} new comment(s)`);
  if (ciFailedFires) parts.push(`CI failed: ${newFailures.join(', ')}`);
  if (ciPassedFires) parts.push('CI is green — all checks passed');
  if (conflictFires) parts.push('has merge conflicts with the base branch');

  const hint = ciFailedFires
    ? 'Check the failing runs (gh pr checks / gh run view --log-failed) and decide your next step.'
    : conflictFires
      ? 'Rebase or merge the base branch to resolve the conflicts, then push.'
      : 'Fetch the latest review/comments and decide your next step.';

  return {
    terminal: null,
    shouldFire,
    nextWatermark,
    summary: shouldFire ? `🔔 Listener: ${tag} — ${parts.join('; ')}. ${url}\n${hint}` : '',
  };
}
