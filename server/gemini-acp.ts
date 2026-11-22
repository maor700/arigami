// Gemini over Antigravity's `agy acp`: one long-lived Agent Client Protocol process per session (docs/ENGINES.md).
// Verified against agy 1.5.14; raw runs in test/fixtures/gemini-acp/.

import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { supervise, killTree } from './lib/children.js';
import { HOME } from './lib/platform.js';
import { cfg, getSession, setClaude, untildify } from './state.js';
import { broadcast } from './bus.js';
import { auth } from './auth.js';
import { HOST_MARK } from './lib/session-procs.js';
import * as scratch from './lib/scratch.js';
import * as sessionMcp from './lib/session-mcp.js';
import { pickDriver } from './lib/screen-driver.js';
import { registerEngine } from './lib/engine-driver.js';
import type { EngineDriver } from './lib/engine-driver.js';
import type { Session } from './state.js';
import { SKILLS_DIR, USER_SKILLS_DIR } from './skills.js';
import { docsDir } from './lib/resource-root.js';
import { policyFor, isRestrictive, serverTouched, checkToolCall } from './agent-policy.js';
import { openPermission, dismissPermission } from './api.js';
import type { PermissionResult } from './api.js';
import { onTurnEnd } from './codex.js';
import { appendChat, getChat, describeAttachment, noteMcpResult, updateUsage, noteTurnUsage, recordTurn, mcpServersFor, memoryBootstrapPrefix } from './claude.js';
import {
  requireAgy,
  agyLoggedIn,
  AGY_SIGNED_OUT,
  acpMcpServers,
  aliasToolName,
  toolInput,
  commandOutput,
  resolveModelId,
  effortsFor,
  fallbackEfforts,
  splitModelId,
  GEMINI_DEFAULT_MODEL,
  pickerRows,
  agyAcpArgs,
  modelRows,
  skillPrompt,
  skillsNote,
  hooksJson,
  hookDecision,
  readsOnlyUnder,
  acpDiffCounts,
  skillStub,
  agyConversationPaths,
} from './lib/gemini-cli.js';
import { geminiRealHome } from './lib/gemini-home.js';
import { bunExecShell } from './lib/bun-exec.js';
import { hasMods } from './mods.js';
import { setGeminiCatalogSource, looksLikeGeminiLimit } from './lib/gemini-quota.js';
import * as extensions from './extensions.js';
import type { AcpMcpServer, AcpModel, GeminiModelRow, ToolName } from './lib/gemini-cli.js';

/** Approval cards wait as long as a screen request, then answer `cancelled`. */
export const APPROVAL_TIMEOUT_MS = Number(process.env.ARIGAMI_GEMINI_APPROVAL_TIMEOUT_MS) || 30 * 60 * 1000;

interface ToolState extends ToolName {
  host: boolean;
  done: boolean;
  denied?: string;
  /** agy's ask_question: shown as the question card, answered by the next message */
  question?: boolean;
}

interface AcpState {
  proc: any | null;
  seq: number;
  pending: Map<number, (r: { result?: any; error?: any }) => void>;
  /** the ACP session id (observed) */
  sessionId: string | null;
  ready: boolean;
  /** actions waiting for the session to be created/resumed */
  queue: Array<() => void>;
  /** a session/prompt is in flight */
  running: boolean;
  /** prompts that arrived while one was running — the next turn */
  after: any[][];
  compacting: boolean;
  /** why a compaction is owed once the session is idle (auto-compact) */
  compactDue: string | null;
  /** auto-compact already fired for this crossing of the threshold */
  autoCompacted: boolean;
  turnStartedAt: number;
  text: string;
  thought: string;
  tools: Map<string, ToolState>;
  /** MCP server names this process was handed */
  servers: string[];
  models: AcpModel[];
  modelId: string | null;
  modeId: string | null;
  /** rpc id of an open permission request → its tool call */
  requests: Map<number | string, string>;
  window: number | null;
  /** why the pre-tool hook refused a call, by agy tool name — shown on the failed card */
  hookDenied: Map<string, string>;
}

const states = new Map<string, AcpState>();

function fresh(): AcpState {
  return {
    proc: null, seq: 0, pending: new Map(), sessionId: null, ready: false, queue: [], running: false, after: [], compacting: false, compactDue: null, autoCompacted: false,
    turnStartedAt: 0, text: '', thought: '', tools: new Map(), servers: [], models: [], modelId: null, modeId: null, requests: new Map(), window: null, hookDenied: new Map(),
  };
}

export function stateOf(id: string): AcpState {
  let st = states.get(id);
  if (!st) states.set(id, (st = fresh()));
  return st;
}

/** Test seam: forget a session's driver state. */
export function resetAcpState(id: string): void {
  states.delete(id);
}

// ---- JSON-RPC ---------------------------------------------------------------

function write(st: AcpState, msg: unknown): boolean {
  const stdin = st.proc?.child?.stdin;
  if (!stdin || stdin.writableEnded || stdin.destroyed) return false;
  try {
    stdin.write(JSON.stringify(msg) + '\n');
    return true;
  } catch {
    return false;
  }
}

function rpc(st: AcpState, method: string, params: unknown): Promise<{ result?: any; error?: any }> {
  const id = ++st.seq;
  return new Promise((resolve) => {
    st.pending.set(id, resolve);
    if (!write(st, { jsonrpc: '2.0', id, method, params })) {
      st.pending.delete(id);
      resolve({ error: { message: 'agy acp is not running' } });
    }
  });
}

const notify = (st: AcpState, method: string, params: unknown) => write(st, { jsonrpc: '2.0', method, params });
const respond = (st: AcpState, id: number | string, result: unknown) => write(st, { jsonrpc: '2.0', id, result });

