// The gatekeeper's MCP tools (mcp/ext-mcp.js turns this module into the `ext-gatekeeper` server).
//
// Two audiences, two processes:
//   - SESSION tools run in the ONE shared process the host's MCP gateway owns. They serve restricted sessions only
//     (manifest audience "restricted"); the caller — its session id, its effective profile with its grants, its
//     host-recorded ancestors and cwd — comes from the gateway (ctx.caller), never from the arguments.
//   - ADMIN tools (gk_admin_*) exist only in a host-call process (EXT_HOST_CALL=1: the owner's trusted tab through
//     POST /__api/ext/gatekeeper/tool/<tool>, which the host allows for a signed-in admin person only).
//
// No tool name reads as "send/post/reply/comment": those would be turned into owner Send cards by the host, and a
// restricted session's writes are already scoped here (its own thread, its own repo, its team, its project).
import fs from 'node:fs';
import path from 'node:path';
import * as D from '../lib/decide.ts';
import * as S from '../lib/store.ts';
import * as X from '../lib/services.ts';
import { fetchFromSession, pushToRepo } from '../lib/git-push.ts';
import * as CO from '../lib/git-checkout.ts';

type Ctx = { caller?: D.Caller } & Record<string, unknown>;
type Tool = { name: string; description: string; inputSchema: Record<string, unknown>; run: (args: any, ctx: Ctx) => Promise<unknown> | unknown };

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required });
const str = (description: string) => ({ type: 'string', description });
const num = (description: string) => ({ type: 'number', description });

/** What a refusal looks like to the model and to the bench (`denied by the gatekeeper`). */
const refused = (reason: string) => ({ ok: false, decision: 'refused', error: `denied by the gatekeeper: ${reason}` });

interface Call {
  caller: D.Caller;
  cfg: S.Config;
}

/**
 * One gated call: the caller check, the grant, then `body` (which may refuse further with `deny`). Every outcome is one
 * audit line. `body` returns the tool result; a thrown error is a `failed` line (the gate said yes, the service said no).
 */
async function gated(tool: string, action: string | null, ctx: Ctx, target: string, body: (c: Call, deny: (r: string) => never, note: (a: Record<string, unknown>) => void) => Promise<unknown>): Promise<unknown> {
  const caller = ctx.caller as D.Caller;
  const base = { session: caller?.session || null, profile: caller?.profile?.name || null, tool, action: action || undefined, target: target || undefined };
  const c = D.callerOk(caller);
  if (!c.ok) {
    S.audit({ ...base, decision: 'refused', reason: c.reason });
    return refused(c.reason);
  }
  if (action) {
    const g = D.hasGrant(caller, action);
    if (!g.ok) {
      S.audit({ ...base, decision: 'refused', reason: g.reason });
      return refused(g.reason);
    }
  }
  let approval: Record<string, unknown> | undefined;
  class Deny extends Error {}
  const deny = (r: string): never => {
    throw new Deny(r);
  };
  try {
    const out = await body({ caller, cfg: S.readConfig() }, deny, (a) => (approval = a));
    S.audit({ ...base, decision: 'allowed', ...(approval ? { approval } : {}), result: summary(out) });
    // The session's thread is bound here but the host has no record of it yet: hand it over once (manifest permission
    // session:origin; the gateway records metadata.origin, which the host uses for a triggers:'own-thread' listener).
    const b = bindingFor(caller);
    if (b && !caller.origin && out && typeof out === 'object' && !Array.isArray(out)) return { ...(out as object), _meta: { 'arigami/origin': { channel: b.channel, thread_ts: b.thread_ts } } };
    return out;
  } catch (e) {
    if (e instanceof Deny) {
      S.audit({ ...base, decision: 'refused', reason: e.message, ...(approval ? { approval } : {}) });
      return refused(e.message);
    }
    const msg = S.redact((e as Error)?.message || String(e));
    S.audit({ ...base, decision: 'failed', reason: msg, ...(approval ? { approval } : {}) });
    return { ok: false, decision: 'failed', error: `the gatekeeper allowed this, but it failed: ${msg}` };
  }
}

const summary = (out: unknown): Record<string, unknown> | undefined => {
  if (!out || typeof out !== 'object') return undefined;
  const o = out as Record<string, unknown>;
  const keep: Record<string, unknown> = {};
  for (const k of ['ts', 'number', 'url', 'sha', 'branch', 'merged', 'state', 'identifier', 'status', 'id']) if (k in o && typeof o[k] !== 'object') keep[k] = o[k];
  return Object.keys(keep).length ? keep : undefined;
};

const bindingFor = (caller: D.Caller) => D.effectiveBinding(caller.session!, caller.lineage || [], S.readState().bindings);

/**
 * The session's incident thread, binding it automatically when it has none yet: from where its creator said it was
 * started (`metadata.origin`, trusted like an admin's choice), else from a Slack thread its family watches with a host
 * listener, else from a thread_ts the call names. The last two are the session's own claims, so they pass the same
 * check as slack_bind_thread (incident channel, a thread an alert source or operator opened). Once bound, never changes.
 */
