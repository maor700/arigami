// Codex over `codex app-server`: one long-lived JSON-RPC process per session (docs/ENGINES.md). server/codex.ts (exec) stays as the fallback.
// Verified against codex-cli 0.153.4; raw runs in test/fixtures/codex-app/.

import { HOME } from './lib/platform.js';
import { cfg, getSession, setClaude, untildify } from './state.js';
import { broadcast } from './bus.js';
import { registerEngine } from './lib/engine-driver.js';
import type { EngineDriver } from './lib/engine-driver.js';
import type { Session } from './state.js';
import { getActiveId, getAccount } from './accounts.js';
import { openPermission, dismissPermission } from './api.js';
import type { PermissionResult } from './api.js';
import {
  codexDriver as execDriver,
  codexPrepare,
  codexBuildSpawn,
  codexHomeFor,
  codexHooksFile,
  codexModels,
  refreshCodexModels,
  flatToolName,
  isHookTrustNotice,
  CODEX_MODEL_RE,
  EFFORTS,
  textOfContent,
  restrictedAgentOf,
  reapGivenUpHostTool,
  onLimitText,
  onTurnEnd,
} from './codex.js';
import { appendChat, describeAttachment, noteMcpResult, updateUsage, noteTurnUsage, recordTurn, ensureRunning, isRunning } from './claude.js';

/** Approval cards wait as long as a screen request (api.ts SCREEN_REQUEST_TIMEOUT_MS), then answer `cancel`. */
export const APPROVAL_TIMEOUT_MS = Number(process.env.ARIGAMI_CODEX_APPROVAL_TIMEOUT_MS) || 30 * 60 * 1000;

interface ItemState {
  name: string;
  server: string | null;
  host: boolean;
  tool: string | null;
}

interface AppState {
  proc: any | null;
  seq: number;
  pending: Map<number, (r: { result?: any; error?: any }) => void>;
  threadId: string | null;
  ready: boolean;
  /** actions waiting for the thread to be started/resumed */
  queue: Array<() => void>;
  turnId: string | null;
  /** turn/start sent, its id not known yet */
  starting: boolean;
  /** input waiting for the running turn's id (steered once known) */
  steer: any[][];
  /** input that could not join the running turn — the next turn */
  after: any[][];
  interruptDue: boolean;
  turnStartedAt: number;
  compacting: boolean;
  compactDue: string | null;
  compactThen: Array<() => void>;
  items: Map<string, ItemState>;
  reasoning: Map<string, string>;
  errs: Set<string>;
  lastUsage: any | null;
  /** rpc id of a server request → the item it gates */
  requests: Map<number | string, string>;
  diffAt: number;
}

const states = new Map<string, AppState>();

function fresh(): AppState {
  return {
    proc: null, seq: 0, pending: new Map(), threadId: null, ready: false, queue: [], turnId: null, starting: false,
    steer: [], after: [], interruptDue: false, turnStartedAt: 0, compacting: false, compactDue: null, compactThen: [],
    items: new Map(), reasoning: new Map(), errs: new Set(), lastUsage: null, requests: new Map(), diffAt: 0,
  };
}

export function stateOf(id: string): AppState {
  let st = states.get(id);
  if (!st) states.set(id, (st = fresh()));
  return st;
}

/** Test seam: forget a session's driver state. */
export function resetAppState(id: string): void {
  states.delete(id);
}

// ---- JSON-RPC ---------------------------------------------------------------

function write(st: AppState, msg: unknown): boolean {
  const stdin = st.proc?.child?.stdin;
  if (!stdin || stdin.writableEnded || stdin.destroyed) return false;
  try {
    stdin.write(JSON.stringify(msg) + '\n');
    return true;
  } catch {
    return false;
  }
}

function rpc(st: AppState, method: string, params: unknown): Promise<{ result?: any; error?: any }> {
  const id = ++st.seq;
  return new Promise((resolve) => {
    st.pending.set(id, resolve);
    if (!write(st, { jsonrpc: '2.0', id, method, params })) {
      st.pending.delete(id);
      resolve({ error: { message: 'codex app-server is not running' } });
    }
  });
}