// ---- what a session is handed -------------------------------------------------

const cwdOf = (s: Session): string => untildify(s.cwd) || HOME;
const slugOf = (s: Session): string | null => (typeof s.metadata?.agent === 'string' && s.metadata.agent ? s.metadata.agent : null);

/** Identity a stdio MCP server needs (gateway off) — http entries carry the token in their header instead. */
function identityEnv(s: Session): Record<string, string> {
  return {
    ARIGAMI_SESSION_ID: s.id,
    ARIGAMI_HOST_ID: HOST_MARK,
    ...scratch.envFor(s.id),
    ARIGAMI_URL: cfg.hostBase!,
    ARIGAMI_PUBLIC_PATH: '/__host/',
    ARIGAMI_TOKEN: auth.tokenForSession(s.id),
    ARIGAMI_ENGINE: 'gemini',
    ...(cfg.publicUrl ? { ARIGAMI_PUBLIC_URL: cfg.publicUrl } : {}),
  };
}

/** The session's MCP servers in ACP shape: claude's set minus Claude-only grants and (A3) servers the allowlist never reaches. */
export function geminiMcpServers(s: Session): AcpMcpServer[] {
  const servers: Record<string, any> = mcpServersFor(s, { claudeGrants: false });
  const policy = policyFor(slugOf(s));
  if (isRestrictive(policy) && policy!.tools !== null) {
    for (const name of Object.keys(servers)) if (!serverTouched(policy!, name)) delete servers[name];
  }
  sessionMcp.recordSpawn(s.id, Object.entries(servers).map(([name, sv]) => sessionMcp.classify(name, sv)));
  return acpMcpServers(servers, { ARIGAMI_TOKEN: auth.tokenForSession(s.id) }, identityEnv(s));
}

/** Where `/arigami:<skill>` resolves on this host (the same three packs claude gets as plugins). */
function skillRoots(): Record<string, string | null> {
  let ext: string | null = null;
  try {
    if (extensions.extPluginHasSkills()) ext = path.join(extensions.EXT_PLUGIN_DIR, 'skills');
  } catch { /* loader not ready */ }
  return { arigami: SKILLS_DIR, 'arigami-user': fs.existsSync(USER_SKILLS_DIR) ? USER_SKILLS_DIR : null, 'arigami-ext': ext };
}

// ---- the session's own customization dir -----------------------------------------------

/** Where agy finds this session's hooks and skills (`agy acp --add-dir`); rewritten on every spawn, removed with the session. */
export const geminiSessionDir = (id: string): string => path.join(cfg.configDir!, 'gemini', id);