async function ensureBinding(call: Call, named?: { channel?: unknown; thread_ts?: unknown } | null) {
  const { caller, cfg } = call;
  const have = bindingFor(caller);
  if (have) return have;
  if (!cfg.slack.channel) return null;
  for (const cand of D.bindingCandidates(caller, cfg.slack.channel, named)) {
    if (cand.by !== 'origin') {
      if (!cfg.slack.bindOnFirstUse) continue;
      const r = await X.slack(cfg, 'conversations.replies', { channel: cand.channel, ts: cand.thread_ts, limit: 1 }).catch(() => null);
      const v = D.checkBind({ channel: cand.channel, thread_ts: cand.thread_ts, configuredChannel: cfg.slack.channel, root: (r?.messages || [])[0] || null, openers: [...cfg.slack.threadOpeners, ...cfg.slack.operators.map((o) => o.id)], existing: null, allowFirstUse: true });
      if (!v.ok) continue;
    }
    const b = { channel: cand.channel, thread_ts: cand.thread_ts, by: cand.by, at: new Date().toISOString() };
    S.updateState((s) => {
      if (!s.bindings[caller.session!]) s.bindings[caller.session!] = b;
    });
    S.audit({ session: caller.session, profile: caller.profile?.name || null, tool: 'binding', target: `${b.channel}/${b.thread_ts}`, decision: 'config', reason: `incident thread bound automatically (${cand.by})` });
    return bindingFor(caller);
  }
  return null;
}
const notBefore = (caller: D.Caller, b: D.Binding | null) => (b && D.SELF_CHOSEN.has(b.by) && caller.createdAt ? Date.parse(caller.createdAt) || null : null);
const repoPath = (cfg: S.Config) => `/repos/${cfg.github.repo}`;
const needRepo = (cfg: S.Config, deny: (r: string) => never) => (D.validRepo(cfg.github.repo) ? cfg.github.repo : deny('no GitHub repo configured'));
const prNum = (v: unknown, deny: (r: string) => never) => {
  const n = Number(String(v ?? '').replace(/^#/, ''));
  return Number.isInteger(n) && n > 0 ? n : deny('pr must be a PR number');
};

async function getPr(cfg: S.Config, n: number, deny: (r: string) => never) {
  const pr = await X.gh(cfg, 'GET', `${repoPath(cfg)}/pulls/${n}`);
  const v = D.prInScope(pr, cfg.github.repo);
  if (!v.ok) deny(v.reason);
  return pr;
}

const trimText = (s: unknown, n = 4000) => {
  const t = String(s ?? '');
  return t.length > n ? t.slice(0, n) + `… [${t.length - n} more chars]` : t;
};

const opIds = (cfg: S.Config): string[] => (cfg.slack.operators || []).map((o) => o.id);
/** TEST-ONLY approver apps (store.ts slack.testApproverApps); only plain app ids count. */
const testApps = (cfg: S.Config): string[] => (Array.isArray(cfg.slack.testApproverApps) ? cfg.slack.testApproverApps : []).map(String).filter((a) => /^A[A-Z0-9]{4,}$/.test(a));

/** Operator approval (thread) or, for a merge, the auto-rule. Returns what approved it, or denies with every reason. */
async function approve(call: Call, action: string, target: string, approvalTs: string | null, deny: (r: string) => never, autoRule?: () => Promise<{ ok: true; checks: string[]; approvedBy: string[] } | { ok: false; reason: string }>, named?: { channel?: unknown; thread_ts?: unknown } | null) {
  const { caller, cfg } = call;
  const b = await ensureBinding(call, named);
  const reasons: string[] = [];
  if (b) {
    const msgs = (await X.slackThread(cfg, b.channel, b.thread_ts)) as D.SlackMessage[];
    const v = D.findOperatorApproval({
      action,
      target,
      binding: b,
      messages: msgs,
      operators: cfg.slack.operators.map((o) => o.id),
      testApproverApps: testApps(cfg),
      consumed: Object.keys(S.readState().consumed),
      nowMs: Date.now(),
      maxAgeMin: cfg.approvals.maxAgeMin,
      verbs: cfg.approvals.verbs,
      approvalTs: approvalTs || null,
      notBeforeMs: notBefore(caller, b),
    });
    if (v.ok) return { kind: 'operator', ...(v.viaTestApp ? { viaTestApp: v.viaTestApp } : {}), approver: v.approver, approverName: cfg.slack.operators.find((o) => o.id === v.approver)?.name || null, channel: v.channel, ts: v.ts };
    reasons.push(v.reason);
  } else reasons.push('no incident thread bound, so no operator approval can be read');
  if (autoRule && !approvalTs) {
    const a = await autoRule();
    if (a.ok) return { kind: 'auto-rule', checks: a.checks, approvedBy: a.approvedBy };
    reasons.push(`auto-rule: ${a.reason}`);
  }
  return deny(`${action} needs an operator's approval — ${reasons.join('; ')}`);
}

function consume(approval: Record<string, unknown>, action: string, target: string, session: string) {
  if (approval.kind !== 'operator') return;
  S.updateState((s) => {
    s.consumed[`${approval.channel}:${approval.ts}`] = { action, target, session, at: new Date().toISOString() };
  });
}

// ---- session tools ----------------------------------------------------------------------------------------------------

const sessionTools: Tool[] = [
  {
    name: 'gatekeeper_status',
    description: 'What this restricted session may do through the gatekeeper: its grants, its incident thread, the repo / channel / team / project in scope, and which actions need an operator approval. Call this first.',
    inputSchema: obj({}),
    run: (_a, ctx) =>
      gated('gatekeeper_status', null, ctx, '', async (call) => {
        const { caller, cfg } = call;
        const grants = (caller.profile?.grants || []).filter((g) => g.startsWith(D.GRANT_PREFIX)).map((g) => g.slice(D.GRANT_PREFIX.length));
        const b = await ensureBinding(call).catch(() => bindingFor(caller));
        return {
          ok: true,
          session: caller.session,
          profile: caller.profile?.name,
          may: grants.filter((g) => D.ACTIONS[g]).map((g) => ({ action: g, what: D.ACTIONS[g].label, needsApproval: !!D.ACTIONS[g].approval })),
          incidentThread: b ? { channel: b.channel, thread_ts: b.thread_ts, boundBy: b.by, inheritedFrom: b.from === caller.session ? null : b.from } : 'none yet — pass the alert thread\'s thread_ts to a Slack tool (or slack_bind_thread) and it is bound',
          scope: {
            githubRepo: cfg.github.repo || null,
            slackChannel: cfg.slack.channel || null,
            linearTeam: cfg.linear.teamId || null,
            linearProject: cfg.linear.projectId || null,
            sentryProject: cfg.sentry.project ? `${cfg.sentry.org}/${cfg.sentry.project}` : null,
          },
          approvals: 'merge, revert and alert-rule changes run only when an operator (checked by Slack user id) says so in this session\'s incident thread' + (cfg.github.autoMerge.enabled ? ', or — for a merge — when CI is green and the PR has an approving review on its head commit' : ''),
        };
      }),
  },
  // ---- Slack
  {
    name: 'slack_bind_thread',
    description: 'Bind this session to its incident thread in the incident channel (once; a binding never changes and children inherit it). Only a thread an alert source or operator started.',
    inputSchema: obj({ thread_ts: str('the thread root message ts'), channel: str('optional; must be the incident channel') }, ['thread_ts']),
    run: (a, ctx) =>
      gated('slack_bind_thread', null, ctx, String(a.thread_ts || ''), async ({ caller, cfg }, deny) => {
        const g1 = D.hasGrant(caller, 'slack.read');
        const g2 = D.hasGrant(caller, 'slack.post');
        if (!g1.ok && !g2.ok) deny('no Slack grant in the session\'s profile');
        const channel = String(a.channel || cfg.slack.channel || '');
        let root: any = null;
        if (D.validTs(a.thread_ts) && channel === cfg.slack.channel) {
          const r = await X.slack(cfg, 'conversations.replies', { channel, ts: a.thread_ts, limit: 1 });
          root = (r.messages || [])[0] || null;
        }
        const v = D.checkBind({
          channel,
          thread_ts: a.thread_ts,
          configuredChannel: cfg.slack.channel,
          root,
          openers: [...cfg.slack.threadOpeners, ...cfg.slack.operators.map((o) => o.id)],
          existing: bindingFor(caller),
          allowFirstUse: cfg.slack.bindOnFirstUse,
        });
        if (!v.ok) deny(v.reason);
        const binding = { channel, thread_ts: String(a.thread_ts), by: 'first-use', at: new Date().toISOString() };
        S.updateState((s) => {
          s.bindings[caller.session!] = binding;
        });
        return { ok: true, channel, thread_ts: binding.thread_ts };
      }),
  },
  {
    name: 'slack_read_thread',
    description: 'Read this session\'s incident thread (root first). With no thread bound yet, pass the thread_ts of its alert thread and it is bound.',
    inputSchema: obj({ limit: num('max messages (default 100)'), thread_ts: str('optional: the alert thread to bind when none is bound yet'), channel: str('optional; must be the incident channel') }),
    run: (a, ctx) =>
      gated('slack_read_thread', 'slack.read', ctx, '', async (call, deny) => {
        const { cfg } = call;
        const b = (await ensureBinding(call, a)) || deny('no incident thread bound to this session — pass the alert thread\'s thread_ts, or an admin binds one');
        if (a.thread_ts && String(a.thread_ts) !== b.thread_ts) deny(`only its own incident thread — thread ${String(a.thread_ts)} is not ${b.thread_ts}`);
        const msgs = await X.slackThread(cfg, b.channel, b.thread_ts, Math.min(500, Number(a.limit) || 100));
        return { ok: true, channel: b.channel, thread_ts: b.thread_ts, messages: msgs.map((m: any) => ({ ts: m.ts, user: m.user || null, bot: !D.isPersonMessage(m, opIds(cfg), testApps(cfg)), ...(D.isTestApproverMessage(m, opIds(cfg), testApps(cfg)) ? { operatorViaTestApp: true } : {}), text: trimText(m.text, 3000) })) };
      }),
  },
  {
    name: 'slack_read_channel',
    description: 'Read the latest top-level messages of the incident channel.',
    inputSchema: obj({ limit: num('max messages (default 20, max 100)') }),
    run: (a, ctx) =>
      gated('slack_read_channel', 'slack.read', ctx, '', async ({ cfg }, deny) => {
        if (!cfg.slack.channel) deny('no incident channel configured');
        const r = await X.slack(cfg, 'conversations.history', { channel: cfg.slack.channel, limit: Math.min(100, Number(a.limit) || 20) });
        return { ok: true, channel: cfg.slack.channel, messages: (r.messages || []).map((m: any) => ({ ts: m.ts, user: m.user || null, bot: !D.isPersonMessage(m, opIds(cfg), testApps(cfg)), thread_ts: m.thread_ts || null, replies: m.reply_count || 0, text: trimText(m.text, 1500) })) };
      }),
  },
  {
    name: 'slack_thread_say',
    description: 'Write a message in this session\'s own incident thread (the only place it can write in Slack). Mention a person with <@USERID>. With no thread bound yet, pass the alert thread\'s thread_ts and it is bound.',
    inputSchema: obj({ text: str('the message'), channel: str('optional; must be the thread\'s channel'), thread_ts: str('optional; must be the session\'s thread') }, ['text']),
    run: (a, ctx) =>
      gated('slack_thread_say', 'slack.post', ctx, String(a.channel || ''), async (call, deny) => {
        const { cfg } = call;
        const b = await ensureBinding(call, a);
        const v = D.checkSlackWrite(a, b);
        if (!v.ok) deny(v.reason);
        const r = await X.slack(cfg, 'chat.postMessage', { channel: b!.channel, thread_ts: b!.thread_ts, text: String(a.text), reply_broadcast: false, unfurl_links: false, unfurl_media: false }, true);
        return { ok: true, ts: r.ts, channel: b!.channel, thread_ts: b!.thread_ts };
      }),
  },
  // ---- GitHub
  {
    name: 'github_get_pr',
    description: 'A PR of the repo: state, head/base, reviews, review comments, conversation, and the checks on its head commit.',
    inputSchema: obj({ pr: num('PR number') }, ['pr']),
    run: (a, ctx) =>
      gated('github_get_pr', 'github.read', ctx, String(a.pr || ''), async ({ cfg }, deny) => {
        needRepo(cfg, deny);
        const n = prNum(a.pr, deny);
        const pr = await getPr(cfg, n, deny);
        const [reviews, rc, ic, checks] = await Promise.all([
          X.gh(cfg, 'GET', `${repoPath(cfg)}/pulls/${n}/reviews?per_page=100`),
          X.gh(cfg, 'GET', `${repoPath(cfg)}/pulls/${n}/comments?per_page=100`),
          X.gh(cfg, 'GET', `${repoPath(cfg)}/issues/${n}/comments?per_page=100`),
          X.gh(cfg, 'GET', `${repoPath(cfg)}/commits/${pr.head.sha}/check-runs?per_page=100`),
        ]);
        return {
          ok: true,
          number: n,
          url: pr.html_url,
          title: pr.title,
          state: pr.state,
          merged: !!pr.merged,
          draft: !!pr.draft,
          author: pr.user?.login,
          head: { ref: pr.head.ref, sha: pr.head.sha },
          base: pr.base.ref,
          body: trimText(pr.body, 3000),
          requestedReviewers: (pr.requested_reviewers || []).map((r: any) => r.login),
          reviews: reviews.map((r: any) => ({ by: r.user?.login, state: r.state, commit: r.commit_id, body: trimText(r.body, 1500) })),
          reviewComments: rc.map((c: any) => ({ id: c.id, by: c.user?.login, path: c.path, line: c.line, body: trimText(c.body, 1500) })),
          conversation: ic.map((c: any) => ({ by: c.user?.login, body: trimText(c.body, 1500) })),
          checks: (checks.check_runs || []).map((c: any) => ({ name: c.name, status: c.status, conclusion: c.conclusion, runUrl: c.details_url })),
        };
      }),
  },
  {
    name: 'github_list_prs',
    description: 'Open (or closed) PRs of the repo.',
    inputSchema: obj({ state: str('open (default) | closed | all') }),
    run: (a, ctx) =>
      gated('github_list_prs', 'github.read', ctx, '', async ({ cfg }, deny) => {
        needRepo(cfg, deny);
        const state = ['open', 'closed', 'all'].includes(a.state) ? a.state : 'open';
        const prs = await X.gh(cfg, 'GET', `${repoPath(cfg)}/pulls?state=${state}&per_page=50`);
        return { ok: true, prs: prs.map((p: any) => ({ number: p.number, title: p.title, head: p.head?.ref, author: p.user?.login, url: p.html_url, draft: !!p.draft })) };
      }),
  },
  {
    name: 'github_run_logs',
    description: 'A CI run of the repo: its jobs and, for the failed ones (or all), the tail of their logs.',
    inputSchema: obj({ run_id: num('the Actions run id'), all_jobs: { type: 'boolean', description: 'logs of every job, not only failed ones' } }, ['run_id']),
    run: (a, ctx) =>
      gated('github_run_logs', 'github.read', ctx, String(a.run_id || ''), async ({ cfg }, deny) => {
        needRepo(cfg, deny);
        const id = Number(a.run_id);
        if (!Number.isInteger(id) || id <= 0) deny('run_id must be a number');
        const run = await X.gh(cfg, 'GET', `${repoPath(cfg)}/actions/runs/${id}`);
        const jobs = await X.gh(cfg, 'GET', `${repoPath(cfg)}/actions/runs/${id}/jobs?per_page=50`);
        const out: any[] = [];
        for (const j of jobs.jobs || []) {
          const want = a.all_jobs === true || (j.conclusion && !['success', 'skipped', 'neutral'].includes(j.conclusion));
          let log: string | null = null;
          if (want) {
            try {
              const t = String(await X.gh(cfg, 'GET', `${repoPath(cfg)}/actions/jobs/${j.id}/logs`, undefined, true));
              log = t.length > 20000 ? '…' + t.slice(-20000) : t;
            } catch (e) {
              log = `(log unavailable: ${(e as Error).message})`;
            }
          }
          out.push({ id: j.id, name: j.name, conclusion: j.conclusion, steps: (j.steps || []).filter((s: any) => s.conclusion && s.conclusion !== 'success').map((s: any) => `${s.name}: ${s.conclusion}`), ...(log !== null ? { log } : {}) });
        }
        return { ok: true, id, status: run.status, conclusion: run.conclusion, branch: run.head_branch, sha: run.head_sha, event: run.event, url: run.html_url, pullRequests: (run.pull_requests || []).map((p: any) => p.number), jobs: out };
      }),
  },
  {
    name: 'github_push',
    description: 'Push a branch of the repo from a git checkout inside this session\'s directory. Never the default or a protected branch. The gatekeeper reads the commits from your checkout and pushes them itself — no token reaches the session.',
    inputSchema: obj({ branch: str('target branch name'), path: str('the checkout, relative to (or inside) the session directory; default: the session directory'), ref: str('what to push (default HEAD)'), force: { type: 'boolean', description: 'force-push (only if the gatekeeper config allows it)' } }, ['branch']),
    run: (a, ctx) =>
      gated('github_push', 'github.push', ctx, String(a.branch || ''), async ({ caller, cfg }, deny) => {
        const repo = needRepo(cfg, deny);
        const info = await X.gh(cfg, 'GET', repoPath(cfg));
        const v = D.checkBranch(a.branch, { defaultBranch: info.default_branch, protectedBranches: cfg.github.protectedBranches, branchPattern: cfg.github.branchPattern });
        if (!v.ok) deny(v.reason);
        if (a.force === true && !cfg.github.allowForcePush) deny('force-push is off in the gatekeeper config');
        if (!caller.cwd) deny('the host did not say where this session works');
        let root: string;
        let target: string;
        try {
          root = fs.realpathSync(caller.cwd!);
          target = fs.realpathSync(path.resolve(root, String(a.path || '.')));
        } catch {
          return deny(`no such directory: ${String(a.path || '.')}`);
        }
        if (!D.pathInside(target, root)) deny('the checkout must be inside the session\'s own directory');
        const mirror = S.mirrorDir(caller.session!);
        const sha = await fetchFromSession(mirror, target, String(a.ref || 'HEAD'), String(a.branch));
        const token = await X.githubToken(cfg);
        const p = await pushToRepo(mirror, { webUrl: cfg.github.webUrl, repo, branch: String(a.branch), token, force: a.force === true });
        if (!p.ok) throw new Error(`push rejected: ${p.detail}`);
        return { ok: true, branch: String(a.branch), sha, repo };
      }),
  },
  {
    name: 'github_checkout',
    description:
      'Get the source of the repo into this session\'s own directory — the session has no GitHub token and no github.com access, ' +
      'so this is the way to read the code. A new path: a checkout of the branch / tag / commit you name (default: the default branch), ' +
      'origin set to the repo\'s plain https URL. An existing checkout made here: refreshed — the gatekeeper puts the latest ' +
      'branches and tags in a bundle inside its .git, then run the returned `fetch` command in it yourself and merge/rebase/checkout as usual. ' +
      'Push your work with github_push.',
    inputSchema: obj({ ref: str('branch, tag or commit (default: the default branch)'), path: str('where, relative to the session directory (default: the repo name)'), repo: str('owner/name — only the configured repo; optional') }),
    run: (a, ctx) =>
      gated('github_checkout', 'github.read', ctx, String(a.ref || ''), async ({ caller, cfg }, deny) => {
        const repo = needRepo(cfg, deny);
        if (a.repo !== undefined && a.repo !== null && a.repo !== '' && String(a.repo).toLowerCase() !== repo.toLowerCase()) deny(`only the configured repo ${repo}, not ${String(a.repo)}`);
        if (!caller.cwd) deny('the host did not say where this session works');
        const rel = String(a.path || repo.split('/').pop() || 'repo');
        let where: { target: string; exists: boolean };
        try {
          where = CO.checkoutTarget(caller.cwd!, rel, D.pathInside);
        } catch (e) {
          return deny((e as Error).message.includes('own directory') ? (e as Error).message : `no such parent directory for ${rel}`);
        }
        const token = await X.githubToken(cfg);
        const mirror = await CO.fetchUpstream({ webUrl: cfg.github.webUrl, repo, token });
        const ref = String(a.ref || '') || (await X.gh(cfg, 'GET', repoPath(cfg))).default_branch;
        const r = await CO.resolveRef(mirror, ref);
        const isRepo = where.exists && fs.existsSync(path.join(where.target, '.git'));
        if (isRepo) {
          await CO.writeBundle(mirror, where.target, D.pathInside, caller.cwd!);
          return { ok: true, repo, path: rel, refreshed: true, ref, sha: r.sha, next: CO.fetchCommand(rel) };
        }
        await CO.freshCheckout(mirror, { target: where.target, sha: r.sha, branch: r.branch, origin: CO.originUrl(cfg.github.webUrl, repo) });
        return { ok: true, repo, path: rel, created: true, ref, sha: r.sha, branch: r.branch, push: 'github_push { branch, path }' };
      }),
  },
  {
    name: 'github_open_pr',
    description: 'Open a PR from a branch of the repo into its default branch. The author is the bot.',
    inputSchema: obj({ branch: str('the head branch (already pushed)'), title: str('PR title'), body: str('PR description'), draft: { type: 'boolean' } }, ['branch', 'title']),
    run: (a, ctx) =>
      gated('github_open_pr', 'github.pr', ctx, String(a.branch || ''), async ({ cfg }, deny) => {
        needRepo(cfg, deny);
        const info = await X.gh(cfg, 'GET', repoPath(cfg));
        const v = D.checkBranch(a.branch, { defaultBranch: info.default_branch, protectedBranches: cfg.github.protectedBranches, branchPattern: cfg.github.branchPattern });
        if (!v.ok) deny(v.reason);
        const pr = await X.gh(cfg, 'POST', `${repoPath(cfg)}/pulls`, { title: String(a.title).slice(0, 256), head: String(a.branch), base: info.default_branch, body: String(a.body || '').slice(0, 60000), draft: a.draft === true });
        return { ok: true, number: pr.number, url: pr.html_url };
      }),
  },
  {
    name: 'github_pr_note',
    description: 'Add a note (conversation comment) to a PR of the repo.',
    inputSchema: obj({ pr: num('PR number'), body: str('the note') }, ['pr', 'body']),
    run: (a, ctx) =>
      gated('github_pr_note', 'github.pr', ctx, String(a.pr || ''), async ({ cfg }, deny) => {
        needRepo(cfg, deny);
        const n = prNum(a.pr, deny);
        await getPr(cfg, n, deny);
        if (!String(a.body || '').trim()) deny('empty note');
        const c = await X.gh(cfg, 'POST', `${repoPath(cfg)}/issues/${n}/comments`, { body: String(a.body).slice(0, 60000) });
        return { ok: true, number: n, url: c.html_url };
      }),
  },
  {
    name: 'github_request_review',
    description: 'Request (or re-request) reviews on a PR of the repo.',
    inputSchema: obj({ pr: num('PR number'), reviewers: { type: 'array', items: { type: 'string' }, description: 'GitHub logins' } }, ['pr', 'reviewers']),
    run: (a, ctx) =>
      gated('github_request_review', 'github.review', ctx, String(a.pr || ''), async ({ cfg }, deny) => {
        needRepo(cfg, deny);
        const n = prNum(a.pr, deny);
        await getPr(cfg, n, deny);
        const reviewers = (Array.isArray(a.reviewers) ? a.reviewers : []).map(String).filter((x: string) => /^[A-Za-z0-9-]{1,39}$/.test(x)).slice(0, 10);
        if (!reviewers.length) deny('no valid reviewer logins');
        await X.gh(cfg, 'POST', `${repoPath(cfg)}/pulls/${n}/requested_reviewers`, { reviewers });
        return { ok: true, number: n, reviewers };
      }),
  },
  {
    name: 'github_merge',
    description: 'Merge a PR of the repo. Runs ONLY when an operator said "merge" in this session\'s incident thread (checked by Slack user id; pass approval_ts to point at that message) or under the auto-rule (CI green + an approving review on the head commit).',
    inputSchema: obj({ pr: num('PR number'), approval_ts: str('optional: the ts of the operator\'s message in the thread'), method: str('merge | squash | rebase (default from config)'), thread_ts: str('optional: the incident thread, when none is bound yet') }, ['pr']),
    run: (a, ctx) =>
      gated('github_merge', 'github.merge', ctx, String(a.pr || ''), async (call, deny, note) => {
        const { cfg, caller } = call;
        needRepo(cfg, deny);
        const n = prNum(a.pr, deny);
        const pr = await getPr(cfg, n, deny);
        if (pr.merged) deny(`PR #${n} is already merged`);
        if (pr.state !== 'open') deny(`PR #${n} is ${pr.state}`);
        const ap = await approve(call, 'github.merge', String(n), a.approval_ts ? String(a.approval_ts) : null, deny, async () => {
          if (!cfg.github.autoMerge.enabled) return { ok: false as const, reason: 'the auto-merge rule is off' };
          const [checks, status, reviews] = await Promise.all([
            X.gh(cfg, 'GET', `${repoPath(cfg)}/commits/${pr.head.sha}/check-runs?per_page=100`),
            X.gh(cfg, 'GET', `${repoPath(cfg)}/commits/${pr.head.sha}/status`),
            X.gh(cfg, 'GET', `${repoPath(cfg)}/pulls/${n}/reviews?per_page=100`),
          ]);
          return D.checkAutoRule(cfg.github.autoMerge, pr, checks.check_runs || [], status.statuses || [], reviews);
        }, a);
        note(ap);
        const method = ['merge', 'squash', 'rebase'].includes(a.method) ? a.method : cfg.github.mergeMethod;
        // `sha`: GitHub refuses if the head moved after the approval was checked.
        const r = await X.gh(cfg, 'PUT', `${repoPath(cfg)}/pulls/${n}/merge`, { merge_method: method, sha: pr.head.sha });
        consume(ap, 'github.merge', String(n), caller.session!);
        return { ok: true, number: n, merged: !!r.merged, sha: r.sha, approvedBy: ap };
      }),
  },
  {
    name: 'github_revert',
    description: 'Open a revert PR for a merged PR of the repo. Runs ONLY when an operator said "revert" in this session\'s incident thread (checked by Slack user id). Merging the revert PR is a separate github_merge.',
    inputSchema: obj({ pr: num('the merged PR number'), approval_ts: str('optional: the ts of the operator\'s message in the thread'), thread_ts: str('optional: the incident thread, when none is bound yet') }, ['pr']),
    run: (a, ctx) =>
      gated('github_revert', 'github.revert', ctx, String(a.pr || ''), async (call, deny, note) => {
        const { cfg, caller } = call;
        needRepo(cfg, deny);
        const n = prNum(a.pr, deny);
        const pr = await getPr(cfg, n, deny);
        if (!pr.merged) deny(`PR #${n} is not merged`);
        const ap = await approve(call, 'github.revert', String(n), a.approval_ts ? String(a.approval_ts) : null, deny, undefined, a);
        note(ap);
        const d = await X.ghGraphql(cfg, 'mutation($id: ID!) { revertPullRequest(input: { pullRequestId: $id }) { revertPullRequest { number url } } }', { id: pr.node_id });
        consume(ap, 'github.revert', String(n), caller.session!);
        const rp = d?.revertPullRequest?.revertPullRequest || {};
        return { ok: true, number: rp.number, url: rp.url, reverts: n, approvedBy: ap };
      }),
  },
  // ---- Linear
  {
    name: 'linear_get_issue',
    description: 'A ticket of the configured Linear team: title, state, description, labels and recent notes.',
    inputSchema: obj({ id: str('the ticket identifier (e.g. TEAM-12) or id') }, ['id']),
    run: (a, ctx) =>
      gated('linear_get_issue', 'linear.read', ctx, String(a.id || ''), async ({ cfg }, deny) => {
        const i = await linearIssue(cfg, a.id, deny);
        return { ok: true, id: i.id, identifier: i.identifier, title: i.title, url: i.url, state: i.state?.name, description: trimText(i.description, 8000), labels: (i.labels?.nodes || []).map((l: any) => l.name), notes: (i.comments?.nodes || []).map((c: any) => ({ by: c.user?.name || null, body: trimText(c.body, 1500), at: c.createdAt })) };
      }),
  },
  {
    name: 'linear_update_issue',
    description: 'Change a ticket of the configured team: its state (by name, e.g. "In Progress", "Canceled"), title or description.',
    inputSchema: obj({ id: str('ticket identifier or id'), state: str('the new state name'), title: str('new title'), description: str('new description (markdown; replaces the old one)') }, ['id']),
    run: (a, ctx) =>
      gated('linear_update_issue', 'linear.write', ctx, String(a.id || ''), async ({ cfg }, deny) => {
        const i = await linearIssue(cfg, a.id, deny);
        const input: Record<string, unknown> = {};
        if (a.state) {
          const st = await X.linear(cfg, 'query($t: String!) { team(id: $t) { states { nodes { id name type } } } }', { t: cfg.linear.teamId });
          const v = D.linearStateAllowed(String(a.state), st.team?.states?.nodes || []);
          if (!v.ok) deny(v.reason);
          input.stateId = (st.team.states.nodes as any[]).find((x) => x.name === (v as any).state.name).id;
        }
        if (typeof a.title === 'string' && a.title.trim()) input.title = a.title.slice(0, 250);
        if (typeof a.description === 'string') input.description = a.description.slice(0, 100000);
        if (!Object.keys(input).length) deny('nothing to change');
        const r = await X.linear(cfg, 'mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { identifier state { name } } } }', { id: i.id, input });
        return { ok: !!r.issueUpdate?.success, identifier: r.issueUpdate?.issue?.identifier, state: r.issueUpdate?.issue?.state?.name };
      }),
  },
  {
    name: 'linear_add_note',
    description: 'Add a note (comment) to a ticket of the configured team.',
    inputSchema: obj({ id: str('ticket identifier or id'), body: str('markdown') }, ['id', 'body']),
    run: (a, ctx) =>
      gated('linear_add_note', 'linear.write', ctx, String(a.id || ''), async ({ cfg }, deny) => {
        const i = await linearIssue(cfg, a.id, deny);
        if (!String(a.body || '').trim()) deny('empty note');
        const r = await X.linear(cfg, 'mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id url } } }', { input: { issueId: i.id, body: String(a.body).slice(0, 50000) } });
        return { ok: !!r.commentCreate?.success, identifier: i.identifier, url: r.commentCreate?.comment?.url };
      }),
  },
  {
    name: 'linear_create_issue',
    description: 'Create a ticket in the configured team (and project, if one is configured).',
    inputSchema: obj({ title: str('title'), description: str('markdown') }, ['title']),
    run: (a, ctx) =>
      gated('linear_create_issue', 'linear.write', ctx, '', async ({ cfg }, deny) => {
        if (!cfg.linear.teamId) deny('no Linear team configured');
        const input: Record<string, unknown> = { teamId: cfg.linear.teamId, title: String(a.title).slice(0, 250), description: String(a.description || '').slice(0, 100000) };
        if (cfg.linear.projectId) input.projectId = cfg.linear.projectId;
        const r = await X.linear(cfg, 'mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier url } } }', { input });
        return { ok: !!r.issueCreate?.success, identifier: r.issueCreate?.issue?.identifier, url: r.issueCreate?.issue?.url };
      }),
  },
  // ---- Sentry
  {
    name: 'sentry_get_issue',
    description: 'An issue of the configured Sentry project (numeric id or short id), with its latest event\'s exception and top frames.',
    inputSchema: obj({ id: str('issue id or short id (PROJECT-1)') }, ['id']),
    run: (a, ctx) =>
      gated('sentry_get_issue', 'sentry.read', ctx, String(a.id || ''), async ({ cfg }, deny) => {
        const i = await sentryIssue(cfg, a.id, deny);
        let latest: any = null;
        try {
          const ev = await X.sentry(cfg, 'GET', `/api/0/organizations/${cfg.sentry.org}/issues/${i.id}/events/latest/`);
          const exc = (ev.entries || []).find((e: any) => e.type === 'exception');
          latest = {
            eventId: ev.eventID,
            when: ev.dateCreated,
            message: ev.message || ev.title,
            url: (ev.tags || []).find((t: any) => t.key === 'url')?.value || null,
            exception: (exc?.data?.values || []).map((v: any) => ({ type: v.type, value: v.value, frames: (v.stacktrace?.frames || []).slice(-8).map((f: any) => `${f.filename || f.module}:${f.lineNo} ${f.function || ''}`) })),
          };
        } catch {
          /* an issue without a readable event is still an issue */
        }
        return { ok: true, id: i.id, shortId: i.shortId, title: i.title, status: i.status, level: i.level, count: i.count, firstSeen: i.firstSeen, lastSeen: i.lastSeen, url: i.permalink, latest };
      }),
  },
  {
    name: 'sentry_list_issues',
    description: 'Issues of the configured Sentry project (Sentry search syntax, default "is:unresolved").',
    inputSchema: obj({ query: str('search, e.g. is:unresolved'), limit: num('max 50') }),
    run: (a, ctx) =>
      gated('sentry_list_issues', 'sentry.read', ctx, '', async ({ cfg }, deny) => {
        if (!cfg.sentry.org || !cfg.sentry.project) deny('no Sentry project configured');
        const q = encodeURIComponent(String(a.query || 'is:unresolved'));
        const r = await X.sentry(cfg, 'GET', `/api/0/projects/${cfg.sentry.org}/${cfg.sentry.project}/issues/?query=${q}&limit=${Math.min(50, Number(a.limit) || 20)}`);
        return { ok: true, issues: (r || []).map((i: any) => ({ id: i.id, shortId: i.shortId, title: i.title, status: i.status, count: i.count, lastSeen: i.lastSeen })) };
      }),
  },
  {
    name: 'sentry_add_note',
    description: 'Add a note to an issue of the configured Sentry project.',
    inputSchema: obj({ id: str('issue id or short id'), text: str('the note') }, ['id', 'text']),
    run: (a, ctx) =>
      gated('sentry_add_note', 'sentry.note', ctx, String(a.id || ''), async ({ cfg }, deny) => {
        const i = await sentryIssue(cfg, a.id, deny);
        if (!String(a.text || '').trim()) deny('empty note');
        const body = { text: String(a.text).slice(0, 10000) };
        try {
          await X.sentry(cfg, 'POST', `/api/0/organizations/${cfg.sentry.org}/issues/${i.id}/comments/`, body);
        } catch (e) {
          if ((e as X.ServiceError).status !== 404) throw e;
          await X.sentry(cfg, 'POST', `/api/0/issues/${i.id}/comments/`, body);
        }
        return { ok: true, id: i.id, shortId: i.shortId };
      }),
  },
  {
    name: 'sentry_set_status',
    description: 'Resolve (or unresolve) an issue of the configured Sentry project.',
    inputSchema: obj({ id: str('issue id or short id'), status: str('resolved | unresolved') }, ['id', 'status']),
    run: (a, ctx) =>
      gated('sentry_set_status', 'sentry.resolve', ctx, String(a.id || ''), async ({ cfg }, deny) => {
        const status = String(a.status || '');
        if (!['resolved', 'unresolved'].includes(status)) deny('status must be resolved or unresolved (ignoring/muting is not delegated)');
        const i = await sentryIssue(cfg, a.id, deny);
        try {
          await X.sentry(cfg, 'PUT', `/api/0/organizations/${cfg.sentry.org}/issues/${i.id}/`, { status });
        } catch (e) {
          if ((e as X.ServiceError).status !== 404) throw e;
          await X.sentry(cfg, 'PUT', `/api/0/organizations/${cfg.sentry.org}/issues/?id=${i.id}`, { status });
        }
        return { ok: true, id: i.id, shortId: i.shortId, status };
      }),
  },
  {
    name: 'sentry_get_alert_rule',
    description: 'Read an alert rule the gatekeeper manages.',
    inputSchema: obj({ id: str('the alert rule (workflow) id') }, ['id']),
    run: (a, ctx) =>
      gated('sentry_get_alert_rule', 'sentry.read', ctx, String(a.id || ''), async ({ cfg }, deny) => {
        const v = D.alertRuleInScope(a.id, cfg.sentry.alertRules);
        if (!v.ok) deny(v.reason);
        const r = await X.sentry(cfg, 'GET', `/api/0/organizations/${cfg.sentry.org}/workflows/${a.id}/`);
        return { ok: true, id: String(a.id), rule: r };
      }),
  },
  {
    name: 'sentry_update_alert_rule',
    description: 'Change an alert rule the gatekeeper manages. Runs ONLY when an operator approved it in this session\'s incident thread (checked by Slack user id; e.g. "apply filters"). `changes` is merged into the rule.',
    inputSchema: obj({ id: str('the alert rule (workflow) id'), changes: { type: 'object', description: 'fields to change' }, approval_ts: str('optional: the ts of the operator\'s message'), thread_ts: str('optional: the incident thread, when none is bound yet') }, ['id', 'changes']),
    run: (a, ctx) =>
      gated('sentry_update_alert_rule', 'sentry.alerts', ctx, String(a.id || ''), async (call, deny, note) => {
        const { cfg, caller } = call;
        const v = D.alertRuleInScope(a.id, cfg.sentry.alertRules);
        if (!v.ok) deny(v.reason);
        if (!a.changes || typeof a.changes !== 'object' || Array.isArray(a.changes) || !Object.keys(a.changes).length) deny('changes must be a non-empty object');
        const ap = await approve(call, 'sentry.alerts', String(a.id), a.approval_ts ? String(a.approval_ts) : null, deny, undefined, a);
        note(ap);
        const cur = await X.sentry(cfg, 'GET', `/api/0/organizations/${cfg.sentry.org}/workflows/${a.id}/`);
        const r = await X.sentry(cfg, 'PUT', `/api/0/organizations/${cfg.sentry.org}/workflows/${a.id}/`, { ...cur, ...a.changes }, { alerts: true });
        consume(ap, 'sentry.alerts', String(a.id), caller.session!);
        return { ok: true, id: String(a.id), approvedBy: ap, rule: { name: r?.name, enabled: r?.enabled } };
      }),
  },
];

async function linearIssue(cfg: S.Config, id: unknown, deny: (r: string) => never) {
  const key = String(id || '').trim();
  if (!/^[A-Za-z0-9-]{1,64}$/.test(key)) deny('id must be a ticket identifier or id');
  const d = await X.linear(cfg, 'query($id: String!) { issue(id: $id) { id identifier title url description state { name } team { id key } project { id } labels { nodes { name } } comments(last: 20) { nodes { body createdAt user { name } } } } }', { id: key });
  const v = D.linearInScope(d.issue, cfg.linear);
  if (!v.ok) deny(v.reason);
  return d.issue;
}

async function sentryIssue(cfg: S.Config, id: unknown, deny: (r: string) => never) {
  if (!cfg.sentry.org || !cfg.sentry.project) deny('no Sentry project configured');
  const key = String(id || '').trim();
  let issue: any;
  if (/^\d{1,20}$/.test(key)) issue = await X.sentry(cfg, 'GET', `/api/0/organizations/${cfg.sentry.org}/issues/${key}/`);
  else if (/^[A-Za-z0-9_-]{1,80}$/.test(key)) issue = (await X.sentry(cfg, 'GET', `/api/0/organizations/${cfg.sentry.org}/shortids/${key}/`))?.group;
  else deny('id must be a Sentry issue id or short id');
  const v = D.sentryIssueInScope(issue, cfg.sentry);
  if (!v.ok) deny(v.reason);
  return issue;
}

// ---- admin tools: the owner's tab only (host call; the host also refuses session tokens for them) ------------------

const isHost = (ctx: Ctx) => !!ctx.caller?.hostCall;
// Managed (sidecar) mode: a "host call" reaches this process over the pod's loopback, which a session in the host
// container can reach too — so nothing that changes scope, identities or bindings is served there at all.
const ADMIN_WRITES = new Set(['gk_admin_save_config', 'gk_admin_set_identity', 'gk_admin_clear_identity', 'gk_admin_bind']);
const adminOnly = (tool: string, ctx: Ctx, fn: () => Promise<unknown> | unknown) => {
  if (!isHost(ctx)) {
    S.audit({ session: ctx.caller?.session || null, tool, decision: 'refused', reason: 'admin tool called by a session' });
    return refused('admin tools are for the owner\'s tab only');
  }
  if (S.isManaged() && ADMIN_WRITES.has(tool)) {
    S.audit({ session: null, tool, decision: 'refused', reason: 'managed by the deployment' });
    return { ok: false, error: 'managed by the deployment: change the gatekeeper\'s Secret / ConfigMap, not the tab' };
  }
  return fn();
};

const SERVICES = ['github', 'slack', 'linear', 'sentry'] as const;
const IDENTITY_FIELDS: Record<string, string[]> = { github: ['appId', 'installationId', 'privateKey'], slack: ['botToken'], linear: ['apiKey'], sentry: ['token', 'alertsToken'] };

function cleanConfig(input: any): S.Config {
  const cur = S.readConfig();
  const c: any = JSON.parse(JSON.stringify(cur));
  const g = input?.github || {};
  if ('repo' in g) {
    if (g.repo && !D.validRepo(g.repo)) throw new Error('github.repo must be owner/name');
    c.github.repo = String(g.repo || '');
  }
  for (const k of ['apiUrl', 'webUrl']) if (typeof g[k] === 'string' && /^https:\/\//.test(g[k])) c.github[k] = g[k].replace(/\/+$/, '');
  if (Array.isArray(g.protectedBranches)) c.github.protectedBranches = g.protectedBranches.map(String).filter(Boolean).slice(0, 50);
  if ('branchPattern' in g) {
    if (g.branchPattern) new RegExp(String(g.branchPattern));
    c.github.branchPattern = g.branchPattern ? String(g.branchPattern) : null;
  }
  if (['merge', 'squash', 'rebase'].includes(g.mergeMethod)) c.github.mergeMethod = g.mergeMethod;
  if (typeof g.allowForcePush === 'boolean') c.github.allowForcePush = g.allowForcePush;
  if (g.autoMerge && typeof g.autoMerge === 'object') {
    const am = g.autoMerge;
    c.github.autoMerge = {
      enabled: am.enabled === true,
      requiredChecks: Array.isArray(am.requiredChecks) ? am.requiredChecks.map(String).filter(Boolean) : c.github.autoMerge.requiredChecks,
      approvers: Array.isArray(am.approvers) ? am.approvers.map(String).filter(Boolean) : c.github.autoMerge.approvers,
      minApprovals: Math.max(1, Math.min(10, Number(am.minApprovals) || 1)),
    };
  }
  const sl = input?.slack || {};
  if (typeof sl.apiUrl === 'string' && /^https?:\/\//.test(sl.apiUrl)) c.slack.apiUrl = sl.apiUrl.replace(/\/+$/, '');
  if ('channel' in sl) {
    if (sl.channel && !/^[CG][A-Z0-9]{4,20}$/.test(sl.channel)) throw new Error('slack.channel must be a channel id (C…)');
    c.slack.channel = String(sl.channel || '');
  }
  if (Array.isArray(sl.operators)) {
    c.slack.operators = sl.operators
      .map((o: any) => (typeof o === 'string' ? { id: o } : { id: String(o?.id || ''), ...(o?.name ? { name: String(o.name).slice(0, 60) } : {}) }))
      .filter((o: S.Operator) => /^[UW][A-Z0-9]{4,20}$/.test(o.id));
  }
  if (Array.isArray(sl.threadOpeners)) c.slack.threadOpeners = sl.threadOpeners.map(String).filter((x: string) => /^[UWBA][A-Z0-9]{4,20}$/.test(x));
  if (typeof sl.bindOnFirstUse === 'boolean') c.slack.bindOnFirstUse = sl.bindOnFirstUse;
  // TEST-ONLY approver apps (store.ts): Slack app ids only
  if (Array.isArray(sl.testApproverApps)) c.slack.testApproverApps = [...new Set(sl.testApproverApps.map(String).filter((x: string) => /^A[A-Z0-9]{4,20}$/.test(x)))];
  const li = input?.linear || {};
  if (typeof li.apiUrl === 'string' && /^https?:\/\//.test(li.apiUrl)) c.linear.apiUrl = li.apiUrl;
  if ('teamId' in li) c.linear.teamId = String(li.teamId || '');
  if ('projectId' in li) c.linear.projectId = li.projectId ? String(li.projectId) : null;
  const se = input?.sentry || {};
  if (typeof se.baseUrl === 'string' && /^https?:\/\//.test(se.baseUrl)) c.sentry.baseUrl = se.baseUrl.replace(/\/+$/, '');
  for (const k of ['org', 'project']) if (k in se) c.sentry[k] = String(se[k] || '');
  if (Array.isArray(se.alertRules)) c.sentry.alertRules = se.alertRules.map(String).filter((x: string) => /^\d{1,20}$/.test(x));
  const ap = input?.approvals || {};
  if (ap.maxAgeMin !== undefined) c.approvals.maxAgeMin = Math.max(1, Math.min(7 * 24 * 60, Number(ap.maxAgeMin) || 240));
  if (ap.verbs && typeof ap.verbs === 'object') {
    const verbs: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(ap.verbs)) if (D.SENSITIVE.includes(k) && Array.isArray(v)) verbs[k] = (v as unknown[]).map((x) => String(x).toLowerCase()).filter((x) => /^[a-z0-9]{2,30}$/.test(x));
    c.approvals.verbs = verbs;
  }
  return c;
}

const adminTools: Tool[] = [
  {
    name: 'gk_admin_state',
    description: 'Gatekeeper configuration, which identities are set (never their values), thread bindings and the action catalog.',
    inputSchema: obj({}),
    run: (_a, ctx) =>
      adminOnly('gk_admin_state', ctx, () => ({
        ok: true,
        dir: S.DIR,
        managed: S.isManaged(),
        config: S.readConfig(),
        identities: S.identityStatus(),
        bindings: S.readState().bindings,
        actions: Object.entries(D.ACTIONS).map(([k, v]) => ({ grant: D.GRANT_PREFIX + k, ...v })),
      })),
  },
  {
    name: 'gk_admin_save_config',
    description: 'Save the gatekeeper scope configuration (partial update).',
    inputSchema: obj({ config: { type: 'object' } }, ['config']),
    run: (a, ctx) =>
      adminOnly('gk_admin_save_config', ctx, () => {
        try {
          const c = S.writeConfig(cleanConfig(a.config));
          S.audit({ session: null, tool: 'gk_admin_save_config', decision: 'config', reason: 'scope configuration saved by an admin' });
          return { ok: true, config: c };
        } catch (e) {
          return { ok: false, error: (e as Error).message };
        }
      }),
  },
  {
    name: 'gk_admin_set_identity',
    description: 'Set (part of) one bot identity. Values are stored in the gatekeeper\'s own 0600 store and never returned.',
    inputSchema: obj({ service: str('github | slack | linear | sentry'), values: { type: 'object' } }, ['service', 'values']),
    run: (a, ctx) =>
      adminOnly('gk_admin_set_identity', ctx, () => {
        const svc = String(a.service);
        if (!(SERVICES as readonly string[]).includes(svc)) return { ok: false, error: 'unknown service' };
        const cur: any = S.readIdentities();
        const next = { ...(cur[svc] || {}) };
        for (const k of IDENTITY_FIELDS[svc]) {
          const v = a.values?.[k];
          if (typeof v === 'string' && v.trim()) next[k] = k === 'privateKey' ? v.trim() + '\n' : v.trim();
        }
        if (svc === 'github' && next.privateKey && !/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(next.privateKey)) return { ok: false, error: 'privateKey must be a PEM private key' };
        S.writeIdentities({ ...cur, [svc]: next });
        S.audit({ session: null, tool: 'gk_admin_set_identity', decision: 'config', reason: `${svc} identity updated (${Object.keys(a.values || {}).filter((k) => IDENTITY_FIELDS[svc].includes(k)).join(', ')})` });
        return { ok: true, identities: S.identityStatus() };
      }),
  },
  {
    name: 'gk_admin_clear_identity',
    description: 'Remove one bot identity from the gatekeeper store.',
    inputSchema: obj({ service: str('github | slack | linear | sentry') }, ['service']),
    run: (a, ctx) =>
      adminOnly('gk_admin_clear_identity', ctx, () => {
        const svc = String(a.service);
        if (!(SERVICES as readonly string[]).includes(svc)) return { ok: false, error: 'unknown service' };
        const cur: any = S.readIdentities();
        delete cur[svc];
        S.writeIdentities(cur);
        S.audit({ session: null, tool: 'gk_admin_clear_identity', decision: 'config', reason: `${svc} identity removed` });
        return { ok: true, identities: S.identityStatus() };
      }),
  },
  {
    name: 'gk_admin_test',
    description: 'Check one identity against its service (read-only) and report who it is.',
    inputSchema: obj({ service: str('github | slack | linear | sentry') }, ['service']),
    run: (a, ctx) =>
      adminOnly('gk_admin_test', ctx, async () => {
        const cfg = S.readConfig();
        try {
          if (a.service === 'github') {
            const r = await X.gh(cfg, 'GET', repoPath(cfg));
            return { ok: true, repo: r.full_name, defaultBranch: r.default_branch, permissions: r.permissions || null };
          }
          if (a.service === 'slack') {
            const r = await X.slack(cfg, 'auth.test', {});
            return { ok: true, bot: r.user_id, team: r.team };
          }
          if (a.service === 'linear') {
            const r = await X.linear(cfg, 'query($t: String!) { viewer { name } team(id: $t) { key name } }', { t: cfg.linear.teamId });
            return { ok: true, viewer: r.viewer?.name, team: r.team?.key };
          }
          if (a.service === 'sentry') {
            const r = await X.sentry(cfg, 'GET', `/api/0/projects/${cfg.sentry.org}/${cfg.sentry.project}/`);
            return { ok: true, project: r.slug };
          }
          return { ok: false, error: 'unknown service' };
        } catch (e) {
          return { ok: false, error: S.redact((e as Error).message) };
        }
      }),
  },
  {
    name: 'gk_admin_bind',
    description: 'Bind (or unbind) a session to its incident thread.',
    inputSchema: obj({ session: str('session id'), channel: str('channel id'), thread_ts: str('thread root ts'), clear: { type: 'boolean' } }, ['session']),
    run: (a, ctx) =>
      adminOnly('gk_admin_bind', ctx, () => {
        const sid = String(a.session || '');
        if (!/^[A-Za-z0-9_-]{1,80}$/.test(sid)) return { ok: false, error: 'invalid session id' };
        if (a.clear === true) {
          S.updateState((s) => {
            delete s.bindings[sid];
          });
          S.audit({ session: sid, tool: 'gk_admin_bind', decision: 'config', reason: 'binding removed by an admin' });
          return { ok: true, bindings: S.readState().bindings };
        }
        if (!/^[CG][A-Z0-9]{4,20}$/.test(String(a.channel || '')) || !D.validTs(a.thread_ts)) return { ok: false, error: 'channel id and thread_ts required' };
        S.updateState((s) => {
          s.bindings[sid] = { channel: String(a.channel), thread_ts: String(a.thread_ts), by: 'admin', at: new Date().toISOString() };
        });
        S.audit({ session: sid, tool: 'gk_admin_bind', decision: 'config', target: `${a.channel}/${a.thread_ts}`, reason: 'bound by an admin' });
        return { ok: true, bindings: S.readState().bindings };
      }),
  },
  {
    name: 'gk_admin_audit',
    description: 'The latest gatekeeper decisions (newest first).',
    inputSchema: obj({ limit: num('max lines (default 200)') }),
    run: (a, ctx) => adminOnly('gk_admin_audit', ctx, () => ({ ok: true, entries: S.auditTail(Number(a.limit) || 200) })),
  },
];

/** A host-call process (the owner's tab) sees the admin tools too; the gateway's shared process never does. */
export const tools: Tool[] = process.env.EXT_HOST_CALL === '1' ? [...adminTools, ...sessionTools] : sessionTools;
export const _test = { sessionTools, adminTools, cleanConfig };
