// The gatekeeper's decisions — pure functions, no I/O, so every rule is unit-tested (test/gatekeeper.test.ts).
//
// The model never decides anything here. A call is allowed only when ALL of these hold, each checked in code:
//   1. the caller is a restricted session, as the HOST recorded it (the MCP gateway's caller facts, never the args);
//   2. its effective profile carries the grant for the action (`gatekeeper:<service>.<action>`);
//   3. the target is in the configured scope (the one repo, the incident thread, the team, the project);
//   4. for a sensitive action (merge, revert, alert-rule change): an operator approval — a Slack message whose
//      AUTHOR USER ID is a configured operator, in the session's own incident thread, naming the action — or the
//      auto-rule (CI green + an approving GitHub review on the head commit). Display names, quotes, a bot's message,
//      or the session's word never count.

export const GRANT_PREFIX = 'gatekeeper:';

/** Every action the gatekeeper performs, by grant. `approval` = also needs an operator approval or the auto-rule. */
export const ACTIONS: Record<string, { service: 'slack' | 'github' | 'linear' | 'sentry'; label: string; approval?: boolean }> = {
  'slack.read': { service: 'slack', label: 'Read its own incident thread and the incident channel' },
  'slack.post': { service: 'slack', label: 'Write in its own incident thread' },
  'github.read': { service: 'github', label: 'Read PRs, reviews, checks and CI logs of the repo' },
  'github.push': { service: 'github', label: 'Push branches (never the default or a protected branch)' },
  'github.pr': { service: 'github', label: 'Open PRs and add notes to them' },
  'github.review': { service: 'github', label: 'Request reviews' },
  'github.merge': { service: 'github', label: 'Merge a PR', approval: true },
  'github.revert': { service: 'github', label: 'Revert a merged PR', approval: true },
  'linear.read': { service: 'linear', label: 'Read tickets of the team' },
  'linear.write': { service: 'linear', label: 'Status, description, notes and new tickets in the team' },
  'sentry.read': { service: 'sentry', label: 'Read issues, events and alert rules of the project' },
  'sentry.note': { service: 'sentry', label: 'Add notes to issues' },
  'sentry.resolve': { service: 'sentry', label: 'Resolve / unresolve issues' },
  'sentry.alerts': { service: 'sentry', label: 'Change an alert rule', approval: true },
};

export const SENSITIVE = Object.keys(ACTIONS).filter((a) => ACTIONS[a].approval);

/** What the host says about the caller (mcp/ext-mcp.js ctx.caller, filled from the gateway's _meta). */
export interface Caller {
  session: string | null;
  shared: boolean;
  hostCall: boolean;
  profile: { name: string; grants?: string[]; parent?: string | null } | null;
  lineage: string[];
  cwd: string | null;
  /** host-recorded creation time of the session (ISO) */
  createdAt?: string | null;
  /** where the session or its nearest ancestor was started from, as its creator recorded it (host-protected) */
  origin?: { kind?: string; channel?: string; thread_ts?: string } | null;
  /** Slack threads the session's family watches through host listeners (self-registered: a claim to verify) */
  slackThreads?: { session: string; channel: string; thread_ts: string }[];
}

export type Verdict = { ok: true } | { ok: false; reason: string };
const no = (reason: string): Verdict => ({ ok: false, reason });
const yes: Verdict = { ok: true };

/** Is this a call the gatekeeper serves at all? Only a restricted session, only through the host's gateway. */
export function callerOk(c: Caller | null | undefined): Verdict {
  if (!c) return no('no caller');
  if (c.hostCall) return no('the gatekeeper acts only for a restricted session, not for a host call');
  if (!c.shared) return no('the gatekeeper runs only behind the host MCP gateway (ARIGAMI_MCP_GATEWAY must be on)');
  if (!c.session) return no('no calling session');
  if (!c.profile) return no('the gatekeeper serves restricted sessions only — this session has no profile');
  return yes;
}

/** Does the caller's effective profile hold the grant for `action`? */
export function hasGrant(c: Caller, action: string): Verdict {
  if (!ACTIONS[action]) return no(`unknown action ${action}`);
  const grants = Array.isArray(c.profile?.grants) ? c.profile!.grants! : [];
  return grants.includes(GRANT_PREFIX + action) ? yes : no(`${action} is not in the session's profile "${c.profile?.name || '?'}"`);
}