const descriptionOf = (skillMd: string): string => {
  try {
    const fm = /^---\n([\s\S]*?)\n---/.exec(fs.readFileSync(skillMd, 'utf8'))?.[1] || '';
    return (/^description:\s*(.*)$/m.exec(fm)?.[1] || '').replace(/^["']|["']$/g, '');
  } catch {
    return '';
  }
};

/**
 * The pre-tool hook (A3 allowlist, mods, ask-before-edit) and one stub per Arigami skill, so agy lists them as its own.
 * A user skill shadows a shipped one of the same name, as everywhere else.
 */
export function writeSessionDir(s: Session): string {
  const dir = geminiSessionDir(s.id);
  const agents = path.join(dir, '.agents');
  fs.mkdirSync(agents, { recursive: true });
  const restricted = isRestrictive(policyFor(slugOf(s)));
  const flags = ['--agy', ...(restricted ? ['--restricted'] : []), ...(hasMods() ? ['--mods'] : [])];
  fs.writeFileSync(path.join(agents, 'hooks.json'), hooksJson(bunExecShell('policy', flags), { post: hasMods() }));
  const skillsRoot = path.join(agents, 'skills');
  fs.rmSync(skillsRoot, { recursive: true, force: true });
  const roots = skillRoots();
  for (const root of [roots['arigami-ext'], roots.arigami, roots['arigami-user']]) {
    if (!root) continue;
    let names: string[] = [];
    try { names = fs.readdirSync(root); } catch { continue; }
    for (const name of names) {
      const real = path.join(root, name);
      if (!/^[a-z0-9][a-z0-9-]*$/.test(name) || !fs.existsSync(path.join(real, 'SKILL.md'))) continue;
      fs.mkdirSync(path.join(skillsRoot, name), { recursive: true });
      fs.writeFileSync(path.join(skillsRoot, name, 'SKILL.md'), skillStub(name, descriptionOf(path.join(real, 'SKILL.md')), real));
    }
  }
  return dir;
}

/** Deleting a session: its customization dir, and the conversations agy kept for it. */
export function removeGeminiSession(id: string, conversations: string[] = []): void {
  states.delete(id);
  try { fs.rmSync(geminiSessionDir(id), { recursive: true, force: true }); } catch { /* best effort */ }
  for (const c of conversations) for (const p of agyConversationPaths(geminiRealHome(), c)) try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* agy's files */ }
}

/** The pre-tool hook's question (mcp/policy-hook.js --agy): the call under Arigami's name, the allowlist's verdict, else what the permission mode wants agy to do. */
export function geminiToolCheck(id: string, name: string, args: unknown): { tool: ToolName; input: Record<string, unknown>; decision: 'allow' | 'deny' | 'ask' | 'force_ask'; reason?: string } {
  const s = getSession(id);
  const st = states.get(id);
  const servers = st?.servers.length ? st.servers : (((s?.claude as any)?.mcpLoaded?.servers || []) as any[]).map((x) => String(x.name));
  const tool = aliasToolName(name, servers);
  const input = toolInput(tool.name, args);
  const v = s ? checkToolCall(policyFor(slugOf(s)), tool.name, input, id) : { allow: true as const };
  if (!v.allow) {
    const reason = `[arigami policy] ${(v as any).reason || `${tool.name} is not allowed for this agent`}`;
    st?.hookDenied.set(name, reason);
    return { tool, input, decision: 'deny', reason };
  }
  if (ownRead(id, tool.name, args)) return { tool, input, decision: 'allow' };
  return { tool, input, decision: hookDecision(s?.claude?.permissionMode, tool.name) };
}

/** Arigami's own skill packs and docs sit outside the workspace: reading them is part of running a skill, never a question for the human. */
const ownRead = (id: string, tool: string, args: unknown): boolean => readsOnlyUnder(tool, args, [...Object.values(skillRoots()), docsDir(), geminiSessionDir(id)]);

/** A mod refused a call the allowlist let through (api.ts runs the mods): remembered for the failed card. */
export function noteHookDenied(id: string, name: string, reason: string): void {
  states.get(id)?.hookDenied.set(name, reason);
}

/** Arigami's permission mode → agy's session mode; bypass stays on `default` so every request still reaches the policy check. */
export function acpModeFor(permissionMode: string | null | undefined): string {
  if (permissionMode === 'acceptEdits') return 'accept-edits';
  if (permissionMode === 'plan') return 'plan';
  return 'default';
}

/** Pure: the session/prompt content — text (non-image attachments listed) + one image block per image. */
export function buildPrompt(text: string, attachments: any[] = []): any[] {
  let txt = text || '';
  const images = attachments.filter((a) => a?.isImage && !a.archive && (a.dataBase64 || typeof a.path === 'string'));
  const others = attachments.filter((a) => !images.includes(a));
  if (others.length) txt += (txt ? '\n\n' : '') + `📎 Attached ${others.length} file(s) — read them as needed:\n${others.map(describeAttachment).join('\n')}`;
  const blocks: any[] = [];
  for (const a of images) {
    let data = a.dataBase64;
    if (!data) try { data = fs.readFileSync(a.path).toString('base64'); } catch { /* listed as a path instead */ }
    if (data) blocks.push({ type: 'image', mimeType: a.type || 'image/png', data });
    else txt += `\n${describeAttachment(a)}`;
  }
  if (!txt && !blocks.length) txt = '(empty message)';
  return [...(txt ? [{ type: 'text', text: txt }] : []), ...blocks];
}

// ---- models ---------------------------------------------------------------------

const MODELS_TTL_MS = 60 * 60_000;
let modelCache: { rows: GeminiModelRow[]; at: number } | null = null;
let modelsInflight: Promise<GeminiModelRow[]> | null = null;
const modelsFile = (): string => path.join(cfg.configDir!, 'gemini-models.json');

function noteModels(models: { availableModels?: AcpModel[]; currentModelId?: string } | undefined, window: number | null): void {
  if (!Array.isArray(models?.availableModels) || !models!.availableModels!.length) return;
  const rows = modelRows(models!.availableModels!, window || modelCache?.rows[0]?.contextWindow || null);
  modelCache = { rows, at: Date.now() };
  try { fs.writeFileSync(modelsFile(), JSON.stringify({ at: modelCache.at, rows })); } catch { /* a cache */ }
}

/** The Gemini families Antigravity offers this account, as the picker lists them. */
export function geminiModels(): GeminiModelRow[] {
  return pickerRows(geminiFamilies());
}

/** Every family agy serves this account, Claude/GPT-through-Google included (from the last session or probe; survives a restart). */
export function geminiFamilies(): GeminiModelRow[] {
  if (!modelCache) {
    try {
      const j = JSON.parse(fs.readFileSync(modelsFile(), 'utf8'));
      if (Array.isArray(j?.rows)) modelCache = { rows: j.rows, at: Number(j.at) || 0 };
    } catch { /* none yet */ }
  }
  return modelCache?.rows || [];
}

/** Ask agy for the list without spending a turn: initialize + session/new in a scratch dir (hourly, or `force`). */
export function refreshGeminiModels({ force = false }: { force?: boolean } = {}): Promise<GeminiModelRow[]> {
  const have = geminiModels();
  if (!force && modelCache && have.length && Date.now() - modelCache.at < MODELS_TTL_MS) return Promise.resolve(have);
  if (modelsInflight) return modelsInflight;
  modelsInflight = (async () => {
    try {
      const dir = path.join(cfg.configDir!, 'gemini-probe');
      fs.mkdirSync(dir, { recursive: true });
      await acpOnce({ cwd: dir, timeoutMs: 20_000 }, async (c) => {
        const r = await c.rpc('session/new', { cwd: dir, mcpServers: [] });
        if (r.result?.models) noteModels(r.result.models, null);
        if (r.result?.sessionId) await c.rpc('session/close', { sessionId: r.result.sessionId });
      });
    } catch (e) {
      console.warn(`[gemini] model list: ${(e as Error).message}`);
    } finally {
      modelsInflight = null;
    }
    return geminiModels();
  })();
  return modelsInflight;
}

let versionCache: { at: number; value: string | null } | null = null;
/** `agy --version`, cached per host process. */
export async function agyVersion(): Promise<string | null> {
  if (versionCache && (versionCache.value || Date.now() - versionCache.at < 60_000)) return versionCache.value;
  const value = await new Promise<string | null>((resolve) => {
    try {
      execFile(requireAgy(), ['--version'], { timeout: 5000 }, (err, stdout) => resolve(err ? null : String(stdout).match(/\d+\.\d+\.\d+\S*/)?.[0] || null));
    } catch {
      resolve(null);
    }
  });
  versionCache = { at: Date.now(), value };
  return value;
}

// ---- a short-lived ACP client (model probe, one-shots) ----------------------------------

interface AcpClient {
  rpc(method: string, params: unknown): Promise<{ result?: any; error?: any }>;
  onUpdate(fn: (update: any) => void): void;
}

/** Run `fn` against a throwaway `agy acp` (permissions auto-approved), initialized; the process is killed afterwards. */
export async function acpOnce<T>(opts: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; tag?: string }, fn: (c: AcpClient) => Promise<T>): Promise<T> {
  const bin = requireAgy();
  const child = spawn(bin, agyAcpArgs(process.env, ['--dangerously-skip-permissions']), { cwd: opts.cwd, env: opts.env || geminiEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
  supervise(child, opts.tag || 'gemini-acp');
  const pending = new Map<number, (r: any) => void>();
  const listeners: Array<(u: any) => void> = [];
  let seq = 0;
  let buf = '';
  let err = '';
  const send = (msg: unknown) => { try { child.stdin.write(JSON.stringify(msg) + '\n'); } catch { /* exited */ } };
  child.stdin.on('error', () => {});
  child.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      let j: any;
      try { j = JSON.parse(line); } catch { continue; }
      if (j.id != null && !j.method) {
        pending.get(Number(j.id))?.(j.error ? { error: j.error } : { result: j.result });
        pending.delete(Number(j.id));
      } else if (j.id != null && j.method === 'session/request_permission') {
        const allow = (j.params?.options || []).find((o: any) => o.kind === 'allow_once') || j.params?.options?.[0];
        send({ jsonrpc: '2.0', id: j.id, result: { outcome: allow ? { outcome: 'selected', optionId: allow.optionId } : { outcome: 'cancelled' } } });
      } else if (j.id != null && j.method) {
        send({ jsonrpc: '2.0', id: j.id, error: { code: -32601, message: `arigami does not handle ${j.method}` } });
      } else if (j.method === 'session/update') {
        for (const l of listeners) l(j.params?.update || {});
      }
    }
  });
  const client: AcpClient = {
    rpc: (method, params) =>
      new Promise((resolve) => {
        const id = ++seq;
        pending.set(id, resolve);
        send({ jsonrpc: '2.0', id, method, params });
      }),
    onUpdate: (l) => listeners.push(l),
  };
  let timer: any;
  const gone = new Promise<never>((_, reject) => {
    child.on('error', (e) => reject(e));
    child.on('close', (code) => reject(new Error(`agy acp exited (code ${code})${err.trim() ? ': ' + err.trim().slice(-300) : ''}`)));
    timer = setTimeout(() => reject(new Error('agy acp timed out')), opts.timeoutMs || 3 * 60 * 1000);
  });
  gone.catch(() => {});
  try {
    return await Promise.race([
      (async () => {
        const init = await client.rpc('initialize', { protocolVersion: 1, clientInfo: CLIENT_INFO, clientCapabilities: CLIENT_CAPS });
        if (init.error) throw new Error(`agy acp: initialize failed: ${init.error.message}`);
        return fn(client);
      })(),
      gone,
    ]);
  } finally {
    clearTimeout(timer);
    try { child.stdin.end(); } catch { /* gone */ }
    killTree(child.pid!);
  }
}

