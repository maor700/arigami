// Host skill pack — TWO roots merged by name:
//   shipped  ROOT/skills            git-tracked, READ-ONLY from the app's point
//                                   of view (never written at runtime)
//   user     $ARIGAMI_DIR/skills    writable: human editor saves, skill-proposal
//                                   applies, profile-bundle skills all land here
// A user skill with the same name as a shipped one OVERRIDES it (the app and
// sessions see the user copy); each listed skill carries `source`. Editing a
// shipped skill therefore creates an override copy in the user dir — the repo
// checkout stays clean (F2: a profile apply used to pollute the git tree).
// Sessions see the user dir through a generated plugin at
// $ARIGAMI_DIR/user-plugin (see userPluginDir()) passed as a second
// --plugin-dir by server/claude.js.
//
// Plus a curated "relationship" backbone (which host surface invokes which
// skill) and an optional, AI-generated enrichment layer (per-skill summaries +
// inferred secondary edges). The backbone is correct-by-construction; the AI
// layer is opt-in, cached to $ARIGAMI_DIR (never into the git-tracked pack),
// and clearly marked as inferred in the UI.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { cfg } from './state.js';
import { runOneShot, hostEngine } from './lib/oneshot.js';
import { resourceRoot } from './lib/resource-root.js';
import { linkDir } from './lib/platform.js';

const ROOT = resourceRoot();
/** Shipped pack (git-tracked). Read-only at runtime. */
export const SKILLS_DIR = path.join(ROOT, 'skills');
/** User/bundle skills — the only root the app ever writes to. */
export const USER_SKILLS_DIR = path.join(cfg.configDir!, 'skills');
// EXT: a third, READ-ONLY source — docs contributed by an installed extension,
// generated into $ARIGAMI_DIR/ext-plugin/skills/<name>/SKILL.md by the loader.
// They are listed so the human can see what a session sees; PUT refuses them
// (edit the extension, not the generated file).
export type SkillSource = 'shipped' | 'user' | 'extension';
const GRAPH_CACHE = path.join(cfg.configDir!, 'skills-graph.json');

export const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
// A4: `slash:` frontmatter value — one lowercase word the composer maps to the skill.
export const SLASH_RE = /^[a-z][a-z0-9-]{0,23}$/;
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

function rootOf(source: SkillSource): string {
  return source === 'user' ? USER_SKILLS_DIR : SKILLS_DIR;
}

function hasSkillIn(root: string, dir: string): boolean {
  try {
    return fs.statSync(path.join(root, dir)).isDirectory() &&
      fs.existsSync(path.join(root, dir, 'SKILL.md'));
  } catch {
    return false;
  }
}

/** Which root a skill resolves from (user wins), or null if it isn't anywhere. */
export function skillSource(name: string): SkillSource | null {
  if (!NAME_RE.test(name)) return null;
  if (hasSkillIn(USER_SKILLS_DIR, name)) return 'user';
  if (hasSkillIn(SKILLS_DIR, name)) return 'shipped';
  return null;
}

/** Absolute directory of the EFFECTIVE skill (user override wins), or null. */
export function skillDir(name: string): string | null {
  const src = skillSource(name);
  return src ? path.join(rootOf(src), name) : null;
}

export function isSkillDir(dir: string): boolean {
  return skillSource(dir) !== null;
}

function listSupporting(full: string): { name: string; size: number }[] {
  try {
    return fs
      .readdirSync(full)
      .filter((f) => f !== 'SKILL.md')
      .filter((f) => fs.statSync(path.join(full, f)).isFile())
      .map((f) => ({ name: f, size: fs.statSync(path.join(full, f)).size }));
  } catch {
    return [];
  }
}

export interface SkillSummary {
  name: string;
  description: string;
  argumentHint: string;
  /** EXT: the extension that contributed this skill (source === 'extension') */
  ext?: string;
  /** A4: optional `slash:` frontmatter — the composer offers the skill as /<slash> (e.g. `slash: plan`). */
  slash: string;
  files: { name: string; size: number }[];
  /** where the effective copy lives; user overrides shipped by name */
  source: SkillSource;
  /** true when a user copy shadows a shipped skill of the same name */
  overridesShipped: boolean;
}

function dirsIn(root: string): string[] {
  try {
    return fs.readdirSync(root).filter((d) => NAME_RE.test(d) && hasSkillIn(root, d));
  } catch {
    return [];
  }
}

/** Merged, sorted skill names: shipped ∪ user (each name once). */
function skillDirs(): string[] {
  return [...new Set([...dirsIn(SKILLS_DIR), ...dirsIn(USER_SKILLS_DIR)])].sort();
}

function readSkillMeta(dir: string): SkillSummary {
  const source = skillSource(dir)!;
  const full = path.join(rootOf(source), dir);
  const content = fs.readFileSync(path.join(full, 'SKILL.md'), 'utf8');
  const fm = parseFrontmatter(content);
  return {
    name: dir,
    description: fm.description || '',
    argumentHint: fm['argument-hint'] || '',
    slash: SLASH_RE.test(fm.slash || '') ? fm.slash : '',
    files: listSupporting(full),
    source,
    overridesShipped: source === 'user' && hasSkillIn(SKILLS_DIR, dir),
  };
}

