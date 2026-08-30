// Agents ("צוות", PRD-ARIGAMI-AGENTS §1–§3 A1). An agent is WHO: a persistent
// identity a session can be born from — persona, referenced (shared) skills,
// its own memory namespace, default model, tool/domain allowlists and a budget.
// Sessions stay the unit of work (WHAT/WHEN): `create_session({agent})` inherits
// the agent's model/persona/skills and carries `metadata.agent = <slug>`; a
// session without an agent behaves exactly as before.
//
// Storage: $ARIGAMI_DIR/agents/<slug>/
//   agent.json   the record below (never secrets)
//   persona.md   ≤ ~20 lines "who you are + limits" — injected into the first
//                turn of every session born from the agent (see personaBlock)
//   memory/      MEMORY.md + journal/ — the agent's memory namespace
//                (memory.ts: scope 'agent:<slug>'; the agent sees USER.md + own)
//   assets/      brand/style references the session is told about (listed only)
//   browser/     the agent's persistent Chrome profile (A2, lib/chrome.ts) — never exported
//   identity.json the agent's own Google identity (A2, capabilities.ts) — no secrets
//
// No per-agent private skills (user decision): `skills` are NAMES of shared
// skills (shipped pack or $ARIGAMI_DIR/skills), validated to exist.
import fs from 'node:fs';
import path from 'node:path';
import { ARIGAMI_DIR } from './lib/instance.js';
import { cfg } from './lib/config.js';
import { broadcast } from './bus.js';
import { isSkillDir, NAME_RE as SKILL_NAME_RE } from './skills.js';
import { CORE_TOOLS, RESTRICTED_BUILTINS, policyOf, toolAllowed } from './agent-policy.js';

export const AGENTS_DIR = path.join(ARIGAMI_DIR, 'agents');
// Same shape as bundle/skill slugs: lowercase, digits, hyphens; 1–40 chars.
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const PERSONA_MAX_CHARS = 4000;
// A3: request_action `kind` — a short machine tag ("send-email", "merge", "post:facebook").
export const ACTION_KIND_RE = /^[a-z0-9][a-z0-9:._-]{0,39}$/;
const EMOJI_DEFAULT = '🤖';

export interface AgentBudget {
  tokensPerDay?: number;
}

export interface Agent {
  slug: string;
  name: string;
  emoji: string;
  color: string;
  model?: string | null; // `claude --model` value; null/absent = CLI default
  skills: string[]; // names of SHARED skills the agent should use
  tools?: string[]; // allowlist — families / tool names / mcp__<server>__* patterns (A3: host-enforced, agent-policy.ts)
  domains?: string[]; // allowlist for open_tab + WebFetch (A3: host-enforced)
  budget?: AgentBudget; // tokensPerDay (A3: enforced via the activity ledger, agent-ledger.ts)
  autoApprove?: string[]; // A3: request_action `kind`s the host answers with the primary button at once
  toolsV?: number; // A5: allowlist generation — 2 = written after `publish` became a revocable family
  homeSessionId?: string | null; // the long-lived DM session (get-or-create)
  createdAt: string;
  updatedAt: string;
}

/** The record plus the things that live next to it on disk. */
export interface AgentView extends Agent {
  persona: string;
  assets: string[];
}

export interface AgentInput {
  slug?: string;
  name?: string;
  emoji?: string;
  color?: string;
  model?: string | null;
  skills?: string[];
  tools?: string[];
  domains?: string[];
  budget?: AgentBudget | null;
  autoApprove?: string[] | null;
  persona?: string;
}

export type AgentResult = { ok: true; agent: AgentView } | { ok: false; error: string; status?: number };

export const agentDir = (slug: string): string => path.join(AGENTS_DIR, slug);
export const agentMemoryDir = (slug: string): string => path.join(AGENTS_DIR, slug, 'memory');
const recordFile = (slug: string) => path.join(agentDir(slug), 'agent.json');
const personaFile = (slug: string) => path.join(agentDir(slug), 'persona.md');
const assetsDir = (slug: string) => path.join(agentDir(slug), 'assets');

