// PROMPT1: the instruction blocks the host puts in front of a session's messages, as one registry the owner can edit
// (docs/INSTRUCTIONS-AND-VAULT.md, phase 1). Each built-in block has a default text here; a file
// `<ARIGAMI_DIR>/user/prompts/<id>.md` replaces it (front-matter `enabled: false` turns it off), and
// `<ARIGAMI_DIR>/user/prompts/custom/<name>.md` adds a block of the owner's own. The user repo versions them; a missing
// file is the default, so Arigami updates keep improving the blocks nobody touched.
//
// Blocks are guidance for the model. What matters is enforced in code whatever they say (outbound cards, the login
// card's session-token 403, humanGate on password fields, sign_in's ladder and vault-fill guard, A3 domains) — editing
// a block can't switch that off.
//
// Persona and memory are not here: they are data, edited where they live (the agent page, Memory).
import fs from 'node:fs';
import path from 'node:path';
import { ARIGAMI_DIR } from './lib/instance.js';

export type When = 'first-turn' | 'every-turn';
export type Engine = 'claude' | 'codex';

export interface BuiltinBlock {
  id: string;
  title: string;
  description: string;
  when: When;
  guardrail?: boolean; // a block whose rules the owner should think twice about turning off
  vars?: string[]; // {{name}} placeholders the text may use
  text: string; // the default
}

/** What a block's text is rendered with. Every field is optional: a missing value renders as empty. */
export interface RenderCtx {
  engine?: Engine;
  sharedDisplay?: string;
  capabilities?: string;
  extensions?: string;
  docker?: boolean;
  simpleMode?: boolean;
}

export const PROMPTS_DIR = (): string => path.join(ARIGAMI_DIR, 'user', 'prompts');
const CUSTOM_DIR = (): string => path.join(PROMPTS_DIR(), 'custom');
const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

