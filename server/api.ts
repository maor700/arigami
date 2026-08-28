import path from 'node:path';
import { IncomingMessage, ServerResponse } from 'node:http';
import { isWin, which, shellArgs, toPosixPath, HOME } from './lib/platform.js';
import * as state from './state.js';
import * as claude from './claude.js';
import { broadcast } from './bus.js';
import { cfg, nano, untildify } from './state.js';
import { SKILLS_DIR, isSkillDir, NAME_RE as SKILL_NAME_RE } from './skills.js';
import {
  changesFor,
  changeDiff,
  changeIdentity,
  prStatus,
  worktreeInfo,
  addWorktree,
} from './git.js';
import fs from 'node:fs';
import net from 'node:net';

const PERMISSION_TIMEOUT_MS = 10 * 60 * 1000;
// Longer than a permission decision — a request_screen ask is typically a
// manual login/2FA/CAPTCHA flow the human has to actually walk through.
const SCREEN_REQUEST_TIMEOUT_MS = 30 * 60 * 1000;
// Push-title suffix per request_screen `reason` (agreed names, see T1/T4 spec).
const SCREEN_REASON_LABEL: Record<string, string> = {
  login: 'login needed',
  '2fa': '2FA code needed',
  captcha: 'CAPTCHA needed',
  payment: 'payment step needs you',
  other: 'needs you on the machine',
};

interface PendingPermission {
  resolve: (value: PermissionResult | PromiseLike<PermissionResult>) => void;
  timer: NodeJS.Timeout;
  sessionId: string;
  toolName: string;
  input: unknown;
}

interface ScreenRequestResult {
  ok: boolean;
  note?: string;
}

interface PendingScreenRequest {
  resolve: (value: ScreenRequestResult | PromiseLike<ScreenRequestResult>) => void;
  timer: NodeJS.Timeout;
  sessionId: string;
}

interface CleanupPlanResult {
  removable: boolean;
  recorded: boolean;
  cmds: string[];
  worktree: string | null;
  branch: string | null;
}

interface CleanupResult {
  cmd: string;
  code: number;
  output: string;
}

const pendingPermissions = new Map<string, PendingPermission>();
const pendingScreenRequests = new Map<string, PendingScreenRequest>();

function json(
  res: ServerResponse,
  body: unknown,
  status: number = 200
): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const notFound = (
  res: ServerResponse,
  what: string = 'not found'
): void => json(res, { error: what }, 404);

const badRequest = (res: ServerResponse, msg: string): void =>
  json(res, { error: msg }, 400);

function readBody(
  req: IncomingMessage,
  maxBytes: number = 5e6
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c: Buffer) => {
      data += c;
      if (data.length > maxBytes) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data) as Record<string, unknown>);
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

interface PermissionResult {
  behavior: string;
  message?: string;
  updatedInput?: unknown;
}

async function handlePermissionRequest(
  res: ServerResponse,
  body: Record<string, unknown>
): Promise<void> {
  const sessionId = body.session_id as string | undefined;
  const s = sessionId && state.getSession(sessionId);
  if (!s) return badRequest(res, `unknown session_id: ${sessionId}`);
  const requestId = 'perm_' + nano();
  const toolName = (body.tool_name || body.toolName || 'unknown') as string;
  const input = body.input ?? {};
  // NOTE on AskUserQuestion: we deliberately keep it on the normal (blocking)
  // permission path. Auto-approving it made the CLI run the tool immediately and
  // return "the user did not answer" (there's no interactive TTY in headless
  // stream-json mode), so the model proceeded WITHOUT waiting. Keeping the
  // permission pending is what makes the model wait; the user answers through the
  // rendered "Question for you" card (posted as a message, which interrupts the
  // blocked turn). We only hide the redundant permission *bubble* in the UI — see
  // ChatPane's permission-request case.
  const result = await new Promise<PermissionResult>((resolve) => {
    const timer = setTimeout(() => {
      pendingPermissions.delete(requestId);
      state.setClaude(sessionId, { state: 'working' });
      claude.appendChat(sessionId, {
        kind: 'permission-answer',
        requestId,
        behavior: 'deny',
        message: 'timed out',
      });
      resolve({
        behavior: 'deny',
        message: 'Permission request timed out after 10 minutes',
      });
    }, PERMISSION_TIMEOUT_MS);
    pendingPermissions.set(requestId, {
      resolve,
      timer,
      sessionId,
      toolName,
      input,
    });
    state.setClaude(sessionId, { state: 'awaiting-input' });
    claude.appendChat(sessionId, {
      kind: 'permission-request',
      requestId,
      toolName,
      input,
    });
    broadcast({
      type: `permission-request:${sessionId}`,
      requestId,
      toolName,
      input,
    });
  });
  json(res, result);
}

// Force-deny any permission request left pending for a session — e.g. its
// `claude` process just died — instead of leaving the chat card showing live
// Allow/Deny buttons for up to PERMISSION_TIMEOUT_MS with nothing behind them.
export function expirePendingPermissions(
  sessionId: string,
  message: string = 'session ended'
): void {
  for (const [requestId, entry] of pendingPermissions) {
    if (entry.sessionId !== sessionId) continue;
    clearTimeout(entry.timer);
    pendingPermissions.delete(requestId);
    claude.appendChat(sessionId, {
      kind: 'permission-answer',
      requestId,
      behavior: 'deny',
      message,
    });
    entry.resolve({ behavior: 'deny', message });
  }
}

function answerPermission(
  sessionId: string,
  data: {
    requestId: string;
    behavior: string;
    message?: string;
    updatedInput?: unknown;
  }
): { ok: boolean } | null {
  const entry = pendingPermissions.get(data.requestId);
  if (!entry || entry.sessionId !== sessionId) return null;
  clearTimeout(entry.timer);
  pendingPermissions.delete(data.requestId);
  state.setClaude(sessionId, { state: 'working' });
  claude.appendChat(sessionId, {
    kind: 'permission-answer',
    requestId: data.requestId,
    behavior: data.behavior,
    ...(data.message ? { message: data.message } : {}),
  });
  entry.resolve(
    data.behavior === 'allow'
      ? {
          behavior: 'allow',
          updatedInput: data.updatedInput ?? entry.input,
        }
      : {
          behavior: 'deny',
          message: data.message || 'Denied by user',
        }
  );
  return { ok: true };
}

// ---- push for human intervention -------------------------------------------
// request_screen / request_action / report_to_master(blocked) all mean "the
// agent is stuck until a human acts". Mirror listeners.ts: one push per event,
// tagged by session so the OS collapses repeats into a single notification.
// Best-effort and fire-and-forget — push is never allowed to fail the request.
const INTERVENTION_PUSH_COOLDOWN_MS = 15 * 1000;
const lastInterventionPush = new Map<string, number>(); // `${sessionId}:${kind}` → ts
function pushIntervention(
  sessionId: string,
  kind: 'screen' | 'action' | 'blocked',
  body: string,
  titleSuffix?: string
): void {
  const key = `${sessionId}:${kind}`;
  const now = Date.now();
  // Same session, same kind, within the cooldown → the previous push is still
  // on the lock screen; don't buzz the phone again.
  if (now - (lastInterventionPush.get(key) || 0) < INTERVENTION_PUSH_COOLDOWN_MS) return;
  lastInterventionPush.set(key, now);
  const s = state.getSession(sessionId);
  const title = `${s?.title || 'Arigami'}${titleSuffix ? ` — ${titleSuffix}` : ''}`;
  import('./push.js')
    .then((push) => {
      if (!push.hasSubscriptions()) return;
      return push.sendPush({
        title: title.slice(0, 80),
        body: body.slice(0, 200),
        tag: `${kind}:${sessionId}`,
        sessionId,
        url: `/__host/#/session/${encodeURIComponent(sessionId)}`,
      });
    })
    .catch(() => {});
}

// request_screen: the agent asks the human to look at / drive the shared
// desktop (manual login, CAPTCHA, interactive installer…), shown as a live
// embedded view in the chat. Blocking, same shape as handlePermissionRequest.
async function handleScreenRequest(
  res: ServerResponse,
  body: Record<string, unknown>
): Promise<void> {
  const sessionId = body.session_id as string | undefined;
  const s = sessionId && state.getSession(sessionId);
  if (!s) return badRequest(res, `unknown session_id: ${sessionId}`);
  const requestId = 'scrn_' + nano();
  const prompt = String(body.prompt || '');
  const result = await new Promise<ScreenRequestResult>((resolve) => {
    const timer = setTimeout(() => {
      pendingScreenRequests.delete(requestId);
      state.setClaude(sessionId, { state: 'working' });
      const note = '(timed out — the human did not respond)';
      claude.appendChat(sessionId, { kind: 'screen-request-answer', requestId, note });
      resolve({ ok: true, note });
    }, SCREEN_REQUEST_TIMEOUT_MS);
    pendingScreenRequests.set(requestId, { resolve, timer, sessionId });
    state.setClaude(sessionId, { state: 'awaiting-input' });
    claude.appendChat(sessionId, { kind: 'screen-request', requestId, prompt });
    const reason = typeof body.reason === 'string' ? body.reason : '';
    const hint = typeof body.hint === 'string' ? body.hint : '';
    pushIntervention(
      sessionId,
      'screen',
      hint ? `${prompt}\n${hint}` : prompt,
      SCREEN_REASON_LABEL[reason] || 'needs you on the machine'
    );
  });
  json(res, result);
}

// Force-resolve any screen request left pending for a session — e.g. its
// `claude` process just died — instead of leaving the chat card showing a
// live embedded view for up to SCREEN_REQUEST_TIMEOUT_MS with nothing behind it.
export function expirePendingScreenRequests(
  sessionId: string,
  message: string = 'session ended'
): void {
  for (const [requestId, entry] of pendingScreenRequests) {
    if (entry.sessionId !== sessionId) continue;
    clearTimeout(entry.timer);
    pendingScreenRequests.delete(requestId);
    claude.appendChat(sessionId, { kind: 'screen-request-answer', requestId, note: message });
    entry.resolve({ ok: true, note: message });
  }
}

function answerScreenRequest(
  sessionId: string,
  data: { requestId: string; note?: string }
): { ok: boolean } | null {
  const entry = pendingScreenRequests.get(data.requestId);
  if (!entry || entry.sessionId !== sessionId) return null;
  clearTimeout(entry.timer);
  pendingScreenRequests.delete(data.requestId);
  state.setClaude(sessionId, { state: 'working' });
  claude.appendChat(sessionId, {
    kind: 'screen-request-answer',
    requestId: data.requestId,
    ...(data.note ? { note: data.note } : {}),
  });
  entry.resolve({ ok: true, ...(data.note ? { note: data.note } : {}) });
  return { ok: true };
}

// The origin an OAuth redirect_uri should use to land back on THIS request's
// device — needed so a flow like Linear connect doesn't hardcode localhost
// and dead-end when the cockpit's opened over Tailscale/LAN from a different
// device. Host comes off the Host header (proxies/tunnels preserve it).
//
// Scheme is NOT copied from the request — it's forced: OAuth providers (Linear
// included) reject a plaintext-HTTP redirect_uri for any non-loopback host,
// no exception for a private tailnet (RFC 8252 §7.3 — "native apps", which is
// what a DCR public client is treated as). So loopback gets http; anything
// else gets https on the default port — i.e. it assumes `tailscale serve`
// (real HTTPS cert) is fronting this host, not the plain-HTTP direct tailnet
// URL, which physically cannot satisfy this rule for a spec-compliant
// provider. Port is dropped for the https case for the same reason.
function browserOrigin(req: IncomingMessage): string {
  const host = req.headers.host || `localhost:${cfg.port}`;
  const hostname = host.split(':')[0];
  const isLoopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  return isLoopback ? `http://${host}` : `https://${hostname}`;
}

function spawnSafe(id: string): void {
  try {
    claude.ensureRunning(id);
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    claude.appendChat(id, {
      kind: 'error',
      text: `failed to start claude: ${error.message}`,
    });
    state.setClaude(id, { state: 'dead' });
  }
}

