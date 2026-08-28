// Host skill pack — read/edit the bundled skills at ROOT/skills, plus a curated
// "relationship" backbone (which host surface invokes which skill) and an
// optional, AI-generated enrichment layer (per-skill summaries + inferred
// secondary edges). The backbone is correct-by-construction; the AI layer is
// opt-in, cached to ~/.arigami (never into the git-tracked pack), and clearly
// marked as inferred in the UI.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { cfg } from './state.js';
import { runClaudeOneShot } from './lib/oneshot.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SKILLS_DIR = path.join(ROOT, 'skills');
const GRAPH_CACHE = path.join(cfg.configDir!, 'skills-graph.json');

export const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const TEXT_EXT = new Set(['.md', '.sh', '.js', '.ts', '.json', '.txt', '.yml', '.yaml', '.mjs']);
const MAX_FILE = 200_000;

// ---- curated backbone: host surfaces and the skills they invoke -------------
// Source of truth lives in server logic, not the files — so we encode it here.
// Edges referencing a skill that isn't on disk are dropped at build time.
export interface Surface {
  id: string;
  label: string;
  desc: string;
}
const SURFACES: Surface[] = [
  { id: 'surface:ticket', label: 'Ticket Launcher', desc: 'Starts a session from a Linear ticket — the human picks which skill runs' },
  { id: 'surface:changes', label: 'Changes Tab', desc: 'Read-only headless runs over the worktree diff' },
  { id: 'surface:session', label: 'In-Session Chat', desc: 'Skills the agent runs inside a live session' },
  { id: 'surface:mcp', label: 'Host MCP', desc: 'arigami tools skills call back into' },
];

// from = surface id, to = skill dir name. The ticket/empty launcher no longer
// pins a fixed skill (the user picks one per session), so there's no
// correct-by-construction edge for it — only genuinely fixed wiring lives here.
const BACKBONE: { from: string; to: string; label: string }[] = [
  { from: 'surface:changes', to: 'explain-changes', label: 'summarizes the diff' },
  { from: 'surface:mcp', to: 'explain-changes', label: 'set_changes_explanation' },
];

// ---- frontmatter -----------------------------------------------------------
function parseFrontmatter(content: string): Record<string, string> {
  const m = content.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const mm = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (mm) out[mm[1]] = mm[2].trim();
  }
  return out;
}

export function isSkillDir(dir: string): boolean {
  try {
    return fs.statSync(path.join(SKILLS_DIR, dir)).isDirectory() &&
      fs.existsSync(path.join(SKILLS_DIR, dir, 'SKILL.md'));
  } catch {
    return false;
  }
}

function listSupporting(dir: string): { name: string; size: number }[] {
  try {
    return fs
      .readdirSync(path.join(SKILLS_DIR, dir))
      .filter((f) => f !== 'SKILL.md')
      .filter((f) => fs.statSync(path.join(SKILLS_DIR, dir, f)).isFile())
      .map((f) => ({ name: f, size: fs.statSync(path.join(SKILLS_DIR, dir, f)).size }));
  } catch {
    return [];
  }
}

export interface SkillSummary {
  name: string;
  description: string;
  argumentHint: string;
  files: { name: string; size: number }[];
}

function skillDirs(): string[] {
  try {
    return fs.readdirSync(SKILLS_DIR).filter(isSkillDir).sort();
  } catch {
    return [];
  }
}

function readSkillMeta(dir: string): SkillSummary {
  const content = fs.readFileSync(path.join(SKILLS_DIR, dir, 'SKILL.md'), 'utf8');
  const fm = parseFrontmatter(content);
  return {
    name: dir,
    description: fm.description || '',
    argumentHint: fm['argument-hint'] || '',
    files: listSupporting(dir),
  };
}

// GET /__api/skills — pack list + curated backbone (instant, always correct).
export function listSkills() {
  const dirs = skillDirs();
  const present = new Set(dirs);
  const hasLib = (() => {
    try {
      return fs.statSync(path.join(SKILLS_DIR, '_lib')).isDirectory();
    } catch {
      return false;
    }
  })();
  return {
    skills: dirs.map(readSkillMeta),
    surfaces: SURFACES,
    backbone: BACKBONE.filter((e) => present.has(e.to)),
    lib: hasLib,
  };
}

// GET /__api/skills/:name — raw SKILL.md + read-only supporting file contents.
export function readSkill(name: string) {
  if (!NAME_RE.test(name) || !isSkillDir(name)) return null;
  const content = fs.readFileSync(path.join(SKILLS_DIR, name, 'SKILL.md'), 'utf8');
  const files = listSupporting(name).map((f) => {
    const full = path.join(SKILLS_DIR, name, f.name);
    const ext = path.extname(f.name).toLowerCase();
    const text = TEXT_EXT.has(ext) && f.size <= MAX_FILE;
    return {
      name: f.name,
      size: f.size,
      content: text ? fs.readFileSync(full, 'utf8') : null,
    };
  });
  return { ...readSkillMeta(name), content, supporting: files };
}