const notify = (st: AppState, method: string, params: unknown) => write(st, { jsonrpc: '2.0', method, params });
const respond = (st: AppState, id: number | string, result: unknown) => write(st, { jsonrpc: '2.0', id, result });

// ---- policy ------------------------------------------------------------------

/** bypassPermissions → cfg.codexApprovals; any asking mode → 'untrusted' (on-request never asks under danger-full-access — measured). */
export function approvalPolicyFor(s: Pick<Session, 'claude'> | null | undefined, hostPolicy: string = cfg.codexApprovals): string {
  const mode = s?.claude?.permissionMode || 'bypassPermissions';
  if (mode !== 'bypassPermissions') return 'untrusted';
  return hostPolicy === 'on-request' || hostPolicy === 'untrusted' ? hostPolicy : 'never';
}

const cwdOf = (s: Session): string => untildify(s.cwd) || HOME;

function modelOf(s: Session): string | null {
  const m = s.claude?.modelChoice;
  return m && CODEX_MODEL_RE.test(m) ? m : null;
}

function effortOf(s: Session): string | null {
  const e = s.claude?.effort;
  return e && EFFORTS.has(e) ? e : null;
}

function threadParams(s: Session): Record<string, unknown> {
  const model = modelOf(s);
  // Sandbox stays danger-full-access: bwrap cannot start on this VPS (ENGINES.md limit 1).
  return { cwd: cwdOf(s), approvalPolicy: approvalPolicyFor(s), sandbox: 'danger-full-access', ...(model ? { model } : {}) };
}

/** Pure: the turn/start input items — text (non-image attachments listed) + localImage per image. */
export function buildInput(text: string, attachments: any[] = []): any[] {
  let txt = text || '';
  const images = attachments.filter((a) => a?.isImage && typeof a.path === 'string' && !a.archive);
  const others = attachments.filter((a) => !images.includes(a));
  if (others.length) {
    txt += (txt ? '\n\n' : '') + `📎 Attached ${others.length} file(s) — read them as needed:\n${others.map(describeAttachment).join('\n')}`;
  }
  if (!txt && !images.length) txt = '(empty message)';
  return [...(txt ? [{ type: 'text', text: txt, text_elements: [] }] : []), ...images.map((a) => ({ type: 'localImage', path: a.path }))];
}

// ---- process lifecycle ----------------------------------------------------------

function dropProc(id: string, st: AppState, why: string): void {
  for (const r of st.pending.values()) r({ error: { message: why } });
  const keep = { compactThen: st.compactThen, after: st.after };
  const next = fresh();
  next.after = [...keep.after, ...st.steer];
  next.compactThen = keep.compactThen;
  states.set(id, next);
}

/** A3: trust this home's hooks.json in-process — the top-level --dangerously-bypass-hook-trust does not reach app-server threads (measured). */
async function trustHooks(id: string, st: AppState, cwd: string): Promise<void> {
  const own = codexHooksFile(codexHomeFor(id));
  const r = await rpc(st, 'hooks/list', { cwds: [cwd] });
  const hooks = (r.result?.data || []).flatMap((d: any) => d?.hooks || []).filter((h: any) => h?.sourcePath === own && h.trustStatus !== 'trusted' && h.key && h.currentHash);
  if (!hooks.length) return;
  const value = Object.fromEntries(hooks.map((h: any) => [h.key, { trusted_hash: h.currentHash }]));
  const w = await rpc(st, 'config/batchWrite', { edits: [{ keyPath: 'hooks.state', mergeStrategy: 'upsert', value }], reloadUserConfig: true });
  if (w.error) console.error(`[codex-app] could not trust hooks: ${w.error.message}`);
}