// ---- process lifecycle ----------------------------------------------------------

const CLIENT_INFO = { name: 'arigami', title: 'Arigami', version: '1' };
// agy reads and writes files itself; Arigami offers neither a file system nor a terminal over ACP.
const CLIENT_CAPS = { fs: { readTextFile: false, writeTextFile: false }, terminal: false };

function dropProc(id: string, st: AcpState, why: string): void {
  for (const r of st.pending.values()) r({ error: { message: why } });
  const next = fresh();
  next.after = st.after; // messages the dead process never got to — the next process takes them
  states.set(id, next);
}

/** session/set_model when the session's model + effort differ from what the agent runs; a pick the account lacks is said in the chat. */
async function applyModel(id: string, st: AcpState): Promise<void> {
  const s = getSession(id);
  if (!s) return;
  const pick = resolveModelId(s.claude?.modelChoice, s.claude?.effort, st.models, st.modelId);
  if (pick.error) appendChat(id, { kind: 'error', text: `gemini: ${pick.error}${pick.id ? '' : ` — running on ${st.modelId || 'the default model'}`}` });
  if (pick.id && pick.id !== st.modelId) {
    const r = await rpc(st, 'session/set_model', { sessionId: st.sessionId, modelId: pick.id });
    if (r.error) appendChat(id, { kind: 'error', text: `gemini: could not switch to ${pick.id}: ${r.error.message} — running on ${st.modelId || 'the default model'}` });
    else st.modelId = pick.id;
  }
  if (st.modelId && getSession(id)?.claude?.model !== st.modelId) setClaude(id, { model: st.modelId });
}

async function applyMode(id: string, st: AcpState): Promise<void> {
  const want = acpModeFor(getSession(id)?.claude?.permissionMode);
  if (want === st.modeId) return;
  const r = await rpc(st, 'session/set_mode', { sessionId: st.sessionId, modeId: want });
  if (!r.error) st.modeId = want;
}