/** Effective SKILL.md text ('' if the skill doesn't exist). */
export function readSkillContent(name: string): string {
  const dir = skillDir(name);
  if (!dir) return '';
  try {
    return fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
  } catch {
    return '';
  }
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
    skills: [...dirs.map(readSkillMeta), ...extensionSkills()],
    surfaces: SURFACES,
    backbone: BACKBONE.filter((e) => present.has(e.to)),
    lib: hasLib,
  };
}

/** EXT: read-only entries for the docs the installed extensions contribute. */
export function extensionSkills(): SkillSummary[] {
  try {
    // Late require: skills.ts is imported by claude.js, which the loader imports back.
    const ext = require('./extensions.js') as typeof import('./extensions.js');
    return ext.extPluginSkills().map((s) => ({
      name: s.name,
      description: s.description,
      argumentHint: '',
      slash: '',
      files: [],
      source: 'extension' as SkillSource,
      overridesShipped: false,
      ext: s.ext,
    }));
  } catch {
    return [];
  }
}

// GET /__api/skills/:name — raw SKILL.md + read-only supporting file contents.
export function readSkill(name: string) {
  if (!NAME_RE.test(name) || !isSkillDir(name)) return null;
  const dir = skillDir(name)!;
  const content = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
  const files = listSupporting(dir).map((f) => {
    const full = path.join(dir, f.name);
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

// PUT /__api/skills/:name — validated write of SKILL.md, ALWAYS into the user
// dir. Editing a shipped skill creates an override copy there (the shipped
// file is untouched; supporting files are copied along so $SKILL_DIR stays
// self-contained). Edit-only by default
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
  const dest = path.join(USER_SKILLS_DIR, name);
  fs.mkdirSync(dest, { recursive: true });
  if (skillSource(name) === 'shipped') {
    // first override of a shipped skill: bring its supporting files along
    for (const f of listSupporting(path.join(SKILLS_DIR, name))) {
      const to = path.join(dest, f.name);
      if (!fs.existsSync(to)) fs.copyFileSync(path.join(SKILLS_DIR, name, f.name), to);
    }
  }
  fs.writeFileSync(path.join(dest, 'SKILL.md'), content);
  ensureUserPlugin();
  // EXT: $ARIGAMI_DIR/skills lives inside the user's git repo now (it is a
  // symlink into user/skills) — so an edited skill gets versioned like the rest
  // of the user's code. Debounced and best-effort: never block a save on git.
  try {
    (require('./extensions.js') as typeof import('./extensions.js')).autoCommit(`skill ${name}`);
  } catch { /* loader not present (tests) */ }
  return { ok: true, skill: readSkillMeta(name) };
}

// ---- user plugin (how SESSIONS see the user dir) ---------------------------
// Claude Code discovers skills through --plugin-dir (repeatable). The shipped
// pack is ROOT itself (ROOT/.claude-plugin + ROOT/skills). For the user dir we
// generate a tiny second plugin under $ARIGAMI_DIR: a manifest plus a `skills`
// symlink to $ARIGAMI_DIR/skills — so sessions list user skills as
// /arigami-user:<name> with no copying and no regeneration on every write.
export const USER_PLUGIN_DIR = path.join(cfg.configDir!, 'user-plugin');
export function ensureUserPlugin(): string {
  try {
    fs.mkdirSync(USER_SKILLS_DIR, { recursive: true });
    fs.mkdirSync(path.join(USER_PLUGIN_DIR, '.claude-plugin'), { recursive: true });
    const manifest = path.join(USER_PLUGIN_DIR, '.claude-plugin', 'plugin.json');
    const want = JSON.stringify(
      {
        name: 'arigami-user',
        description: 'Skills installed on this Arigami instance ($ARIGAMI_DIR/skills): profile bundles, applied proposals, edited/overridden host skills',
        version: '0.1.0',
      },
      null,
      2
    );
    let cur = '';
    try { cur = fs.readFileSync(manifest, 'utf8'); } catch {}
    if (cur !== want) fs.writeFileSync(manifest, want);
    const link = path.join(USER_PLUGIN_DIR, 'skills');
    let ok = false;
    // Resolve before comparing, like extensions.ts:227 does. linkDir() writes
    // path.resolve(target) and creates a JUNCTION on Windows, whose target
    // Node reads back normalised — a raw compare never matches, so this rm'd
    // and recreated the link on every call, on a path Claude Code may be
    // reading at that moment.
    try {
      ok =
        fs.lstatSync(link).isSymbolicLink() &&
        path.resolve(path.dirname(link), fs.readlinkSync(link)) === path.resolve(USER_SKILLS_DIR);
    } catch {}
    if (!ok) {
      try { fs.rmSync(link, { recursive: true, force: true }); } catch {}
      linkDir(USER_SKILLS_DIR, link);
    }
  } catch { /* best-effort: sessions still get the shipped pack */ }
  return USER_PLUGIN_DIR;
}

// ---- AI enrichment ---------------------------------------------------------
// A content hash over every SKILL.md — drives the "analysis is stale" badge.
function packHash(): string {
  const h = crypto.createHash('sha1');
  for (const dir of skillDirs()) {
    h.update(dir);
    h.update(readSkillContent(dir));
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
  `1. Read every skills/*/SKILL.md, and every SKILL.md under ${USER_SKILLS_DIR} (user/bundle skills; a same-named one overrides the shipped copy).\n` +
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
    const text = await runOneShot(ANALYZE_PROMPT, { engine: hostEngine(), cwd: ROOT, timeoutMs: 4 * 60 * 1000, tag: 'skills-analyze' });
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