async function startThread(id: string, p: any): Promise<void> {
  const st = stateOf(id);
  const gone = () => stateOf(id) !== st || st.proc !== p;
  const init = await rpc(st, 'initialize', { clientInfo: { name: 'arigami', title: 'Arigami', version: '1' }, capabilities: { experimentalApi: true } });
  if (gone()) return;
  if (init.error) {
    appendChat(id, { kind: 'error', text: `codex app-server: initialize failed: ${init.error.message}` });
    return;
  }
  notify(st, 'initialized', {});
  const s = getSession(id);
  if (!s) return;
  if (restrictedAgentOf(s)) await trustHooks(id, st, cwdOf(s));
  const prev = p.resume ? s.claude?.sessionId : null;
  let r = prev ? await rpc(st, 'thread/resume', { threadId: prev, ...threadParams(s) }) : await rpc(st, 'thread/start', threadParams(s));
  if (gone()) return;
  if (r.error && prev) {
    // A thread with no turn yet has no rollout to resume — that one starts over silently.
    if (!/no rollout found/i.test(String(r.error.message)))
      appendChat(id, { kind: 'system', text: `⤷ codex could not resume the previous thread (${String(r.error.message).slice(0, 160)}) — started a new one` });
    r = await rpc(st, 'thread/start', threadParams(s));
    if (gone()) return;
  }
  const thread = r.result?.thread;
  if (r.error || !thread?.id) {
    appendChat(id, { kind: 'error', text: `codex app-server: could not start a thread: ${r.error?.message || 'no thread id'}` });
    setClaude(id, { state: 'idle' });
    return;
  }
  st.threadId = thread.id;
  setClaude(id, { sessionId: thread.id, ...(r.result.model ? { model: r.result.model } : {}) });
  if (getSession(id)?.claude?.state === 'restarting') setClaude(id, { state: 'idle' });
  st.ready = true;
  void refreshCodexModels({ force: !prev });
  if (st.compactDue) runCompaction(id, st, st.compactDue);
  const q = st.queue.splice(0);
  for (const fn of q) fn();
  if (!st.compacting && !st.turnId && !st.starting && st.after.length) startTurn(id, st, st.after.splice(0).flat());
}

function appHandshake(p: any): void {
  const id = p.id;
  const prev = states.get(id);
  if (prev?.proc && prev.proc !== p) dropProc(id, prev, 'replaced by a new codex app-server');
  const st = stateOf(id);
  st.proc = p;
  p.child.once('close', () => {
    if (stateOf(id).proc === p) dropProc(id, stateOf(id), 'codex app-server exited');
  });
  startThread(id, p).catch((e) => appendChat(id, { kind: 'error', text: `codex app-server: ${(e as Error).message}` }));
}

// ---- turns -------------------------------------------------------------------

function startTurn(id: string, st: AppState, input: any[]): void {
  const s = getSession(id);
  if (!s || !st.threadId) return;
  const model = modelOf(s);
  const effort = effortOf(s);
  st.starting = true;
  setClaude(id, { state: 'working' });
  rpc(st, 'turn/start', {
    threadId: st.threadId,
    input,
    cwd: cwdOf(s),
    approvalPolicy: approvalPolicyFor(s),
    sandboxPolicy: { type: 'dangerFullAccess' },
    summary: 'auto',
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
  }).then((r) => {
    st.starting = false;
    if (r.error) {
      appendChat(id, { kind: 'error', text: `codex: could not start the turn: ${r.error.message}`, isError: true });
      if (!st.turnId) setClaude(id, { state: 'idle' });
      return;
    }
    if (!st.turnId && r.result?.turn?.id) onTurnId(id, st, r.result.turn.id);
  });
}

function onTurnId(id: string, st: AppState, turnId: string): void {
  st.turnId = turnId;
  st.starting = false;
  if (st.interruptDue) {
    st.interruptDue = false;
    rpc(st, 'turn/interrupt', { threadId: st.threadId, turnId });
  }
  for (const input of st.steer.splice(0)) steerTurn(id, st, input);
}

function steerTurn(id: string, st: AppState, input: any[]): void {
  if (!st.turnId || st.compacting) {
    st.after.push(input);
    return;
  }
  rpc(st, 'turn/steer', { threadId: st.threadId, expectedTurnId: st.turnId, input }).then((r) => {
    if (!r.error) return;
    // The turn ended between the check and the call — the message becomes the next turn.
    if (st.turnId || st.starting || st.compacting) st.after.push(input);
    else startTurn(id, st, input);
  });
}