async function startSession(id: string, p: any): Promise<void> {
  const st = stateOf(id);
  const gone = () => stateOf(id) !== st || st.proc !== p;
  const init = await rpc(st, 'initialize', { protocolVersion: 1, clientInfo: CLIENT_INFO, clientCapabilities: CLIENT_CAPS });
  if (gone()) return;
  if (init.error) {
    appendChat(id, { kind: 'error', text: `gemini: agy acp did not initialize: ${init.error.message}` });
    return;
  }
  const s = getSession(id);
  if (!s) return;
  const mcpServers = geminiMcpServers(s);
  st.servers = mcpServers.map((m) => m.name);
  const cwd = cwdOf(s);
  // The first-turn blocks, persona and memory snapshot ride as the system prompt; agy keeps them with the session, so a resume sends none.
  const fresh = () => rpc(st, 'session/new', { cwd, mcpServers, _meta: { antigravity: { systemPrompt: { append: memoryBootstrapPrefix(p) + skillsNote(skillRoots()) } } } });
  // A session that never had a turn is started over: its system prompt is only known to be kept once a turn ran.
  const prev = p.resume && p.hadTurn ? s.claude?.sessionId : null;
  let r = prev ? await rpc(st, 'session/resume', { sessionId: prev, cwd, mcpServers }) : await fresh();
  if (gone()) return;
  if (r.error && prev) {
    appendChat(id, { kind: 'system', text: `⤷ gemini could not resume the previous conversation (${String(r.error.message).slice(0, 160)}) — started a new one` });
    r = await fresh();
    if (gone()) return;
  }
  const sid = r.result?.sessionId || (r.error ? null : prev);
  if (r.error || !sid) {
    const msg = String(r.error?.message || 'no session id');
    appendChat(id, { kind: 'error', text: `gemini: could not start a session: ${msg}${/auth|log ?in|credential/i.test(msg) ? ` — ${AGY_SIGNED_OUT}` : ''}` });
    setClaude(id, { state: 'idle' });
    return;
  }
  st.sessionId = sid;
  st.models = Array.isArray(r.result?.models?.availableModels) ? r.result.models.availableModels : [];
  st.modelId = r.result?.models?.currentModelId || null;
  st.modeId = r.result?.modes?.currentModeId || null;
  noteModels(r.result?.models, null);
  // Every conversation agy opened for this session — what removeGeminiSession deletes.
  const known: string[] = Array.isArray((s.claude as any)?.acpSessions) ? (s.claude as any).acpSessions : [];
  setClaude(id, { sessionId: sid, ...(known.includes(sid) ? {} : { acpSessions: [...known, sid].slice(-50) }) } as any);
  await applyModel(id, st);
  await applyMode(id, st);
  if (gone()) return;
  if (getSession(id)?.claude?.state === 'restarting') setClaude(id, { state: 'idle' });
  st.ready = true;
  for (const fn of st.queue.splice(0)) fn();
  if (!st.running && st.after.length) startPrompt(id, st, st.after.splice(0).flat());
}

function acpHandshake(p: any): void {
  const id = p.id;
  const prev = states.get(id);
  if (prev?.proc && prev.proc !== p) dropProc(id, prev, 'replaced by a new agy acp');
  const st = stateOf(id);
  st.proc = p;
  if (!p.resume) p.bootstrapInSystem = true; // composeTurnText: the bootstrap is the system prompt, not a message prefix
  p.hadTurn = hadTurn(id); // read now: the message that caused this spawn is appended right after
  p.child.once('close', () => {
    if (stateOf(id).proc === p) dropProc(id, stateOf(id), 'agy acp exited');
  });
  startSession(id, p).catch((e) => appendChat(id, { kind: 'error', text: `gemini: ${(e as Error).message}` }));
}

// ---- turns -------------------------------------------------------------------

const hadTurn = (id: string): boolean => (getChat(id, 0) || []).some((e: any) => e.kind === 'user');

const COMPACT = [{ type: 'text', text: '/compact' }];
const isCompact = (input: any[]): boolean => input.length === 1 && /^\/compact\s*$/.test(String(input[0]?.text || ''));

function startPrompt(id: string, st: AcpState, input: any[]): void {
  if (!st.sessionId) return;
  st.running = true;
  st.turnStartedAt = Date.now();
  st.compacting = isCompact(input);
  setClaude(id, { state: 'working' });
  if (st.compacting) appendChat(id, { kind: 'system', text: `⤷ compacting the context${st.compactDue ? ` (${st.compactDue})` : ''}…` });
  if (st.compacting) st.compactDue = null;
  // Model, effort and mode can change between turns with no respawn.
  applyModel(id, st)
    .then(() => applyMode(id, st))
    .then(() => rpc(st, 'session/prompt', { sessionId: st.sessionId, prompt: input }))
    .then((r) => onPromptDone(id, st, r));
}

function acpWriteMessage(proc: any, { text, attachments = [] }: { text: string; attachments?: any[] }): void {
  const id = proc.id;
  const st = stateOf(id);
  const input = buildPrompt(skillPrompt(text, skillRoots()), attachments);
  // A second session/prompt makes agy end the running one at once (measured) — so a mid-turn message waits its turn.
  const deliver = () => (st.running ? void st.after.push(input) : startPrompt(id, st, input));
  if (!st.ready) st.queue.push(deliver);
  else deliver();
}

function acpInterrupt(proc: any): void {
  const id = proc.id;
  const st = stateOf(id);
  st.after = [];
  if (!st.running || !st.sessionId) return;
  // ACP: a cancelled turn's open permission requests are answered `cancelled`.
  for (const [rid, toolCallId] of st.requests) {
    respond(st, rid, { outcome: { outcome: 'cancelled' } });
    dismissPermission(id, toolCallId, 'interrupted');
  }
  st.requests.clear();
  notify(st, 'session/cancel', { sessionId: st.sessionId });
}

/** Pure: ACP prompt usage → claude field names (inputTokens excludes the cached part — measured). */
export function mapAcpUsage(u: any) {
  return {
    input_tokens: Number(u?.inputTokens) || 0,
    output_tokens: Number(u?.outputTokens) || 0,
    cache_read_input_tokens: Number(u?.cachedReadTokens) || 0,
    cache_creation_input_tokens: Number(u?.cachedWriteTokens) || 0,
  };
}

