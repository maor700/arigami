// The Antigravity CLI (`agy`) behind the `gemini` engine: where it is, whether it is signed in, and the pure
// mappings the driver (server/gemini-acp.ts) uses. Verified against agy 1.5.14 — docs/ENGINES.md.
import fs from 'node:fs';
import path from 'node:path';
import { which, extraBinDirs, HOME } from './platform.js';

export const AGY_MISSING =
  'the Gemini engine needs the Antigravity CLI (`agy`) and it is not installed on this host — install it, sign in once by running `agy`, and try again';
export const AGY_SIGNED_OUT = 'the Antigravity CLI (`agy`) is not signed in on this host — run `agy` once in a terminal and log in with Google';

export function findAgy(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.ARIGAMI_AGY_BIN) return env.ARIGAMI_AGY_BIN;
  return which('agy', [path.join(HOME, '.local', 'bin'), ...extraBinDirs()], env);
}

/** The agy binary, or a loud error naming what is missing. */
export function requireAgy(env: NodeJS.ProcessEnv = process.env): string {
  const bin = findAgy(env);
  if (!bin || (path.isAbsolute(bin) && !fs.existsSync(bin))) throw new Error(AGY_MISSING);
  return bin;
}

/** A gemini home other than ~/.gemini: ARIGAMI_GEMINI_HOME (ARIGAMI_GEMINI_DIR is the same knob), or null. */
export function geminiHomeOverride(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.ARIGAMI_GEMINI_HOME || env.ARIGAMI_GEMINI_DIR || null;
}

/** agy's own Google login (it refreshes the file itself; never read into a log). */
export function agyTokenFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(geminiHomeOverride(env) || path.join(HOME, '.gemini'), 'antigravity-cli', 'antigravity-oauth-token');
}

/** `agy acp` argv; an overridden gemini home goes as --gemini-dir (only the acp subcommand takes it — measured). */
export function agyAcpArgs(env: NodeJS.ProcessEnv = process.env, extra: string[] = []): string[] {
  const home = geminiHomeOverride(env);
  return ['acp', ...(home ? ['--gemini-dir', home] : []), ...extra];
}

export function agyLoggedIn(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    return fs.statSync(agyTokenFile(env)).size > 0;
  } catch {
    return false;
  }
}

/** Can a gemini session start here: the CLI is installed and signed in. */
export function geminiReady(env: NodeJS.ProcessEnv = process.env): boolean {
  const bin = findAgy(env);
  return !!bin && (!path.isAbsolute(bin) || fs.existsSync(bin)) && agyLoggedIn(env);
}

// ---- models ---------------------------------------------------------------------

/** Effort is the tail of an ACP model id (gemini-4-neon-high); there is no separate effort setting. */
export const GEMINI_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
/** What a session with no pick runs on (the cockpit shows the same): Neon at high. */
export const GEMINI_DEFAULT_MODEL = 'gemini-4-neon';
export const GEMINI_DEFAULT_EFFORT = 'high';
const EFFORT_TAIL = new RegExp(`-(${GEMINI_EFFORTS.join('|')})$`);

export interface AcpModel {
  modelId: string;
  name?: string;
}

/** One picker row: a model family with the effort levels it is offered at (same shape as a codex row). */
export interface GeminiModelRow {
  id: string;
  name: string;
  desc: string;
  efforts: string[];
  defaultEffort: string | null;
  contextWindow: number | null;
}

/** gemini-4-neon-high → { family: 'gemini-4-neon', effort: 'high' }; an id with no effort tail is its own family. */
export function splitModelId(id: string): { family: string; effort: string | null } {
  const m = EFFORT_TAIL.exec(id);
  return m ? { family: id.slice(0, m.index), effort: m[1] } : { family: id, effort: null };
}

const byEffort = (a: string, b: string) => GEMINI_EFFORTS.indexOf(a as any) - GEMINI_EFFORTS.indexOf(b as any);