function deliver(id: string, st: AppState, input: any[]): void {
  if (st.compacting) st.after.push(input);
  else if (st.turnId) steerTurn(id, st, input);
  else if (st.starting) st.steer.push(input);
  else startTurn(id, st, input);
}

function appWriteMessage(proc: any, { text, attachments = [] }: { text: string; attachments?: any[] }): void {
  const id = proc.id;
  const st = stateOf(id);
  if (/(^|\n)\/compact\s*$/.test(text || '') && !attachments.length) {
    requestCompaction(id, 'manual');
    return;
  }
  const input = buildInput(text, attachments);
  if (!st.ready) st.queue.push(() => deliver(id, st, input));
  else deliver(id, st, input);
}

function appInterrupt(proc: any): void {
  const st = stateOf(proc.id);
  st.after = [];
  st.steer = [];
  if (st.turnId) rpc(st, 'turn/interrupt', { threadId: st.threadId, turnId: st.turnId });
  else if (st.starting) st.interruptDue = true;
}

// ---- compaction (P3-2) -------------------------------------------------------------

/** thread/compact/start now, or as soon as the thread is idle; `then` runs once it finished (or failed). */
export function requestCompaction(id: string, reason: string, then?: () => void): void {
  const st = stateOf(id);
  if (then) st.compactThen.push(then);
  if (!isRunning(id)) {
    st.compactDue = reason;
    ensureRunning(id);
    return;
  }
  if (!st.ready || st.turnId || st.starting || st.compacting) {
    if (!st.compacting) st.compactDue = reason;
    return;
  }
  runCompaction(id, st, reason);
}

function runCompaction(id: string, st: AppState, reason: string): void {
  st.compactDue = null;
  st.compacting = true;
  setClaude(id, { state: 'working' });
  appendChat(id, { kind: 'system', text: `⤷ compacting the context (${reason})…` });
  rpc(st, 'thread/compact/start', { threadId: st.threadId }).then((r) => {
    if (!r.error) return;
    st.compacting = false;
    appendChat(id, { kind: 'error', text: `codex: compaction failed: ${r.error.message}`, isError: true });
    setClaude(id, { state: 'idle' });
    afterIdle(id, st, true);
  });
}

/** A turn (or compaction) ended: run compaction callbacks, then a due compaction, then the carried-over input. */
function afterIdle(id: string, st: AppState, compactionEnded: boolean): void {
  if (compactionEnded && !st.compactDue) for (const fn of st.compactThen.splice(0)) try { fn(); } catch { /* replay is best-effort */ }
  if (st.compactDue && !st.turnId && !st.starting) return runCompaction(id, st, st.compactDue);
  if (st.after.length && !st.turnId && !st.starting && !st.compacting) startTurn(id, st, st.after.splice(0).flat());
}

// ---- items ---------------------------------------------------------------------

/** Pure: how a v2 ThreadItem shows in the transcript. */
export function describeAppItem(item: any): ItemState {
  switch (item?.type) {
    case 'mcpToolCall': {
      const server = String(item.server || '');
      const tool = String(item.tool || '');
      return { name: flatToolName(server, tool), server, host: server === 'arigami', tool };
    }
    case 'commandExecution':
      return { name: 'Bash', server: null, host: false, tool: null };
    case 'fileChange':
      return { name: 'Edit', server: null, host: false, tool: null };
    case 'dynamicToolCall':
      return { name: String(item.tool || 'tool'), server: null, host: false, tool: null };
    case 'webSearch':
      return { name: 'WebSearch', server: null, host: false, tool: null };
    case 'imageView':
      return { name: 'ImageView', server: null, host: false, tool: null };
    default:
      return { name: String(item?.type || 'item'), server: null, host: false, tool: null };
  }
}

const kindOf = (k: any): string => (typeof k === 'string' ? k : String(k?.type || 'update'));

/** Pure: +/- line counts of a unified diff. */
export function diffCounts(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const l of String(diff || '').split('\n')) {
    if (l.startsWith('+') && !l.startsWith('+++')) additions++;
    else if (l.startsWith('-') && !l.startsWith('---')) deletions++;
  }
  return { additions, deletions };
}

