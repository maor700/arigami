// The PR tab's merge box (server/assets/card.jsx): what stands between the PR and a merge — GitHub's own answer, read
// with the host's gh login — and the buttons GitHub puts under it (merge with a method, auto-merge, update the branch,
// ready for review). The routes in api.ts let only the owner's cockpit call the actions.
import { execFile } from 'node:child_process';

const gh = (args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile('gh', args, { timeout: 60000, maxBuffer: 16 * 1024 * 1024 }, (err, out, errOut) =>
      err ? reject(new Error(String(errOut || err.message).trim().slice(0, 400))) : resolve(String(out))
    );
  });

const MERGE_QUERY = `query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){
  viewerPermission mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed autoMergeAllowed deleteBranchOnMerge viewerDefaultMergeMethod
  pullRequest(number:$n){
    state merged mergedAt mergedBy{login} isDraft mergeable mergeStateStatus reviewDecision headRefOid
    viewerCanUpdate viewerCanMergeAsAdmin viewerCanEnableAutoMerge viewerCanDisableAutoMerge viewerCanUpdateBranch
    autoMergeRequest{mergeMethod enabledBy{login}}
    reviewThreads(first:100){nodes{isResolved}}
    commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){nodes{
      __typename ... on CheckRun{name isRequired(pullRequestNumber:$n)} ... on StatusContext{context isRequired(pullRequestNumber:$n)}
    }}}}}}
  }}}`;

/** GitHub's merge facts for one PR, or null when gh can't say (no auth, no access). */
export async function mergeInfo(owner: string, repo: string, num: number | string): Promise<any | null> {
  try {
    const r = JSON.parse(await gh(['api', 'graphql', '-f', `query=${MERGE_QUERY}`, '-F', `o=${owner}`, '-F', `r=${repo}`, '-F', `n=${num}`]));
    return r?.data?.repository || null;
  } catch {
    return null;
  }
}

type Row = { id: string; s: 'ok' | 'bad' | 'warn' | 'pending'; title: string; detail?: string; action?: string };
type CheckItem = { name: string; state: 'ok' | 'bad' | 'pending'; required?: boolean };

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;

/**
 * The merge box, GitHub's way: one row per requirement (reviews, checks, conversations, conflicts), whether the
 * green button is live, which methods the repository allows, and whether "Merge via chat" has anything to fix
 * (conflicts, an out-of-date branch, failing required checks — what an agent can do; an approval it can't).
 */
