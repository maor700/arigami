// The OpenAI Codex CLI as arigami's second agent-engine — the `codex` half of
// server/lib/engine-driver.ts (claude.js is the first half). Verified against
// codex-cli 0.153.4 on this host; every claim below that says "measured" is
// backed by a real run whose raw JSONL sits in test/fixtures/codex-stream/.
//
// The two things that make this driver look different from claude's:
//
// 1. ONE PROCESS PER TURN. `codex exec` is not a long-lived stdin/stdout
//    conversation like `claude -p --input-format stream-json`. It reads ONE
//    prompt (we pass `-` so the prompt comes from stdin), runs one turn, and
//    exits 0. The next turn is a fresh `codex exec resume <thread_id>` against
//    the same $CODEX_HOME. That fits arigami's existing lifecycle unchanged:
//    the process exits → the close handler marks the session idle → the next
//    sendMessage() calls ensureRunning() which spawns again with resume=true,
//    because s.claude.sessionId (the thread id) is set. Nothing in claude.js's
//    spawn path had to learn about it.
//    Consequence: stdin is at EOF for the whole turn. See writeMessage() for
//    what happens to a message that arrives mid-turn.
//
// 2. THE THREAD ID IS OBSERVED, NOT ASSIGNED. Codex mints its own id and
//    announces it on `thread.started`; there is no `--session-id`. Hence
//    sessionId.mode === 'observed' and the store-on-first-event in handleEvent.
//
// Everything else — the chat log, the bus, personas, memory bootstrap, Simple
// mode, worktrees, the cockpit — is engine-agnostic and needed no change: this
// file only has to end up calling appendChat() with the same seven kinds.
//
// KNOWN LIMITS, stated rather than papered over:
//   - No live approval channel. `codex exec` has no `--permission-prompt-tool`
//     equivalent, so permissions.kind is 'none' and the process runs with
//     --dangerously-bypass-approvals-and-sandbox (also FORCED here: codex's own
//     bubblewrap sandbox cannot start on this box — `bwrap: loopback: Failed
//     RTM_NEWADDR`). Isolation comes from the session's worktree, as it already
//     did for claude's bypassPermissions.
//   - A3 allowlists are NOT enforceable here (no PreToolUse hook, no
//     --disallowedTools). prepare() refuses to spawn such a session rather than
//     running it with a policy that silently does nothing.
//   - Remote (url) MCP grants are skipped — codex keeps its own OAuth store per
//     $CODEX_HOME, so an arigami grant minted for claude is not usable.
//   - RES1's model ladder / LADDER1's compaction are claude-shaped and do not
//     run for codex sessions.
//   - `item.type: 'reasoning'` was never observed in any live run (see
//     handleEvent) — it is handled defensively, not verified.

import fs from 'node:fs';
import path from 'node:path';
import { HOME } from './lib/platform.js';
import { bunExec } from './lib/bun-exec.js';
import { cfg, getSession, setClaude, untildify } from './state.js';
import { auth } from './auth.js';
import { pickDriver } from './lib/screen-driver.js';
import { registerEngine } from './lib/engine-driver.js';
import type { EngineDriver } from './lib/engine-driver.js';
import type { Session } from './state.js';
import { SKILLS_DIR, USER_SKILLS_DIR } from './skills.js';
import * as extensions from './extensions.js';
import { injectedServersFor } from './mcp-connections.js';
import { policyFor, isRestrictive } from './agent-policy.js';
import { expirePendingPermissions, expirePendingScreenRequests } from './api.js';
import {
  appendChat,
  composeTurnText,
  describeAttachment,
  noteMcpResult,
  updateUsage,
  noteTurnUsage,
  recordTurn,
  ensureRunning,
  isRunning,
} from './claude.js';

// ---- the CLI --------------------------------------------------------------

/** The codex binary. Overridable for tests / a non-PATH install. */
function codexBin(): string {
  return process.env.ARIGAMI_CODEX_BIN || 'codex';
}

/**
 * The REAL codex home — where `codex login` put auth.json. Every session gets
 * its OWN $CODEX_HOME (thread history + generated config must not be shared),
 * and symlinks auth.json back to this one so a single login serves them all.
 */
function realCodexHome(): string {
  return process.env.ARIGAMI_CODEX_HOME || process.env.CODEX_HOME || path.join(HOME, '.codex');
}

/** $CODEX_HOME for one session. Persistent: `codex exec resume` reads the thread history from it. */
export function codexHomeFor(sessionId: string): string {
  return path.join(cfg.configDir!, 'codex', sessionId);
}