/** Pure: the tool-use `input` (+ diff stats for a fileChange). */
export function appItemInput(item: any): { input: unknown; extra: Record<string, unknown> } {
  switch (item?.type) {
    case 'mcpToolCall':
    case 'dynamicToolCall':
      return { input: item.arguments ?? {}, extra: {} };
    case 'commandExecution':
      return { input: { command: item.command || '' }, extra: {} };
    case 'fileChange': {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const patch = changes.map((c: any) => c?.diff || '').filter(Boolean).join('\n');
      return {
        input: { file_path: changes.map((c: any) => c?.path).filter(Boolean).join(', '), patch },
        extra: patch ? diffCounts(patch) : {},
      };
    }
    case 'webSearch':
      return { input: { query: item.query || '' }, extra: {} };
    case 'imageView':
      return { input: { path: item.path || '' }, extra: {} };
    default:
      return { input: item ?? {}, extra: {} };
  }
}

/** Pure: a finished item as a tool-result. */
export function appItemResult(item: any): { content: string; isError: boolean } {
  const failed = item?.status === 'failed' || item?.status === 'declined' || !!item?.error;
  switch (item?.type) {
    case 'mcpToolCall':
      return failed
        ? { content: String(item.error?.message || (item.status === 'declined' ? 'declined' : 'tool call failed')), isError: true }
        : { content: textOfContent(item.result?.content ?? item.result ?? ''), isError: false };
    case 'commandExecution': {
      const code = item.exitCode;
      const out = String(item.aggregatedOutput ?? '');
      return { content: out || (item.status === 'declined' ? 'declined by the human' : ''), isError: failed || (typeof code === 'number' && code !== 0) };
    }
    case 'fileChange': {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const lines = changes.map((c: any) => `${kindOf(c?.kind)}: ${c?.path}`).join('\n');
      return { content: item.status === 'declined' ? `declined by the human\n${lines}` : lines || 'no changes', isError: failed };
    }
    case 'dynamicToolCall':
      return { content: textOfContent(item.contentItems ?? ''), isError: failed || item.success === false };
    case 'webSearch':
      return { content: Array.isArray(item.results) ? JSON.stringify(item.results) : String(item.query || ''), isError: false };
    case 'imageView':
      return { content: String(item.path || ''), isError: false };
    default:
      return { content: JSON.stringify(item ?? {}), isError: failed };
  }
}

const QUIET_ITEMS = new Set(['userMessage', 'agentMessage', 'reasoning', 'contextCompaction', 'hookPrompt']);

function emitToolUse(id: string, st: AppState, item: any): ItemState {
  const meta = describeAppItem(item);
  st.items.set(String(item.id), meta);
  if (!meta.host) {
    const { input, extra } = appItemInput(item);
    appendChat(id, { kind: 'tool-use', toolUseId: String(item.id), name: meta.name, input, ...extra });
  }
  return meta;
}

/** Pure: reasoning text of a completed item, else the streamed deltas. */
export function reasoningText(item: any, streamed = ''): string {
  const join = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').join('\n\n') : '');
  return join(item?.summary) || join(item?.content) || streamed;
}

/** Pure: v2 TokenUsageBreakdown → claude field names; inputTokens already includes the cached part. */
export function mapAppUsage(u: any) {
  const cached = Number(u?.cachedInputTokens) || 0;
  const input = Number(u?.inputTokens) || 0;
  // A compaction reports only totalTokens: that is the new context.
  const base = input || Number(u?.totalTokens) || 0;
  return {
    input_tokens: Math.max(0, base - cached),
    output_tokens: Number(u?.outputTokens) || 0,
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: Number(u?.cacheWriteInputTokens) || 0,
  };
}

// ---- server requests (P3-1) -------------------------------------------------------