// ---- GitHub scope --------------------------------------------------------------------------------------------------

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
export const validRepo = (r: unknown): r is string => typeof r === 'string' && REPO_RE.test(r);

/** `release/*` style patterns → a matcher. Only `*` is special. */
export function globMatch(pattern: string, s: string): boolean {
  const re = new RegExp('^' + pattern.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
  return re.test(s);
}

/** May the gatekeeper push `branch`? Never the default branch, a protected pattern, or a malformed ref. */
export function checkBranch(branch: unknown, o: { defaultBranch: string; protectedBranches?: string[]; branchPattern?: string | null }): Verdict {
  const b = String(branch ?? '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(b)) return no(`invalid branch name "${b.slice(0, 80)}"`);
  if (b.includes('..') || b.includes('//') || b.endsWith('/') || b.endsWith('.lock') || b.endsWith('.') || /@\{/.test(b)) return no(`invalid branch name "${b}"`);
  if (b === o.defaultBranch) return no(`"${b}" is the default branch — changes reach it only through a merged PR`);
  for (const p of o.protectedBranches || []) if (globMatch(p, b)) return no(`"${b}" is protected (${p})`);
  if (o.branchPattern) {
    let re: RegExp;
    try { re = new RegExp(o.branchPattern); } catch { return no('the configured branch pattern is invalid'); }
    if (!re.test(b)) return no(`"${b}" does not match the allowed branch pattern ${o.branchPattern}`);
  }
  return yes;
}

/** A PR is in scope when it lives in the configured repo (its base and its head). */
export function prInScope(pr: { base?: { repo?: { full_name?: string } }; head?: { repo?: { full_name?: string } | null } } | null, repo: string): Verdict {
  if (!pr) return no('no such PR');
  const base = pr.base?.repo?.full_name || '';
  const head = pr.head?.repo?.full_name || '';
  if (base.toLowerCase() !== repo.toLowerCase()) return no(`PR is not in ${repo}`);
  if (head && head.toLowerCase() !== repo.toLowerCase()) return no(`PR head is a fork (${head}) — only branches of ${repo}`);
  return yes;
}

/** A path the session hands us must be inside its own cwd (both already realpath'd by the caller). */
export function pathInside(child: string, root: string): boolean {
  if (!child || !root) return false;
  const r = root.endsWith('/') ? root : root + '/';
  return child === root || child.startsWith(r);
}

// ---- Slack scope ---------------------------------------------------------------------------------------------------

/**
 * `by` says how trustworthy the choice of thread is:
 *   admin / origin  — a person chose it (the Activity tab, or the session's creator recorded `metadata.origin`);
 *   first-use / listener / named — the session itself pointed at it (slack_bind_thread, its own Slack listener, a
 *     thread_ts it passed); allowed only for a thread an alert source or operator opened (checkBind), and an
 *     operator approval read from it must be newer than the session (findOperatorApproval `notBeforeMs`).
 */
export interface Binding { channel: string; thread_ts: string; by: string; at: string }
export const SELF_CHOSEN = new Set(['first-use', 'listener', 'named']);

/** Candidate threads for an automatic binding, best first. Pure: the caller verifies the self-chosen ones (checkBind). */
export function bindingCandidates(c: Caller, configuredChannel: string, named?: { channel?: unknown; thread_ts?: unknown } | null): { channel: string; thread_ts: string; by: 'origin' | 'listener' | 'named' }[] {
  const out: { channel: string; thread_ts: string; by: 'origin' | 'listener' | 'named' }[] = [];
  const o = c.origin;
  if (o && (o.kind === undefined || o.kind === 'slack') && validTs(o.thread_ts) && String(o.channel || '') === configuredChannel)
    out.push({ channel: configuredChannel, thread_ts: o.thread_ts!, by: 'origin' });
  for (const t of c.slackThreads || []) if (t.channel === configuredChannel && validTs(t.thread_ts)) out.push({ channel: t.channel, thread_ts: t.thread_ts, by: 'listener' });
  if (named && validTs(named.thread_ts) && (!named.channel || String(named.channel) === configuredChannel))
    out.push({ channel: configuredChannel, thread_ts: String(named.thread_ts), by: 'named' });
  return out;
}

/**
 * Is this Slack message a bot's? Only when Slack itself marks it so: a `bot_id`, or subtype `bot_message`.
 *
 * Why a message with the operator's user id and no bot_id counts as the operator even when an app posted it: Slack
 * sets `user` from the token that posted. A bot token always yields a `bot_id` (and its own bot user); `username` /
 * icon overrides need a bot token too, so they also carry a `bot_id`. The ONLY way to get `user: <operator>` without
 * a `bot_id` is a user token of that operator — i.e. the operator, or an app the operator personally authorised to
 * write as them, which is the operator's own delegation. `app_id` on such a message only says which client sent it.
 */
export const isBotMessage = (m: { bot_id?: string; subtype?: string }): boolean => !!m.bot_id || m.subtype === 'bot_message';

/**
 * TEST-ONLY (config `slack.testApproverApps`, empty by default): a bot-marked message still counts as its author's own
 * word when ALL of these hold — the app that posted it is listed, its `user` is a configured operator, and it is not a
 * classic `bot_message`. It exists for a test harness that can only post an operator's words through its own Slack
 * app (with that operator's user token). A stranger through the same app is not an operator; the session's own bot is
 * a bot user, never an operator; display names and quotes are never read. Leave the list empty in production.
 */
export function isTestApproverMessage(m: { user?: string; bot_id?: string; app_id?: string; subtype?: string }, operators: string[], testApproverApps: string[] | undefined): boolean {
  if (!testApproverApps?.length || !isBotMessage(m)) return false;
  return m.subtype !== 'bot_message' && !!m.app_id && testApproverApps.includes(m.app_id) && !!m.user && operators.includes(m.user);
}

/** A person's own message: not bot-marked, or a listed test approver app posting for an operator (see above). */
export const isPersonMessage = (m: { user?: string; bot_id?: string; app_id?: string; subtype?: string }, operators: string[], testApproverApps?: string[]): boolean =>
  !isBotMessage(m) || isTestApproverMessage(m, operators, testApproverApps);

/** The session's incident thread: its own binding, else its nearest ancestor's (host-recorded lineage, parent first). */
export function effectiveBinding(session: string, lineage: string[], bindings: Record<string, Binding>): (Binding & { from: string }) | null {
  for (const id of [session, ...lineage]) if (bindings[id]) return { ...bindings[id], from: id };
  return null;
}

const TS_RE = /^\d{6,12}\.\d{1,8}$/;
export const validTs = (ts: unknown): ts is string => typeof ts === 'string' && TS_RE.test(ts);

/**
 * A message the session wants to write: only into its bound thread. Any channel / thread_ts it names must be that
 * thread's; broadcasts (@channel/@here/@everyone, user groups) are refused — the thread is for the incident, not a
 * megaphone.
 */
export function checkSlackWrite(args: { text?: unknown; channel?: unknown; thread_ts?: unknown }, b: Binding | null, maxLen = 3500): Verdict {
  if (!b) return no('no incident thread is bound to this session (slack_bind_thread, or an admin binds one)');
  if (args.channel !== undefined && args.channel !== null && args.channel !== '' && String(args.channel) !== b.channel)
    return no(`only its own incident thread — channel ${String(args.channel)} is not ${b.channel}`);
  if (args.thread_ts !== undefined && args.thread_ts !== null && args.thread_ts !== '' && String(args.thread_ts) !== b.thread_ts)
    return no(`only its own incident thread — thread ${String(args.thread_ts)} is not ${b.thread_ts}`);
  const text = String(args.text ?? '');
  if (!text.trim()) return no('empty message');
  if (text.length > maxLen) return no(`message longer than ${maxLen} characters`);
  if (/<!(channel|here|everyone)(\|[^>]*)?>|<!subteam\^/i.test(text) || /(^|\s)@(channel|here|everyone)\b/i.test(text)) return no('no broadcast mentions (@channel / @here / @everyone / user groups)');
  return yes;
}

/** May a session bind itself (first use) to this thread? Only in the incident channel, only a thread an allowed opener started. */
export function checkBind(o: {
  channel: string;
  thread_ts: unknown;
  configuredChannel: string;
  root: { ts?: string; user?: string; bot_id?: string; app_id?: string; thread_ts?: string } | null;
  openers: string[];
  existing: Binding | null;
  allowFirstUse: boolean;
}): Verdict {
  if (o.existing) return no(`already bound to thread ${o.existing.thread_ts} in ${o.existing.channel} — a binding never changes`);
  if (!o.allowFirstUse) return no('self-binding is off — an admin binds the incident thread');
  if (!o.configuredChannel) return no('no incident channel configured');
  if (o.channel !== o.configuredChannel) return no(`only threads of the incident channel ${o.configuredChannel}`);
  if (!validTs(o.thread_ts)) return no('thread_ts must be a Slack message ts');
  if (!o.root || o.root.ts !== o.thread_ts) return no('no such message in the incident channel');
  if (o.root.thread_ts && o.root.thread_ts !== o.root.ts) return no('that message is a reply, not a thread root');
  const who = [o.root.user, o.root.bot_id, o.root.app_id].filter(Boolean) as string[];
  if (!who.some((w) => o.openers.includes(w))) return no('the thread was not opened by an allowed alert source or operator');
  return yes;
}

// ---- operator approval (the only way a person says yes) ------------------------------------------------------------

export interface SlackMessage {
  ts: string;
  user?: string;
  bot_id?: string;
  app_id?: string;
  subtype?: string;
  text?: string;
  thread_ts?: string;
}

export const DEFAULT_VERBS: Record<string, string[]> = {
  'github.merge': ['merge'],
  'github.revert': ['revert'],
  'sentry.alerts': ['apply', 'approve', 'approved'],
};

/** Words of a message, lowercased, quotes and code stripped (a quoted "merge" is someone else's word). */
export function ownWords(text: string): string[] {
  const unquoted = String(text || '')
    .split('\n')
    .filter((l) => !/^\s*(>|&gt;)/.test(l))
    .join('\n')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/<[^>]*>/g, ' ');
  return unquoted.toLowerCase().split(/[^a-z0-9#]+/).filter(Boolean);
}

/** PR numbers a message names (#123); an approval that names others is not for this target. */
const numbersIn = (text: string): string[] => [...String(text || '').replace(/<[^>]*>/g, ' ').matchAll(/#(\d{1,7})\b/g)].map((m) => m[1]);

export interface ApprovalQuery {
  action: string;
  /** e.g. the PR number for github actions, the rule id for sentry.alerts */
  target: string;
  binding: Binding | null;
  /** the bound thread's messages (conversations.replies), root first */
  messages: SlackMessage[];
  operators: string[];
  /** TEST-ONLY: Slack app ids whose posts for an operator count as the operator's (isTestApproverMessage). */
  testApproverApps?: string[];
  /** `${channel}:${ts}` already used */
  consumed: Set<string> | string[];
  nowMs: number;
  maxAgeMin: number;
  verbs?: Record<string, string[]>;
  /** the session points at the exact triggering message */
  approvalTs?: string | null;
  /** for a thread the session chose itself: only messages newer than this (the session's creation) count */
  notBeforeMs?: number | null;
}

export type ApprovalVerdict = { ok: true; approver: string; ts: string; channel: string; text: string; viaTestApp?: string } | { ok: false; reason: string };

/** Is there an operator's approval for this action in the session's own thread? Checked on the AUTHOR USER ID only. */
export function findOperatorApproval(q: ApprovalQuery): ApprovalVerdict {
  if (!SENSITIVE.includes(q.action)) return { ok: false, reason: `${q.action} needs no approval` };
  if (!q.binding) return { ok: false, reason: 'no incident thread bound — an operator approval is read only from the session\'s own thread' };
  if (!q.operators.length) return { ok: false, reason: 'no operators configured' };
  const used = q.consumed instanceof Set ? q.consumed : new Set(q.consumed);
  const verbs = (q.verbs && q.verbs[q.action]) || DEFAULT_VERBS[q.action] || [];
  const why: string[] = [];
  const consider = (m: SlackMessage): ApprovalVerdict | null => {
    const tag = `message ${m.ts}`;
    if (m.thread_ts !== q.binding!.thread_ts && m.ts !== q.binding!.thread_ts) return { ok: false, reason: `${tag} is not in the session's thread` };
    if (!isPersonMessage(m, q.operators, q.testApproverApps)) return { ok: false, reason: `${tag} is not a person's message` };
    if (!m.user || !q.operators.includes(m.user)) return { ok: false, reason: `${tag} is by ${m.user || 'nobody'}, not an operator` };
    const age = (q.nowMs - Number(m.ts) * 1000) / 60_000;
    if (!(age <= q.maxAgeMin)) return { ok: false, reason: `${tag} is older than ${q.maxAgeMin} min` };
    if (age < -5) return { ok: false, reason: `${tag} is from the future` };
    if (q.notBeforeMs && Number(m.ts) * 1000 < q.notBeforeMs - 60_000) return { ok: false, reason: `${tag} is older than this session — in a thread the session picked itself, only a newer operator word counts` };
    const words = ownWords(m.text || '');
    if (!verbs.some((v) => words.includes(v))) return { ok: false, reason: `${tag} does not say ${verbs.join('/')}` };
    const nums = numbersIn(m.text || '');
    if (q.action.startsWith('github.') && nums.length && !nums.includes(String(q.target))) return { ok: false, reason: `${tag} names #${nums.join(', #')}, not #${q.target}` };
    if (used.has(`${q.binding!.channel}:${m.ts}`)) return { ok: false, reason: `${tag} was already used for an earlier action` };
    const viaTestApp = isTestApproverMessage(m, q.operators, q.testApproverApps) ? m.app_id : undefined;
    return { ok: true, approver: m.user, ts: m.ts, channel: q.binding!.channel, text: String(m.text || '').slice(0, 200), ...(viaTestApp ? { viaTestApp } : {}) };
  };
  if (q.approvalTs) {
    const m = q.messages.find((x) => x.ts === q.approvalTs);
    if (!m) return { ok: false, reason: `no message ${q.approvalTs} in the session's thread` };
    return consider(m) as ApprovalVerdict;
  }
  // Newest first: the latest operator word in the thread is the one that triggered this.
  for (const m of [...q.messages].sort((a, b) => Number(b.ts) - Number(a.ts))) {
    const v = consider(m)!;
    if (v.ok) return v;
    if (m.user && q.operators.includes(m.user)) why.push(v.reason);
  }
  return { ok: false, reason: `no operator approval in the thread${why.length ? ` (${why.slice(0, 3).join('; ')})` : ''} — an operator (by Slack user id) must say ${verbs.join('/')} in the session's thread` };
}

// ---- the auto-rule: CI green + an approving review on the head commit ----------------------------------------------

export interface AutoRule {
  enabled: boolean;
  /** check names that must be present and green; [] = every check run on the head must be green (at least one) */
  requiredChecks?: string[];
  /** GitHub logins whose approval counts; [] = any reviewer except the PR author and bots */
  approvers?: string[];
  minApprovals?: number;
}

export interface PrFacts {
  number: number;
  state: string;
  merged?: boolean;
  draft?: boolean;
  user?: { login?: string };
  head: { sha: string; ref: string };
  base: { ref: string };
}

const GREEN = new Set(['success', 'neutral', 'skipped']);

export function checkAutoRule(rule: AutoRule | null | undefined, pr: PrFacts, checkRuns: { name: string; status: string; conclusion: string | null; head_sha?: string }[], statuses: { context: string; state: string }[], reviews: { user?: { login?: string; type?: string }; state: string; commit_id?: string; submitted_at?: string }[]): { ok: true; checks: string[]; approvedBy: string[] } | { ok: false; reason: string } {
  if (!rule?.enabled) return { ok: false, reason: 'the auto-merge rule is off' };
  if (pr.draft) return { ok: false, reason: 'PR is a draft' };
  // Checks: the latest run per name on the head commit.
  const latest = new Map<string, { status: string; conclusion: string | null }>();
  for (const r of checkRuns) if (!r.head_sha || r.head_sha === pr.head.sha) latest.set(r.name, r);
  for (const s of statuses) if (!latest.has(s.context)) latest.set(s.context, { status: 'completed', conclusion: s.state === 'success' ? 'success' : s.state === 'pending' ? null : 'failure' });
  const required = rule.requiredChecks || [];
  const names = required.length ? required : [...latest.keys()];
  if (!names.length) return { ok: false, reason: 'no CI checks on the head commit' };
  for (const n of names) {
    const r = latest.get(n);
    if (!r) return { ok: false, reason: `required check "${n}" has not run on ${pr.head.sha.slice(0, 7)}` };
    if (r.status !== 'completed' || !r.conclusion) return { ok: false, reason: `check "${n}" is still running` };
    if (!GREEN.has(r.conclusion)) return { ok: false, reason: `check "${n}" is ${r.conclusion}` };
  }
  if (!required.length) for (const [n, r] of latest) if (r.status === 'completed' && r.conclusion && !GREEN.has(r.conclusion)) return { ok: false, reason: `check "${n}" is ${r.conclusion}` };
  // Reviews: the latest decisive review per reviewer.
  const author = (pr.user?.login || '').toLowerCase();
  const byUser = new Map<string, { state: string; commit_id?: string }>();
  for (const r of [...reviews].sort((a, b) => String(a.submitted_at || '').localeCompare(String(b.submitted_at || '')))) {
    const login = (r.user?.login || '').toLowerCase();
    if (!login || r.user?.type === 'Bot' || login.endsWith('[bot]')) continue;
    if (!['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.state)) continue;
    byUser.set(login, r);
  }
  for (const [login, r] of byUser) if (r.state === 'CHANGES_REQUESTED') return { ok: false, reason: `${login} requested changes` };
  const allowed = (rule.approvers || []).map((x) => x.toLowerCase());
  const approvedBy = [...byUser]
    .filter(([login, r]) => r.state === 'APPROVED' && r.commit_id === pr.head.sha && login !== author && (!allowed.length || allowed.includes(login)))
    .map(([login]) => login);
  const need = Math.max(1, rule.minApprovals || 1);
  if (approvedBy.length < need) return { ok: false, reason: `needs ${need} approving review(s) on the head commit ${pr.head.sha.slice(0, 7)}${allowed.length ? ` from ${allowed.join(', ')}` : ''} (has ${approvedBy.length})` };
  return { ok: true, checks: names, approvedBy };
}

// ---- Linear / Sentry scope -------------------------------------------------------------------------------------------

export function linearInScope(issue: { team?: { id?: string } | null; project?: { id?: string } | null } | null, cfg: { teamId?: string; projectId?: string | null }): Verdict {
  if (!issue) return no('no such ticket');
  if (!cfg.teamId) return no('no Linear team configured');
  if (issue.team?.id !== cfg.teamId) return no('ticket is not in the configured team');
  if (cfg.projectId && issue.project?.id !== cfg.projectId) return no('ticket is not in the configured project');
  return yes;
}

export function sentryIssueInScope(issue: { project?: { slug?: string; id?: string } } | null, cfg: { project?: string }): Verdict {
  if (!issue) return no('no such issue');
  if (!cfg.project) return no('no Sentry project configured');
  if (issue.project?.slug !== cfg.project && issue.project?.id !== cfg.project) return no(`issue is not in project ${cfg.project}`);
  return yes;
}

export function alertRuleInScope(id: unknown, allow: string[] | undefined): Verdict {
  const s = String(id ?? '');
  if (!/^\d{1,20}$/.test(s)) return no('alert rule id must be numeric');
  if (!allow?.length) return no('no alert rules configured for the gatekeeper');
  return allow.includes(s) ? yes : no(`alert rule ${s} is not one the gatekeeper manages`);
}

/** Linear state names a session may move a ticket to (no deleting / archiving through this path). */
export function linearStateAllowed(name: string, states: { name: string; type: string }[]): { ok: true; state: { name: string; type: string } } | { ok: false; reason: string } {
  const s = states.find((x) => x.name.toLowerCase() === String(name || '').toLowerCase());
  if (!s) return { ok: false, reason: `no state "${name}" in the team (${states.map((x) => x.name).join(', ')})` };
  return { ok: true, state: s };
}