// Codex gives up on an MCP tool call after `tool_timeout_sec` and reports it as
// a failed tool result. arigami's blocking host tools (request_screen,
// permission_prompt) wait on a HUMAN, for minutes — measured live: with 15s a
// request_screen died after exactly 15.1s; with 180s a real human answered at
// 38.35s and the call went through. So this is deliberately pinned to the
// host's own SCREEN_REQUEST_TIMEOUT_MS (server/api.ts, 30 minutes): the engine
// must not give up before the card the human is looking at does.
const TOOL_TIMEOUT_SEC = 30 * 60;
const STARTUP_TIMEOUT_SEC = 20;

// Codex silently falls back to its default model when `-m` names something it
// doesn't know (measured — no error, no warning), so a claude alias leaking in
// from a session's modelChoice would look like it worked. Only pass through
// names that plausibly belong to codex.
const CODEX_MODEL_RE = /^(?:gpt|codex|o[0-9])[a-zA-Z0-9._-]*$/;
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

// ---- TOML -----------------------------------------------------------------

// TOML basic strings take the same escapes JSON does for everything we write
// here (paths, ids, tokens, urls) — no multi-line, no literal control chars.
const tstr = (v: unknown): string => JSON.stringify(String(v ?? ''));
const tarr = (v: unknown[]): string => `[${v.map(tstr).join(', ')}]`;
/** A dotted TOML table header segment: bare when it can be, quoted otherwise. */
const tkey = (k: string): string => (/^[A-Za-z0-9_-]+$/.test(k) ? k : tstr(k));

// ---- per-session bookkeeping ----------------------------------------------

interface ItemState {
  /** the flat `mcp__<server>__<tool>` name, or the pseudo tool name for non-MCP items */
  name: string;
  /** MCP server this item belongs to, for the live health map */
  server: string | null;
  /** an arigami host tool: its call/result echo is suppressed, exactly as claude's is */
  host: boolean;
  /** the bare tool name for an mcp_tool_call (`request_screen`), for the give-up cleanup */
  tool: string | null;
}

interface CodexSessionState {
  items: Map<string, ItemState>;
  /** top-level `{type:"error"}` messages already surfaced this turn (they repeat) */
  errs: Set<string>;
  turnStartedAt: number;
  /** messages that arrived while stdin was already at EOF — see writeMessage() */
  carry: string[];
  /** the "remote MCP grants don't work here" note is worth saying once, not every turn */
  warnedRemote: boolean;
}

const sessions = new Map<string, CodexSessionState>();

function stateOf(id: string): CodexSessionState {
  let st = sessions.get(id);
  if (!st) {
    st = { items: new Map(), errs: new Set(), turnStartedAt: 0, carry: [], warnedRemote: false };
    sessions.set(id, st);
  }
  return st;
}

/** Drop everything remembered about a session (its process is gone for good). */
export function forgetCodexSession(id: string): void {
  sessions.delete(id);
}

// ---- prepare(): $CODEX_HOME ------------------------------------------------

/** Point `link` at `target`, replacing whatever is there. Returns false if it couldn't. */
function linkDir(link: string, target: string): boolean {
  try {
    const st = fs.lstatSync(link);
    if (st.isSymbolicLink() && fs.readlinkSync(link) === target) return true;
    fs.rmSync(link, { recursive: true, force: true });
  } catch {
    /* nothing there — fall through and create it */
  }
  try {
    fs.symlinkSync(target, link);
    return true;
  } catch (e) {
    console.error(`[codex] could not link ${link} -> ${target}: ${(e as Error).message}`);
    return false;
  }
}

/**
 * Skills, verbatim. Codex reads $CODEX_HOME/skills/<root>/<name>/SKILL.md and
 * derives the namespace from the ROOT DIRECTORY NAME — so a symlink called
 * `arigami` produces `arigami:<name>`, the exact package name personaBlock()
 * already promises the model. Measured: all 13 shipped skills load with zero
 * frontmatter warnings and `/arigami:explain-changes` runs end to end.
 *
 * The three roots mirror pluginDirArgs()'s three --plugin-dir entries, and get
 * the same namespaces claude gives them. Note codex has NO override-by-order
 * semantics: a name present in two roots is two separate skills, not a shadow.
 *
 * $CODEX_HOME/skills/.system is codex's OWN pack, deleted and rewritten on
 * every codex upgrade — nothing of ours may ever live under it. We also don't
 * link it in: arigami sessions have no use for imagegen/skill-creator, and
 * leaving it out keeps headroom under codex's skills context budget.
 */