export function mergeModel(info: any, opts: { number: number; title: string; base: string; head: string; checks: CheckItem[] }) {
  const pr = info?.pullRequest;
  if (!pr) return null;
  if (pr.merged) return { status: 'merged', by: pr.mergedBy?.login || '', at: pr.mergedAt || '' };
  if (pr.state === 'CLOSED') return { status: 'closed' };
  const mss = String(pr.mergeStateStatus || 'UNKNOWN');
  const rows: Row[] = [];
  // GitHub merges only for write access — a reader still sees what blocks it, but gets no button and no "Merge via chat"
  // (the agent merges with the same gh login). An unknown permission counts as none.
  const canWrite = ['ADMIN', 'MAINTAIN', 'WRITE'].includes(String(info.viewerPermission || ''));

  if (pr.isDraft) rows.push({ id: 'draft', s: 'warn', title: 'This pull request is still a work in progress', detail: 'Draft pull requests cannot be merged.', action: pr.viewerCanUpdate ? 'ready' : undefined });

  const rd = String(pr.reviewDecision || '');
  if (rd === 'APPROVED') rows.push({ id: 'reviews', s: 'ok', title: 'Changes approved', detail: 'The required reviews approved these changes.' });
  else if (rd === 'CHANGES_REQUESTED') rows.push({ id: 'reviews', s: 'bad', title: 'Changes requested', detail: 'A reviewer asked for changes before this can be merged.' });
  else if (rd === 'REVIEW_REQUIRED') rows.push({ id: 'reviews', s: 'bad', title: 'Review required', detail: 'At least 1 approving review is required by reviewers with write access.' });

  const cs = opts.checks;
  const req = cs.filter((c) => c.required);
  const badReq = req.filter((c) => c.state === 'bad');
  const pendReq = req.filter((c) => c.state === 'pending');
  const bad = cs.filter((c) => c.state === 'bad').length;
  const pend = cs.filter((c) => c.state === 'pending').length;
  const ok = cs.length - bad - pend;
  if (cs.length) {
    const parts = [bad && `${bad} failing`, pend && `${pend} in progress`, ok && `${ok} successful`].filter(Boolean).join(', ');
    const names = (l: CheckItem[]) => l.map((c) => c.name).join(', ');
    const detail = badReq.length ? `Required: ${names(badReq)} failed. ${parts}.` : pendReq.length ? `Waiting for required: ${names(pendReq)}. ${parts}.` : `${parts} ${cs.length === 1 ? 'check' : 'checks'}.`;
    rows.push(
      bad ? { id: 'checks', s: badReq.length ? 'bad' : 'warn', title: 'Some checks were not successful', detail }
        : pend ? { id: 'checks', s: 'pending', title: 'Some checks haven’t completed yet', detail }
        : { id: 'checks', s: 'ok', title: 'All checks have passed', detail }
    );
  }

  const open = (pr.reviewThreads?.nodes || []).filter((t: any) => !t.isResolved).length;
  if (open) rows.push({ id: 'conversations', s: 'warn', title: `${plural(open, 'unresolved conversation')}`, detail: 'Resolve them on the Files changed tab, or answer them.' });

  const mergeable = String(pr.mergeable || 'UNKNOWN');
  if (mergeable === 'CONFLICTING' || mss === 'DIRTY') rows.push({ id: 'conflicts', s: 'bad', title: 'This branch has conflicts that must be resolved', detail: `${opts.head} conflicts with ${opts.base}.` });
  else if (mss === 'BEHIND') rows.push({ id: 'conflicts', s: 'warn', title: 'This branch is out-of-date with the base branch', detail: `Merge the latest changes from ${opts.base} into this branch.`, action: pr.viewerCanUpdateBranch ? 'update' : undefined });
  else if (mergeable === 'UNKNOWN') rows.push({ id: 'conflicts', s: 'pending', title: 'Checking for the ability to merge automatically…' });
  else rows.push({ id: 'conflicts', s: 'ok', title: 'No conflicts with base branch', detail: 'Merging can be performed automatically.' });

  const canMerge = canWrite && !pr.isDraft && mergeable === 'MERGEABLE' && ['CLEAN', 'UNSTABLE', 'HAS_HOOKS'].includes(mss);
  // BLOCKED with every row green: a requirement GitHub enforces but doesn't spell out to this viewer (a code owner, a ruleset)
  const unexplained = canWrite && !canMerge && mss === 'BLOCKED' && !rows.some((r) => r.s !== 'ok');
  if (unexplained) rows.push({ id: 'rules', s: 'bad', title: 'Merging is blocked', detail: `The ${opts.base} branch's rules require something this PR doesn't meet yet.` });

  const methods = (
    [['squash', info.squashMergeAllowed], ['merge', info.mergeCommitAllowed], ['rebase', info.rebaseMergeAllowed]] as [string, boolean][]
  ).filter(([, on]) => on).map(([m]) => m);
  const pref = { SQUASH: 'squash', MERGE: 'merge', REBASE: 'rebase' }[String(info.viewerDefaultMergeMethod || '')] || '';
  return {
    status: 'open',
    canWrite,
    rows,
    canMerge,
    blocked: !canMerge,
    unstable: mss === 'UNSTABLE',
    methods,
    method: methods.includes(pref) ? pref : methods[0] || 'merge',
    defaultTitle: { squash: `${opts.title} (#${opts.number})`, merge: `Merge pull request #${opts.number} from ${opts.head}`, rebase: '' } as Record<string, string>,
    headSha: pr.headRefOid || '',
    deleteBranch: !!info.deleteBranchOnMerge,
    canAdmin: canWrite && !!pr.viewerCanMergeAsAdmin,
    canAuto: !!(canWrite && pr.viewerCanEnableAutoMerge && info.autoMergeAllowed && !pr.autoMergeRequest),
    canDisableAuto: !!pr.viewerCanDisableAutoMerge && !!pr.autoMergeRequest,
    auto: pr.autoMergeRequest ? { method: String(pr.autoMergeRequest.mergeMethod || '').toLowerCase(), by: pr.autoMergeRequest.enabledBy?.login || '' } : null,
    // what "Merge via chat" would fix — shown only when there is any
    fixable: !canWrite ? [] : rows.filter((r) => (r.id === 'conflicts' && r.s !== 'ok' && r.s !== 'pending') || (r.id === 'checks' && r.s === 'bad')).map((r) => r.title),
  };
}

/** Required-check names from the merge facts (the REST/gh-view rollup doesn't say which ones are required). */
export function requiredChecks(info: any): Set<string> {
  const nodes = info?.pullRequest?.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes || [];
  return new Set(nodes.filter((c: any) => c.isRequired).map((c: any) => c.name || c.context));
}

const METHOD_FLAG: Record<string, string> = { squash: '--squash', merge: '--merge', rebase: '--rebase' };

export async function merge(owner: string, repo: string, num: string, o: { method: string; subject?: string; body?: string; admin?: boolean; auto?: boolean; sha?: string }) {
  const flag = METHOD_FLAG[o.method];
  if (!flag) throw new Error('method must be squash, merge or rebase');
  const args = ['pr', 'merge', num, '--repo', `${owner}/${repo}`, flag];
  if (o.auto) args.push('--auto');
  if (o.admin) args.push('--admin');
  if (o.subject) args.push('--subject', o.subject);
  if (o.body) args.push('--body', o.body);
  if (o.sha) args.push('--match-head-commit', o.sha);
  await gh(args);
}

export async function disableAuto(owner: string, repo: string, num: string) {
  await gh(['pr', 'merge', num, '--repo', `${owner}/${repo}`, '--disable-auto']);
}

export async function updateBranch(owner: string, repo: string, num: string, rebase: boolean) {
  await gh(['pr', 'update-branch', num, '--repo', `${owner}/${repo}`, ...(rebase ? ['--rebase'] : [])]);
}

export async function markReady(owner: string, repo: string, num: string) {
  await gh(['pr', 'ready', num, '--repo', `${owner}/${repo}`]);
}