// Spin up a session for a ticket. Shared by the launcher's POST /sessions
// ticket path and the trigger/pending queue, so a triggered session is identical
// to a hand-launched one. Mirrors the web buildTicketPayload default prompt.
// Injected when a trigger runs in autonomous mode (unattended, e.g. on EC2).
const AUTONOMY_DIRECTIVE =
  'AUTONOMOUS MODE — you are running unattended; no human is watching this session. ' +
  'Do NOT ask the human any questions and do NOT pause for review or approval at any ' +
  'step. Make reasonable decisions yourself. If a workflow step says to request review ' +
  'or wait for the human, treat it as auto-approved and proceed all the way to ' +
  'completion. Never block waiting for input.';

// The first prompt for a session that's set to run a specific skill — the
// user (or a saved trigger/preset) picked `skill` from GET /__api/skills.
export function buildSkillPrompt(skill: string, ticket?: string): string | null {
  if (!skill || !SKILL_NAME_RE.test(skill) || !isSkillDir(skill)) return null;
  const dir = path.join(SKILLS_DIR, skill);
  return (
    `Read ${dir}/SKILL.md in full and follow it exactly` +
    (ticket ? `, with $ARGUMENTS=${ticket} and $SKILL_DIR=${dir}.` : `, with $SKILL_DIR=${dir}.`)
  );
}

// A new session's first message: an explicit `skill` wins (its instructions,
// plus `prompt` merged in after as "Additional instructions" if both are
// given); otherwise `prompt` verbatim; otherwise a plain ticket stub;
// otherwise null (blank session — mirrors today's empty-launcher behavior).
// The absolute $SKILL_DIR path is only knowable server-side, so this is the
// single place that builds it — the browser-launched, triggered/pending, and
// generic POST /sessions paths all funnel through it.
export function buildFirstPrompt(opts: { skill?: string; prompt?: string; ticket?: string }): string | null {
  const skillPrompt = opts.skill ? buildSkillPrompt(opts.skill, opts.ticket) : null;
  const extra = opts.prompt && opts.prompt.trim() ? opts.prompt.trim() : null;
  if (skillPrompt && extra) return `${skillPrompt}\n\n## Additional instructions\n${extra}`;
  if (skillPrompt) return skillPrompt;
  if (extra) return extra;
  return opts.ticket ? `Work on ${opts.ticket}.` : null;
}

export function startTicketSession(opts: {
  ticket: string;
  title?: string;
  prompt?: string;
  skill?: string;
  model?: string;
  effort?: string;
  metadata?: Record<string, unknown>;
  permissionMode?: string;
  cwd?: string;
  autonomous?: boolean;
  injectPrompt?: string;
}): { id: string } {
  const id = opts.ticket;
  let prompt = buildFirstPrompt({ skill: opts.skill, prompt: opts.prompt, ticket: id })!;
  if (opts.autonomous) prompt += `\n\n${AUTONOMY_DIRECTIVE}`;
  if (opts.injectPrompt && opts.injectPrompt.trim())
    prompt += `\n\n## Additional instructions\n${opts.injectPrompt.trim()}`;
  const s = state.createSession({
    title: opts.title && opts.title !== id ? opts.title : id,
    cwd: opts.cwd || (cfg as any).reposDir || cfg.defaultCwd,
    // Autonomous runs must never hit a permission prompt (nobody to answer it).
    permissionMode: opts.autonomous ? 'bypassPermissions' : opts.permissionMode || 'bypassPermissions',
    metadata: { ticket: id, ...(opts.metadata || {}) },
    model: opts.model,
    effort: opts.effort,
  });
  spawnSafe(s.id);
  try {
    claude.sendMessage(s.id, prompt);
  } catch {}
  return { id: s.id };
}

// Spin up a plain (empty) session — shared by the launcher's empty form and the
// pending queue's empty items. No first prompt unless a skill/prompt was given.
export function startEmptySession(opts: {
  title?: string;
  cwd?: string;
  permissionMode?: string;
  prompt?: string;
  skill?: string;
  model?: string;
  effort?: string;
  metadata?: Record<string, unknown>;
}): { id: string } {
  const prompt = buildFirstPrompt({ skill: opts.skill, prompt: opts.prompt });
  const s = state.createSession({
    title: opts.title,
    cwd: opts.cwd,
    permissionMode: opts.permissionMode || 'bypassPermissions',
    model: opts.model,
    effort: opts.effort,
    metadata: opts.metadata || {},
  });
  spawnSafe(s.id);
  if (prompt && prompt.trim()) {
    try {
      claude.sendMessage(s.id, prompt);
    } catch {}
  }
  return { id: s.id };
}

const shq = (v: string | number): string =>
  `'${String(v).replace(/'/g, `'\\''`)}'`;

export function defaultCleanupCmds(
  wtRaw: string | null | undefined,
  branch: string | null | undefined
): string[] {
  if (!wtRaw) return [];
  // The script runs under a POSIX shell (Git Bash on Windows), where a
  // backslash is an escape character and `dirname` only splits on `/`. git
  // itself already reports forward-slash paths; normalize in case the worktree
  // came from session metadata a skill wrote with native separators.
  const wt = toPosixPath(wtRaw);
  const script = [
    `MAIN=$(git -C ${shq(wt)} rev-parse --git-common-dir 2>/dev/null); MAIN=$(cd "$(dirname "$MAIN")" 2>/dev/null && pwd)`,
    `git -C "$MAIN" worktree remove --force ${shq(wt)} 2>/dev/null || rm -rf ${shq(wt)}`,
    `[ -n "$MAIN" ] && git -C "$MAIN" worktree prune 2>/dev/null`,
    branch
      ? `[ -n "$MAIN" ] && git -C "$MAIN" branch -D ${shq(branch)} 2>/dev/null`
      : null,
    `true`,
  ]
    .filter(Boolean)
    .join('; ');
  return [script];
}

export async function cleanupPlan(s: any): Promise<CleanupPlanResult> {
  const recorded =
    Array.isArray(s.metadata?.cleanup) && s.metadata.cleanup.length > 0;
  if (recorded) {
    return {
      removable: true,
      recorded: true,
      cmds: s.metadata.cleanup,
      worktree: (untildify(s.metadata?.worktree) as string | null) || null,
      branch: (s.metadata?.branch as string) || null,
    };
  }
  // A worker with no recorded cleanup owns no worktree of its own: a read-only
  // worker RUNS IN the master's worktree (wireWorker: cwd = parentDir), so the
  // worktreeInfo fallback below would detect the MASTER's worktree as linked and
  // generate an rm-rf against the master's live workspace — destroying a sibling
  // session. Never derive a cleanup plan for a worker from the on-disk worktree;
  // only the explicit metadata.cleanup path (mutating workers) is removable.
  if (s.metadata?.role === 'worker') {
    return { removable: false, recorded: false, cmds: [], worktree: null, branch: null };
  }
  const info = await worktreeInfo(s);
  if (info.linked && info.dir) {
    return {
      removable: true,
      recorded: false,
      cmds: defaultCleanupCmds(info.dir, info.branch),
      worktree: info.dir,
      branch: info.branch,
    };
  }
  return {
    removable: false,
    recorded: false,
    cmds: [],
    worktree: null,
    branch: null,
  };
}

async function runCleanup(s: any): Promise<CleanupResult[]> {
  const cmds = (await cleanupPlan(s)).cmds;
  const results: CleanupResult[] = [];
  if (!cmds.length) return results;
  const cwd = path.dirname(
    (untildify(s.cwd) as string | null) || HOME || '.'
  );
  for (const cmd of cmds) {
    try {
      const proc = Bun.spawn(shellArgs(String(cmd)), {
        cwd,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      results.push({
        cmd,
        code: code as number,
        output: (out + err).trim().slice(0, 4000),
      });
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      results.push({ cmd, code: -1, output: error.message });
    }
  }
  return results;
}

function formatReview(s: any, verdict: string, summary: string): string {
  const comments = (s.review?.comments || []).filter(
    (c: any) => !c.suggested
  );
  const label: Record<string, string> = {
    approve: '✅ Approved',
    'request-changes': '🔧 Request changes',
    comment: '💬 Comments',
  };
  const out = [
    `## Local-changes review — ${label[verdict] || '💬 Comments'}`,
    '',
  ];
  if (summary) out.push(summary, '');

  const byFile = new Map<string, any[]>();
  const features: any[] = [];
  for (const c of comments) {
    if (c.target?.kind === 'feature') features.push(c);
    else {
      const k = c.target?.path || '(general)';
      if (!byFile.has(k)) byFile.set(k, []);
      byFile.get(k)!.push(c);
    }
  }

  const fmt = (loc: string, c: any): string => {
    const line = c.resolved
      ? `- ~~${loc}${c.body}~~ _(✓ resolved)_`
      : `- ${loc}${c.body}`;
    const replies = (c.replies || []).map((r: any) => `  - ↳ ${r.body}`);
    return [line, ...replies].join('\n');
  };

  for (const [p, cs] of byFile) {
    out.push(`### ${p}`);
    for (const c of cs)
      out.push(
        fmt(c.target?.lineLabel ? `${c.target.lineLabel}: ` : '', c)
      );
    out.push('');
  }

  if (features.length) {
    out.push('### Features');
    for (const c of features)
      out.push(
        fmt(c.target?.featureTitle ? c.target.featureTitle + ': ' : '', c)
      );
    out.push('');
  }

  const open = comments.filter((c: any) => !c.resolved).length;
  if (!comments.length) {
    out.push(
      verdict === 'approve'
        ? 'No comments — the local changes look good.'
        : '(no inline comments)'
    );
  } else if (open) {
    out.push(
      '_Please address each unresolved comment above — fix it, or reply explaining why not._'
    );
  } else {
    out.push('_All comments resolved — nothing left to address._');
  }
  return out.join('\n');
}

function formatRemoteReview(s: any, verdict: string, summary: string): string {
  const comments = (s.review?.comments || []).filter(
    (c: any) => !c.suggested
  );
  const eventMap: Record<string, string> = {
    approve: 'APPROVE',
    'request-changes': 'REQUEST_CHANGES',
    comment: 'COMMENT',
  };
  const event = eventMap[verdict] || 'COMMENT';
  const withReplies = (c: any): string =>
    [c.body, ...(c.replies || []).map((r: any) => ` (follow-up: ${r.body})`)].join(
      ''
    );
  const branch = s.metadata?.branch || '';
  const prNum = s.metadata?.prNumber;
  const where = prNum
    ? `PR #${prNum}`
    : `the open PR for the current branch${branch ? ` \`${branch}\`` : ''}`;
  const out = [
    `## Publish this as a GitHub PR review (event \`${event}\`)`,
    '',
    `Post the review below to ${where} using the \`gh\` CLI. This is a REVIEW of someone else's PR — do NOT modify, fix, stage, commit, or push any code; only post the review.`,
    '',
  ];
  if (summary) out.push('**Review body:**', summary, '');

  const byFile = new Map<string, any[]>();
  const general: any[] = [];
  for (const c of comments) {
    if (c.target?.kind === 'feature' || !c.target?.path) general.push(c);
    else {
      const k = c.target.path;
      if (!byFile.has(k)) byFile.set(k, []);
      byFile.get(k)!.push(c);
    }
  }

  if (byFile.size) {
    out.push('**Inline comments** — map each to `{path, line (new-file side), body}`:', '');
    for (const [p, cs] of byFile) {
      for (const c of cs) {
        const ln = c.target?.lineLabel
          ? String(c.target.lineLabel).replace(/^L/i, '')
          : '';
        out.push(
          `- \`${p}\`${ln ? ` · line ${ln}` : ''} → ${withReplies(c)}`
        );
      }
    }
    out.push('');
  }

  if (general.length) {
    out.push('**General comments** (fold into the review body):', '');
    for (const c of general)
      out.push(
        `- ${c.target?.featureTitle ? c.target.featureTitle + ': ' : ''}${withReplies(c)}`
      );
    out.push('');
  }

  out.push(
    '### How to post',
    `1. Resolve the PR: \`gh pr view ${prNum || ''} --json number,headRefName,url\` (the worktree's branch should map to it).`,
    '2. Create the review in one API call (inline comments use the NEW-side line number):',
    '```bash',
    'gh api repos/{owner}/{repo}/pulls/<number>/reviews --input - <<\'JSON\'',
    `{ "event": "${event}", "body": "<review body>",`,
    '  "comments": [ { "path": "<path>", "line": <line>, "side": "RIGHT", "body": "<comment>" } ] }',
    'JSON',
    '```',
    '   (omit `comments` if there are no inline ones; `{owner}/{repo}` is auto-resolved by gh).',
    '3. Reply here with the review URL. If there is no PR or a line can\'t be mapped, say so instead of guessing.'
  );
  return out.join('\n');
}