function linkSkills(codexHome: string): void {
  const skillsRoot = path.join(codexHome, 'skills');
  fs.mkdirSync(skillsRoot, { recursive: true });
  linkDir(path.join(skillsRoot, 'arigami'), SKILLS_DIR);
  if (fs.existsSync(USER_SKILLS_DIR)) linkDir(path.join(skillsRoot, 'arigami-user'), USER_SKILLS_DIR);
  let extSkills = '';
  try {
    if (extensions.extPluginHasSkills()) extSkills = path.join(extensions.EXT_PLUGIN_DIR, 'skills');
  } catch {
    /* loader not ready — a session must still start */
  }
  if (extSkills && fs.existsSync(extSkills)) linkDir(path.join(skillsRoot, 'arigami-ext'), extSkills);
  else fs.rmSync(path.join(skillsRoot, 'arigami-ext'), { recursive: true, force: true });
}

/**
 * The MCP dict, as TOML. Same three sources mcpConfigFor() feeds claude — the
 * host server, the enabled extensions' servers, and (see below) the agent's own
 * remote grants — only written to $CODEX_HOME/config.toml instead of passed as
 * inline JSON on argv, because codex has no `--mcp-config`.
 *
 * The key is `mcp_servers` in snake_case. `mcpServers`, the spelling every
 * other tool uses, is IGNORED IN SILENCE — verified live: a config with
 * `[mcpServers.arigami]` produced no warning and no tools at all.
 */
function mcpTables(s: Session, st: CodexSessionState): string[] {
  const servers: Record<string, any> = { arigami: bunExec('host') };
  const slug = typeof s.metadata?.agent === 'string' && s.metadata.agent ? s.metadata.agent : null;
  try {
    Object.assign(servers, extensions.extServersFor(slug ? `agent:${slug}` : 'global'));
  } catch {
    /* a broken extension must never stop a session from starting */
  }
  // M1 grants are `{type:'http', url}` entries whose credentials live in
  // CLAUDE's own per-agent MCP store. Codex authenticates remote servers
  // through its own `codex mcp login` under $CODEX_HOME and would just start an
  // unauthenticated connection (and burn STARTUP_TIMEOUT_SEC doing it), so they
  // are left out — and the session is told once, because its persona may have
  // promised those tools.
  if (slug) {
    let skipped: string[] = [];
    try {
      skipped = Object.keys(injectedServersFor(`agent:${slug}`));
    } catch {
      /* no connections.json */
    }
    if (skipped.length && !st.warnedRemote) {
      st.warnedRemote = true;
      appendChat(s.id, {
        kind: 'system',
        text:
          `⤷ המנוע כאן הוא Codex, ולכן שרתי ה-MCP המרוחקים של הסוכן (${skipped.join(', ')}) לא זמינים בסשן הזה — ` +
          `האישורים שלהם שייכים ל-Claude. אל תסתמך על הכלים שלהם; כלי הבית של אריגמי כן עובדים.`,
      });
    }
  }

  const env: Record<string, string> = {
    ARIGAMI_SESSION_ID: s.id,
    ARIGAMI_URL: cfg.hostBase!,
    ARIGAMI_PUBLIC_PATH: '/__host/',
    ARIGAMI_TOKEN: auth.tokenForSession(s.id),
    ...(cfg.publicUrl ? { ARIGAMI_PUBLIC_URL: cfg.publicUrl } : {}),
  };

  const out: string[] = [];
  for (const [name, sv] of Object.entries(servers)) {
    const header = `[mcp_servers.${tkey(name)}]`;
    if (sv && typeof sv === 'object' && typeof (sv as any).url === 'string') {
      out.push(header, `url = ${tstr((sv as any).url)}`, `tool_timeout_sec = ${TOOL_TIMEOUT_SEC}`, '');
      continue;
    }
    if (!sv || typeof (sv as any).command !== 'string') continue;
    out.push(
      header,
      `command = ${tstr((sv as any).command)}`,
      `args = ${tarr(Array.isArray((sv as any).args) ? (sv as any).args : [])}`,
      `startup_timeout_sec = ${STARTUP_TIMEOUT_SEC}`,
      `tool_timeout_sec = ${TOOL_TIMEOUT_SEC}`,
      ''
    );
    // The host server carries this session's identity; an extension server gets
    // whatever env it declared, plus the same identity so it can call back.
    const svEnv = { ...env, ...((sv as any).env && typeof (sv as any).env === 'object' ? (sv as any).env : {}) };
    out.push(`[mcp_servers.${tkey(name)}.env]`);
    for (const [k, v] of Object.entries(svEnv)) out.push(`${tkey(k)} = ${tstr(v)}`);
    out.push('');
  }
  return out;
}