function readFileSafe(p: string): string {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

/** "Marketing Lead" → "marketing-lead"; Hebrew/other scripts → '' (caller must pass a slug). */
export function slugify(name: string): string {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

const cleanList = (v: unknown): string[] | undefined => {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) return undefined;
  return [...new Set(v.map((x) => String(x || '').trim()).filter(Boolean))];
};

function validateSkills(skills: string[]): string | null {
  for (const s of skills) {
    if (!SKILL_NAME_RE.test(s)) return `invalid skill name: ${s}`;
    if (!isSkillDir(s)) return `unknown skill: ${s} (agents reference shared skills by name — see GET /__api/skills)`;
  }
  return null;
}

function pickColor(): string {
  const used = new Set(listAgents().map((a) => a.color));
  const palette = cfg.palette || ['#6A4FC4'];
  return palette.find((c) => !used.has(c)) || palette[listAgents().length % palette.length];
}

/** The allowlist generation `writeRecord` stamps (see migrateTools). */
export const TOOLS_V = 2;

/**
 * A5 (#2) — `publish_artifact`/`share_artifact` used to be CORE (unrevocable), so
 * every agent could publish and mint a public link. They are a `publish` family
 * now. A record written before that says nothing about publishing yet WAS able to
 * publish: grant it the family once and stamp `toolsV`, so unticking the checkbox
 * later actually sticks. Agents with no allowlist at all are unrestricted anyway.
 */
function migrateTools(a: Agent): Agent {
  if (!a.tools?.length || a.toolsV === TOOLS_V) return a;
  const next: Agent = { ...a, tools: [...new Set([...a.tools, 'publish'])], toolsV: TOOLS_V };
  try {
    writeRecord(next);
  } catch {
    /* read-only dir — the in-memory grant still applies */
  }
  return next;
}

function readRecord(slug: string): Agent | null {
  if (!SLUG_RE.test(slug)) return null;
  const raw = readFileSafe(recordFile(slug));
  if (!raw) return null;
  try {
    const a = JSON.parse(raw) as Agent;
    if (!a || a.slug !== slug) return null;
    return migrateTools({ ...a, skills: Array.isArray(a.skills) ? a.skills : [] });
  } catch {
    return null;
  }
}

function writeRecord(a: Agent): void {
  a = { ...a, toolsV: TOOLS_V };
  fs.mkdirSync(agentDir(a.slug), { recursive: true });
  fs.mkdirSync(agentMemoryDir(a.slug), { recursive: true });
  fs.mkdirSync(assetsDir(a.slug), { recursive: true });
  fs.writeFileSync(recordFile(a.slug), JSON.stringify(a, null, 2) + '\n');
}

export function listAssets(slug: string): string[] {
  try {
    return fs
      .readdirSync(assetsDir(slug), { withFileTypes: true })
      .filter((e) => e.isFile() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

export function readPersona(slug: string): string {
  return readFileSafe(personaFile(slug)).replace(/\s+$/, '');
}

export function writePersona(slug: string, text: string): void {
  fs.mkdirSync(agentDir(slug), { recursive: true });
  fs.writeFileSync(personaFile(slug), String(text || '').trim() ? String(text).trim() + '\n' : '');
}

export function toView(a: Agent): AgentView {
  return { ...a, persona: readPersona(a.slug), assets: listAssets(a.slug) };
}

export function listAgents(): Agent[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(AGENTS_DIR).filter((d) => SLUG_RE.test(d));
  } catch {
    return [];
  }
  return names
    .map(readRecord)
    .filter((a): a is Agent => !!a)
    .sort((x, y) => x.createdAt.localeCompare(y.createdAt));
}

export function listAgentViews(): AgentView[] {
  return listAgents().map(toView);
}

export function getAgent(slug: string): AgentView | null {
  const a = readRecord(String(slug || ''));
  return a ? toView(a) : null;
}

function announce(): void {
  try {
    broadcast({ type: 'agents-updated', agents: listAgentViews() });
  } catch {
    /* no ws yet (tests, early boot) */
  }
}

/** Shared field validation for create/update. Returns the error or null. */
function validateFields(input: AgentInput): string | null {
  if (input.name !== undefined && !String(input.name).trim()) return 'name required';
  if (input.name !== undefined && String(input.name).length > 80) return 'name too long (max 80)';
  if (input.emoji !== undefined && [...String(input.emoji)].length > 4) return 'emoji must be a single glyph';
  if (input.color !== undefined && !/^#[0-9a-fA-F]{6}$/.test(String(input.color))) return 'color must be #rrggbb';
  if (input.model !== undefined && input.model !== null && !/^[A-Za-z0-9._:-]{1,80}$/.test(String(input.model)))
    return 'invalid model';
  if (input.persona !== undefined && String(input.persona).length > PERSONA_MAX_CHARS)
    return `persona too long (max ${PERSONA_MAX_CHARS} chars — keep it to ~20 lines)`;
  if (input.budget !== undefined && input.budget !== null) {
    const t = (input.budget as AgentBudget).tokensPerDay;
    if (t !== undefined && (!Number.isFinite(Number(t)) || Number(t) < 0)) return 'budget.tokensPerDay must be a non-negative number';
  }
  if (input.skills !== undefined) {
    const list = cleanList(input.skills);
    if (!list) return 'skills must be an array of names';
    const err = validateSkills(list);
    if (err) return err;
  }
  if (input.tools !== undefined && input.tools !== null && !Array.isArray(input.tools)) return 'tools must be an array';
  if (input.domains !== undefined && input.domains !== null && !Array.isArray(input.domains)) return 'domains must be an array';
  if (input.autoApprove !== undefined && input.autoApprove !== null) {
    if (!Array.isArray(input.autoApprove)) return 'autoApprove must be an array of action kinds';
    for (const k of input.autoApprove) if (!ACTION_KIND_RE.test(String(k))) return `invalid action kind: ${k}`;
  }
  return null;
}

export function createAgent(input: AgentInput): AgentResult {
  const name = String(input.name || '').trim();
  if (!name) return { ok: false, error: 'name required', status: 400 };
  const slug = String(input.slug || slugify(name)).trim();
  if (!SLUG_RE.test(slug))
    return { ok: false, error: `invalid slug "${slug}" — lowercase letters, digits and hyphens (pass an explicit slug for non-Latin names)`, status: 400 };
  if (readRecord(slug)) return { ok: false, error: `agent "${slug}" already exists`, status: 409 };
  const err = validateFields({ ...input, name });
  if (err) return { ok: false, error: err, status: 400 };
  const now = new Date().toISOString();
  const agent: Agent = {
    slug,
    name,
    emoji: String(input.emoji || EMOJI_DEFAULT),
    color: input.color ? String(input.color) : pickColor(),
    model: input.model ? String(input.model) : null,
    skills: cleanList(input.skills) || [],
    ...(cleanList(input.tools)?.length ? { tools: cleanList(input.tools) } : {}),
    ...(cleanList(input.domains)?.length ? { domains: cleanList(input.domains) } : {}),
    ...(input.budget && Number(input.budget.tokensPerDay) > 0 ? { budget: { tokensPerDay: Number(input.budget.tokensPerDay) } } : {}),
    ...(cleanList(input.autoApprove)?.length ? { autoApprove: cleanList(input.autoApprove) } : {}),
    homeSessionId: null,
    createdAt: now,
    updatedAt: now,
  };
  writeRecord(agent);
  writePersona(slug, input.persona || '');
  announce();
  return { ok: true, agent: toView(agent) };
}

export function updateAgent(slug: string, patch: AgentInput & { homeSessionId?: string | null }): AgentResult {
  const cur = readRecord(String(slug || ''));
  if (!cur) return { ok: false, error: `unknown agent: ${slug}`, status: 404 };
  const err = validateFields(patch);
  if (err) return { ok: false, error: err, status: 400 };
  const next: Agent = { ...cur };
  if (patch.name !== undefined) next.name = String(patch.name).trim();
  if (patch.emoji !== undefined) next.emoji = String(patch.emoji || EMOJI_DEFAULT);
  if (patch.color !== undefined) next.color = String(patch.color);
  if (patch.model !== undefined) next.model = patch.model ? String(patch.model) : null;
  if (patch.skills !== undefined) next.skills = cleanList(patch.skills) || [];
  if (patch.tools !== undefined) {
    const l = cleanList(patch.tools);
    if (l?.length) next.tools = l;
    else delete next.tools;
  }
  if (patch.domains !== undefined) {
    const l = cleanList(patch.domains);
    if (l?.length) next.domains = l;
    else delete next.domains;
  }
  if (patch.budget !== undefined) {
    const t = patch.budget ? Number(patch.budget.tokensPerDay) : 0;
    if (t > 0) next.budget = { tokensPerDay: t };
    else delete next.budget;
  }
  if (patch.autoApprove !== undefined) {
    const l = cleanList(patch.autoApprove);
    if (l?.length) next.autoApprove = l;
    else delete next.autoApprove;
  }
  if (patch.homeSessionId !== undefined) next.homeSessionId = patch.homeSessionId || null;
  next.updatedAt = new Date().toISOString();
  writeRecord(next);
  if (patch.persona !== undefined) writePersona(next.slug, patch.persona);
  announce();
  return { ok: true, agent: toView(next) };
}

export function deleteAgent(slug: string): { ok: boolean; error?: string } {
  const cur = readRecord(String(slug || ''));
  if (!cur) return { ok: false, error: `unknown agent: ${slug}` };
  fs.rmSync(agentDir(cur.slug), { recursive: true, force: true });
  announce();
  return { ok: true };
}

// ---- persona injection (claude.js, first turn of a session born from an agent)

/**
 * The system-reminder block a session born from `slug` gets in its first turn
 * (same prompt-cache reasoning as the memory bootstrap: once, never mid-session).
 * Returns '' for an unknown agent so a stale metadata.agent never breaks a spawn.
 */
export function personaBlock(slug: string): string {
  const a = getAgent(slug);
  if (!a) return '';
  const lines: string[] = [];
  lines.push(`You are running as the agent "${a.name}" ${a.emoji} (slug: ${a.slug}) — one of the human's team of agents in Arigami. Stay in this role for the whole session.`);
  if (a.persona.trim()) lines.push('', '## Persona', a.persona.trim());
  if (a.skills.length)
    lines.push('', `## Skills you should use (shared skills, invoke as /arigami:<name> or /arigami-user:<name>): ${a.skills.join(', ')}`);
  // A5 (#3): the old line named only the allowlist, so agents refused legal calls
  // ("I'm blocked from publishing") and, in the other direction, assumed a
  // capability they never had. Say all three things: what you MAY use (allowlist
  // + the always-on core), what is denied, and that a denial is REPORTED by the
  // host — so trying is safe and guessing never is.
  if (a.tools?.length) {
    const p = policyOf(a);
    const denied = RESTRICTED_BUILTINS.filter((b) => !toolAllowed(p, b));
    lines.push(
      '',
      '## Tools',
      `- You MAY use: your allowlist — ${a.tools.join(', ')} (families expand to concrete tools) — PLUS the always-on set every session keeps: the read-only built-ins (Read, Glob, Grep, TodoWrite, …) and the cockpit core (${CORE_TOOLS.join(', ')}).`,
      `- DENIED: everything else${denied.length ? `, including the built-ins ${denied.join(', ')}` : ''}. The host enforces it — denied tools are hidden from your toolset or refused with a reason.`,
      '- If a call is denied the host TELLS you so in the tool result. So never refuse a task on a guess about your own permissions (try the call), and never assume a capability you were not given. When something you need is blocked, say exactly what was blocked and ask the human with request_action — do not work around it.'
    );
    // A5 (#1): without `triggers` there is NO way to make a durable routine — the
    // CLI's own CronCreate only makes a session-only job that dies with this
    // process and never shows in the Routine tab.
    if (!toolAllowed(p, 'cronjob'))
      lines.push(
        '- Routines: you may NOT create or change scheduled jobs (no "triggers"), and a session-only schedule (CronCreate) is not a routine — it is invisible in the Routine tab and dies with this process. If the human asks for one, say it has to be added in your Routine tab (Agent page → Routine → "Add routine"), or that you need the "triggers" tool. Never report a routine as created.'
      );
  }
  // A5 (#2): publishing is a revocable family and a PUBLIC link always asks first.
  {
    const canPublish = !a.tools?.length || toolAllowed(policyOf(a), 'publish_artifact');
    const autoShare = (a.autoApprove || []).includes('share');
    lines.push(
      '',
      `## Publishing: publish_artifact is ${canPublish ? 'available to you (host-local link, /__artifacts/…)' : 'NOT available to you — hand the file path to the human instead'}. ` +
        `A PUBLIC share link (share:true / share_artifact) ${autoShare ? 'is minted at once — the human pre-approved the "share" kind for you.' : 'is never minted on your word alone: the host opens a "share" approval card for the human and gives you the link only after they approve.'}`
    );
  }
  if (a.domains?.length) lines.push('', `## Domains you may reach: ${a.domains.join(', ')} — the host refuses open_tab / WebFetch elsewhere.`);
  if (a.budget?.tokensPerDay) lines.push('', `## Budget: ${a.budget.tokensPerDay} tokens/day, enforced by the host — when it runs out you get one final warning to wrap up, and after it every further turn (and every new session) is refused until local midnight. Be economical.`);
  lines.push('', `## Actions: give request_action a short \`kind\` ("send-email", "merge", "post:facebook"). The human can tick "auto-approve this kind from now on" on the card; kinds in your autoApprove list${a.autoApprove?.length ? ` (${a.autoApprove.join(', ')})` : ''} are answered by the host at once with the primary button.`);
  if (a.assets.length)
    lines.push('', `## Assets (brand/style references): ${a.assets.map((f) => path.join(assetsDir(a.slug), f)).join(', ')}`);
  lines.push(
    '',
    `## Memory: memory_write/memory_search default to YOUR namespace (agent:${a.slug}); USER.md (facts about the human) is shared. Pass agent:"" to write the shared MEMORY.md instead.`,
    '',
    `## Connections & browser (A2): your Chrome profile is your own (agents/${a.slug}/browser — logins persist across your sessions; save_browser_logins syncs into it, shared:true also into the host's base). request_setup for identity / composio:* connects to YOUR agent (owner agent:${a.slug}); the host's shared connection is used only as a fallback. cronjob({agent}) defaults to you — your runs are born from you.`
  );
  return `<system-reminder>\n${lines.join('\n')}\n</system-reminder>\n\n`;
}