/** Pure: a server request → the permission card it shows, or null when it is answered without asking. */
export function cardFor(method: string, params: any, items?: Map<string, ItemState>): { toolName: string; input: unknown; toolUseId: string } | null {
  const toolUseId = String(params?.itemId || '');
  switch (method) {
    case 'item/commandExecution/requestApproval':
      return { toolName: 'Bash', toolUseId, input: { command: params.command || '', ...(params.cwd ? { cwd: params.cwd } : {}), ...(params.reason ? { reason: params.reason } : {}) } };
    case 'item/fileChange/requestApproval':
      return { toolName: items?.get(toolUseId)?.name || 'Edit', toolUseId, input: { ...(params.reason ? { reason: params.reason } : {}), ...(params.grantRoot ? { grantRoot: params.grantRoot } : {}) } };
    case 'item/permissions/requestApproval':
      return { toolName: 'Permissions', toolUseId, input: { permissions: params.permissions ?? {}, ...(params.reason ? { reason: params.reason } : {}) } };
    case 'item/tool/requestUserInput':
      return {
        toolName: 'AskUserQuestion',
        toolUseId,
        input: {
          questions: (params.questions || []).map((q: any) => ({
            question: q.question,
            header: q.header,
            multiSelect: false,
            options: (q.options || []).map((o: any) => ({ label: o.label, description: o.description || '' })),
          })),
        },
      };
    default:
      return null;
  }
}

/** Pure: the human's answer → the JSON-RPC result codex expects. */
export function answerFor(method: string, params: any, ans: PermissionResult): unknown {
  const allow = ans.behavior === 'allow';
  switch (method) {
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
      return { decision: allow ? 'accept' : ans.timedOut ? 'cancel' : 'decline' };
    case 'item/permissions/requestApproval':
      return { permissions: allow ? params.permissions ?? {} : {} };
    case 'item/tool/requestUserInput': {
      const picks = ((ans.updatedInput as any)?.answers || {}) as Record<string, string>;
      const answers: Record<string, { answers: string[] }> = {};
      for (const q of params.questions || []) {
        const a = picks[q.question] ?? picks[q.header];
        if (allow && typeof a === 'string' && a) answers[q.id] = { answers: [a] };
      }
      return { answers };
    }
    default:
      return {};
  }
}

function onServerRequest(id: string, st: AppState, j: any): void {
  const card = cardFor(j.method, j.params, st.items);
  if (!card) {
    // Dynamic tools, token refresh, MCP elicitations: nothing registered for them here.
    if (j.method === 'mcpServer/elicitation/request') respond(st, j.id, { action: 'decline' });
    else write(st, { jsonrpc: '2.0', id: j.id, error: { code: -32601, message: `arigami does not handle ${j.method}` } });
    return;
  }
  const proc = st.proc;
  st.requests.set(j.id, card.toolUseId);
  if (card.toolName === 'AskUserQuestion') appendChat(id, { kind: 'tool-use', toolUseId: card.toolUseId, name: 'AskUserQuestion', input: card.input });
  openPermission(id, { ...card, timeoutMs: APPROVAL_TIMEOUT_MS }).then((ans) => {
    st.requests.delete(j.id);
    if (stateOf(id).proc !== proc) return;
    respond(st, j.id, answerFor(j.method, j.params, ans));
    if (getSession(id)?.claude?.state === 'awaiting-input') setClaude(id, { state: 'working' });
  });
}

// ---- handleEvent ------------------------------------------------------------------

function onItemCompleted(id: string, st: AppState, item: any): void {
  switch (item.type) {
    case 'userMessage':
    case 'hookPrompt':
      return;
    case 'agentMessage':
      if (item.text) appendChat(id, { kind: 'assistant-text', text: String(item.text) });
      return;
    case 'reasoning': {
      const text = reasoningText(item, st.reasoning.get(String(item.id)) || '');
      st.reasoning.delete(String(item.id));
      if (text.trim()) appendChat(id, { kind: 'thinking', text });
      return;
    }
    case 'contextCompaction':
      appendChat(id, { kind: 'system', text: '⤷ context compacted' });
      return;
    default: {
      const meta = st.items.get(String(item.id)) || emitToolUse(id, st, item);
      st.items.delete(String(item.id));
      const { content, isError } = appItemResult(item);
      if (meta.server) noteMcpResult(id, meta.server, { content, is_error: isError });
      if (meta.host) {
        if (isError) reapGivenUpHostTool(id, meta.tool);
        return;
      }
      appendChat(id, { kind: 'tool-result', toolUseId: String(item.id), content, isError });
    }
  }
}