/**
 * Everything a spawn needs that argv can't express: the per-session $CODEX_HOME
 * with its generated config.toml, the auth symlink, and the skill roots.
 * Re-run before EVERY spawn (which, for codex, means every turn) — it is
 * idempotent, and that is what makes a mid-session change to the extensions or
 * the user's skills take effect on the next turn instead of the next restart.
 */
function codexPrepare(s: Session, _opts: { resume: boolean }): void {
  // A3 has no equivalent here: codex has no PreToolUse hook and no
  // --disallowedTools, so an allowlist would be advisory at best while the
  // agent's persona promises it is enforced. Refusing to spawn is the honest
  // failure — loud, at spawn, exactly like pickEngine() refusing an
  // unimplemented engine.
  const slug = typeof s.metadata?.agent === 'string' && s.metadata.agent ? s.metadata.agent : null;
  if (slug && isRestrictive(policyFor(slug))) {
    throw new Error(
      `agent "${slug}" has a tool/domain allowlist, and the codex engine cannot enforce it ` +
        `(no PreToolUse hook, no --disallowedTools) — run this agent on the claude engine`
    );
  }

  const codexHome = codexHomeFor(s.id);
  fs.mkdirSync(codexHome, { recursive: true });

  // One login, many sessions: auth.json stays in the real ~/.codex and every
  // per-session home symlinks to it. A copy would go stale the moment codex
  // refreshes the ChatGPT token.
  const authSrc = path.join(realCodexHome(), 'auth.json');
  if (!fs.existsSync(authSrc)) {
    throw new Error(`codex is not signed in — ${authSrc} is missing; run \`codex login\` on the host first`);
  }
  linkDir(path.join(codexHome, 'auth.json'), authSrc);

  linkSkills(codexHome);

  const st = stateOf(s.id);
  const cwd = untildify(s.cwd) || HOME;
  const lines = [
    '# generated by server/codex.ts — rewritten before every spawn, do not edit by hand',
    `# session ${s.id}`,
    '',
    // Without this codex asks whether the directory is trusted; the session's
    // worktree IS the sandbox boundary arigami already chose for it.
    `[projects.${tstr(cwd)}]`,
    'trust_level = "trusted"',
    '',
    ...mcpTables(s, st),
  ];
  fs.writeFileSync(path.join(codexHome, 'config.toml'), lines.join('\n') + '\n');
}

// ---- buildSpawn() ----------------------------------------------------------

/**
 * `--model` / reasoning effort, as argv. Effort is not a flag on codex — it is
 * the `model_reasoning_effort` config key — but `-c key=value` is accepted by
 * both `exec` and `exec resume`, so it can still be argv here and stay out of
 * the generated config (which would otherwise have to be rewritten per turn
 * just to change it).
 */
function codexModelArgs({ model, effort }: { model?: string | null; effort?: string | null } = {}): string[] {
  const out: string[] = [];
  if (model && CODEX_MODEL_RE.test(model)) out.push('-m', model);
  else if (model) console.warn(`[codex] ignoring model "${model}" — not a codex model name`);
  if (effort && EFFORTS.has(effort)) out.push('-c', `model_reasoning_effort=${JSON.stringify(effort)}`);
  return out;
}

/** File-based: everything MCP was written into config.toml by prepare(). */
function codexInjectMcp(_s: Session): string[] {
  return [];
}