// The built-ins, in the order they are sent. Texts moved here verbatim from server/claude.js and mcp/host-mcp.js.
export const BUILTIN: BuiltinBlock[] = [
  {
    id: 'links',
    title: 'Links',
    description: 'How to show the human anything: artifacts and tabs, never localhost URLs.',
    when: 'first-turn',
    text:
      'Arigami links: to show the human anything, call publish_artifact (static file/dir → /__artifacts/<id>/) or ' +
      'open_tab (a LIVE dev server — pass http://localhost:$PORT, the host proxies it into a cockpit tab). ' +
      'Never write http://localhost:… URLs in replies, reports, pushes or messages: the human may be on a phone or ' +
      'another machine. The host returns host-RELATIVE paths (/__host/?session=…, /__artifacts/…) — pass them on as-is. ' +
      '$ARIGAMI_URL is an internal base for your own API calls only, not a link for people. ' +
      'Need a port for a dev server? call allocate_port (or set_metadata({patch:{needs_server:true}})) and use $PORT / the returned port.',
  },
  {
    id: 'login',
    title: 'Signing in',
    description: 'One tool for every sign-in (sign_in): the host runs the order — connection, saved login, the owner\'s own Chrome — in code.',
    when: 'first-turn',
    guardrail: true,
    vars: [],
    text:
      'Signing in anywhere (a site, a service, gcloud): call sign_in({site, reason}) and do what its answer says — the host picks the way in.\n' +
      'Never type or ask for a password, 2FA code or token yourself: sign_in({site, fill}) has the host type it from the vault. What the human writes in the chat themselves and asks you to enter, you enter.\n' +
      'If sign_in answers blocked, stop and report its one reason to the human.',
  },
  {
    id: 'host-rules',
    title: 'Host rules',
    description: 'Scratch files, outbound messages as cards, and teardown.',
    when: 'first-turn',
    guardrail: true,
    text:
      "Temporary files go under $TMPDIR — it is this session's own scratch directory and the host deletes it with the session. " +
      'Do not write to /tmp directly: nothing owns files there, so they outlive you.\n' +
      "Nothing you send to a person leaves on your call: WhatsApp messages, Slack messages, emails and comments through Arigami's " +
      'tools become a card with your exact text, and the host sends them only when the owner presses Send. Write the final text, ' +
      'then stop and wait for the "[host] …" outcome. Never look for another way to send.\n' +
      "Teardown is the host's job. delete_session stops every process this session started (detached ones included) and removes " +
      'the worktree it owns unless it holds unpushed work. Do not rm -rf, git worktree remove, or kill things yourself as "cleanup".',
  },
  {
    id: 'container',
    title: 'Container',
    description: 'Only on a container host (Docker / Kubernetes): sudo works, but only apt installs and $HOME survive a restart.',
    when: 'first-turn',
    text:
      'This host runs in a container where you have passwordless sudo. Its root filesystem resets on restart, except that packages ' +
      'installed with `sudo apt-get install` (after `sudo apt-get update`) are kept on the volume and reinstalled at start. Anything ' +
      'else installed outside $HOME is lost — for those, install per user: `pip install --user <pkg>` or `python3 -m venv`, ' +
      '`npm i -g --prefix ~/.local <pkg>`, or a static binary into ~/.local/bin (first on PATH, persistent).',
  },
  {
    id: 'identity',
    title: 'Identity',
    description: "Who the agent is and what it can do here; the connectable services and installed extensions are filled in.",
    when: 'first-turn',
    vars: ['capabilities', 'extensions'],
    text:
      "You are the agent inside Arigami — the human's self-hosted cockpit (this session is one of its sessions). " +
      'Introduce yourself as Arigami\'s agent, not by the name of the CLI/model behind you ("Claude", "Codex"); ' +
      'answer in the language the human writes in. ' +
      "What you can do here: browse and screenshot websites on this session's own desktop (open the browser, capture_screen, publish_artifact); " +
      'read and send WhatsApp (the `whatsapp` tool); read mail/calendar/drive and other providers through Composio once connected; ' +
      'work on git repos (clone into the workspace, worktrees, review, merge); spawn child sessions for parallel work; ' +
      'react to triggers (WhatsApp/Slack/Linear/webhooks/cron) via register_listener; keep a memory across sessions; ' +
      'sign in to sites and CLIs (sign_in: in the human\'s own Chrome, the host typing passwords from their vault — you never see one); ' +
      'and hand the desktop over to the human (request_screen) for a CAPTCHA, a payment or an approval on their phone. ' +
      'When the human greets you or asks what you can do, give a short, concrete menu of these (3 suggested actions), in their language.\n' +
      '\n{{capabilities}}\n\n{{extensions}}',
  },
  {
    id: 'simple-mode',
    title: 'Simple chat mode',
    description: 'Sent with every message while a session is in the Simple view: answer in at most two sentences.',
    when: 'every-turn',
    text:
      'Simple chat mode is ON for this session: the human switched the cockpit to the "Simple" view, where only ' +
      'your prose reaches them — tool calls, edits, bash output and thinking are folded away behind a counter. ' +
      'Hard rule for what you write to the human in this chat: at most two sentences by default — the outcome and the one ' +
      'thing that matters. Details only when asked. No headers, tables, bullet lists, code dumps or step-by-step narration ' +
      'of what you did. Bad news is said first and plainly. This is a per-session rule and overrides longer-form formatting ' +
      'guidance from anywhere else. It limits only what you write to the human — not your tool use or the work itself.',
  },
];

// ---- files ----------------------------------------------------------------------------------------------------------

interface Parsed { meta: Record<string, string>; body: string }

/** `---\nkey: value\n---\n` front-matter + body. No front-matter → all body. */
export function parseFile(text: string): Parsed {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^\s*([A-Za-z][\w-]*)\s*:\s*(.*?)\s*$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
  }
  return { meta, body: m[2] };
}