/** Pure: ACP `availableModels` → one row per family, each defaulting to high. */
export function modelRows(available: AcpModel[], contextWindow: number | null = null): GeminiModelRow[] {
  const rows = new Map<string, GeminiModelRow>();
  for (const m of available || []) {
    if (!m || typeof m.modelId !== 'string') continue;
    const { family, effort } = splitModelId(m.modelId);
    let row = rows.get(family);
    if (!row) {
      const name = String(m.name || family).replace(/\s*\((?:Low|Medium|High|XHigh|Extra|Max)\)\s*$/i, '');
      rows.set(family, (row = { id: family, name, desc: '', efforts: [], defaultEffort: null, contextWindow }));
    }
    if (effort && !row.efforts.includes(effort)) row.efforts.push(effort);
  }
  for (const row of rows.values()) {
    row.efforts.sort(byEffort);
    row.defaultEffort = pickEffort(row.efforts);
  }
  return [...rows.values()];
}

/** Pure: the rows the cockpit's picker offers — Gemini families that have effort levels (no Orchestrator, no Claude/GPT through Google). */
export function pickerRows(rows: GeminiModelRow[]): GeminiModelRow[] {
  return (rows || []).filter((r) => r.id.startsWith('gemini-') && r.efforts.length > 0);
}

/** The level a family runs at when none was asked for: high, else the middle one. */
function pickEffort(efforts: string[]): string | null {
  if (!efforts.length) return null;
  if (efforts.includes(GEMINI_DEFAULT_EFFORT)) return GEMINI_DEFAULT_EFFORT;
  return efforts[Math.floor((efforts.length - 1) / 2)];
}

/** Pure: a family's levels when agy has not listed any yet — Neon and Hydrogen go up to xhigh, the rest to high. */
export function fallbackEfforts(model: string | null | undefined): string[] {
  const family = splitModelId(model || GEMINI_DEFAULT_MODEL).family;
  return /-(neon|hydrogen)$/.test(family) ? ['low', 'medium', 'high', 'xhigh'] : ['low', 'medium', 'high'];
}

export interface ModelPick {
  /** the ACP model id to set; null = leave the agent on its current model */
  id: string | null;
  /** why the asked-for model/effort could not be used (shown in the chat) */
  error?: string;
}

/** Pure: Arigami's model (a family like gemini-4-neon, or a full id; none = Neon) + effort (none = high) → the ACP model id, validated against the account's list; an explicit effort wins over the id's tail. */
export function resolveModelId(model: string | null | undefined, effort: string | null | undefined, available: AcpModel[], current?: string | null): ModelPick {
  const ids = (available || []).map((m) => m?.modelId).filter((x): x is string => typeof x === 'string');
  const want = model && model !== 'default' ? String(model) : null;
  const level = effort && effort !== 'default' ? String(effort) : null;
  if (!ids.length) return want || level ? { id: null, error: 'Antigravity reported no models for this account' } : { id: null };
  const split = ids.map(splitModelId);
  const families = [...new Set(split.map((x) => x.family))];
  let family: string | null = null;
  let tail: string | null = null;
  if (want) {
    const sp = splitModelId(want);
    if (families.includes(want)) family = want;
    else if (families.includes(sp.family)) [family, tail] = [sp.family, sp.effort];
    if (!family) return { id: null, error: `model "${want}" is not offered by Antigravity for this account (offered: ${families.join(', ')})` };
  } else {
    // no pick: Neon when the account has it, else whatever agy is on
    family = families.includes(GEMINI_DEFAULT_MODEL) ? GEMINI_DEFAULT_MODEL : splitModelId(current || '').family;
    if (!families.includes(family)) return level ? { id: null, error: `effort "${level}" needs a model — none is selected` } : { id: null };
  }
  const efforts = split.filter((x) => x.family === family && x.effort).map((x) => x.effort as string).sort(byEffort);
  if (!efforts.length) return { id: family, ...(level ? { error: `${family} has no effort levels — "${level}" ignored` } : {}) };
  const asked = level || tail;
  if (asked && efforts.includes(asked)) return { id: `${family}-${asked}` };
  const fallback = pickEffort(efforts);
  return { id: `${family}-${fallback}`, ...(asked ? { error: `${family} is not offered at effort "${asked}" (offered: ${efforts.join(', ')}) — using ${fallback}` } : {}) };
}

/** Pure: the model a host utility runs on when none is named — the flash family at its lowest effort, else agy's default (null). */
export function utilityModel(rows: GeminiModelRow[]): string | null {
  const row = (rows || []).find((r) => /flash/i.test(r.id));
  return row ? (row.efforts.length ? `${row.id}-${row.efforts[0]}` : row.id) : null;
}