function codexBuildSpawn(s: Session, { resume, sessionId }: { resume: boolean; sessionId: string | null }) {
  const common = [
    '--json',
    // Codex's own sandbox cannot start on this host (bwrap: loopback: Failed
    // RTM_NEWADDR), and arigami already isolates a session in its worktree and
    // grants claude bypassPermissions — same posture, different flag name.
    '--dangerously-bypass-approvals-and-sandbox',
    // A session cwd is often a plain directory (~/repos, an artifact dir), not a repo.
    '--skip-git-repo-check',
    ...codexModelArgs({ model: s.claude?.modelChoice, effort: s.claude?.effort }),
    // `-` = read the prompt from stdin. writeMessage() writes the turn and
    // closes stdin; codex starts working on EOF. (Leaving stdin open with a
    // prompt on argv instead makes codex print "Reading additional input from
    // stdin..." and hang forever — measured.)
    '-',
  ];
  // `exec resume` takes no -C/--cd (verified against 0.153.4), so the working
  // directory comes from the spawn's own cwd for both forms — which is what
  // spawnProc passes to child_process.spawn anyway.
  const args = resume && sessionId ? ['exec', 'resume', sessionId, ...common] : ['exec', ...common];

  const cwd = untildify(s.cwd) || HOME;
  const screenHandle = pickDriver().peek(s.id);
  // Claude's account token has no meaning here and must not leak into a codex
  // process; codex authenticates purely through $CODEX_HOME/auth.json.
  const { CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY, ...rest } = process.env;
  const env: NodeJS.ProcessEnv = {
    ...rest,
    CODEX_HOME: codexHomeFor(s.id),
    ARIGAMI_SESSION_ID: s.id,
    ARIGAMI_URL: cfg.hostBase,
    ARIGAMI_PUBLIC_PATH: '/__host/',
    ...(cfg.publicUrl ? { ARIGAMI_PUBLIC_URL: cfg.publicUrl } : {}),
    ARIGAMI_TOKEN: auth.tokenForSession(s.id),
    ...(typeof s.metadata?.agent === 'string' && s.metadata.agent ? { ARIGAMI_AGENT: s.metadata.agent } : {}),
    ARIGAMI_SKILLS: SKILLS_DIR,
    ARIGAMI_USER_SKILLS: USER_SKILLS_DIR,
    ...(s.metadata?.port ? { PORT: String(s.metadata.port) } : {}),
    ...(screenHandle?.display ? { DISPLAY: String(screenHandle.display) } : {}),
  };
  return { bin: codexBin(), args, env, cwd };
}

// ---- writeMessage() --------------------------------------------------------

/**
 * One turn, written to stdin and then closed — the EOF is what starts codex.
 *
 * A message that arrives while a turn is already running finds stdin at EOF.
 * Claude just queues such a message on its live stdin; codex physically
 * cannot, and a write-after-end is a silent no-op in node (an async 'error'
 * event, not a throw), so it would LOSE the message. Instead it is carried
 * over and delivered as its own turn the moment this process exits — the user
 * already saw their bubble in the transcript, so re-delivering through
 * sendMessage() (which would append it a second time) is exactly what we don't
 * want here.
 */
function codexWriteMessage(proc: any, { text, attachments = [] }: { text: string; attachments?: any[] }): void {
  let txt = text || '';
  if (attachments.length) {
    // No inline images: codex only takes them as `-i` at spawn, and by now the
    // process is up. Every attachment is on disk with an absolute path, which
    // the model can read itself — that is what describeAttachment lists.
    const list = attachments.map(describeAttachment).join('\n');
    txt += (txt ? '\n\n' : '') + `📎 Attached ${attachments.length} file(s) — read them as needed:\n${list}`;
  }
  if (!txt) txt = '(empty message)';

  const st = stateOf(proc.id);
  if (proc.codexStdinDone || !proc.child.stdin || proc.child.stdin.writableEnded) {
    st.carry.push(txt);
    // The current process is what has to finish before a new turn can start.
    if (!proc.codexCarryHooked) {
      proc.codexCarryHooked = true;
      proc.child.once('close', () => setTimeout(() => deliverCarryOver(proc.id), 150));
    }
    return;
  }
  proc.codexStdinDone = true;
  try {
    proc.child.stdin.end(txt.endsWith('\n') ? txt : txt + '\n');
  } catch (e) {
    appendChat(proc.id, { kind: 'error', text: `codex: could not write the turn to stdin: ${(e as Error).message}` });
  }
}

/** Send everything that piled up while the last turn was running, as one new turn. */
function deliverCarryOver(id: string): void {
  const st = sessions.get(id);
  if (!st?.carry.length) return;
  if (isRunning(id)) return; // a newer process already picked the session up
  const text = st.carry.join('\n\n');
  st.carry = [];
  try {
    const p: any = ensureRunning(id); // spawns `codex exec resume <thread>`
    setClaude(id, { state: 'working' });
    codexWriteMessage(p, { text: composeTurnText(p, text) });
  } catch (e) {
    appendChat(id, {
      kind: 'error',
      text: `codex: a message sent during the previous turn could not be delivered: ${(e as Error).message}`,
    });
  }
}

