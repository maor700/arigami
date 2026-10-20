// One approval, one merge offer — the rules both share, free of the state
// singleton so they are unit-testable with a fake `gh`.
//
// APPROVE is a single action (the review card's button, the Changes tab's
// button, review/submit verdict "approve" all land in api.approveSession). What
// it DOES depends on the session, never on which surface was clicked:
//   local     no pull request — the human approves the session's own work.
//             Stamps metadata.review (with the reviewed SHA when the session owns
//             a branch); a child branch becomes mergeable by the host.
//   pr-own    the session's branch has a pull request the viewer authored.
//             GitHub won't let you approve your own PR, so this is the same
//             local stamp; the PR can then be merged on GitHub (see below).
//   pr-review someone else's pull request. Approve = an APPROVE review posted
//             to the PR (by the session's agent, with `gh`), stamped with the
//             PR head SHA it approved. Nothing is merged from here.
//   unknown   a PR whose author GitHub didn't tell us — approve refuses rather
//             than guess between a public post and a private stamp.
//
// MERGE is offered only when the viewer can actually merge (mergeOffer).

export interface PrRef { owner: string; repo: string; number: number; url: string }

export interface PrFacts {
  ok: boolean;
  error?: string;
  author: string | null;      // PR author login
  viewer: string | null;      // the gh-authenticated login (the human's token)
  permission: string | null;  // viewer's permission on the repo: ADMIN | MAINTAIN | WRITE | TRIAGE | READ
  state: string | null;       // OPEN | CLOSED | MERGED
  draft: boolean;
  mergeable: string | null;   // MERGEABLE | CONFLICTING | UNKNOWN
  base: string | null;        // PR base branch
  headSha: string | null;     // PR head commit
}

export type ApprovalMode = 'local' | 'pr-own' | 'pr-review' | 'unknown';

export function prRefOf(md: any): PrRef | null {
  const m = /github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/.exec(String(md?.pr || ''));
  if (m) return { owner: m[1], repo: m[2], number: Number(m[3]), url: `https://github.com/${m[1]}/${m[2]}/pull/${m[3]}` };
  const r = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(String(md?.repo || ''));
  const n = Number(md?.prNumber);
  if (r && Number.isInteger(n) && n > 0) return { owner: r[1], repo: r[2], number: n, url: `https://github.com/${r[1]}/${r[2]}/pull/${n}` };
  return null;
}

export type GhRunner = (args: string[]) => Promise<{ ok: boolean; out: string }>;