function flushThought(id: string, st: AcpState): void {
  const text = st.thought.trim();
  st.thought = '';
  if (text) appendChat(id, { kind: 'thinking', text });
}

function flushText(id: string, st: AcpState): void {
  const text = st.text;
  st.text = '';
  if (text.trim()) appendChat(id, { kind: 'assistant-text', text });
}

function onPromptDone(id: string, st: AcpState, r: { result?: any; error?: any }): void {
  if (stateOf(id) !== st) return; // the process was replaced; its close handler already settled the session
  flushThought(id, st);
  flushText(id, st);
  // A tool the turn left without a final status (cancelled, or a command agy moved to the background).
  for (const [toolCallId, t] of st.tools) {
    if (!t.done && !t.host && !t.question) appendChat(id, { kind: 'tool-result', toolUseId: toolCallId, content: t.denied || '', isError: !!t.denied });
  }
  st.tools.clear();
  const wasCompaction = st.compacting;
  st.running = false;
  st.compacting = false;
  const durationMs = st.turnStartedAt ? Date.now() - st.turnStartedAt : undefined;
  setClaude(id, { state: 'idle' });
  const stop = String(r.result?.stopReason || '');
  if (r.error) {
    const msg = String(r.error.message || 'the turn failed');
    appendChat(id, { kind: 'error', text: `gemini: ${msg}`, isError: true });
    if (looksLikeGeminiLimit(msg)) import('./gemini-recovery.js').then((m) => m.onGeminiLimit(id, msg)).catch(() => {});
  } else if (stop === 'cancelled') {
    appendChat(id, { kind: 'system', text: '⏹ interrupted' });
  } else if (wasCompaction) {
    appendChat(id, { kind: 'system', text: '⤷ context compacted' });
  } else {
    if (stop === 'refusal') appendChat(id, { kind: 'error', text: 'gemini: the model refused this request', isError: true });
    else if (stop && stop !== 'end_turn') appendChat(id, { kind: 'system', text: `⤷ the turn stopped early (${stop})` });
    appendChat(id, { kind: 'result', text: '', isError: false, durationMs });
  }
  if (r.result?.usage) noteTurnUsage(id, mapAcpUsage(r.result.usage));
  if (!wasCompaction) recordTurn(id, { duration_ms: durationMs, total_cost_usd: null });
  if (st.running) return; // recordTurn's budget warning already started the next turn; queued input follows it
  if (st.compactDue) startPrompt(id, st, COMPACT); // auto-compact runs between turns, before anything queued
  else if (st.after.length) startPrompt(id, st, st.after.splice(0).flat());
  else onTurnEnd(id);
}

// ---- tool calls -----------------------------------------------------------------

/** Pure: a finished tool call's text — its content blocks, else the raw output; a diff reads as the file it changed. */
export function toolResultText(u: any): string {
  const parts: string[] = [];
  for (const c of Array.isArray(u?.content) ? u.content : []) {
    if (c?.type === 'content' && typeof c.content?.text === 'string') parts.push(commandOutput(c.content.text));
    else if (c?.type === 'diff' && c.path) parts.push(`${c.oldText == null ? 'created' : 'updated'}: ${c.path}`);
  }
  if (parts.length) return parts.join('\n');
  const out = u?.rawOutput;
  if (typeof out === 'string') return commandOutput(out);
  if (out && typeof out.output === 'string') return commandOutput(out.output);
  return out && Object.keys(out).length ? JSON.stringify(out) : '';
}

/** Pure: agy's ask_question arguments → the question card's input. */
export function questionInput(raw: any): { questions: Array<{ question: string; header: string; multiSelect: boolean; options: Array<{ label: string; description: string }> }> } {
  const list = Array.isArray(raw?.questions) ? raw.questions : [];
  return {
    questions: list.map((q: any) => ({
      question: String(q?.question || ''),
      header: String(q?.header || ''),
      multiSelect: !!q?.is_multi_select,
      options: (Array.isArray(q?.options) ? q.options : []).map((o: any) => {
        const text = String(typeof o === 'string' ? o : o?.label || '');
        const rec = /^\(Recommended\)\s*/i;
        return { label: text.replace(rec, ''), description: rec.test(text) ? 'Recommended' : String(o?.description || '') };
      }),
    })),
  };
}

function toolOf(id: string, st: AcpState, u: any): ToolState {
  const toolCallId = String(u.toolCallId);
  let t = st.tools.get(toolCallId);
  if (t) return t;
  const raw = String(u.name || u.title || '');
  const meta = aliasToolName(raw, st.servers, u.kind);
  t = { ...meta, host: meta.server === 'arigami', done: false };
  st.tools.set(toolCallId, t);
  flushThought(id, st);
  flushText(id, st);
  if (raw === 'ask_question') {
    // agy ends the turn on a question and takes the next message as the answer — the card answers with a message.
    t.question = true;
    appendChat(id, { kind: 'tool-use', toolUseId: toolCallId, name: 'AskUserQuestion', input: questionInput(u.rawInput ?? u.args) });
    return t;
  }
  // Arigami's own tools show as UI (a badge, a card, a tab) — both halves of the raw call stay out of the transcript.
  if (!t.host) appendChat(id, { kind: 'tool-use', toolUseId: toolCallId, name: t.name, input: toolInput(t.name, u.rawInput ?? u.args) });
  return t;
}