/** Pure: the effort levels a model family (none = Neon) is offered at. */
export function effortsFor(model: string | null | undefined, available: AcpModel[]): string[] {
  const family = splitModelId(model || GEMINI_DEFAULT_MODEL).family;
  const out = (available || []).map((m) => splitModelId(m.modelId)).filter((x) => x.family === family && x.effort).map((x) => x.effort as string);
  return [...new Set(out)].sort(byEffort);
}

// ---- MCP ------------------------------------------------------------------------

export type AcpMcpServer =
  | { type: 'http' | 'sse'; name: string; url: string; headers: Array<{ name: string; value: string }> }
  | { name: string; command: string; args: string[]; env: Array<{ name: string; value: string }> };

/** Pure: Claude-shaped `mcpServers` entries → ACP's array; `${VAR}` in a header is expanded from `vars` (agy expands nothing). */
export function acpMcpServers(servers: Record<string, any>, vars: Record<string, string>, stdioEnv: Record<string, string> = {}): AcpMcpServer[] {
  const expand = (v: unknown) => String(v ?? '').replace(/\$\{([A-Z0-9_]+)\}/g, (m, k) => (k in vars ? vars[k] : m));
  const out: AcpMcpServer[] = [];
  for (const [name, sv] of Object.entries(servers || {})) {
    if (!sv || typeof sv !== 'object') continue;
    if (typeof sv.url === 'string') {
      const headers = Object.entries(sv.headers && typeof sv.headers === 'object' ? sv.headers : {}).map(([k, v]) => ({ name: k, value: expand(v) }));
      out.push({ type: sv.type === 'sse' ? 'sse' : 'http', name, url: sv.url, headers });
    } else if (typeof sv.command === 'string') {
      const env = { ...stdioEnv, ...(sv.env && typeof sv.env === 'object' ? sv.env : {}) };
      out.push({ name, command: sv.command, args: Array.isArray(sv.args) ? sv.args.map(String) : [], env: Object.entries(env).map(([k, v]) => ({ name: k, value: String(v) })) });
    }
  }
  return out;
}

// ---- tool names ---------------------------------------------------------------------

/** agy's built-ins → the Claude built-in with the same power (agent-policy and the tool cards speak Claude's names). */
export const AGY_BUILTIN_ALIASES: Record<string, string> = {
  run_command: 'Bash',
  send_command_input: 'Bash',
  command_status: 'BashOutput',
  write_file: 'Write',
  write_to_file: 'Write',
  replace_file_content: 'Edit',
  multi_replace_file_content: 'Edit',
  sed_file: 'Edit',
  notebook_edit: 'NotebookEdit',
  read_file: 'Read',
  view_file: 'Read',
  list_dir: 'Glob',
  find_by_name: 'Glob',
  grep_search: 'Grep',
  read_url_content: 'WebFetch',
  open_browser_url: 'WebFetch',
  search_web: 'WebSearch',
  invoke_subagent: 'Agent',
  browser_subagent: 'Agent',
  run_workflow: 'Agent',
  schedule: 'CronCreate',
};

const KIND_ALIASES: Record<string, string> = { execute: 'Bash', edit: 'Edit', delete: 'Edit', move: 'Edit', read: 'Read', search: 'Grep', fetch: 'WebFetch' };

export interface ToolName {
  /** the name policy and cards use: mcp__<server>__<tool>, a Claude built-in, or agy's own */
  name: string;
  server: string | null;
  tool: string | null;
}

/** Pure: an ACP tool name → Arigami's; agy's mcp_<server>_<tool> is split on the server names this session was spawned with (longest first). */
export function aliasToolName(raw: string, servers: string[] = [], kind?: string | null): ToolName {
  const name = String(raw || '');
  if (name.startsWith('mcp_') && !name.startsWith('mcp__')) {
    const rest = name.slice(4);
    const known = [...servers].sort((a, b) => b.length - a.length).find((s) => rest.startsWith(s + '_') && rest.length > s.length + 1);
    const server = known || rest.slice(0, Math.max(0, rest.indexOf('_'))) || rest;
    const tool = rest.slice(server.length + 1);
    return { name: `mcp__${server}__${tool}`, server, tool };
  }
  if (name.startsWith('mcp__')) {
    const rest = name.slice(5);
    const i = rest.indexOf('__');
    return { name, server: i < 0 ? rest : rest.slice(0, i), tool: i < 0 ? '' : rest.slice(i + 2) };
  }
  return { name: AGY_BUILTIN_ALIASES[name] || (name ? name : KIND_ALIASES[String(kind || '')] || 'tool'), server: null, tool: null };
}