function onUsage(id: string, st: AppState, tokenUsage: any): void {
  st.lastUsage = tokenUsage;
  const last = tokenUsage?.last;
  if (!last) return;
  const s = getSession(id);
  const model = s?.claude?.model || s?.claude?.modelChoice || null;
  const window = Number(tokenUsage.modelContextWindow) || null;
  const catalog = [...(model && window ? [{ id: model, contextWindow: window }] : []), ...codexModels()];
  const mapped = mapAppUsage(last);
  updateUsage(id, mapped, catalog);
  if (Number(last.inputTokens) > 0) noteTurnUsage(id, mapped);
  const limit = Number(s?.claude?.autoCompactTokens) || 0;
  const ctx = mapped.input_tokens + mapped.cache_read_input_tokens;
  if (limit && ctx >= limit && !st.compacting && !st.compactDue) {
    st.compactDue = `auto, ${Math.round(ctx / 1000)}k ≥ ${Math.round(limit / 1000)}k tokens`;
    if (!st.turnId && !st.starting) runCompaction(id, st, st.compactDue);
  }
}

function onTurnCompleted(id: string, st: AppState, turn: any): void {
  const wasCompaction = st.compacting;
  st.turnId = null;
  st.starting = false;
  st.compacting = false;
  st.items.clear();
  const status = String(turn?.status || 'completed');
  const durationMs = Number(turn?.durationMs) || (st.turnStartedAt ? Date.now() - st.turnStartedAt : undefined);
  setClaude(id, { state: 'idle' });
  if (status === 'failed') {
    const text = String(turn?.error?.message || 'codex turn failed');
    if (!st.errs.has(text)) {
      st.errs.add(text);
      appendChat(id, { kind: 'error', text, isError: true });
    }
    const info = turn?.error?.codexErrorInfo;
    onLimitText(id, info === 'usageLimitExceeded' || info === 'rateLimitExceeded' ? `usage limit reached (${info}): ${text}` : text);
  } else if (status === 'interrupted') {
    appendChat(id, { kind: 'system', text: '⏹ interrupted' });
  } else if (!wasCompaction) {
    appendChat(id, { kind: 'result', text: '', isError: false, durationMs });
  }
  if (!wasCompaction) recordTurn(id, { duration_ms: durationMs, total_cost_usd: null });
  afterIdle(id, st, wasCompaction);
  if (!st.turnId && !st.starting && !st.compacting) onTurnEnd(id);
}