// ---- handleEvent(): the codex stream → the seven normalized kinds ----------

const textOfContent = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content))
    return content
      .map((c: any) => (typeof c?.text === 'string' ? c.text : typeof c === 'string' ? c : JSON.stringify(c)))
      .join('\n');
  return content == null ? '' : JSON.stringify(content);
};

/**
 * Codex reports an MCP call as `{server, tool}` in two separate fields; every
 * A3 allowlist, every persona line and claude's whole `mcp__*` convention is
 * written against the FLAT name. Composing it here is what keeps one vocabulary
 * across both engines.
 */
const flatToolName = (server: string, tool: string): string =>
  `mcp__${String(server).replace(/[^A-Za-z0-9_-]/g, '_')}__${tool}`;

/** What kind of item this is, and how it should look in the transcript. */
function describeItem(item: any): ItemState {
  switch (item?.type) {
    case 'mcp_tool_call': {
      const server = String(item.server || '');
      const tool = String(item.tool || '');
      return { name: flatToolName(server, tool), server, host: server === 'arigami', tool };
    }
    case 'command_execution':
      // Named `Bash` on purpose: it is the same thing claude's Bash tool is, and
      // the cockpit already renders that name well.
      return { name: 'Bash', server: null, host: false, tool: null };
    case 'file_change':
      return { name: 'FileChange', server: null, host: false, tool: null };
    default:
      return { name: String(item?.type || 'item'), server: null, host: false, tool: null };
  }
}

/** The `input` bubble for a tool-use, per item type. */
function itemInput(item: any): unknown {
  switch (item?.type) {
    case 'mcp_tool_call':
      return item.arguments ?? {};
    case 'command_execution':
      return { command: item.command || '' };
    case 'file_change':
      return { changes: Array.isArray(item.changes) ? item.changes : [] };
    default:
      return item ?? {};
  }
}

/** The `content` / `isError` of a finished item, as a tool-result. */
function itemResult(item: any): { content: string; isError: boolean } {
  const failed = item?.status === 'failed' || !!item?.error;
  switch (item?.type) {
    case 'mcp_tool_call':
      // Codex has no `is_error` flag on the result — `status:"failed"` plus an
      // `error.message` is the whole signal (a tool timeout arrives this way:
      // "timed out awaiting tools/call after 15s").
      return failed
        ? { content: String(item.error?.message || 'tool call failed'), isError: true }
        : { content: textOfContent(item.result?.content ?? item.result ?? ''), isError: false };
    case 'command_execution': {
      const code = item.exit_code;
      return {
        content: String(item.aggregated_output ?? ''),
        isError: failed || (typeof code === 'number' && code !== 0),
      };
    }
    case 'file_change': {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      // `--json` carries only {path, kind} per change, never the patch itself —
      // unlike claude's Edit tool_use, which carries the full new content.
      return { content: changes.map((c: any) => `${c.kind}: ${c.path}`).join('\n') || 'no changes', isError: failed };
    }
    default:
      return { content: JSON.stringify(item ?? {}), isError: failed };
  }
}

/**
 * A blocking arigami tool that codex GAVE UP on leaves the host still waiting:
 * the card in the cockpit stays live for SCREEN_REQUEST_TIMEOUT_MS (30 minutes)
 * with nobody behind it, because the host's timer knows nothing about codex's.
 * The generic close handler reaps this when the process exits — but a turn can
 * run for minutes after a tool gave up, and a card the model already stopped
 * waiting for must not keep asking the human to act. So close it here, the
 * moment the failed result lands.
 */
function reapGivenUpHostTool(id: string, tool: string | null): void {
  if (tool === 'request_screen') expirePendingScreenRequests(id, 'codex gave up on the tool call (tool_timeout_sec)');
  else if (tool === 'permission_prompt') expirePendingPermissions(id, 'codex gave up on the tool call (tool_timeout_sec)');
}

function emitToolUse(id: string, item: any, st: CodexSessionState): ItemState {
  const meta = describeItem(item);
  st.items.set(String(item.id), meta);
  // arigami's own tools drive the UI directly (a status badge, an action card,
  // a tab) — echoing the raw call and its JSON result would show the same thing
  // twice, exactly as it would for claude, so both halves are suppressed.
  if (!meta.host) appendChat(id, { kind: 'tool-use', toolUseId: String(item.id), name: meta.name, input: itemInput(item) });
  return meta;
}

