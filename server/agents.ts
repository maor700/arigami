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

export const AGENTS_DIR = path.join(ARIGAMI_DIR, 'agents');
// Same shape as bundle/skill slugs: lowercase, digits, hyphens; 1–40 chars.
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const PERSONA_MAX_CHARS = 4000;
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
  tools?: string[]; // allowlist (enforced in A3; advisory in A1)
  domains?: string[]; // allowlist (enforced in A3; advisory in A1)
  budget?: AgentBudget;
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

function readRecord(slug: string): Agent | null {
  if (!SLUG_RE.test(slug)) return null;
  const raw = readFileSafe(recordFile(slug));
  if (!raw) return null;
  try {
    const a = JSON.parse(raw) as Agent;
    if (!a || a.slug !== slug) return null;
    return { ...a, skills: Array.isArray(a.skills) ? a.skills : [] };
  } catch {
    return null;
  }
}

function writeRecord(a: Agent): void {
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
  if (a.tools?.length) lines.push('', `## Tools you may use: ${a.tools.join(', ')} — do not use others without asking.`);
  if (a.domains?.length) lines.push('', `## Domains you may reach: ${a.domains.join(', ')} — do not browse others without asking.`);
  if (a.budget?.tokensPerDay) lines.push('', `## Budget: ~${a.budget.tokensPerDay} tokens/day — be economical.`);
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