/** Pure: the tool-use `input` in Claude's field names where a card reads them; agy's own `toolSummary` is dropped. */
export function toolInput(name: string, rawInput: any): Record<string, unknown> {
  const { toolSummary: _s, ...raw } = rawInput && typeof rawInput === 'object' ? rawInput : ({} as any);
  const file = raw.Path ?? raw.TargetFile ?? raw.AbsolutePath ?? raw.path;
  switch (name) {
    case 'Bash':
      return typeof raw.CommandLine === 'string' ? { command: raw.CommandLine, ...(raw.Cwd ? { cwd: raw.Cwd } : {}) } : raw;
    case 'Write':
      return file ? { file_path: file, content: raw.Content ?? raw.CodeContent ?? '' } : raw;
    case 'Read':
    case 'Edit':
      return file ? { ...raw, file_path: file } : raw;
    default:
      return raw;
  }
}

/** Pure: agy wraps a command's output in a status header — keep the output, plus the exit code when it is not 0. */
export function commandOutput(text: string): string {
  const m = /^Created At:[^\n]*\n(?:Completed At:[^\n]*\n)?Command exited with code (-?\d+)\.\n\nCommand output:\n([\s\S]*)$/.exec(String(text || ''));
  if (!m) return text;
  const out = m[2].replace(/\r\n/g, '\n');
  return m[1] === '0' ? out : `${out}${!out || out.endsWith('\n') ? '' : '\n'}(exit code ${m[1]})`;
}

// ---- skills -----------------------------------------------------------------------

const SKILL_CMD = /^\/(arigami|arigami-user|arigami-ext):([a-z0-9][a-z0-9-]*)(?:\s+([\s\S]*))?$/;

/** Pure: `/arigami:<skill> args` → an instruction to read that SKILL.md (agy has no plugin dirs); anything else unchanged. */
export function skillPrompt(text: string, roots: Record<string, string | null | undefined>, exists: (p: string) => boolean = fs.existsSync): string {
  const m = SKILL_CMD.exec(String(text || '').trim());
  const root = m && roots[m[1]];
  if (!m || !root) return text;
  const file = path.join(root, m[2], 'SKILL.md');
  if (!exists(file)) return text;
  return `Run the Arigami skill "${m[2]}": read ${file} first and follow it exactly.${m[3]?.trim() ? `\n\n${m[3].trim()}` : ''}`;
}

/** The system-prompt line that tells the agent where Arigami's skills are. */
export function skillsNote(roots: Record<string, string | null | undefined>): string {
  const dirs = Object.entries(roots).filter(([, d]) => d).map(([k, d]) => `/${k}:<name> → ${d}/<name>/SKILL.md`);
  return dirs.length ? `<system-reminder>\nArigami skills are files, not slash commands, on this engine: when asked to run a skill, read its SKILL.md and follow it (${dirs.join('; ')}).\n</system-reminder>\n\n` : '';
}

// ---- print mode (one-shots) ---------------------------------------------------------

/** Pure: `agy -p --output-format json` stdout → the response text; throws agy's own error on status ERROR. */
export function parseAgyPrint(stdout: string): string {
  const line = String(stdout || '').trim().split('\n').filter((l) => l.trim().startsWith('{')).pop() || '';
  let j: any;
  try { j = JSON.parse(line); } catch { return String(stdout || ''); }
  if (j?.status === 'ERROR' || j?.error) throw new Error(String(j.error || 'agy reported an error').replace(/^Error:\s*/, ''));
  return typeof j?.response === 'string' ? j.response : '';
}

/** Pure: the print-mode model id — a full gemini id as is, a family + effort joined, anything else left to agy's default. */
export function agyPrintModel(model?: string, effort?: string): string | null {
  if (!model || !/^gemini-[a-z0-9.-]+$/.test(model)) return null;
  return effort && !/-(low|medium|high|xhigh|max)$/.test(model) ? `${model}-${effort}` : model;
}