function onToolUpdate(id: string, st: AcpState, u: any): void {
  if (!u?.toolCallId) return;
  const t = toolOf(id, st, u);
  const status = String(u.status || '');
  if (t.done || (status !== 'completed' && status !== 'failed')) return;
  t.done = true;
  const isError = status === 'failed' || Number(u.rawOutput?.exit_code) > 0;
  const hookReason = isError ? st.hookDenied.get(String(u.name || '')) : undefined;
  if (hookReason) {
    st.hookDenied.delete(String(u.name || ''));
    t.denied = hookReason;
  }
  if (t.question) return;
  // A finished edit: the Changes tab reloads on turnDiff.at (as with codex's turn/diff/updated).
  const diff = isError ? null : acpDiffCounts(u.content);
  if (diff) setClaude(id, { turnDiff: { at: Date.now(), ...diff } } as any);
  const content = toolResultText(u) || (isError ? t.denied || 'failed' : '');
  if (t.server) noteMcpResult(id, t.server, { content, is_error: isError && !t.denied });
  if (!t.host) appendChat(id, { kind: 'tool-result', toolUseId: String(u.toolCallId), content, isError });
}

// ---- permission requests ------------------------------------------------------------

/** Pure: the human's answer → the ACP outcome, picked from the options agy offered. */
export function outcomeFor(options: any[], ans: Pick<PermissionResult, 'behavior' | 'timedOut'>): { outcome: string; optionId?: string } {
  const list = Array.isArray(options) ? options : [];
  const allow = ans.behavior === 'allow';
  const pick = list.find((o) => o?.kind === (allow ? 'allow_once' : 'reject_once')) || list.find((o) => String(o?.kind || '').startsWith(allow ? 'allow' : 'reject'));
  if (!pick || (ans.timedOut && !allow)) return { outcome: 'cancelled' };
  return { outcome: 'selected', optionId: pick.optionId };
}

function onPermissionRequest(id: string, st: AcpState, j: any): void {
  const call = j.params?.toolCall || {};
  const options = j.params?.options || [];
  const toolCallId = String(call.toolCallId || '');
  const t = toolOf(id, st, call);
  const input = toolInput(t.name, call.rawInput ?? call.args);
  const s = getSession(id);
  // A3: the agent's allowlist is checked here on every request, in every mode — agy has no PreToolUse hook Arigami can install.
  const verdict = s ? checkToolCall(policyFor(slugOf(s)), t.name, input, id) : { allow: true as const };
  if (!verdict.allow) {
    t.denied = `denied by the agent's allowlist: ${(verdict as any).reason || t.name}`;
    appendChat(id, { kind: 'system', text: `⤷ ${t.denied}` });
    respond(st, j.id, { outcome: outcomeFor(options, { behavior: 'deny' }) });
    return;
  }
  // agy still asks about a file outside the workspace after the hook said allow (measured) — answered here.
  if ((s?.claude?.permissionMode || 'bypassPermissions') === 'bypassPermissions' || ownRead(id, t.name, call.rawInput ?? call.args)) {
    respond(st, j.id, { outcome: outcomeFor(options, { behavior: 'allow' }) });
    return;
  }
  const proc = st.proc;
  st.requests.set(j.id, toolCallId);
  openPermission(id, { toolName: t.name, input, toolUseId: toolCallId, timeoutMs: APPROVAL_TIMEOUT_MS }).then((ans) => {
    if (!st.requests.has(j.id)) return; // answered by an interrupt
    st.requests.delete(j.id);
    if (stateOf(id).proc !== proc) return;
    if (ans.behavior !== 'allow') t.denied = ans.timedOut ? 'nobody answered the approval' : 'declined by the human';
    respond(st, j.id, { outcome: outcomeFor(options, ans) });
    if (getSession(id)?.claude?.state === 'awaiting-input') setClaude(id, { state: 'working' });
  });
}

// ---- handleEvent ------------------------------------------------------------------

function onUsage(id: string, st: AcpState, u: any): void {
  const used = Number(u.used) || 0;
  const size = Number(u.size) || 0;
  if (size && size !== st.window) {
    st.window = size;
    if (modelCache) for (const row of modelCache.rows) row.contextWindow = row.contextWindow || size;
  }
  if (!used) return;
  // agy reports the window itself; the row is keyed the way updateUsage looks it up.
  updateUsage(id, { input_tokens: used }, size ? [{ id: String(getSession(id)?.claude?.model || ''), contextWindow: size }] : null);
  autoCompact(id, st, used, size);
}

/** Auto-compact: past autoCompactPct of the window agy reports, run its /compact once — now if idle, else when the turn ends. */
function autoCompact(id: string, st: AcpState, used: number, size: number): void {
  const pct = Number(getSession(id)?.claude?.autoCompactPct) || 0;
  if (!pct || !size) return;
  const limit = Math.round(size * (pct / 100));
  if (getSession(id)?.claude?.autoCompactTokens !== limit) setClaude(id, { autoCompactTokens: limit });
  if (used < limit) {
    st.autoCompacted = false;
    return;
  }
  // Once per crossing: a compaction that does not bring the context back under the line is not repeated.
  if (st.autoCompacted || st.compacting || st.compactDue) return;
  st.autoCompacted = true;
  st.compactDue = `auto, ${Math.round(used / 1000)}k ≥ ${Math.round(limit / 1000)}k tokens`;
  if (st.ready && !st.running) startPrompt(id, st, COMPACT);
}

/** Pure: ACP availableCommands → the Commands tab's rows (agy's own commands and the Arigami skill stubs alike). */
export function commandRows(list: unknown): Array<{ name: string; description: string; argumentHint: string }> {
  const seen = new Set<string>();
  const out: Array<{ name: string; description: string; argumentHint: string }> = [];
  for (const c of Array.isArray(list) ? list : []) {
    const name = typeof c?.name === 'string' ? c.name.trim() : '';
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, description: String(c.description || ''), argumentHint: String(c.input?.hint || '') });
  }
  return out;
}