function formatFile(meta: Record<string, string | undefined>, body: string): string {
  const lines = Object.entries(meta).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}: ${v}`);
  return lines.length ? `---\n${lines.join('\n')}\n---\n${body}` : body;
}

const readOr = (p: string): string | null => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const isOff = (v: string | undefined): boolean => v !== undefined && /^(false|no|off|0)$/i.test(v);

export interface BlockView {
  id: string;
  title: string;
  description: string;
  when: When;
  engines: Engine[] | null; // null = all
  builtin: boolean;
  guardrail: boolean;
  vars: string[];
  enabled: boolean;
  edited: boolean; // a built-in with a file of the owner's (text or enabled)
  defaultText: string | null; // built-ins only
  text: string; // what is sent (before {{vars}})
}

function engineList(v: string | undefined): Engine[] | null {
  if (!v) return null;
  const list = v.split(/[\s,]+/).filter((e): e is Engine => e === 'claude' || e === 'codex');
  return list.length ? list : null;
}

/** Every block: built-ins (with the owner's override, if any) in their order, then the owner's own, by name. */
export function listBlocks(): BlockView[] {
  const out: BlockView[] = BUILTIN.map((b) => {
    const raw = readOr(path.join(PROMPTS_DIR(), `${b.id}.md`));
    const f = raw === null ? null : parseFile(raw);
    const body = f && f.body.trim() ? f.body.replace(/\s+$/, '') : null;
    return {
      id: b.id, title: b.title, description: b.description, when: b.when, engines: null, builtin: true,
      guardrail: !!b.guardrail, vars: b.vars || [],
      enabled: !(f && isOff(f.meta.enabled)),
      edited: raw !== null,
      defaultText: b.text,
      text: body ?? b.text,
    };
  });
  let names: string[] = [];
  try { names = fs.readdirSync(CUSTOM_DIR()).filter((n) => n.endsWith('.md')).sort(); } catch { /* none */ }
  for (const n of names) {
    const id = n.slice(0, -3);
    if (!ID_RE.test(id)) continue;
    const f = parseFile(readOr(path.join(CUSTOM_DIR(), n)) || '');
    out.push({
      id, title: f.meta.title || id, description: '', when: f.meta.when === 'every-turn' ? 'every-turn' : 'first-turn',
      engines: engineList(f.meta.engines), builtin: false, guardrail: false, vars: [],
      enabled: !isOff(f.meta.enabled), edited: true, defaultText: null, text: f.body.replace(/\s+$/, ''),
    });
  }
  return out;
}

/** Fill {{vars}}; an empty value takes its blank line with it. */
export function fill(text: string, ctx: RenderCtx): string {
  const vals: Record<string, string> = {
    sharedDisplay: ctx.sharedDisplay || ':99',
    capabilities: ctx.capabilities || '',
    extensions: ctx.extensions || '',
    engine: ctx.engine || '',
  };
  return text
    .replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (k in vals ? vals[k] : ''))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function applies(b: BlockView, when: When, ctx: RenderCtx): boolean {
  if (!b.enabled || b.when !== when) return false;
  if (b.engines && ctx.engine && !b.engines.includes(ctx.engine)) return false;
  if (b.id === 'container' && !ctx.docker) return false;
  if (b.id === 'simple-mode' && !ctx.simpleMode) return false;
  return true;
}

export const wrap = (text: string): string => (text ? `<system-reminder>\n${text}\n</system-reminder>\n\n` : '');

/**
 * The text for `when`, each block in its own <system-reminder>. First turn: the built-ins up to (not including)
 * `identity`, then the owner's own blocks, then `identity` — so the persona and memory the caller appends follow it.
 */
export function render(when: When, ctx: RenderCtx, blocks: BlockView[] = listBlocks()): string {
  const on = blocks.filter((b) => applies(b, when, ctx));
  const builtins = on.filter((b) => b.builtin);
  const custom = on.filter((b) => !b.builtin);
  const ordered = when === 'first-turn'
    ? [...builtins.filter((b) => b.id !== 'identity'), ...custom, ...builtins.filter((b) => b.id === 'identity')]
    : [...builtins, ...custom];
  return ordered.map((b) => wrap(fill(b.text, ctx))).join('');
}

/** One block, rendered alone (claude.js keeps identityReminder / SIMPLE_MODE_REMINDER as thin wrappers). */
export function renderOne(id: string, ctx: RenderCtx): string {
  const b = listBlocks().find((x) => x.id === id);
  if (!b || !b.enabled) return '';
  return wrap(fill(b.text, ctx));
}

// ---- edits (the API's) -----------------------------------------------------------------------------------------------

export class PromptError extends Error {}

/** Save an override of a built-in (text and/or enabled), or a custom block. A text equal to the default stores none. */
export function saveBlock(id: string, patch: { text?: string; enabled?: boolean; title?: string; when?: When; engines?: Engine[] | null }): BlockView {
  if (!ID_RE.test(id)) throw new PromptError('a block id is lowercase letters, digits and dashes');
  const builtin = BUILTIN.find((b) => b.id === id);
  const current = listBlocks().find((b) => b.id === id);
  const text = (patch.text ?? current?.text ?? '').replace(/\r\n/g, '\n').replace(/\s+$/, '');
  const enabled = patch.enabled ?? current?.enabled ?? true;
  if (builtin) {
    const file = path.join(PROMPTS_DIR(), `${id}.md`);
    if (enabled && text === builtin.text) {
      fs.rmSync(file, { force: true }); // back to the default: nothing of the owner's left
    } else {
      fs.mkdirSync(PROMPTS_DIR(), { recursive: true });
      fs.writeFileSync(file, formatFile({ enabled: enabled ? undefined : 'false' }, text === builtin.text ? '' : `${text}\n`));
    }
  } else {
    if (!text.trim()) throw new PromptError('a block of your own needs some text');
    fs.mkdirSync(CUSTOM_DIR(), { recursive: true });
    const when = patch.when ?? current?.when ?? 'first-turn';
    const engines = patch.engines === undefined ? current?.engines ?? null : patch.engines;
    fs.writeFileSync(path.join(CUSTOM_DIR(), `${id}.md`), formatFile({
      title: patch.title ?? current?.title ?? id,
      when,
      engines: engines?.length ? engines.join(', ') : undefined,
      enabled: enabled ? undefined : 'false',
    }, `${text}\n`));
  }
  return listBlocks().find((b) => b.id === id)!;
}

/** Reset a built-in to its default, or delete a block of the owner's own. */
export function resetBlock(id: string): void {
  if (!ID_RE.test(id)) throw new PromptError('bad block id');
  if (BUILTIN.some((b) => b.id === id)) fs.rmSync(path.join(PROMPTS_DIR(), `${id}.md`), { force: true });
  else fs.rmSync(path.join(CUSTOM_DIR(), `${id}.md`), { force: true });
}

// ---- layers: what an agent or a session inherits (phase 2) ----------------------------------------------------------
//
// Resolution, most specific last: Arigami default → the owner's override (above) → the agent's layer → the session's
// layer. A layer maps a block id to 'off', 'on', or its own text; a missing id inherits. An id that matches no block is
// a block of that layer's own (first turn unless it says otherwise).

export type LayerEntry = 'off' | 'on' | { text: string; when?: When; engines?: Engine[] };
export type Layer = Record<string, LayerEntry>;
export type LayerSource = 'default' | 'owner' | 'agent' | 'session';
export interface LayeredBlock extends BlockView { source: LayerSource }

const MAX_LAYER_TEXT = 20_000;

/** A layer as stored: unknown shapes dropped, ids checked, texts capped. Null when nothing is left. */
export function cleanLayer(input: unknown): Layer | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const out: Layer = {};
  for (const [id, v] of Object.entries(input as Record<string, unknown>)) {
    if (!ID_RE.test(id)) continue;
    if (v === 'off' || v === 'on') out[id] = v;
    else if (v && typeof v === 'object' && typeof (v as any).text === 'string' && (v as any).text.trim()) {
      const e: { text: string; when?: When; engines?: Engine[] } = { text: (v as any).text.replace(/\r\n/g, '\n').slice(0, MAX_LAYER_TEXT) };
      if ((v as any).when === 'every-turn' || (v as any).when === 'first-turn') e.when = (v as any).when;
      const engines = Array.isArray((v as any).engines) ? (v as any).engines.filter((x: unknown): x is Engine => x === 'claude' || x === 'codex') : [];
      if (engines.length) e.engines = engines;
      out[id] = e;
    }
  }
  return Object.keys(out).length ? out : null;
}

/** The blocks after the agent's and the session's layers, each marked with the layer that decided it. */
export function applyLayers(blocks: BlockView[], layers: { agent?: Layer | null; session?: Layer | null }): LayeredBlock[] {
  const out: LayeredBlock[] = blocks.map((b) => ({ ...b, source: b.builtin ? (b.edited ? 'owner' : 'default') : 'owner' }));
  for (const name of ['agent', 'session'] as const) {
    const layer = layers[name];
    if (!layer) continue;
    for (const [id, e] of Object.entries(layer)) {
      const b = out.find((x) => x.id === id);
      if (b) {
        if (e === 'off') Object.assign(b, { enabled: false, source: name });
        else if (e === 'on') Object.assign(b, { enabled: true, source: name });
        else Object.assign(b, { text: e.text, enabled: true, source: name, ...(e.when && !b.builtin ? { when: e.when } : {}), ...(e.engines ? { engines: e.engines } : {}) });
      } else if (typeof e === 'object') {
        out.push({
          id, title: id, description: '', when: e.when || 'first-turn', engines: e.engines || null, builtin: false, guardrail: false,
          vars: [], enabled: true, edited: true, defaultText: null, text: e.text, source: name,
        });
      }
    }
  }
  return out;
}