async function linearTickets(facets: Record<string, unknown>): Promise<unknown> {
  // Prefer the live Linear MCP when it's authenticated; otherwise fall back to
  // the local cache / personal-API-key path in pages.js.
  try {
    const mcp = await import('./linear-mcp.js');
    if (mcp.status().connected) return await mcp.listIssuesByFacets(facets);
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    if (error.message === 'LINEAR_NEEDS_AUTH') return { tickets: [], needsAuth: true };
    // fall through to the cache path on any MCP error
  }
  try {
    const pages = await import('./pages.js');
    const filter = facets.assignee === 'me' ? 'assigned' : 'all';
    return await (pages as any).linear.listAssigned(filter);
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    return { tickets: [], error: `linear unavailable: ${error.message}` };
  }
}

// ---- Dispatcher (master/worker orchestration) ----
// See docs/DISPATCHER.md. A session that spawns a worker auto-becomes its master;
// the host stamps role/master/worktree/branch/cleanup and enforces global caps.

const SUMMARY_CAP = 2048; // ~2 KB hard cap on a worker result summary (decision 3)
const MAX_ARTIFACTS = 12;

type WireResult =
  | { deferred: true; reason: string }
  | {
      cwd: string;
      permissionMode: string;
      metadata: Record<string, unknown>;
    };

// Count live workers of a given kind across the WHOLE tree (caps are global, so
// depth never lets the fleet exceed the cap). Dead/archived don't count.
function countWorkers(kind: string): number {
  return state
    .listSessions()
    .filter(
      (s: any) =>
        s.metadata?.role === 'worker' &&
        s.metadata?.kind === kind &&
        s.claude?.state !== 'dead'
    ).length;
}

function sanitizeSubtask(subtask: string | null): string {
  return (subtask || 'work').replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 40) || 'work';
}

// Allocate a free port from the dispatcher pool for a needsServer worker. Free =
// not claimed by any live session's metadata.port. Released implicitly when the
// session is deleted. Returns null if the pool is exhausted (worker still spawns,
// just without a host-allocated port).
function allocatePort(): number | null {
  const [lo, hi] = cfg.dispatcher.portRange;
  const used = new Set(
    state
      .listSessions()
      .map((s: any) => Number(s.metadata?.port))
      .filter((n) => Number.isFinite(n) && n > 0)
  );
  for (let p = lo; p <= hi; p++) if (!used.has(p)) return p;
  return null;
}

// Resolve all auto-wiring for a worker spawn: caps → worktree (mutating) → cwd +
// permission mode + metadata. Returns {deferred} when at capacity (no session is
// created — the master leaves the node ready and retries next wake, decision 14).
async function wireWorker(
  masterId: string,
  kind: 'mutating' | 'readonly',
  body: any
): Promise<WireResult> {
  const master = state.getSession(masterId);
  if (!master) throw new Error(`unknown master session: ${masterId}`);

  const cap =
    kind === 'mutating'
      ? cfg.dispatcher.maxMutating
      : cfg.dispatcher.maxReadOnly;
  if (countWorkers(kind) >= cap)
    return { deferred: true, reason: 'at-capacity' };

  const subtask = body.subtask ? String(body.subtask) : null;
  const metadata: Record<string, unknown> = {
    role: 'worker',
    master: masterId,
    kind,
    ...(subtask ? { subtask } : {}),
  };
  if (body.needsServer) {
    const port = allocatePort();
    if (port) metadata.port = port; // surfaced to the worker as $PORT (claude.js)
  }
  const parentDir =
    (untildify((master.metadata?.worktree as string) || master.cwd) as string) ||
    HOME;

  if (kind === 'mutating') {
    const safe = sanitizeSubtask(subtask);
    const branch = `dispatch/${safe}`;
    const dir = path.join(cfg.reposDir, '.dispatch-worktrees', `${safe}-${nano()}`);
    const info = await worktreeInfo(master);
    const base = body.base ? String(body.base) : info.branch || 'main';
    const r = await addWorktree(parentDir, dir, branch, base);
    if (!r.ok) throw new Error(`worktree add failed: ${r.error}`);
    metadata.worktree = dir;
    metadata.branch = branch;
    metadata.base = r.base;
    metadata.cleanup = defaultCleanupCmds(dir, branch);
    return {
      cwd: dir,
      permissionMode: body.permissionMode || 'bypassPermissions',
      metadata,
    };
  }
  // read-only: run in the parent's repo, no worktree (decision 5).
  return {
    cwd: parentDir,
    permissionMode: body.permissionMode || 'bypassPermissions',
    metadata,
  };
}

// FULL children (project folders): regular sessions under a controller — no
// worker thinning, no dispatch branch policy. The child is expected to run its
// own skill and provision itself (e.g. a ticket-workflow skill sets up its own
// worktree); the host only wires identity (role/master) + optional port, and
// caps the fleet (a dev server per child is the expensive part).
function countFullChildren(): number {
  return state
    .listSessions()
    .filter(
      (s: any) =>
        s.metadata?.role === 'child' &&
        s.metadata?.kind === 'full' &&
        s.claude?.state !== 'dead'
    ).length;
}

async function wireFullChild(masterId: string, body: any): Promise<WireResult> {
  const master = state.getSession(masterId);
  if (!master) throw new Error(`unknown master session: ${masterId}`);
  if (countFullChildren() >= cfg.dispatcher.maxChildren)
    return { deferred: true, reason: 'at-capacity' };
  const subtask = body.subtask ? String(body.subtask) : null;
  const metadata: Record<string, unknown> = {
    role: 'child',
    master: masterId,
    kind: 'full',
    ...(subtask ? { subtask } : {}),
  };
  if (body.needsServer) {
    const port = allocatePort();
    if (port) metadata.port = port;
  }
  const parentDir =
    (untildify((master.metadata?.worktree as string) || master.cwd) as string) ||
    HOME;
  return {
    cwd: (untildify(body.cwd ? String(body.cwd) : '') as string) || parentDir,
    permissionMode: body.permissionMode || 'bypassPermissions',
    metadata,
  };
}

// A session that spawns children controls a project folder. First spawn
// auto-creates it (named after the master) with the master as controller —
// every dispatch flow gets the folder UI for free. Idempotent.
function ensureProjectFolder(masterId: string) {
  const master = state.getSession(masterId);
  if (!master) return null;
  const existing = state
    .listFolders()
    .find((f) => f.controllerSessionId === masterId);
  if (existing) return existing;
  const folder = state.createFolder({
    name: master.title || masterId,
    ...(master.sortOrder != null ? { sortOrder: master.sortOrder } : {}),
  });
  state.patchFolder(folder.id, { controllerSessionId: masterId });
  state.patchSession(masterId, { folderId: folder.id });
  return folder;
}

// Read + parse the master's durable plan (ORCHESTRATION.json in its cwd). Bounded
// read; never throws — returns {plan:null, planError} on any problem.
function readOrchestration(s: any): { plan: unknown; planError?: string } {
  const dir = untildify((s.metadata?.worktree as string) || s.cwd) as string;
  if (!dir) return { plan: null, planError: 'no cwd' };
  const file = path.join(dir, 'ORCHESTRATION.json');
  try {
    const raw = fs.readFileSync(file, 'utf8');
    if (raw.length > 256 * 1024)
      return { plan: null, planError: 'ORCHESTRATION.json too large' };
    return { plan: JSON.parse(raw) };
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    return {
      plan: null,
      planError: /ENOENT/.test(error.message)
        ? 'no ORCHESTRATION.json yet'
        : error.message,
    };
  }
}

// Bounded per-child summary for the Orchestration view — NEVER the chat (the one
// hard rule). Just identity + status + the capped result struct.
function childSummary(c: any) {
  return {
    id: c.id,
    title: c.title,
    status: c.status,
    color: c.color,
    archived: c.archived,
    claude_state: c.claude?.state,
    subtask: c.metadata?.subtask ?? null,
    kind: c.metadata?.kind ?? null,
    branch: c.metadata?.branch ?? null,
    worktree: c.metadata?.worktree ?? null,
    result: c.metadata?.result ?? null,
  };
}

function capResult(body: any): {
  state: string;
  summary: string;
  artifacts: unknown[];
  note: string;
  reportedAt: string;
} {
  const validStates = ['done', 'blocked', 'error', 'milestone'];
  const st = validStates.includes(body.state) ? body.state : 'milestone';
  const summary = String(body.summary ?? body.note ?? '').slice(0, SUMMARY_CAP);
  const artifacts = Array.isArray(body.artifacts)
    ? body.artifacts.slice(0, MAX_ARTIFACTS)
    : [];
  const note = String(body.note ?? '').slice(0, 280);
  return { state: st, summary, artifacts, note, reportedAt: new Date().toISOString() };
}

// Quick reachability probe for the configured VNC server — lets the client
// hide the screen-share icon cleanly on a machine where setup hasn't run yet,
// instead of showing a button that fails on click.
function probeVnc(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port, timeout: 800 });
    const done = (ok: boolean) => {
      sock.destroy();
      resolve(ok);
    };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    sock.once('timeout', () => done(false));
  });
}