/** agy repeats the list several times a turn: stored (session.claude.capabilities.commands) only when it changed. */
function onCommands(id: string, list: unknown): void {
  const commands = commandRows(list);
  const prev = (getSession(id)?.claude as any)?.capabilities || {};
  if (JSON.stringify(prev.commands || []) === JSON.stringify(commands)) return;
  setClaude(id, { capabilities: { ...prev, commands } } as any);
}

/** ACP responses, agent requests and session/update notifications → the chat kinds. */
function acpHandleEvent(id: string, raw: unknown): void {
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
  if (j?.id != null && j.method) {
    if (j.method === 'session/request_permission') onPermissionRequest(id, st, j);
    else write(st, { jsonrpc: '2.0', id: j.id, error: { code: -32601, message: `arigami does not handle ${j.method}` } });
    return;
  }
  if (j?.method !== 'session/update') return;
  const p = j.params || {};
  if (p.sessionId && st.sessionId && p.sessionId !== st.sessionId) return; // a sub-agent's session
  const u = p.update || {};
  switch (u.sessionUpdate) {
    case 'agent_message_chunk': {
      const text = typeof u.content?.text === 'string' ? u.content.text : '';
      if (!text) break;
      flushThought(id, st);
      st.text += text;
      broadcast({ type: `chat:${id}`, event: { kind: 'assistant-text', partial: true, text } });
      break;
    }
    case 'agent_thought_chunk':
      if (typeof u.content?.text === 'string') {
        flushText(id, st);
        st.thought += u.content.text;
      }
      break;
    case 'tool_call':
    case 'tool_call_update':
      onToolUpdate(id, st, u);
      break;
    case 'usage_update':
      onUsage(id, st, u);
      break;
    case 'current_mode_update':
      if (typeof u.currentModeId === 'string') st.modeId = u.currentModeId;
      break;
    case 'available_commands_update':
      onCommands(id, u.availableCommands);
      break;
    default:
      break; // user_message_chunk, config_option_update, session_info_update, plan
  }
}

// ---- the driver -----------------------------------------------------------------------

/** The env an agy process gets: the host's, minus the other engines' credentials. */
function geminiEnv(): NodeJS.ProcessEnv {
  const { CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY, OPENAI_API_KEY, CODEX_HOME, ...rest } = process.env;
  return rest;
}

function acpPrepare(s: Session, _opts: { resume: boolean }): void {
  requireAgy();
  if (!agyLoggedIn()) throw new Error(AGY_SIGNED_OUT);
  writeSessionDir(s);
}

function acpBuildSpawn(s: Session, _opts: { resume: boolean; sessionId: string | null }) {
  const screenHandle = pickDriver().peek(s.id);
  const env: NodeJS.ProcessEnv = {
    ...geminiEnv(),
    ARIGAMI_SESSION_ID: s.id,
    ARIGAMI_HOST_ID: HOST_MARK,
    ...scratch.envFor(s.id),
    ARIGAMI_URL: cfg.hostBase,
    ARIGAMI_PUBLIC_PATH: '/__host/',
    ...(cfg.publicUrl ? { ARIGAMI_PUBLIC_URL: cfg.publicUrl } : {}),
    ARIGAMI_TOKEN: auth.tokenForSession(s.id),
    ARIGAMI_ENGINE: 'gemini',
    ...(slugOf(s) ? { ARIGAMI_AGENT: slugOf(s)! } : {}),
    ARIGAMI_SKILLS: SKILLS_DIR,
    ARIGAMI_DOCS: docsDir(),
    ARIGAMI_USER_SKILLS: USER_SKILLS_DIR,
    ...(s.metadata?.port ? { PORT: String(s.metadata.port) } : {}),
    ...(screenHandle?.display ? { DISPLAY: String(screenHandle.display) } : {}),
  };
  // The session id, MCP servers, model and mode all travel in the handshake, not on argv.
  return { bin: requireAgy(), args: agyAcpArgs(process.env, ['--add-dir', geminiSessionDir(s.id)]), env, cwd: cwdOf(s) };
}

const geminiDriver: EngineDriver = {
  id: 'gemini',
  prepare: acpPrepare,
  buildSpawn: acpBuildSpawn,
  handleEvent: acpHandleEvent,
  writeMessage: acpWriteMessage,
  handshake: acpHandshake,
  interrupt: acpInterrupt,
  sessionId: {
    mode: 'observed',
    from: (rawEvent: unknown) => {
      const j = rawEvent as any;
      return j?.id != null && !j.method && typeof j.result?.sessionId === 'string' ? j.result.sessionId : null;
    },
  },
  permissions: { kind: 'rpc-request' },
  liveSettings: (id: string) => {
    const st = states.get(id);
    if (st?.ready && !st.running) void applyModel(id, st);
  },
  injectMcp: () => [], // session/new carries the servers
  modelArgs: () => [], // session/set_model carries the model; effort is the tail of its id
  effortLevels: (s: Session) => {
    const st = states.get(s.id);
    const model = s.claude?.modelChoice || null;
    const live = st?.models.length ? effortsFor(model, st.models) : [];
    if (live.length) return live;
    const family = splitModelId(model || GEMINI_DEFAULT_MODEL).family;
    const row = geminiFamilies().find((r) => r.id === family);
    return row?.efforts.length ? row.efforts : fallbackEfforts(model);
  },
};

registerEngine(geminiDriver);
setGeminiCatalogSource(() => geminiFamilies().map((r) => r.id));

export { geminiDriver, acpHandleEvent, acpWriteMessage, acpInterrupt, acpHandshake, acpBuildSpawn, acpPrepare, geminiEnv };
