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

// ---- batched GraphQL fetch --------------------------------------------------
// One GraphQL query (an alias per distinct PR) replaces the six REST calls each
// github-pr listener used to make every poll. Pure: building the query, mapping
// a node to the REST-shaped PrSnapshot diffPr already consumes, and the quota
// guard. The `gh` call itself lives in listeners.ts.

export interface PrTarget {
  owner: string;
  repo: string;
  number: number;
}

export const prKey = (t: PrTarget): string => `${t.owner}/${t.repo}#${t.number}`;

// GraphQL node cost grows with the alias count, so a big fleet is split into
// several queries rather than one that GitHub rejects.
export const PR_BATCH_SIZE = 20;

const PR_FRAGMENT = `fragment PrFields on PullRequest {
  number url state merged mergeable headRefOid
  author { login }
  baseRepository { name owner { login } }
  reviews(last: 100) { nodes { databaseId state author { login } } }
  comments(last: 100) { nodes { databaseId author { login } } }
  reviewThreads(last: 50) { nodes { comments(last: 20) { nodes { databaseId author { login } } } } }
  commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
    __typename
    ... on CheckRun { name status conclusion }
    ... on StatusContext { context state }
  } } } } } }
}`;

// owner/repo/number travel as GraphQL variables, never spliced into the query
// text — a PR URL is user input and `[^/]+` accepts quotes and braces.
export function buildPrBatchQuery(targets: PrTarget[]): { query: string; vars: Record<string, string | number> } {
  const decl: string[] = [];
  const body: string[] = [];
  const vars: Record<string, string | number> = {};
  targets.forEach((t, i) => {
    decl.push(`$o${i}: String!, $r${i}: String!, $n${i}: Int!`);
    body.push(`p${i}: repository(owner: $o${i}, name: $r${i}) { pullRequest(number: $n${i}) { ...PrFields } }`);
    vars[`o${i}`] = t.owner;
    vars[`r${i}`] = t.repo;
    vars[`n${i}`] = t.number;
  });
  const query = `query(${decl.join(', ')}) {\n  rateLimit { cost remaining resetAt }\n  ${body.join('\n  ')}\n}\n${PR_FRAGMENT}`;
  return { query, vars };
}

const nodes = (c: any): any[] => (Array.isArray(c?.nodes) ? c.nodes.filter(Boolean) : []);
const lower = (s: unknown): string => (typeof s === 'string' ? s.toLowerCase() : '');
const asUser = (a: any) => ({ login: a?.author?.login });
// databaseId is the REST `id` — the watermark was always in those units, so a
// listener armed before this change keeps its cursor.
const asRow = (n: any) => ({ id: n.databaseId, user: asUser(n), state: n.state });

// Map one GraphQL PullRequest node onto the REST-shaped snapshot. Returns null
// for a missing node (deleted PR / no access).
export function snapshotFromGraphql(pr: any): PrSnapshot | null {
  if (!pr || typeof pr !== 'object') return null;
  const rollup = nodes(pr.commits)[0]?.commit?.statusCheckRollup;
  const ctxs = nodes(rollup?.contexts);
  const gqlState: string = pr.state || '';
  return {
    meta: {
      number: pr.number,
      html_url: pr.url,
      state: gqlState === 'OPEN' ? 'open' : 'closed',
      merged: pr.merged === true || gqlState === 'MERGED',
      // REST calls a conflicted PR mergeable_state "dirty"; GraphQL says CONFLICTING.
      mergeable_state: pr.mergeable === 'CONFLICTING' ? 'dirty' : lower(pr.mergeable) || 'unknown',
      head: { sha: pr.headRefOid || '' },
      user: { login: pr.author?.login },
      base: { repo: { name: pr.baseRepository?.name, owner: { login: pr.baseRepository?.owner?.login } } },
    },
    reviews: nodes(pr.reviews).map(asRow),
    issueComments: nodes(pr.comments).map(asRow),
    reviewComments: nodes(pr.reviewThreads).flatMap((t) => nodes(t.comments).map(asRow)),
    checkRuns: ctxs
      .filter((c) => c.__typename === 'CheckRun')
      .map((c) => ({ name: c.name, status: lower(c.status), conclusion: lower(c.conclusion) })),
    statusContexts: ctxs
      .filter((c) => c.__typename === 'StatusContext')
      .map((c) => ({ context: c.context, state: lower(c.state) })),
  };
}

export type PrBatchResult = { snap: PrSnapshot } | { err: { kind: GhErrorKind; message: string } };

export interface RateLimitInfo {
  remaining: number;
  resetAt: number; // epoch ms
}

// Split a GraphQL response into one result per alias. A PR GitHub cannot find
// (NOT_FOUND on that alias's path) is `gone` for that listener only; any other
// per-alias error is transient so one bad PR never stops the rest of the batch.
export function parsePrBatch(
  data: any,
  errors: any[] | undefined,
  count: number
): { results: PrBatchResult[]; rate: RateLimitInfo | null } {
  const byAlias = new Map<string, any[]>();
  for (const e of errors || []) {
    const a = Array.isArray(e?.path) ? String(e.path[0]) : '';
    byAlias.set(a, [...(byAlias.get(a) || []), e]);
  }
  const results: PrBatchResult[] = [];
  for (let i = 0; i < count; i++) {
    const snap = snapshotFromGraphql(data?.[`p${i}`]?.pullRequest);
    if (snap) {
      results.push({ snap });
      continue;
    }
    const errs = byAlias.get(`p${i}`) || [];
    const message = errs.map((e) => e?.message).filter(Boolean).join('; ');
    const missing = errs.some((e) => e?.type === 'NOT_FOUND') || (!errs.length && data?.[`p${i}`] !== undefined);
    results.push({ err: { kind: missing ? 'gone' : 'transient', message: message || 'pull request not found' } });
  }
  const rl = data?.rateLimit;
  const resetAt = Date.parse(rl?.resetAt);
  const rate = typeof rl?.remaining === 'number' ? { remaining: rl.remaining, resetAt: Number.isFinite(resetAt) ? resetAt : 0 } : null;
  return { results, rate };
}

// Quota guard. GraphQL gets its own 5000-point hourly bucket; once fewer than
// `floor` points remain, polling pauses until the window resets instead of
// spending the last of it (the same token backs `gh pr create` and the agents'
// own calls). Returns the epoch ms to resume at, or null to go ahead.
export const RATE_FLOOR = 200;
export function quotaPausedUntil(rate: RateLimitInfo | null, now: number, floor = RATE_FLOOR): number | null {
  if (!rate || rate.remaining >= floor) return null;
  return rate.resetAt > now ? rate.resetAt : null;
}