export const ghRun: GhRunner = async (args) => {
  try {
    const p = Bun.spawn(['gh', ...args], { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
    const timer = setTimeout(() => { try { p.kill(); } catch {} }, 15_000);
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    clearTimeout(timer);
    return code === 0 ? { ok: true, out } : { ok: false, out: (err || out).trim() };
  } catch (e) {
    return { ok: false, out: (e as Error).message };
  }
};

// Tests swap the runner (no real GitHub); everything else uses `gh`.
let defaultRun: GhRunner = ghRun;
export function setGhRunner(run: GhRunner | null) { defaultRun = run || ghRun; cache.clear(); }

const cache = new Map<string, { at: number; facts: PrFacts }>();
const TTL_MS = 60_000;

export function clearPrFactsCache() { cache.clear(); }

// What GitHub says about the PR and about the viewer's rights on it.
export async function fetchPrFacts(ref: PrRef, o: { run?: GhRunner; fresh?: boolean } = {}): Promise<PrFacts> {
  const hit = cache.get(ref.url);
  if (!o.fresh && hit && Date.now() - hit.at < TTL_MS) return hit.facts;
  const run = o.run || defaultRun;
  const repo = `${ref.owner}/${ref.repo}`;
  const [pr, me, rp] = await Promise.all([
    run(['pr', 'view', String(ref.number), '--repo', repo, '--json', 'author,state,isDraft,mergeable,baseRefName,headRefOid']),
    run(['api', 'user', '--jq', '.login']),
    run(['repo', 'view', repo, '--json', 'viewerPermission', '--jq', '.viewerPermission']),
  ]);
  let facts: PrFacts;
  if (!pr.ok || !me.ok) {
    facts = { ok: false, error: (!pr.ok ? pr.out : me.out) || 'gh failed', author: null, viewer: null, permission: null, state: null, draft: false, mergeable: null, base: null, headSha: null };
  } else {
    let j: any = {};
    try { j = JSON.parse(pr.out); } catch {}
    facts = {
      ok: !!j.author?.login,
      ...(j.author?.login ? {} : { error: 'unexpected gh output' }),
      author: j.author?.login || null,
      viewer: me.out.trim() || null,
      permission: rp.ok ? rp.out.trim() || null : null,
      state: j.state || null,
      draft: !!j.isDraft,
      mergeable: j.mergeable || null,
      base: j.baseRefName || null,
      headSha: j.headRefOid || null,
    };
  }
  // failures are not cached: the next look retries
  if (facts.ok) cache.set(ref.url, { at: Date.now(), facts });
  return facts;
}

export function approvalMode(md: any, facts: PrFacts | null): ApprovalMode {
  if (!prRefOf(md)) return 'local';
  if (!facts?.ok || !facts.author || !facts.viewer) return 'unknown';
  return facts.author.toLowerCase() === facts.viewer.toLowerCase() ? 'pr-own' : 'pr-review';
}

// Is the session's approval stamp still about what is under review now?
// `sha` = the commit being reviewed now (the local branch tip, or the PR head
// for a pr-review). A stamp without a SHA (a session with no branch) stays
// current until a NEWER review card is raised.
export function approvalCurrent(md: any, o: { sha?: string | null; mode: ApprovalMode; actionAt?: string | null }): boolean {
  const r = md?.review;
  if (r?.state !== 'approved') return false;
  if (o.mode === 'pr-review' ? r.target !== 'github' : r.target === 'github') return false;
  if (r.sha || o.sha) return !!r.sha && r.sha === o.sha;
  return !o.actionAt || String(r.at || '') >= String(o.actionAt);
}

const MERGE_RIGHTS = new Set(['ADMIN', 'MAINTAIN', 'WRITE']);

export interface MergeOfferIn {
  approved: boolean;           // a CURRENT approval
  merged: boolean;
  viewerMayMerge: boolean;     // host-side: admin / master / controller (pr: a person only)
  kind: 'local' | 'pr';
  localReason?: string | null; // mergeStatus' local reason (null = can merge)
  mode?: ApprovalMode;
  facts?: PrFacts | null;
}

// `show` = render the Merge control. Otherwise `reason` explains it in a
// passive line (no button) — or nothing at all when there is no approval yet.
export function mergeOffer(i: MergeOfferIn): { show: boolean; reason: string | null } {
  if (i.merged) return { show: false, reason: 'merged' };
  if (!i.approved) return { show: false, reason: null };
  if (!i.viewerMayMerge) return { show: false, reason: 'no-permission' };
  if (i.kind === 'local') return { show: !i.localReason, reason: i.localReason || null };
  const f = i.facts;
  if (i.mode === 'pr-review') return { show: false, reason: 'not-your-pr' };
  if (!f?.ok || i.mode !== 'pr-own') return { show: false, reason: 'github-unknown' };
  if (!MERGE_RIGHTS.has(String(f.permission || '').toUpperCase())) return { show: false, reason: 'no-permission' };
  if (f.state === 'MERGED') return { show: false, reason: 'merged' };
  if (f.state !== 'OPEN') return { show: false, reason: 'pr-closed' };
  if (f.draft) return { show: false, reason: 'pr-draft' };
  if (f.mergeable === 'CONFLICTING') return { show: false, reason: 'conflict' };
  if (f.mergeable !== 'MERGEABLE') return { show: false, reason: 'pr-checking' };
  return { show: true, reason: null };
}

// Merge the PR on GitHub — only the commit that was approved (--match-head-commit).
export async function mergePr(ref: PrRef, o: { strategy: 'no-ff' | 'squash'; sha: string; run?: GhRunner }): Promise<{ ok: boolean; error?: string }> {
  const run = o.run || defaultRun;
  const r = await run(['pr', 'merge', String(ref.number), '--repo', `${ref.owner}/${ref.repo}`, o.strategy === 'squash' ? '--squash' : '--merge', '--match-head-commit', o.sha]);
  return r.ok ? { ok: true } : { ok: false, error: r.out || 'gh pr merge failed' };
}