// PUT /__api/skills/:name — validated write of SKILL.md. Edit-only by default
// (the skill must already exist) — that's the human editor's UI path. Creation
// of a brand-new skill is only allowed with opts.allowCreate:true, which only
// the skill-proposals apply path (server/skill-proposals.ts) sets — never the
// human-editor route, so PUT still can't be used to smuggle a new skill in.
export function writeSkill(
  name: string,
  content: string,
  opts: { allowCreate?: boolean } = {}
): { ok: true; skill: SkillSummary } | { error: string } {
  if (!NAME_RE.test(name)) return { error: `invalid skill name: ${name}` };
  if (!isSkillDir(name) && !opts.allowCreate) return { error: `no such skill: ${name}` };
  if (typeof content !== 'string' || !content.trim()) return { error: 'empty content' };
  const fm = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return { error: 'missing YAML frontmatter (--- … ---) at the top of the file' };
  const parsed = parseFrontmatter(content);
  if (!parsed.description) return { error: 'frontmatter must include a non-empty "description"' };
  fs.mkdirSync(path.join(SKILLS_DIR, name), { recursive: true });
  fs.writeFileSync(path.join(SKILLS_DIR, name, 'SKILL.md'), content);
  return { ok: true, skill: readSkillMeta(name) };
}

// ---- AI enrichment ---------------------------------------------------------
// A content hash over every SKILL.md — drives the "analysis is stale" badge.
function packHash(): string {
  const h = crypto.createHash('sha1');
  for (const dir of skillDirs()) {
    h.update(dir);
    h.update(fs.readFileSync(path.join(SKILLS_DIR, dir, 'SKILL.md')));
  }
  return h.digest('hex');
}

function readCache(): any {
  try {
    return JSON.parse(fs.readFileSync(GRAPH_CACHE, 'utf8'));
  } catch {
    return null;
  }
}

// GET /__api/skills/graph — cached AI layer + a freshness verdict.
export function getAnalysis() {
  const cache = readCache();
  if (!cache) return { analysis: null, hash: packHash() };
  const hash = packHash();
  return { analysis: cache, hash, stale: cache.hash !== hash };
}

function extractJson(text: string): any {
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a < 0 || b < 0) throw new Error('no JSON object in model output');
  return JSON.parse(text.slice(a, b + 1));
}

const ANALYZE_PROMPT =
  `You are documenting the Arigami's skill system for a small relationship graph. ` +
  `Work in the current directory, READ-ONLY.\n\n` +
  `1. Read every skills/*/SKILL.md.\n` +
  `2. Skim server/claude.js, server/api.ts and server/lib/config.ts to see how the host invokes skills, ` +
  `which skills call the arigami MCP, and which source scripts from skills/_lib.\n\n` +
  `Then output ONLY a JSON object (no prose, no markdown fences) of exactly this shape:\n` +
  `{\n` +
  `  "summaries": { "<skill-dir-name>": "one concise sentence, <=18 words, what the skill does" },\n` +
  `  "edges": [ { "from": "<node id>", "to": "<node id>", "label": "<=5 words" } ]\n` +
  `}\n\n` +
  `Node ids: a skill is "skill:<dir-name>"; the shared script library is "lib"; the arigami MCP is "surface:mcp". ` +
  `Only emit SECONDARY edges the host surface→skill backbone wouldn't already show: ` +
  `skill→skill dependencies (e.g. one skill requires another), skill→lib (sources a script from _lib), ` +
  `and skill→surface:mcp (calls a arigami MCP tool). Do NOT restate surface→skill invocation edges. ` +
  `Use only skill dir names that exist. Keep it tight — quality over quantity.`;

let running: Promise<any> | null = null;

// POST /__api/skills/analyze — run a one-shot headless claude over the pack,
// cache the result, return it. Coalesces concurrent callers onto one run.
export function analyze(): Promise<any> {
  if (running) return running;
  running = (async () => {
    const text = await runClaudeOneShot(ANALYZE_PROMPT, { cwd: ROOT, timeoutMs: 4 * 60 * 1000, tag: 'skills-analyze' });
    const parsed = extractJson(text);
    const record = {
      summaries: parsed.summaries && typeof parsed.summaries === 'object' ? parsed.summaries : {},
      edges: Array.isArray(parsed.edges)
        ? parsed.edges
            .filter((e: any) => e && e.from && e.to)
            .map((e: any) => ({ from: String(e.from), to: String(e.to), label: String(e.label || ''), kind: 'ai' }))
        : [],
      hash: packHash(),
      generatedAt: new Date().toISOString(),
    };
    try {
      fs.mkdirSync(path.dirname(GRAPH_CACHE), { recursive: true });
      fs.writeFileSync(GRAPH_CACHE, JSON.stringify(record, null, 2));
    } catch { /* cache write best-effort */ }
    return { analysis: record, hash: record.hash, stale: false };
  })().finally(() => { running = null; });
  return running;
}