function codexHandleEvent(id: string, raw: unknown): void {
  const j = raw as any;
  const st = stateOf(id);
  switch (j?.type) {
    case 'thread.started': {
      // The id is OBSERVED, not assigned: this is the only place arigami learns
      // which codex thread this session is, and storing it is what makes the
      // next turn a `codex exec resume` instead of a brand-new conversation.
      const threadId = codexDriver.sessionId.mode === 'observed' ? codexDriver.sessionId.from(j) : null;
      if (threadId) setClaude(id, { sessionId: threadId });
      st.items.clear();
      st.errs.clear();
      break;
    }
    case 'turn.started':
      st.turnStartedAt = Date.now();
      st.errs.clear();
      break;
    case 'item.started': {
      const item = j.item;
      if (!item?.id) break;
      // Emitted the moment the call starts, NOT when it finishes: a blocking
      // host tool can sit `in_progress` for minutes (measured: request_screen
      // opened at +11.9s, answered at +50.3s), and the cockpit must show the
      // call bubble while the human is being asked, not after.
      if (item.type === 'agent_message' || item.type === 'reasoning' || item.type === 'error') break;
      emitToolUse(id, item, st);
      break;
    }
    case 'item.completed': {
      const item = j.item;
      if (!item) break;
      switch (item.type) {
        case 'agent_message':
          if (item.text) appendChat(id, { kind: 'assistant-text', text: String(item.text) });
          break;
        case 'reasoning':
          // NOT VERIFIED: no live run ever produced a `reasoning` item, even
          // with model_reasoning_summary="detailed" and effort high (the usage
          // block did report reasoning_output_tokens > 0, so the model reasons —
          // it just isn't surfaced on the `exec --json` stream). Handled the
          // obvious way rather than left to fall through as JSON; treat this
          // branch as unproven until a fixture shows it.
          if (item.text || item.summary)
            appendChat(id, { kind: 'thinking', text: String(item.text || item.summary) });
          break;
        case 'error':
          appendChat(id, { kind: 'error', text: String(item.message || 'codex error'), isError: true });
          break;
        default: {
          // Codex packs the call AND its result into one `item.completed`; the
          // two are separate kinds here, so the started/completed pair is what
          // gets correlated — and an item we never saw start still has to
          // produce its call bubble before its result.
          const meta = st.items.get(String(item.id)) || emitToolUse(id, item, st);
          st.items.delete(String(item.id));
          const { content, isError } = itemResult(item);
          if (meta.server) noteMcpResult(id, meta.server, { content, is_error: isError });
          if (meta.host) {
            if (isError) reapGivenUpHostTool(id, meta.tool);
            break; // suppressed, like claude's mcp__arigami__* results
          }
          appendChat(id, { kind: 'tool-result', toolUseId: String(item.id), content, isError });
          break;
        }
      }
      break;
    }
    case 'turn.completed': {
      const u = j.usage || {};
      // Codex's usage field names are its own; map them onto the ones the
      // context meter and the A3 ledger already speak.
      const mapped = {
        input_tokens: u.input_tokens || 0,
        output_tokens: u.output_tokens || 0,
        cache_read_input_tokens: u.cached_input_tokens || 0,
        cache_creation_input_tokens: u.cache_write_input_tokens || 0,
      };
      updateUsage(id, mapped);
      noteTurnUsage(id, mapped);
      const durationMs = st.turnStartedAt ? Date.now() - st.turnStartedAt : undefined;
      setClaude(id, { state: 'idle' });
      // The turn's own text already landed as assistant-text; this event is the
      // footer (duration, tokens), so it carries no text of its own.
      appendChat(id, { kind: 'result', text: '', isError: false, durationMs });
      // costUsd is not reported by codex at all — the ledger records tokens only.
      recordTurn(id, { duration_ms: durationMs, total_cost_usd: 0 });
      onTurnEnd(id);
      break;
    }
    case 'turn.failed': {
      const text = String(j.error?.message || 'codex turn failed');
      setClaude(id, { state: 'idle' });
      // A failing turn usually ends with the SAME message twice: once as the
      // last top-level `error` event and once as turn.failed's `error.message`
      // (verified on the 401 fixture). Say it once.
      if (!st.errs.has(text)) {
        st.errs.add(text);
        appendChat(id, { kind: 'error', text, isError: true });
      }
      // NOTE: the process still exits 0 on a failed turn (measured on a 401
      // run) — the exit code says nothing, only this event does.
      onTurnEnd(id);
      break;
    }
    case 'error': {
      // Top-level (not item-level) errors are transport chatter — a 401 run
      // produced ten near-identical "Reconnecting... N/5" lines. Surfacing each
      // one floods the transcript with something the human can't act on, and
      // the real failure arrives right after as `turn.failed`. So: drop the
      // retry noise, surface anything else once per turn.
      const msg = String(j.message || '');
      if (/^Reconnecting\.\.\./.test(msg)) {
        console.warn(`[codex] ${id}: ${msg}`);
        break;
      }
      if (!msg || st.errs.has(msg)) break;
      st.errs.add(msg);
      appendChat(id, { kind: 'error', text: msg, isError: true });
      break;
    }
    default:
      break;
  }
}