/** v2 notifications, responses and server requests → the seven chat kinds. */
function appHandleEvent(id: string, raw: unknown): void {
  const j = raw as any;
  const st = stateOf(id);
  if (j?.id != null && !j.method) {
    const r = st.pending.get(Number(j.id));
    if (r) {
      st.pending.delete(Number(j.id));
      r(j.error ? { error: j.error } : { result: j.result });
    }
    return;
  }
  if (j?.id != null && j.method) return onServerRequest(id, st, j);
  const p = j?.params || {};
  if (p.threadId && st.threadId && p.threadId !== st.threadId) return; // a sub-agent thread
  switch (j?.method) {
    case 'thread/started':
      if (p.thread?.id && !st.threadId) setClaude(id, { sessionId: p.thread.id });
      break;
    case 'turn/started':
      st.turnStartedAt = Date.now();
      st.errs.clear();
      if (p.turn?.id) onTurnId(id, st, p.turn.id);
      break;
    case 'item/started': {
      const item = p.item;
      if (!item?.id) break;
      if (item.type === 'contextCompaction' && !st.compacting) {
        st.compacting = true;
        appendChat(id, { kind: 'system', text: '⤷ codex is compacting the context…' });
      }
      if (QUIET_ITEMS.has(item.type)) break;
      emitToolUse(id, st, item);
      break;
    }
    case 'item/agentMessage/delta':
      if (p.delta) broadcast({ type: `chat:${id}`, event: { kind: 'assistant-text', partial: true, text: String(p.delta) } });
      break;
    case 'item/reasoning/textDelta':
    case 'item/reasoning/summaryTextDelta':
      if (p.itemId && p.delta) st.reasoning.set(String(p.itemId), (st.reasoning.get(String(p.itemId)) || '') + String(p.delta));
      break;
    case 'item/completed':
      if (p.item) onItemCompleted(id, st, p.item);
      break;
    case 'thread/tokenUsage/updated':
      onUsage(id, st, p.tokenUsage);
      break;
    case 'thread/settings/updated': {
      const model = p.threadSettings?.model;
      if (typeof model === 'string' && model && getSession(id)?.claude?.model !== model) setClaude(id, { model });
      break;
    }
    case 'turn/diff/updated':
      onDiff(id, st, String(p.diff || ''));
      break;
    case 'turn/completed':
      onTurnCompleted(id, st, p.turn);
      break;
    case 'serverRequest/resolved': {
      const itemId = st.requests.get(p.requestId);
      if (itemId) {
        st.requests.delete(p.requestId);
        dismissPermission(id, itemId);
      }
      break;
    }
    case 'account/rateLimits/updated':
      onRateLimits(id, p);
      break;
    case 'error': {
      const msg = String(p.error?.message || '');
      if (!msg || isHookTrustNotice(msg)) break;
      if (p.willRetry) {
        console.warn(`[codex-app] ${id}: ${msg} (retrying)`);
        break;
      }
      if (st.errs.has(msg)) break;
      st.errs.add(msg);
      appendChat(id, { kind: 'error', text: msg, isError: true });
      break;
    }
    default:
      break;
  }
}

// ---- diffs (P3-3) + quota (P5) ------------------------------------------------------

const DIFF_THROTTLE_MS = 1500;

/** turn/diff/updated → session.claude.turnDiff (the Changes tab reloads on its `at`). */
function onDiff(id: string, st: AppState, diff: string): void {
  const now = Date.now();
  if (now - st.diffAt < DIFF_THROTTLE_MS) return;
  st.diffAt = now;
  setClaude(id, { turnDiff: { at: now, ...diffCounts(diff) } });
}

/** account/rateLimits/updated → the account's live usage (usage.js cache + codex-recovery's confirmation). */
function onRateLimits(id: string, params: any): void {
  const s = getSession(id);
  const pinned = s?.claude?.accountId;
  const accountId = pinned && getAccount(pinned)?.provider === 'codex' ? pinned : getActiveId('codex');
  if (!accountId) return;
  Promise.all([import('./codex-account.js'), import('./usage.js')])
    .then(([ca, usage]: any[]) => usage.noteLiveUsage(accountId, ca.normalizeCodexRateLimits(params)))
    .catch(() => {});
}

// ---- the driver -----------------------------------------------------------------------

function appBuildSpawn(s: Session, opts: { resume: boolean; sessionId: string | null }) {
  const built = codexBuildSpawn(s, opts);
  return { ...built, args: ['app-server'] };
}

const codexAppDriver: EngineDriver = {
  id: 'codex',
  prepare: codexPrepare,
  buildSpawn: appBuildSpawn,
  handleEvent: appHandleEvent,
  writeMessage: appWriteMessage,
  handshake: appHandshake,
  interrupt: appInterrupt,
  sessionId: {
    mode: 'observed',
    from: (rawEvent: unknown) => {
      const j = rawEvent as any;
      return j?.method === 'thread/started' && typeof j.params?.thread?.id === 'string' ? j.params.thread.id : null;
    },
  },
  permissions: { kind: 'rpc-request' },
  injectMcp: execDriver.injectMcp,
  modelArgs: execDriver.modelArgs,
  effortLevels: execDriver.effortLevels,
};

/** The codex driver for a transport: 'exec' keeps server/codex.ts, anything else is app-server. */
export function codexDriverFor(transport: string | undefined): EngineDriver {
  return transport === 'exec' ? execDriver : codexAppDriver;
}

registerEngine(codexDriverFor(cfg.codexTransport));

export { codexAppDriver, appHandleEvent, appWriteMessage, appInterrupt, appHandshake };