export async function handle(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const u = new URL(req.url || '/', 'http://localhost');
  const p = u.pathname;
  const m = req.method;
  try {
    if (p === '/__mcp/permission' && m === 'POST') {
      return await handlePermissionRequest(res, await readBody(req));
    }
    if (p === '/__mcp/screen-request' && m === 'POST') {
      return await handleScreenRequest(res, await readBody(req));
    }
    if (p === '/__api/config' && m === 'GET') {
      const { groqApiKey, composioApiKey, ...pub } = cfg as any;
      return json(res, {
        ...pub,
        voiceEnabled: !!(groqApiKey || process.env.GROQ_API_KEY),
      });
    }
    // ---- Composio integrations -------------------------------------------------
    // OAuth login via Composio CLI session API (no API key required upfront)
    if (p === '/__api/composio/auth/start' && m === 'POST') {
      try {
        const sessionRes = await fetch('https://backend.composio.dev/api/v3.1/cli/create-session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        if (!sessionRes.ok) return json(res, { error: `Composio session error: ${sessionRes.status}` });
        const session = await sessionRes.json() as { id: string; code: string };
        const loginUrl = `https://dashboard.composio.dev/?cliKey=${session.id}`;
        return json(res, { loginUrl, sessionId: session.id });
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        return json(res, { error: err.message });
      }
    }
    if (p === '/__api/composio/auth/status' && m === 'GET') {
      const sessionId = u.searchParams.get('sessionId') || '';
      if (!sessionId) return json(res, { authenticated: false });
      try {
        const pollRes = await fetch(`https://backend.composio.dev/api/v3.1/cli/get-session?id=${encodeURIComponent(sessionId)}`);
        if (!pollRes.ok) return json(res, { authenticated: false });
        const pollData = await pollRes.json() as { api_key?: string | null };
        if (pollData.api_key) {
          // Persist into arigami config + live cfg
          const configPath = (cfg as any).configFile as string;
          let configData: Record<string, unknown> = {};
          try { configData = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch {}
          configData.composioApiKey = pollData.api_key;
          fs.writeFileSync(configPath, JSON.stringify(configData, null, 2) + '\n');
          (cfg as any).composioApiKey = pollData.api_key;
          return json(res, { authenticated: true });
        }
        return json(res, { authenticated: false });
      } catch {
        return json(res, { authenticated: false });
      }
    }
    const COMPOSIO_BASE = 'https://backend.composio.dev';
    const composioKey = (): string => cfg.composioApiKey || process.env.COMPOSIO_API_KEY || '';
    const composioFetch = async (path: string, opts: RequestInit = {}) => {
      const key = composioKey();
      if (!key) throw new Error('COMPOSIO_API_KEY not configured');
      const r = await fetch(`${COMPOSIO_BASE}${path}`, {
        ...opts,
        headers: { 'x-api-key': key, 'Content-Type': 'application/json', ...(opts.headers || {}) },
      });
      const text = await r.text();
      let body: any;
      try { body = JSON.parse(text); } catch { body = { error: text }; }
      if (r.status === 401) throw Object.assign(new Error(body?.error?.message || 'Invalid API key'), { status: 401 });
      if (!r.ok) throw new Error(body?.error?.message || `Composio ${r.status}`);
      return body;
    };
    if (p === '/__api/composio/toolkits' && m === 'GET') {
      try {
        const category = u.searchParams.get('category') || '';
        const qs = `limit=200${category ? `&category=${encodeURIComponent(category)}` : ''}`;
        const [toolkitsRes, connectionsRes] = await Promise.all([
          composioFetch(`/api/v3.1/toolkits?${qs}`),
          composioFetch('/api/v3.1/connected_accounts?limit=200'),
        ]);
        const connectedSlugs = new Set(
          (connectionsRes.items || [])
            .filter((c: any) => c.status === 'ACTIVE')
            .map((c: any) => c.toolkit?.slug).filter(Boolean)
        );
        const toolkits = (toolkitsRes.items || []).map((t: any) => ({
          slug: t.slug,
          name: t.name,
          logo: `https://logos.composio.dev/api/${t.slug}`,
          description: t.description,
          categories: t.categories || [],
          connected: connectedSlugs.has(t.slug),
        }));
        return json(res, { toolkits, hasKey: !!composioKey() });
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        const isAuthError = (err as any).status === 401;
        return json(res, { error: err.message, hasKey: isAuthError ? false : !!composioKey() }, 200);
      }
    }
    if (p === '/__api/composio/connections' && m === 'GET') {
      try {
        const data = await composioFetch('/api/v3.1/connected_accounts?limit=200');
        return json(res, { connections: data.items || [] });
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        return json(res, { error: err.message }, 200);
      }
    }
    if (p === '/__api/composio/connect' && m === 'POST') {
      try {
        const body = await readBody(req);
        const { toolkitSlug } = body as any;
        if (!toolkitSlug) return badRequest(res, 'toolkitSlug required');
        // Step 1: create (or reuse) a Composio-managed auth config for this toolkit
        const authConfigRes = await composioFetch('/api/v3.1/auth_configs', {
          method: 'POST',
          body: JSON.stringify({ toolkit: { slug: toolkitSlug }, type: 'use_composio_managed_auth' }),
        });
        const authConfigId = authConfigRes?.auth_config?.id;
        if (!authConfigId) throw new Error('Failed to get auth config id from Composio');
        // Step 2: get an OAuth redirect link (v3 endpoint for managed auth)
        const key = composioKey();
        const linkRes = await fetch(`${COMPOSIO_BASE}/api/v3/connected_accounts/link`, {
          method: 'POST',
          headers: { 'x-api-key': key, 'Content-Type': 'application/json' },
          body: JSON.stringify({ auth_config_id: authConfigId, user_id: 'default', redirect_url: `${COMPOSIO_BASE}` }),
        });
        const linkData = await linkRes.json() as any;
        if (!linkRes.ok) throw new Error(linkData?.error?.message || `Composio ${linkRes.status}`);
        return json(res, { redirectUrl: linkData.redirect_url, id: linkData.connected_account_id });
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        return json(res, { error: err.message }, 200);
      }
    }
    if (p.startsWith('/__api/composio/connections/') && m === 'DELETE') {
      const connId = p.split('/')[4];
      if (!connId) return badRequest(res, 'connection id required');
      try {
        await composioFetch(`/api/v3.1/connected_accounts/${connId}`, { method: 'DELETE' });
        return json(res, { ok: true });
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        return json(res, { error: err.message }, 200);
      }
    }
    // Global (not per-session) screen-share availability — the sidebar icon
    // hides itself when this is false instead of showing a broken button.
    // ---- SMS inbound webhook -------------------------------------------------
    if (p.startsWith('/__api/sms/inbound') && (m === 'POST' || m === 'GET')) {
      const sms = await import('./sms.js');
      const from = u.searchParams.get('from') || u.searchParams.get('sender') || '';
      const text = u.searchParams.get('body') || u.searchParams.get('message') || '';
      if (m === 'POST' && !from && !text) {
        const b = (await readBody(req)) as any;
        const msg = sms.receiveSms(b.from || b.sender || '', b.body || b.message || b.text || '', b.timestamp);
        return json(res, { ok: true, id: msg.id });
      }
      if (!text) return badRequest(res, 'missing body/message');
      const msg = sms.receiveSms(from, text);
      return json(res, { ok: true, id: msg.id });
    }

    // ---- Push notifications (PWA) -------------------------------------------
    if (p === '/__api/push/vapid-public-key' && m === 'GET') {
      const push = await import('./push.js');
      return json(res, { publicKey: push.getVapidPublicKey() });
    }
    if (p === '/__api/push/subscribe' && m === 'POST') {
      const push = await import('./push.js');
      const body = (await readBody(req)) as any;
      if (!body?.endpoint) return badRequest(res, 'missing subscription');
      push.addSubscription(body);
      return json(res, { ok: true });
    }
    if (p === '/__api/push/unsubscribe' && m === 'POST') {
      const push = await import('./push.js');
      const body = (await readBody(req)) as any;
      push.removeSubscription(body?.endpoint || '');
      return json(res, { ok: true });
    }

    if (p === '/__api/screen/status' && m === 'GET') {
      const available =
        !!cfg.screen?.enabled && (await probeVnc(cfg.screen.vncHost, cfg.screen.vncPort));
      return json(res, { available });
    }
    // ---- Onboarding & workspace provisioning (see docs/ONBOARDING.md) ----
    if (p === '/__api/onboarding/status' && m === 'GET') {
      const ob = await import('./onboarding.js');
      return json(res, ob.status());
    }
    if (p === '/__api/onboarding/repos' && m === 'GET') {
      const ob = await import('./onboarding.js');
      return json(res, ob.listRepos().map((r) => ob.resolveRepo(r)));
    }
    if (p === '/__api/onboarding/repos' && m === 'POST') {
      const ob = await import('./onboarding.js');
      const body = (await readBody(req)) as any;
      if (!body.name || !body.source) return badRequest(res, 'name and source required');
      try {
        return json(res, ob.addRepo(body), 201);
      } catch (e) {
        return badRequest(res, (e as Error).message);
      }
    }
    // Probe a local folder the user typed into the "From local folder" picker:
    // exists? git? toolchain? which env files are copyable. Native-only (the
    // engine must be able to read the path — no-op inside a container).
    if (p === '/__api/onboarding/detect-local' && m === 'POST') {
      const ob = await import('./onboarding.js');
      const body = (await readBody(req)) as any;
      if (!body.path) return badRequest(res, 'path required');
      return json(res, ob.detectLocalSource(String(body.path)));
    }
    if (p === '/__api/onboarding/profiles' && m === 'GET') {
      const ob = await import('./onboarding.js');
      return json(res, ob.listProfiles());
    }
    if (p.startsWith('/__api/onboarding/profiles/')) {
      const ob = await import('./onboarding.js');
      const rest = p.slice('/__api/onboarding/profiles/'.length);
      const [rawName, action] = rest.split('/');
      if (action === 'apply' && m === 'POST') {
        try {
          return json(res, ob.applyProfile(decodeURIComponent(rawName)));
        } catch (e) {
          return badRequest(res, (e as Error).message);
        }
      }
      return notFound(res);
    }
    if (p.startsWith('/__api/onboarding/repos/')) {
      const ob = await import('./onboarding.js');
      const rest = p.slice('/__api/onboarding/repos/'.length);
      const [rawName, action] = rest.split('/');
      const name = decodeURIComponent(rawName);
      try {
        if (!action && m === 'PATCH')
          return json(res, ob.saveRepo(name, (await readBody(req)) as any));
        if (!action && m === 'DELETE') return json(res, { ok: ob.removeRepo(name) });
        if (action === 'clone' && m === 'POST') return json(res, ob.cloneRepo(name));
        if (action === 'env' && m === 'POST') return json(res, ob.resolveEnv(name));
        if (action === 'install' && m === 'POST') return json(res, ob.installDeps(name));
      } catch (e) {
        return badRequest(res, (e as Error).message);
      }
      return notFound(res);
    }
    if (p === '/__api/voice/stt' && m === 'POST') {
      const voice = await import('./voice.js');
      const body = await readBody(req, 32e6);
      try {
        return json(res, await (voice as any).transcribe(body));
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        return json(res, { error: error.message }, 502);
      }
    }

    // ---- Triggers + the Pending-tasks queue (see docs/TRIGGERS.md) ----
    if (p === '/__api/triggers' && m === 'GET') {
      const t = await import('./triggers.js');
      return json(res, t.listTriggers());
    }
    if (p === '/__api/triggers' && m === 'POST') {
      const t = await import('./triggers.js');
      const body = (await readBody(req)) as any;
      const trigger = await t.createTrigger({
        name: body.name,
        filters: body.filters,
        autonomous: body.autonomous,
        injectPrompt: body.injectPrompt,
        skill: body.skill,
        model: body.model,
        effort: body.effort,
      });
      return json(res, trigger, 201);
    }
    if (p.startsWith('/__api/triggers/')) {
      const tid = p.slice('/__api/triggers/'.length);
      const t = await import('./triggers.js');
      if (m === 'GET') {
        const trigger = t.listTriggers().find((x: any) => x.id === tid);
        return trigger
          ? json(res, { ...trigger, log: t.getTriggerLog(tid) })
          : notFound(res, `no such trigger: ${tid}`);
      }
      if (m === 'PATCH') {
        const body = (await readBody(req)) as any;
        const updated = t.patchTrigger(tid, body);
        return updated ? json(res, updated) : notFound(res, `no such trigger: ${tid}`);
      }
      if (m === 'DELETE') return json(res, { ok: t.deleteTrigger(tid) });
      return notFound(res);
    }
    if (p === '/__api/pending' && m === 'GET') {
      const t = await import('./triggers.js');
      return json(res, t.snapshot());
    }
    if (p === '/__api/pending' && m === 'POST') {
      // Manually defer into the queue — a ticket or an empty (plain) session.
      const t = await import('./triggers.js');
      const body = (await readBody(req)) as any;
      if (body.kind === 'empty') {
        const item = t.deferEmpty({
          title: body.title,
          cwd: body.cwd,
          permissionMode: body.permissionMode,
          prompt: body.prompt,
          skill: body.skill,
          model: body.model,
          effort: body.effort,
        });
        return json(res, item, 201);
      }
      if (!body.ticket) return badRequest(res, 'ticket or kind:"empty" required');
      const item = t.deferTicket(String(body.ticket), body.title, body.prompt, {
        skill: body.skill,
        model: body.model,
        effort: body.effort,
      });
      return item ? json(res, item, 201) : badRequest(res, 'already queued or has a live session');
    }
    if (p === '/__api/pending/reorder' && m === 'POST') {
      const t = await import('./triggers.js');
      const body = (await readBody(req)) as any;
      if (!Array.isArray(body.order)) return badRequest(res, 'order[] required');
      return json(res, { ok: t.reorderPending(body.order.map(String)) });
    }
    if (p.startsWith('/__api/pending/')) {
      const rest = p.slice('/__api/pending/'.length);
      const t = await import('./triggers.js');
      if (rest.endsWith('/start') && m === 'POST') {
        const pid = rest.slice(0, -'/start'.length);
        const r = await t.startPending(pid);
        return r ? json(res, r) : notFound(res, `no such pending item: ${pid}`);
      }
      if (m === 'DELETE') return json(res, { ok: t.dismissPending(rest) });
      return notFound(res);
    }
    if (p === '/__api/queue' && m === 'GET') {
      const t = await import('./triggers.js');
      return json(res, t.snapshot().queue);
    }
    if (p === '/__api/queue' && m === 'PATCH') {
      const t = await import('./triggers.js');
      const body = (await readBody(req)) as any;
      return json(res, t.setQueueSettings(body));
    }
    if (p === '/__api/voice/route' && m === 'POST') {
      const voice = await import('./voice.js');
      try {
        return json(res, await (voice as any).route(await readBody(req)));
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        return json(res, { error: error.message }, 502);
      }
    }
    if (p === '/__api/usage' && m === 'GET') {
      const { getUsage } = await import('./usage.js');
      const accountId = u.searchParams.get('accountId') || undefined;
      return json(res, await (getUsage as any)(accountId));
    }
    if (p === '/__api/accounts' && m === 'GET') {
      const acc = await import('./accounts.js');
      return json(res, (acc as any).listAccounts());
    }
    if (p === '/__api/accounts' && m === 'POST') {
      const acc = await import('./accounts.js');
      const body = (await readBody(req)) as any;
      try {
        return json(res, (acc as any).addTokenAccount({ label: body?.label, token: body?.token }));
      } catch (e) {
        return badRequest(res, e instanceof Error ? e.message : String(e));
      }
    }
    if (p === '/__api/accounts/active' && m === 'POST') {
      const acc = (await import('./accounts.js')) as any;
      const body = (await readBody(req)) as any;
      try {
        const newId = body?.id;
        const oldId = acc.getActiveId();
        const out = acc.setActive(newId);
        // Re-point sessions that FOLLOW the active account onto the new one, so
        // switching accounts actually applies to existing sessions (the common
        // expectation). "Follows active" = unpinned (null), pinned to the old
        // active, or pinned to a since-deleted account. Sessions deliberately on
        // a different, still-existing account (e.g. moved by auto-switch) keep it.
        // Every running session restarts with --resume (conversation kept) —
        // including busy ones, whose in-flight turn is cut: the point of the
        // switch is that the user can prompt on the new account immediately.
        // Not-running sessions just get re-pinned for their next spawn.
        let repointed = 0;
        for (const s of state.listSessions({ archived: true })) {
          const aid = (s.claude as any)?.accountId ?? null;
          if (aid === newId) continue;
          const follows = aid === null || aid === oldId || !acc.getAccount(aid);
          if (!follows) continue;
          if (claude.isRunning(s.id)) claude.setAccount(s.id, newId);
          else {
            // Not running: setAccount's restart path won't run, so invalidate
            // the MCP verdicts here — they were recorded under the old identity
            // and stay unverifiable until the session's next spawn.
            (claude as any).markMcpStale(s.id, 'account switched');
            state.setClaude(s.id, { accountId: newId } as any);
          }
          repointed++;
        }
        // The daemon-level `claude mcp list` caches were taken under the old
        // identity too — drop them so the next panel fetch re-checks for real.
        import('./mcp-auth.js').then((mm: any) => mm.invalidateLists()).catch(() => {});
        // Push the new active account's usage to the header immediately (no poll lag).
        import('./usage.js').then((u: any) => u.refreshAccount(newId)).catch(() => {});
        return json(res, { ...out, repointed });
      } catch (e) {
        return badRequest(res, e instanceof Error ? e.message : String(e));
      }
    }
    if (p === '/__api/accounts/pool' && m === 'POST') {
      const acc = await import('./accounts.js');
      const body = (await readBody(req)) as any;
      try {
        return json(res, (acc as any).setPool(body?.id, !!body?.pool));
      } catch (e) {
        return badRequest(res, e instanceof Error ? e.message : String(e));
      }
    }
    if (p === '/__api/accounts/remove' && m === 'POST') {
      const acc = await import('./accounts.js');
      const body = (await readBody(req)) as any;
      return json(res, { ok: (acc as any).removeAccount(body?.id) });
    }
    if (p === '/__api/accounts/auth/start' && m === 'POST') {
      const auth = await import('./accounts-auth.js');
      const body = (await readBody(req)) as any;
      return json(res, (auth as any).startAuth({ label: body?.label }));
    }
    if (p === '/__api/accounts/auth/status' && m === 'GET') {
      const auth = await import('./accounts-auth.js');
      return json(res, (auth as any).authStatus(u.searchParams.get('id') || ''));
    }
    if (p === '/__api/accounts/auth/code' && m === 'POST') {
      const auth = await import('./accounts-auth.js');
      const body = (await readBody(req)) as any;
      return json(res, (auth as any).submitCode(body?.id, body?.code));
    }
    if (p === '/__api/accounts/auth/cancel' && m === 'POST') {
      const auth = await import('./accounts-auth.js');
      const body = (await readBody(req)) as any;
      return json(res, (auth as any).cancelAuth(body?.id));
    }
    // Self-driven OAuth login (PKCE) — the reliable replacement for setup-token
    // TUI scraping. start → user approves in browser → paste code → exchange.
    if (p === '/__api/accounts/oauth/start' && m === 'POST') {
      const o = await import('./oauth-login.js');
      const body = (await readBody(req)) as any;
      return json(res, (o as any).startLogin({ label: body?.label }));
    }
    if (p === '/__api/accounts/oauth/status' && m === 'GET') {
      const o = await import('./oauth-login.js');
      return json(res, (o as any).loginStatus(u.searchParams.get('id') || ''));
    }
    if (p === '/__api/accounts/oauth/code' && m === 'POST') {
      const o = await import('./oauth-login.js');
      const body = (await readBody(req)) as any;
      return json(res, await (o as any).submitCode(body?.id, body?.code));
    }
    if (p === '/__api/accounts/oauth/cancel' && m === 'POST') {
      const o = await import('./oauth-login.js');
      const body = (await readBody(req)) as any;
      return json(res, (o as any).cancelLogin(body?.id));
    }
    if (p === '/__api/mcp/servers' && m === 'GET') {
      const mcp = await import('./mcp-auth.js');
      return json(res, await (mcp as any).listServers(u.searchParams.get('force') === '1', u.searchParams.get('cwd') || ''));
    }
    if (p === '/__api/mcp/login' && m === 'POST') {
      const mcp = await import('./mcp-auth.js');
      const body = (await readBody(req)) as any;
      return json(res, (mcp as any).startLogin(body?.name, body?.cwd));
    }
    if (p === '/__api/mcp/login/status' && m === 'GET') {
      const mcp = await import('./mcp-auth.js');
      return json(res, (mcp as any).loginStatus(u.searchParams.get('name') || ''));
    }
    if (p === '/__api/mcp/logout' && m === 'POST') {
      const mcp = await import('./mcp-auth.js');
      const body = (await readBody(req)) as any;
      return json(res, await (mcp as any).logout(body?.name, body?.cwd));
    }
    if (p === '/__api/models' && m === 'GET') {
      const { getModels } = await import('./models.js');
      return json(res, await (getModels as any)());
    }
    if (p === '/__api/models/refresh' && m === 'POST') {
      const { getModels } = await import('./models.js');
      return json(res, await (getModels as any)(true));
    }
    if (p === '/__api/remote' && (m === 'GET' || m === 'POST')) {
      const remote = await import('./remote.js');
      if (m === 'GET') return json(res, (remote as any).remoteStatus());
      const body = await readBody(req);
      return json(res, (remote as any).setRemote(!!(body as any).enable));
    }
    if (p === '/__api/linear/tickets' && m === 'GET') {
      const g = (k: string) => u.searchParams.get(k) || '';
      const labels = g('labels')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      return json(
        res,
        await linearTickets({
          assignee: g('assignee') || 'me',
          state: g('state'),
          label: g('label'), // legacy single-label still honoured
          labels,
          labelOp: g('labelOp') === 'and' ? 'and' : 'or',
          priority: g('priority'),
          query: g('query'),
          orderBy: g('orderBy') || 'updatedAt',
        })
      );
    }
    if (p === '/__api/linear/labels' && m === 'GET') {
      const mcp = await import('./linear-mcp.js');
      try {
        return json(res, mcp.status().connected ? await mcp.listLabels() : []);
      } catch {
        return json(res, []);
      }
    }
    if (p === '/__api/linear/statuses' && m === 'GET') {
      const mcp = await import('./linear-mcp.js');
      try {
        return json(res, mcp.status().connected ? await mcp.listStatuses() : []);
      } catch {
        return json(res, []);
      }
    }
    if (p === '/__api/linear/status' && m === 'GET') {
      const mcp = await import('./linear-mcp.js');
      return json(res, mcp.status());
    }
    if (p === '/__api/linear/connect' && m === 'POST') {
      const mcp = await import('./linear-mcp.js');
      try {
        return json(res, await mcp.startAuth(browserOrigin(req)));
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        return json(res, { error: error.message }, 502);
      }
    }
    if (p === '/__api/linear/disconnect' && m === 'POST') {
      const mcp = await import('./linear-mcp.js');
      mcp.disconnect();
      return json(res, { ok: true });
    }
    if (p === '/__api/slack/status' && m === 'GET') {
      const s = await import('./slack.js');
      return json(res, s.status());
    }
    if (p === '/__api/slack/connect' && m === 'POST') {
      // Store a Slack user token (xoxp-…). Validated via auth.test before save.
      const body = (await readBody(req)) as any;
      const s = await import('./slack.js');
      try {
        return json(res, { ok: true, ...(await s.setToken(String(body.token || ''))) });
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        return badRequest(res, error.message);
      }
    }
    if (p === '/__api/slack/disconnect' && m === 'POST') {
      const s = await import('./slack.js');
      s.disconnect();
      return json(res, { ok: true });
    }
    if (p === '/__api/whatsapp/status' && m === 'GET') {
      const wb = await import('./whatsapp-bridge.js');
      return json(res, wb.getBridgeStatus());
    }
    if (p === '/__api/whatsapp/connect' && m === 'POST') {
      const wb = await import('./whatsapp-bridge.js');
      const { enqueueWake } = await import('./listeners.js');
      const sessionId = req.headers['x-session-id'] as string || 'ui';
      // Fire and forget — UI polls /status every 3s for updates
      wb.startBridge(sessionId, enqueueWake).catch(console.error);
      return json(res, wb.getBridgeStatus());
    }
    if (p === '/__api/whatsapp/disconnect' && m === 'POST') {
      const wb = await import('./whatsapp-bridge.js');
      wb.stopBridge();
      return json(res, { ok: true });
    }
    if (p === '/__api/linear/oauth/callback' && m === 'GET') {
      const mcp = await import('./linear-mcp.js');
      const code = u.searchParams.get('code');
      const st = u.searchParams.get('state') || undefined;
      const err = u.searchParams.get('error');
      const page = (title: string, body: string) =>
        `<!doctype html><meta charset=utf-8><title>${title}</title>` +
        `<body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f6f4ef">` +
        `<div style="text-align:center;max-width:420px;padding:28px;border:1.5px solid #2a2a2a;border-radius:14px;background:#fff;box-shadow:4px 4px 0 rgba(0,0,0,.18)">${body}</div>`;
      if (err) {
        res.writeHead(400, { 'content-type': 'text/html' });
        res.end(page('Linear — error', `<h2 style="margin:0 0 8px">Authorization failed</h2><p style="color:#9c3b33">${err}</p>`));
        return;
      }
      if (!code) {
        res.writeHead(400, { 'content-type': 'text/html' });
        res.end(page('Linear — error', '<h2>Missing authorization code</h2>'));
        return;
      }
      try {
        await mcp.finishAuth(code, st);
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(
          page('Linear connected', '<h2 style="margin:0 0 8px">✓ Linear connected</h2><p style="color:#555">You can close this tab and return to Arigami.</p><script>setTimeout(()=>window.close(),1200)</script>')
        );
        return;
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        res.writeHead(502, { 'content-type': 'text/html' });
        res.end(page('Linear — error', `<h2 style="margin:0 0 8px">Could not finish auth</h2><p style="color:#9c3b33">${error.message}</p>`));
        return;
      }
    }
    if (p === '/__api/linear/tools' && m === 'GET') {
      const mcp = await import('./linear-mcp.js');
      try {
        return json(res, await mcp.listTools());
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        return json(res, { error: error.message }, 502);
      }
    }
    {
      const tm = p.match(/^\/__api\/linear\/ticket\/([A-Za-z]+-\d+)$/);
      if (tm && m === 'GET') {
        const mcp = await import('./linear-mcp.js');
        try {
          if (mcp.status().connected) {
            const issue = await mcp.getIssue(tm[1]);
            if (issue) return json(res, issue);
          }
        } catch { /* fall back to cache/API-key path */ }
        const pages = await import('./pages.js');
        const t = await (pages as any).linear.getTicket(tm[1]);
        return t ? json(res, t) : notFound(res, `no such ticket: ${tm[1]}`);
      }
    }

    if (p === '/__api/skills' && m === 'GET') {
      const skills = await import('./skills.js');
      return json(res, skills.listSkills());
    }
    if (p === '/__api/skills/graph' && m === 'GET') {
      const skills = await import('./skills.js');
      return json(res, skills.getAnalysis());
    }
    if (p === '/__api/skills/analyze' && m === 'POST') {
      const skills = await import('./skills.js');
      try {
        return json(res, await skills.analyze());
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        return json(res, { error: error.message }, 502);
      }
    }
    {
      const sm = p.match(/^\/__api\/skills\/([a-z0-9][a-z0-9-]*)$/);
      if (sm) {
        const skills = await import('./skills.js');
        if (m === 'GET') {
          const sk = skills.readSkill(sm[1]);
          return sk ? json(res, sk) : notFound(res, `no such skill: ${sm[1]}`);
        }
        if (m === 'PUT') {
          const body = (await readBody(req)) as any;
          const r = skills.writeSkill(sm[1], String(body?.content ?? ''));
          return 'error' in r ? badRequest(res, r.error) : json(res, r);
        }
      }
    }

    // ---- rail folders --------------------------------------------------------
    if (p === '/__api/folders' && m === 'GET') return json(res, state.listFolders());
    if (p === '/__api/folders' && m === 'POST') {
      const body = (await readBody(req)) as any;
      return json(
        res,
        state.createFolder({ name: body?.name, sortOrder: body?.sortOrder }),
        201
      );
    }
    // Atomic drop application (membership + root order + in-folder order) — one
    // broadcast burst, no half-applied drops. Must precede the folder-id matcher.
    if (p === '/__api/rail/reorder' && m === 'POST') {
      const body = (await readBody(req)) as any;
      const moves: any[] = Array.isArray(body?.moves) ? body.moves : [];
      // Snapshot pre-move membership: dragging a session in/out of a PROJECT
      // folder changes the controller's authority, so it gets a thin wake.
      const pre = new Map<string, string | null>(
        moves.map((mv) => [
          String(mv.sessionId),
          state.getSession(String(mv.sessionId))?.folderId || null,
        ])
      );
      state.railReorder(body || {});
      try {
        const listeners = await import('./listeners.js');
        for (const mv of moves) {
          const sid = String(mv.sessionId);
          const before = pre.get(sid) || null;
          const after = state.getSession(sid)?.folderId || null;
          if (before === after) continue;
          const sess: any = state.getSession(sid);
          const label = sess?.metadata?.ticket || sess?.title || sid;
          const beforeCtl = before ? state.getFolder(before)?.controllerSessionId : null;
          const afterCtl = after ? state.getFolder(after)?.controllerSessionId : null;
          if (afterCtl && afterCtl !== sid)
            listeners.enqueueWake(
              afterCtl,
              `adopted: session ${sid} ("${label}") joined your project folder — you can task it now`,
              `adopt:${sid}`
            );
          if (beforeCtl && beforeCtl !== sid && beforeCtl !== afterCtl)
            listeners.enqueueWake(
              beforeCtl,
              `removed: session ${sid} ("${label}") left your project folder — it is no longer yours to task`,
              `remove:${sid}`
            );
        }
      } catch {}
      return json(res, { ok: true });
    }
    // Upgrade a folder to a PROJECT folder: spawn a dedicated controller session
    // seeded with the project-manager skill + the current member list.
    {
      const fmp = p.match(/^\/__api\/folders\/([^/]+)\/make-project$/);
      if (fmp && m === 'POST') {
        const folder = state.getFolder(fmp[1]);
        if (!folder) return notFound(res, `no such folder: ${fmp[1]}`);
        if (folder.controllerSessionId)
          return badRequest(res, 'already a project folder');
        const body = (await readBody(req)) as any;
        const kids = state.folderChildren(fmp[1]);
        // Default cwd: the most common repo among the members.
        const counts = new Map<string, number>();
        for (const k of kids) {
          const c = untildify(k.cwd) as string;
          if (c) counts.set(c, (counts.get(c) || 0) + 1);
        }
        const cwd =
          (untildify(body?.cwd ? String(body.cwd) : '') as string) ||
          [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ||
          (untildify(cfg.defaultCwd) as string);
        const ctl = state.createSession({
          title: body?.title || `${folder.name} · manager`,
          cwd,
          metadata: { role: 'controller', kind: 'controller' },
        });
        state.patchSession(ctl.id, { folderId: folder.id });
        state.patchFolder(folder.id, { controllerSessionId: ctl.id });
        spawnSafe(ctl.id);
        const roster = kids
          .map((k: any) => `- ${k.id} · ${k.metadata?.ticket || k.title} (${k.status || 'no status'})`)
          .join('\n');
        try {
          claude.sendMessage(
            ctl.id,
            `Use the project-manager skill. You are the controller of the project folder "${folder.name}" (folder ${folder.id}).\n\n` +
              `Current member sessions you manage:\n${roster || '- (none yet)'}\n\n` +
              `Ask the human what this project should achieve if it isn't obvious from the members.`
          );
        } catch {}
        return json(res, state.getSession(ctl.id), 201);
      }
    }
    {
      const fm = p.match(/^\/__api\/folders\/([^/]+)$/);
      if (fm) {
        const folder = state.getFolder(fm[1]);
        if (!folder) return notFound(res, `no such folder: ${fm[1]}`);
        if (m === 'GET')
          return json(res, { ...folder, children: state.folderChildren(fm[1]) });
        if (m === 'PATCH')
          return json(res, state.patchFolder(fm[1], (await readBody(req)) as any));
        if (m === 'DELETE') {
          // api.del sends no body — the mode rides the query string.
          const mode = u.searchParams.get('mode') === 'purge' ? 'purge' : 'ungroup';
          if (mode === 'purge') {
            // Kill every child; workers before the controller so its watchdog
            // listeners don't fire on dying children. Differential cleanup:
            // only sessions that OWN a worktree run cleanup — a readonly
            // worker's cwd is the master's shared worktree and cleaning it
            // would rm-rf a live sibling's checkout.
            const children = state.folderChildren(fm[1], { archived: true });
            const ctl = folder.controllerSessionId;
            const ordered = [
              ...children.filter((s: any) => s.id !== ctl),
              ...children.filter((s: any) => s.id === ctl),
            ];
            for (const child of ordered) {
              try {
                claude.kill(child.id);
              } catch {}
              const md: any = child.metadata || {};
              const ownsWorktree =
                md.kind === 'mutating' || (md.worktree && md.kind !== 'readonly');
              if (ownsWorktree) {
                try {
                  await runCleanup(child);
                } catch {}
              }
              state.deleteSession(child.id);
            }
          }
          state.deleteFolder(fm[1]);
          return json(res, { ok: true, mode });
        }
        return notFound(res);
      }
    }

    if (p === '/__api/sessions' && m === 'GET') {
      return json(
        res,
        state.listSessions({
          archived: u.searchParams.get('archived') === 'true',
        })
      );
    }
    if (p === '/__api/sessions' && m === 'POST') {
      const body = (await readBody(req)) as any;
      // Dispatch path: a master spawning a child. `mutating`/`readonly` = thin
      // dispatch workers (host does ALL wiring: parent, role, worktree, branch,
      // cleanup, caps). `full` = a regular session under a project controller —
      // no thinning, the child provisions itself (runs whatever skill it's told).
      const kind =
        body.kind === 'mutating' || body.kind === 'readonly' || body.kind === 'full'
          ? body.kind
          : null;
      if (body.master && kind) {
        const wired =
          kind === 'full'
            ? await wireFullChild(String(body.master), body)
            : await wireWorker(String(body.master), kind, body);
        if ('deferred' in wired) return json(res, wired); // at-capacity → no session
        body.cwd = wired.cwd;
        body.permissionMode = wired.permissionMode;
        body.metadata = { ...(body.metadata || {}), ...wired.metadata };
      }
      const s = state.createSession({
        title: body.title,
        cwd: body.cwd,
        permissionMode: body.permissionMode,
        metadata: body.metadata,
        model: body.model,
        effort: body.effort,
      });
      spawnSafe(s.id);
      // Only build a skill/ticket-fallback prompt when the caller gave us
      // something to build from — leaves the dispatch/worker path (which
      // always sends its own explicit task prompt) untouched.
      const ticketId = body.metadata?.ticket ? String(body.metadata.ticket) : undefined;
      const prompt =
        body.skill || body.prompt || ticketId
          ? buildFirstPrompt({ skill: body.skill, prompt: body.prompt, ticket: ticketId })
          : null;
      if (prompt) {
        try {
          claude.sendMessage(s.id, prompt);
        } catch {}
      }
      if (body.master && kind) {
        // Spawning children makes the master a project-folder controller; the
        // new child lands inside its folder (tree mode's replacement).
        const pf = ensureProjectFolder(String(body.master));
        if (pf) state.patchSession(s.id, { folderId: pf.id });
        // Auto-arm the worker watchdog (crash/stall backstop) targeting the master.
        try {
          const listeners = await import('./listeners.js');
          listeners.registerWorkerWatchdog(
            String(body.master),
            s.id,
            body.subtask ? String(body.subtask) : null
          );
        } catch (e) {
          console.error('[dispatch] watchdog arm failed:', (e as Error).message);
        }
      }
      return json(res, state.getSession(s.id), 201);
    }
    // Manual flat-mode rail reorder — must precede the session-id matcher below.
    if (p === '/__api/sessions/reorder' && m === 'POST') {
      const body = (await readBody(req)) as any;
      if (!Array.isArray(body.order)) return badRequest(res, 'order[] required');
      state.reorderSessions(body.order.map(String));
      return json(res, { ok: true });
    }

    const parts = p.split('/').filter(Boolean);
    if (parts[0] !== '__api' || parts[1] !== 'sessions' || !parts[2])
      return notFound(res);
    const id = parts[2];
    const s = state.getSession(id);
    if (!s) return notFound(res, `no such session: ${id}`);
    const sub = parts.slice(3).join('/');

    if (!sub) {
      if (m === 'GET') return json(res, s);
      if (m === 'PATCH') {
        const body = (await readBody(req)) as any;
        const wasArchived = (s as any).archived;
        const updated = state.patchSession(id, body);
        if (body.archived === true && !wasArchived) {
          claude.kill(id);
          state.stopListenersForSession(id); // listeners die with their session

          if (u.searchParams.get('runCleanup') === 'true') {
            const cleanup = await runCleanup(s);
            return json(res, { ...state.getSession(id), cleanup });
          }
        }
        if (body.archived === false && wasArchived) spawnSafe(id);
        return json(res, updated);
      }
      if (m === 'DELETE') {
        claude.kill(id);
        const cleanup =
          u.searchParams.get('runCleanup') === 'true'
            ? await runCleanup(s)
            : undefined;
        state.deleteSession(id);
        return json(res, { ok: true, ...(cleanup ? { cleanup } : {}) });
      }
      return notFound(res);
    }

    if (sub === 'tabs' && m === 'POST') {
      const body = (await readBody(req)) as any;
      try {
        return json(res, state.addTab(id, body), 201);
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        return badRequest(res, error.message);
      }
    }
    if (parts[3] === 'tabs' && parts[4]) {
      const tabId = parts[4];
      if (m === 'PATCH') {
        const tab = state.patchTab(id, tabId, await readBody(req));
        return tab
          ? json(res, tab)
          : notFound(res, `no such tab: ${tabId}`);
      }
      if (m === 'DELETE') {
        try {
          return state.deleteTab(id, tabId)
            ? json(res, { ok: true })
            : notFound(res, `no such tab: ${tabId}`);
        } catch (e) {
          const error = e instanceof Error ? e : new Error(String(e));
          return badRequest(res, error.message);
        }
      }
      return notFound(res);
    }
    if (sub === 'activate-tab' && m === 'POST') {
      const { tabId } = (await readBody(req)) as any;
      const updated = state.activateTab(id, tabId);
      return updated
        ? json(res, updated)
        : notFound(res, `no such tab: ${tabId}`);
    }
    if (sub === 'listeners' && m === 'GET') {
      return json(res, state.listListeners({ sessionId: id }));
    }
    if (sub === 'listeners' && m === 'POST') {
      const body = (await readBody(req)) as any;
      const type = body.type || 'github-pr';
      if (type !== 'github-pr' && type !== 'linear-issue' && type !== 'slack' && type !== 'whatsapp' && type !== 'sms')
        return badRequest(res, `unsupported listener type: ${type}`);
      try {
        const listeners = await import('./listeners.js');
        const l =
          type === 'linear-issue'
            ? await listeners.registerLinearIssueListener(id, body)
            : type === 'slack'
              ? await listeners.registerSlackListener(id, body)
              : type === 'whatsapp'
                ? await listeners.registerWhatsappListener(id, body)
                : type === 'sms'
                  ? listeners.registerSmsListener(id, body)
                  : await listeners.registerGithubPrListener(id, body);
        return json(res, l, 201);
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        return badRequest(res, error.message);
      }
    }
    if (parts[3] === 'listeners' && parts[4]) {
      const lid = parts[4];
      const l = state.getListener(lid);
      if (!l || l.sessionId !== id) return notFound(res, `no such listener: ${lid}`);
      if (m === 'GET') {
        const listeners = await import('./listeners.js');
        return json(res, { ...l, log: listeners.getListenerLog(lid) });
      }
      if (m === 'DELETE') {
        const listeners = await import('./listeners.js');
        return json(res, { ok: listeners.removeWhatsappListener(lid) });
      }
      return notFound(res);
    }
    // Controller → child command channel (task_session). Authority is the
    // FOLDER, not metadata.master: dragging a session out of a project folder
    // revokes tasking immediately, even if the old master pointer survives.
    // Never interrupts: idle → send now; busy → the child's pending-prompts
    // queue with auto-play (same queue the human uses, so no collision).
    if (sub === 'task' && m === 'POST') {
      const body = (await readBody(req)) as any;
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      const from = typeof body.from === 'string' ? body.from : '';
      if (!text) return badRequest(res, 'text required');
      if (!from) return badRequest(res, 'from (your session id) required');
      const folder = s.folderId ? state.getFolder(s.folderId as string) : null;
      if (!folder || folder.controllerSessionId !== from)
        return json(
          res,
          { error: `not authorized: session ${id} is not in your project folder` },
          403
        );
      const fromLabel = state.getSession(from)?.title || from;
      const wrapped = `[Task from your project controller (${fromLabel})]\n\n${text}`;
      if (s.claude?.state === 'idle') {
        try {
          claude.sendMessage(id, wrapped);
        } catch (e) {
          return json(res, { error: (e as Error).message }, 500);
        }
        return json(res, { ok: true, delivered: 'now' });
      }
      state.addPendingPrompt(id, wrapped);
      state.setPromptAutoPlay(id, true);
      return json(res, {
        ok: true,
        delivered: 'queued',
        note: 'child is busy — the task is in its pending-prompt queue and will auto-play when the turn ends',
      });
    }
    if (sub === 'message' && m === 'POST') {
      const body = (await readBody(req, 32e6)) as any;
      const text = typeof body.text === 'string' ? body.text : '';
      const attachments = Array.isArray(body.attachments)
        ? body.attachments
        : [];
      if (!text.trim() && !attachments.length)
        return badRequest(res, 'text or attachments required');
      try {
        claude.sendMessage(id, text, attachments);
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        return json(res, { error: error.message }, 500);
      }
      return json(res, { ok: true });
    }
    // Answer a client-side tool_use (AskUserQuestion) with a tool_result so the
    // blocked turn resumes immediately instead of stalling until the ~60s
    // question timeout (a plain message would be queued by the CLI meanwhile).
    if (sub === 'question/answer' && m === 'POST') {
      const body = (await readBody(req)) as any;
      const toolUseId = typeof body.toolUseId === 'string' ? body.toolUseId : '';
      const content = typeof body.content === 'string' ? body.content : '';
      if (!toolUseId || !content.trim())
        return badRequest(res, 'toolUseId and content required');
      try {
        claude.answerToolResult(id, toolUseId, content);
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        return json(res, { error: error.message }, 500);
      }
      return json(res, { ok: true });
    }
    // ---- pending prompts (queued while the session is busy) ----
    if (sub === 'prompts' && m === 'POST') {
      const body = (await readBody(req)) as any;
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      if (!text) return badRequest(res, 'text required');
      const prompt = state.addPendingPrompt(id, text);
      return prompt ? json(res, prompt, 201) : notFound(res);
    }
    if (sub === 'prompts/reorder' && m === 'POST') {
      const body = (await readBody(req)) as any;
      if (!Array.isArray(body.order)) return badRequest(res, 'order[] required');
      const updated = state.reorderPendingPrompts(id, body.order.map(String));
      return updated ? json(res, { ok: true }) : notFound(res);
    }
    if (sub === 'prompts/autoplay' && m === 'POST') {
      const body = (await readBody(req)) as any;
      const updated = state.setPromptAutoPlay(id, !!body.on);
      return updated ? json(res, { ok: true, on: !!body.on }) : notFound(res);
    }
    if (parts[3] === 'prompts' && parts[4] && parts[5] === 'play' && m === 'POST') {
      try {
        const ok = claude.playPendingPrompt(id, parts[4]);
        return ok ? json(res, { ok: true }) : notFound(res, `no such prompt: ${parts[4]}`);
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        return json(res, { error: error.message }, 500);
      }
    }
    if (parts[3] === 'prompts' && parts[4] && m === 'DELETE') {
      const removed = state.removePendingPrompt(id, parts[4]);
      return removed ? json(res, { ok: true }) : notFound(res, `no such prompt: ${parts[4]}`);
    }
    if (sub === 'action' && m === 'POST') {
      const { prompt, buttons } = (await readBody(req)) as any;
      if (!prompt || !Array.isArray(buttons))
        return badRequest(res, 'prompt and buttons required');
      const action = { id: 'act_' + nano(), prompt, buttons };
      state.patchSession(id, { action });
      pushIntervention(id, 'action', String(prompt), 'waiting for your answer');
      return json(res, action, 201);
    }
    if (sub === 'action/answer' && m === 'POST') {
      const { value } = (await readBody(req)) as any;
      if (value === undefined) return badRequest(res, 'value required');
      state.patchSession(id, { action: null });
      try {
        claude.sendMessage(id, String(value));
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        return json(res, { error: error.message }, 500);
      }
      return json(res, { ok: true });
    }
    // Dismiss the sticky action bar without answering — the human chose none of
    // the options and just wants it gone. The request_action tool_use already
    // returned, so the model isn't blocked; clearing the state is enough.
    if (sub === 'action/dismiss' && m === 'POST') {
      state.patchSession(id, { action: null });
      return json(res, { ok: true });
    }
    if (sub === 'permission/answer' && m === 'POST') {
      const body = (await readBody(req)) as any;
      if (
        !body.requestId ||
        !['allow', 'deny'].includes(body.behavior)
      ) {
        return badRequest(
          res,
          'requestId and behavior (allow|deny) required'
        );
      }
      const out = answerPermission(id, body);
      return out
        ? json(res, out)
        : notFound(res, `no pending permission request: ${body.requestId}`);
    }
    if (sub === 'screen-request/answer' && m === 'POST') {
      const body = (await readBody(req)) as any;
      if (!body.requestId) return badRequest(res, 'requestId required');
      const out = answerScreenRequest(id, body);
      return out
        ? json(res, out)
        : notFound(res, `no pending screen request: ${body.requestId}`);
    }
    if (sub === 'interrupt' && m === 'POST') {
      return json(res, { ok: claude.interrupt(id) });
    }
    // Kill + respawn the claude proc in place (--resume) — worktree, metadata
    // and chat survive; MCP server connections are re-established.
    if (sub === 'restart' && m === 'POST') {
      try {
        return json(res, { ok: true, claude: claude.restart(id) });
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        return json(res, { error: error.message }, 500);
      }
    }
    // Probe TRUE MCP availability for this session: `claude mcp list` in the
    // session's cwd under the session's account env, folded into the live
    // claude.mcp health map the /mcp panel renders (updates arrive via the
    // session-updated broadcast). force=true bypasses the short probe cache.
    if (sub === 'mcp/check' && m === 'POST') {
      try {
        const body = (await readBody(req)) as any;
        return json(res, { ok: true, mcp: await (claude as any).checkMcp(id, !!body?.force) });
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        return json(res, { error: error.message }, 500);
      }
    }
    if (sub === 'permission-mode' && m === 'POST') {
      const { mode } = (await readBody(req)) as any;
      try {
        return json(res, claude.setPermissionMode(id, mode));
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        return badRequest(res, error.message);
      }
    }
    if (sub === 'model' && m === 'POST') {
      const { model } = (await readBody(req)) as any;
      try {
        return json(res, claude.setModel(id, model));
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        return badRequest(res, error.message);
      }
    }
    if (sub === 'effort' && m === 'POST') {
      const { effort } = (await readBody(req)) as any;
      try {
        return json(res, (claude as any).setEffort(id, effort));
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        return badRequest(res, error.message);
      }
    }
    // Context-window auto-compact threshold, expressed as a % of the session's
    // current model window (null/0 disables it). Applied as a real `claude
    // --autocompact <tokens>` spawn flag, not a message-injection guess.
    if (sub === 'autocompact' && m === 'POST') {
      const { pct } = (await readBody(req)) as any;
      try {
        return json(res, (claude as any).setAutoCompact(id, pct));
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        return badRequest(res, error.message);
      }
    }
    // Drop the conversation and start fresh in the same tab: respawns the
    // claude proc WITHOUT --resume (worktree/branch/metadata/tabs survive —
    // only the conversation itself resets).
    if (sub === 'clear' && m === 'POST') {
      try {
        return json(res, { ok: true, claude: (claude as any).clearConversation(id) });
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        return json(res, { error: error.message }, 500);
      }
    }
    if (sub === 'account' && m === 'POST') {
      const { accountId } = (await readBody(req)) as any;
      try {
        return json(res, (claude as any).setAccount(id, accountId));
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        return badRequest(res, error.message);
      }
    }
    if (sub === 'chat' && m === 'GET') {
      // Paginated mode: ?limit=N&before=SEQ → { events, hasMore, oldestSeq }
      const limit = Number(u.searchParams.get('limit'));
      if (limit > 0) {
        const beforeSeq = Number(u.searchParams.get('before')) || Infinity;
        return json(res, (claude as any).getChatPage(id, { limit, beforeSeq }));
      }
      return json(
        res,
        claude.getChat(id, Number(u.searchParams.get('since')) || 0)
      );
    }
    if (sub === 'cleanup' && m === 'GET') {
      return json(res, await cleanupPlan(s));
    }
    // Dispatcher: a worker reports up to its master. Atomic persist-then-wake —
    // write the capped result to the worker's own metadata.result FIRST, then
    // enqueue a thin pointer to the master (queue-until-idle). Persist-before-wake
    // kills the publish-before-write race (decision 12).
    if (sub === 'report' && m === 'POST') {
      const body = (await readBody(req)) as any;
      // Resolve the master: the recorded parent pointer, or an explicit override
      // the worker passes (covers a worker spawned outside the dispatch path, or a
      // missing pointer). An override back-fills metadata.master so the tree links
      // up and later reports resolve on their own.
      const recorded = (s.metadata?.master as string) || null;
      const master = recorded || (body.master ? String(body.master) : null);
      const result = capResult(body);
      const metaPatch: Record<string, unknown> = { result };
      if (!recorded && body.master) metaPatch.master = String(body.master);
      state.patchSession(id, { metadata: metaPatch });
      // Reflect terminal state on the rail so the tree/list shows it at a glance.
      const statusMap: Record<string, string> = {
        done: 'Done',
        blocked: 'Blocked',
        error: 'Error',
        milestone: s.status,
      };
      if (statusMap[result.state] && statusMap[result.state] !== s.status)
        state.patchSession(id, { status: statusMap[result.state] });
      // A blocked worker needs a human even when its master is woken — the
      // master can't log in / pay / solve a CAPTCHA on its behalf.
      if (result.state === 'blocked')
        pushIntervention(id, 'blocked', result.note || result.summary || 'worker is blocked', 'blocked');
      if (!master)
        return json(res, {
          ok: true,
          master: null,
          warning:
            'no master is recorded for this session and none was provided — the result was persisted but nobody was woken. Pass master:"<session id>" to target one.',
        });
      const subtask = (s.metadata?.subtask as string) || s.title;
      const pointer = `worker ${id} (${subtask}) → ${result.state}${result.note ? `: ${result.note}` : ''}`;
      try {
        const listeners = await import('./listeners.js');
        listeners.enqueueWake(master, pointer, `report:${id}`);
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        return json(res, { ok: true, master, warning: `wake failed: ${error.message}` });
      }
      return json(res, { ok: true, master, delivered: 'queued' });
    }
    // Dispatcher: bounded read for the Orchestration tab — the plan + per-child
    // summaries. NEVER reads a worker's chat (the one hard rule).
    if (sub === 'orchestration' && m === 'GET') {
      const { plan, planError } = readOrchestration(s);
      const children = state
        .listSessions({ archived: true })
        .filter((c: any) => c.metadata?.master === id)
        .map(childSummary);
      return json(res, { id, plan, ...(planError ? { planError } : {}), children });
    }
    if (sub === 'open-editor' && m === 'POST') {
      // Open the session's worktree (or cwd) in the local desktop editor. The
      // `code` CLI shim is often not on PATH, so on macOS we fall back to
      // `open -a` against the installed app, which doesn't need the shim. On
      // Windows the shim IS the normal entrypoint, but it's `code.cmd` — a batch
      // file, which spawn() can only run through cmd.
      const dir =
        (untildify(s.metadata?.worktree as string | undefined) as string | null) ||
        (untildify(s.cwd) as string | null);
      if (!dir) return badRequest(res, 'session has no worktree or cwd');
      const editor = String((cfg as unknown as Record<string, unknown>).editorApp || 'Visual Studio Code');
      const codeBin = isWin ? which('code') : null;
      const cmd =
        process.platform === 'darwin'
          ? ['open', '-a', editor, dir]
          : isWin
            ? ['cmd', '/c', codeBin || 'code', dir]
            : ['code', dir];
      try {
        const proc = Bun.spawn(cmd, { stdout: 'ignore', stderr: 'pipe' });
        const code = await proc.exited;
        if (code !== 0) {
          const err = await new Response(proc.stderr).text();
          return json(res, { error: err.trim() || `editor exited ${code}` }, 500);
        }
        return json(res, { ok: true, dir, editor });
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        return json(res, { error: error.message }, 500);
      }
    }
    if (sub === 'changes' && m === 'GET') {
      return json(res, await changesFor(s, u.searchParams.get('mode')));
    }
    if (sub === 'changes/diff' && m === 'GET') {
      return json(
        res,
        await changeDiff(
          s,
          u.searchParams.get('path'),
          u.searchParams.get('mode')
        )
      );
    }
    if (sub === 'changes/refs' && m === 'GET') {
      return json(res, await prStatus(s));
    }
    // ---- status summary ----
    // Enable + generate (first run reads the whole transcript). body.autoUpdate
    // seeds the checkbox.
    if (sub === 'summary' && m === 'POST') {
      const body = ((await readBody(req).catch(() => null)) || {}) as any;
      // Seed the record so autoUpdate/lang stick and the popover shows "generating".
      state.setStatusSummary(id, {
        text: s.statusSummary?.text || '',
        autoUpdate: body.autoUpdate ?? s.statusSummary?.autoUpdate ?? false,
        lang: body.lang === 'en' ? 'en' : body.lang === 'auto' ? 'auto' : s.statusSummary?.lang ?? 'auto',
        atSeq: s.statusSummary?.atSeq ?? 0,
      });
      try {
        return json(res, claude.summarizeSession(id, { full: !s.statusSummary }));
      } catch (e) {
        return badRequest(res, (e as Error).message);
      }
    }
    // Regenerate now (fold the delta; ?full=true forces a fresh whole-transcript read).
    if (sub === 'summary/update' && m === 'POST') {
      try {
        return json(res, claude.summarizeSession(id, { full: u.searchParams.get('full') === 'true' }));
      } catch (e) {
        return badRequest(res, (e as Error).message);
      }
    }
    // Write path from the headless run's set_status_summary MCP tool.
    if (sub === 'summary/result' && m === 'POST') {
      const body = (await readBody(req)) as any;
      const text = typeof body.text === 'string' ? body.text : '';
      const updated = state.setStatusSummary(id, {
        text,
        tldr: typeof body.tldr === 'string' ? body.tldr : undefined,
        atSeq: Number.isFinite(body.atSeq) ? Number(body.atSeq) : s.statusSummary?.atSeq ?? 0,
      });
      return updated ? json(res, { ok: true }) : notFound(res);
    }
    // Toggle auto-update without regenerating.
    if (sub === 'summary' && m === 'PATCH') {
      const body = (await readBody(req)) as any;
      let updated: unknown = s.statusSummary ? s : null;
      if ('autoUpdate' in body) updated = state.setSummaryAutoUpdate(id, !!body.autoUpdate);
      if (typeof body.lang === 'string') {
        updated = state.setSummaryLang(id, body.lang === 'en' ? 'en' : 'auto');
        // Regenerate in the new language (full, so a Hebrew brief isn't folded
        // into an English one or vice-versa) so the switch is immediately visible.
        if (updated) { try { claude.summarizeSession(id, { full: true }); } catch {} }
      }
      return updated ? json(res, { ok: true }) : notFound(res, 'no summary to toggle');
    }
    // Turn the feature off.
    if (sub === 'summary' && m === 'DELETE') {
      state.clearStatusSummary(id);
      return json(res, { ok: true });
    }
    if (sub === 'changes/explain' && m === 'POST') {
      const body = (await readBody(req)) as any;
      try {
        return json(
          res,
          claude.explainChanges(
            id,
            body.mode === 'pr' ? 'pr' : 'uncommitted'
          )
        );
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        return badRequest(res, error.message);
      }
    }
    if (sub === 'changes/explanation' && m === 'POST') {
      const body = (await readBody(req)) as any;
      const mode =
        body.mode === 'pr' || body.mode === 'uncommitted'
          ? body.mode
          : !body.base || body.base === 'HEAD'
            ? 'uncommitted'
            : 'pr';
      const identity = await changeIdentity(s, mode);
      state.setChangesExplanation(id, mode, {
        language: typeof body.language === 'string' ? body.language : null,
        generatedAt: new Date().toISOString(),
        mode,
        identity: identity ?? undefined,
        files: Array.isArray(body.files) ? body.files : [],
        features: Array.isArray(body.features) ? body.features : [],
      });
      if (body.activate !== false) state.activateTab(id, '__changes');
      return json(res, { ok: true });
    }
    if (parts[3] === 'review') {
      if (parts[4] === 'comment' && !parts[5] && m === 'POST') {
        const body = (await readBody(req)) as any;
        if (!body.target || !body.body)
          return badRequest(res, 'target and body required');
        return json(
          res,
          state.addReviewComment(id, {
            target: body.target,
            body: String(body.body),
            dir: body.dir || null,
          }),
          201
        );
      }
      if (parts[4] === 'comment' && parts[5] && parts[6] === 'reply') {
        const cid = parts[5];
        const rid = parts[7];
        if (!rid && m === 'POST') {
          const body = (await readBody(req)) as any;
          if (!body.body) return badRequest(res, 'body required');
          const r = state.addReviewReply(id, cid, {
            body: String(body.body),
            dir: body.dir || null,
          });
          return r
            ? json(res, r, 201)
            : notFound(res, `no such comment: ${cid}`);
        }
        if (rid && m === 'PATCH') {
          const body = (await readBody(req)) as any;
          const r = state.patchReviewReply(id, cid, rid, {
            body: body.body != null ? String(body.body) : undefined,
          });
          return r
            ? json(res, r)
            : notFound(res, `no such reply: ${rid}`);
        }
        if (rid && m === 'DELETE') {
          return json(res, { ok: state.removeReviewReply(id, cid, rid) });
        }
        return notFound(res);
      }
      if (parts[4] === 'comment' && parts[5] && m === 'DELETE') {
        return json(res, { ok: state.removeReviewComment(id, parts[5]) });
      }
      if (parts[4] === 'comment' && parts[5] && m === 'PATCH') {
        const body = (await readBody(req)) as any;
        const patch: Record<string, unknown> = {};
        if ('resolved' in body) patch.resolved = body.resolved !== false;
        if (typeof body.body === 'string') patch.body = body.body;
        if (body.accept === true || body.suggested === false)
          patch.suggested = false;
        const c = state.patchReviewComment(id, parts[5], patch);
        return c
          ? json(res, c)
          : notFound(res, `no such comment: ${parts[5]}`);
      }
      if (parts[4] === 'auto' && m === 'POST') {
        const body = (await readBody(req)) as any;
        try {
          return json(
            res,
            claude.reviewChanges(
              id,
              body.mode === 'pr' ? 'pr' : 'uncommitted'
            )
          );
        } catch (e) {
          const error = e instanceof Error ? e : new Error(String(e));
          return badRequest(res, error.message);
        }
      }
      if (parts[4] === 'suggestions' && m === 'POST') {
        const body = (await readBody(req)) as any;
        const list = (Array.isArray(body.comments) ? body.comments : []).filter(
          (c: any) => c && c.body
        );
        const mapped = list.map((c: any) => {
          const kind = ['line', 'file', 'feature'].includes(c.kind)
            ? c.kind
            : c.line != null
              ? 'line'
              : 'file';
          const target =
            kind === 'line'
              ? {
                  kind: 'line',
                  path: String(c.path || ''),
                  lineLabel:
                    c.line != null ? `L${Math.round(c.line)}` : undefined,
                }
              : kind === 'feature'
                ? {
                    kind: 'feature',
                    key: String(
                      c.featureTitle || c.path || c.body
                    ).slice(0, 60),
                    featureTitle: String(c.featureTitle || c.path || ''),
                  }
                : { kind: 'file', path: String(c.path || '') };
          return {
            target,
            body: String(c.body),
            dir: c.dir || null,
            suggested: true,
          };
        });
        const added = state.addReviewComments(id, mapped);
        state.activateTab(id, '__changes');
        return json(res, { ok: true, added: added?.length || 0 });
      }
      if (parts[4] === 'submit' && m === 'POST') {
        const body = (await readBody(req)) as any;
        const verdict = ['approve', 'request-changes', 'comment'].includes(
          body.verdict
        )
          ? body.verdict
          : 'comment';
        const target = body.target === 'remote' ? 'remote' : 'local';
        const summary = body.summary ? String(body.summary) : '';
        const msg =
          target === 'remote'
            ? formatRemoteReview(s, verdict, summary)
            : formatReview(s, verdict, summary);
        try {
          claude.sendMessage(id, msg);
        } catch (e) {
          const error = e instanceof Error ? e : new Error(String(e));
          return json(res, { error: error.message }, 500);
        }
        state.clearReview(id);
        if (target === 'local' && verdict === 'approve')
          state.patchSession(id, { status: 'Approved' });
        const sessTab =
          (s as any).tabs.find((t: any) => t.type === 'session') ||
          (s as any).tabs[0];
        if (sessTab) state.activateTab(id, sessTab.id);
        return json(res, { ok: true });
      }
      return notFound(res);
    }
    if (parts[3] === 'bg' && parts[4]) {
      const shellId = parts[4];
      if (parts[5] === 'output' && m === 'GET') {
        const out = claude.bgOutput(id, shellId);
        return out
          ? json(res, out)
          : notFound(res, `no such background shell: ${shellId}`);
      }
      if (parts[5] === 'kill' && m === 'POST') {
        return json(res, { ok: claude.bgKill(id, shellId) });
      }
      return notFound(res);
    }
    return notFound(res);
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    if (!res.headersSent)
      return json(
        res,
        { error: error.message },
        error.message.includes('JSON') ? 400 : 500
      );
    try {
      res.end();
    } catch {}
  }
}