/** The bookkeeping claude does on its `result` event — kept identical on purpose. */
function onTurnEnd(id: string): void {
  import('./listeners.js').then((m) => m.onSessionIdle(id)).catch(() => {});
  import('./host-control.js').then((m) => m.restarts.onSessionIdle()).catch(() => {});
  import('./claude.js')
    .then((m: any) => {
      try { m.kickAutoPlay(id); } catch { /* queued prompts are best-effort */ }
      const cur = getSession(id);
      if (cur?.statusSummary?.autoUpdate && !cur.summarizing) {
        try { m.summarizeSession(id, { full: false }); } catch (e) { console.error('[summary] auto failed:', (e as Error)?.message || e); }
      }
    })
    .catch(() => {});
}

// ---- the driver ------------------------------------------------------------

const codexDriver: EngineDriver = {
  id: 'codex',
  prepare: codexPrepare,
  buildSpawn: codexBuildSpawn,
  handleEvent: codexHandleEvent,
  writeMessage: codexWriteMessage,
  // No handshake: codex has nothing to say before the first turn, and its stdin
  // IS the prompt — anything written here would be prepended to it. Its absence
  // also tells the generic path the process is usable the moment it spawns.
  interrupt: (proc: any) => {
    // stdin is already at EOF while a turn runs, so there is no protocol to
    // interrupt over. Signal the process; the close handler does the rest.
    try { proc.child.kill('SIGINT'); } catch { /* already gone */ }
  },
  sessionId: {
    mode: 'observed',
    from: (rawEvent: unknown) => {
      const j = rawEvent as any;
      return j?.type === 'thread.started' && typeof j.thread_id === 'string' ? j.thread_id : null;
    },
  },
  permissions: { kind: 'none' },
  injectMcp: codexInjectMcp,
  modelArgs: codexModelArgs,
};

registerEngine(codexDriver);

// Exported for the tests, which drive the pure pieces against the recorded
// fixtures in test/fixtures/codex-stream/ without spawning anything.
export { codexDriver, codexPrepare, codexBuildSpawn, codexHandleEvent, codexModelArgs, flatToolName, mcpTables, TOOL_TIMEOUT_SEC };

/**
 * The models codex actually offers. There is no live handshake for this the way
 * claude has one — `~/.codex/models_cache.json` is a background-refreshed local
 * cache, so read it when it's there and fall back to what was seen on
 * 0.153.4 when it isn't. `visibility: "hide"` rows (gpt-reserve,
 * codex-auto-review) are internal and deliberately not offered.
 */
export function codexModels(): { id: string; name: string }[] {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(realCodexHome(), 'models_cache.json'), 'utf8'));
    const rows: any[] = Array.isArray(raw) ? raw : Array.isArray(raw?.models) ? raw.models : [];
    const out = rows
      .filter((m) => m && typeof m.id === 'string' && m.visibility !== 'hide')
      .map((m) => ({ id: String(m.id), name: String(m.display_name || m.name || m.id) }));
    if (out.length) return out;
  } catch {
    /* no cache yet — fall through */
  }
  return [
    { id: 'gpt-5.6-terra', name: 'GPT-5.6-Terra' },
    { id: 'gpt-5.6-luna', name: 'GPT-5.6-Luna' },
    { id: 'gpt-5.5', name: 'GPT-5.5' },
  ];
}

// Deliberately NOT used: `codex queue --thread <id> --message <t>` exists and
// works (a queued message is consumed by the NEXT resume, no live daemon
// needed), but nothing wakes the thread on its own, so a queued message can sit
// unanswered indefinitely. writeMessage()'s carry-over delivers the same
// message as a real turn instead. Noted here so the next person doesn't
// rediscover `queue` and assume it is the missing piece.
