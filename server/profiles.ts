// K3 — Profile Bundles: the unit of install / showcase / export.
//
// A bundle is a directory (or a git repo) shaped like:
//   profile.json                 — manifest (name, version, title, repos[], …)
//   skills/<name>/SKILL.md       — skills to stage into the host pack
//   memory-seed/USER.md|MEMORY.md — bootstrap memory (merged, never overwrites)
//   cron.json                    — [{name, prompt, schedule:{kind,value}, enabled?}]
//   README.md                    — human description
//
// Sources, in resolution order (see resolveSource):
//   1. an existing directory path (absolute, ~/…, or relative to cwd)
//   2. a name under $ARIGAMI_DIR/profiles/<name>/ (installed / previously fetched)
//   3. a name under <repo>/profiles/bundles/<name>/ (shipped, TRUSTED)
//   4. a git URL → shallow clone into $ARIGAMI_DIR/profiles/<name>/
//
// apply() is idempotent and additive: repos are upserted into repos.json
// (onboarding.ts), skills go through the M3 proposal pipeline — a shipped
// bundle's NEW skills are auto-applied (§7.12: built-in = approved), anything
// external or anything that would CHANGE an existing skill stays a pending
// proposal for the human — memory seed lines are appended only when missing,
// cron jobs are registered DISABLED unless `enabled:true`, and the provenance
// lands in $ARIGAMI_DIR/profile.json.
//
// `bin/host profile apply <src>` cannot authenticate against a running host
// (the host bearer is in-memory, C1), so it stages the source into
// $ARIGAMI_DIR/pending-profile; the wizard (B3) or `POST /__api/profiles/apply
// {source:"pending"}` finishes the job. When no host is running the CLI applies
// in-process (`bun server/profiles.ts apply <src>`).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ARIGAMI_DIR } from './lib/instance.js';
import { tilde } from './lib/platform.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SHIPPED_BUNDLES_DIR = path.join(REPO_ROOT, 'profiles', 'bundles');
export const USER_BUNDLES_DIR = path.join(ARIGAMI_DIR, 'profiles');
export const PROVENANCE_FILE = path.join(ARIGAMI_DIR, 'profile.json');
export const PENDING_FILE = path.join(ARIGAMI_DIR, 'pending-profile');

export const BUNDLE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const MAX_SEED_BYTES = 64 * 1024;

// ---- types ------------------------------------------------------------------

export interface BundleRepo {
  name: string;
  source: string;
  branch?: string;
  installCmd?: string;
  devCmd?: string;
  testCmd?: string;
  envSource?: { kind: string; value: string };
}

export interface BundleManifest {
  name: string;
  version?: string;
  title?: string;
  description?: string;
  repos?: BundleRepo[];
  plugins?: string[];
  workflows?: string[];
  issueSource?: string;
  ports?: unknown;
  /** Optional allow-list; when present only these skills/ subdirs are loaded. */
  skills?: string[];
}

export interface BundleCron {
  name: string;
  prompt: string;
  schedule: { kind: 'cron' | 'interval' | 'at'; value: string };
  enabled?: boolean;
  autonomous?: boolean;
  sessionMode?: string;
  deliver?: { push?: boolean; whatsapp?: string; master?: string };
}

export interface Bundle {
  dir: string;
  source: string;
  trusted: boolean;
  manifest: BundleManifest;
  skills: { name: string; content: string }[];
  memorySeed: { user?: string; memory?: string };
  cron: BundleCron[];
  readme: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export interface ApplyReport {
  name: string;
  version?: string;
  source: string;
  trusted: boolean;
  appliedAt: string;
  repos: string[];
  skills: { name: string; status: 'applied' | 'pending' | 'unchanged' | 'error'; proposalId?: string; error?: string }[];
  memory: { user: number; memory: number };
  cron: { id: string; name: string; enabled: boolean }[];
  errors: string[];
}

export interface Provenance extends ApplyReport {
  history?: { name: string; version?: string; source: string; appliedAt: string }[];
}

// ---- helpers ----------------------------------------------------------------

function readText(p: string): string {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function isGitUrl(s: string): boolean {
  return /^(https?:\/\/|git@|ssh:\/\/|git:\/\/)/.test(s) || /\.git$/.test(s);
}

/** Bundle name derived from a git URL: last path segment minus `.git`. */
export function nameFromUrl(url: string): string {
  const seg = url.replace(/\/+$/, '').replace(/\.git$/, '').split(/[/:]/).pop() || '';
  return seg.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '');
}

// ---- loading ----------------------------------------------------------------

function isShippedDir(dir: string): boolean {
  const rel = path.relative(SHIPPED_BUNDLES_DIR, dir);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Read a bundle directory into memory (does not validate — see validate()). */
export function loadBundle(dir: string, source = dir): Bundle {
  dir = path.resolve(dir);
  let manifest: BundleManifest;
  const raw = readText(path.join(dir, 'profile.json'));
  if (!raw) throw new Error(`not a profile bundle: ${dir} (missing profile.json)`);
  try {
    manifest = JSON.parse(raw);
  } catch (e) {
    throw new Error(`profile.json is not valid JSON: ${(e as Error).message}`);
  }
  const skills: Bundle['skills'] = [];
  const skillsDir = path.join(dir, 'skills');
  if (isDir(skillsDir)) {
    const want = Array.isArray(manifest.skills) ? new Set(manifest.skills) : null;
    for (const name of fs.readdirSync(skillsDir).sort()) {
      if (want && !want.has(name)) continue;
      const f = path.join(skillsDir, name, 'SKILL.md');
      if (fs.existsSync(f)) skills.push({ name, content: readText(f) });
    }
  }
  const memorySeed: Bundle['memorySeed'] = {};
  const u = readText(path.join(dir, 'memory-seed', 'USER.md'));
  const m = readText(path.join(dir, 'memory-seed', 'MEMORY.md'));
  if (u) memorySeed.user = u;
  if (m) memorySeed.memory = m;
  let cron: BundleCron[] = [];
  const cronRaw = readText(path.join(dir, 'cron.json'));
  if (cronRaw) {
    try {
      const parsed = JSON.parse(cronRaw);
      cron = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.jobs) ? parsed.jobs : [];
    } catch (e) {
      throw new Error(`cron.json is not valid JSON: ${(e as Error).message}`);
    }
  }
  return { dir, source, trusted: isShippedDir(dir), manifest, skills, memorySeed, cron, readme: readText(path.join(dir, 'README.md')) };
}

export function validate(b: Bundle): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const mf = b.manifest as any;
  if (!mf || typeof mf !== 'object') errors.push('profile.json must be an object');
  else {
    if (typeof mf.name !== 'string' || !BUNDLE_NAME_RE.test(mf.name))
      errors.push(`profile.json: "name" must match ${BUNDLE_NAME_RE} (got ${JSON.stringify(mf.name)})`);
    if (mf.version != null && typeof mf.version !== 'string') errors.push('profile.json: "version" must be a string');
    if (mf.repos != null) {
      if (!Array.isArray(mf.repos)) errors.push('profile.json: "repos" must be an array');
      else
        mf.repos.forEach((r: any, i: number) => {
          if (!r || typeof r !== 'object') return errors.push(`repos[${i}] must be an object`);
          if (typeof r.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(r.name) || r.name === '..' || r.name === '.')
            errors.push(`repos[${i}].name is not a safe directory name`);
          if (typeof r.source !== 'string' || !r.source.trim()) errors.push(`repos[${i}].source is required`);
        });
    }
    for (const k of ['plugins', 'workflows', 'skills'] as const)
      if (mf[k] != null && !(Array.isArray(mf[k]) && mf[k].every((x: unknown) => typeof x === 'string')))
        errors.push(`profile.json: "${k}" must be an array of strings`);
  }
  for (const s of b.skills) {
    if (!SKILL_NAME_RE.test(s.name)) errors.push(`skills/${s.name}: invalid skill name`);
    if (!s.content.trim()) errors.push(`skills/${s.name}/SKILL.md is empty`);
    else if (!/^---\n[\s\S]*?\n---/.test(s.content)) errors.push(`skills/${s.name}/SKILL.md is missing YAML frontmatter`);
    else if (!/^description:\s*\S/m.test(s.content)) errors.push(`skills/${s.name}/SKILL.md frontmatter needs a "description"`);
  }
  for (const [k, v] of Object.entries(b.memorySeed))
    if (v && Buffer.byteLength(v) > MAX_SEED_BYTES) errors.push(`memory-seed/${k.toUpperCase()}.md exceeds ${MAX_SEED_BYTES} bytes`);
  b.cron.forEach((c: any, i: number) => {
    if (!c || typeof c !== 'object') return errors.push(`cron[${i}] must be an object`);
    if (typeof c.prompt !== 'string' || !c.prompt.trim()) errors.push(`cron[${i}].prompt is required`);
    const k = c.schedule?.kind;
    if (k !== 'cron' && k !== 'interval' && k !== 'at') errors.push(`cron[${i}].schedule.kind must be cron|interval|at`);
    if (typeof c.schedule?.value !== 'string' && typeof c.schedule?.value !== 'number')
      errors.push(`cron[${i}].schedule.value is required`);
    if (c.enabled === true && !b.trusted) warnings.push(`cron[${i}] asks to start enabled — external bundle, will be registered disabled`);
  });
  if (!b.readme) warnings.push('README.md missing');
  if (!b.trusted && b.skills.length) warnings.push(`${b.skills.length} skill(s) from an external bundle will be staged as pending proposals`);
  return { ok: errors.length === 0, errors, warnings };
}

// ---- sources ----------------------------------------------------------------

export interface ResolvedSource {
  dir: string;
  source: string;
  fetched: boolean;
}

function gitClone(url: string, dest: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const r = spawnSync('git', ['clone', '--depth', '1', '--quiet', url, dest], {
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    timeout: 120_000,
  });
  if (r.status !== 0) throw new Error(`git clone failed: ${(r.stderr || r.stdout || '').trim().split('\n').pop() || 'unknown error'}`);
}

/**
 * Turn `source` into a local bundle directory. Git URLs are cloned (or
 * `git pull --ff-only`ed when already present) under $ARIGAMI_DIR/profiles/.
 * "pending" reads $ARIGAMI_DIR/pending-profile.
 */
export function resolveSource(source: string): ResolvedSource {
  source = String(source || '').trim();
  if (!source) throw new Error('source is required');
  if (source === 'pending') {
    const p = readText(PENDING_FILE).trim();
    if (!p) throw new Error('no pending profile');
    return { ...resolveSource(p), source: p };
  }
  if (isGitUrl(source)) {
    const name = nameFromUrl(source);
    if (!BUNDLE_NAME_RE.test(name)) throw new Error(`cannot derive a bundle name from ${source}`);
    const dest = path.join(USER_BUNDLES_DIR, name);
    if (isDir(path.join(dest, '.git'))) {
      spawnSync('git', ['pull', '--ff-only', '--quiet'], { cwd: dest, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, timeout: 60_000 });
    } else {
      if (isDir(dest)) throw new Error(`${dest} exists and is not a git checkout — remove it or pass the directory instead`);
      gitClone(source, dest);
    }
    return { dir: dest, source, fetched: true };
  }
  const asPath = path.resolve(tilde(source));
  if (isDir(asPath) && fs.existsSync(path.join(asPath, 'profile.json'))) return { dir: asPath, source: asPath, fetched: false };
  if (BUNDLE_NAME_RE.test(source)) {
    for (const base of [USER_BUNDLES_DIR, SHIPPED_BUNDLES_DIR]) {
      const d = path.join(base, source);
      if (fs.existsSync(path.join(d, 'profile.json'))) return { dir: d, source, fetched: false };
    }
  }
  throw new Error(`no such profile bundle: ${source} (not a directory with profile.json, not a shipped/installed name, not a git URL)`);
}

export interface BundleSummary {
  name: string;
  version?: string;
  title?: string;
  description?: string;
  dir: string;
  trusted: boolean;
  skills: string[];
  cron: number;
  hasMemorySeed: boolean;
  valid: boolean;
  errors: string[];
}

export function summarize(b: Bundle): BundleSummary {
  const v = validate(b);
  return {
    name: b.manifest.name,
    version: b.manifest.version,
    title: b.manifest.title,
    description: b.manifest.description,
    dir: b.dir,
    trusted: b.trusted,
    skills: b.skills.map((s) => s.name),
    cron: b.cron.length,
    hasMemorySeed: !!(b.memorySeed.user || b.memorySeed.memory),
    valid: v.ok,
    errors: v.errors,
  };
}

/** Shipped + installed bundles (installed wins on a name clash). */
export function listBundles(): BundleSummary[] {
  const out: BundleSummary[] = [];
  const seen = new Set<string>();
  for (const base of [USER_BUNDLES_DIR, SHIPPED_BUNDLES_DIR]) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(base).sort();
    } catch {
      continue;
    }
    for (const n of names) {
      const d = path.join(base, n);
      if (!fs.existsSync(path.join(d, 'profile.json'))) continue;
      try {
        const b = loadBundle(d, n);
        const key = b.manifest?.name || n;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(summarize(b));
      } catch (e) {
        out.push({ name: n, dir: d, trusted: false, skills: [], cron: 0, hasMemorySeed: false, valid: false, errors: [(e as Error).message] });
      }
    }
  }
  return out;
}

// ---- pending (installer → wizard hand-off) ----------------------------------

export function setPending(source: string): string {
  fs.mkdirSync(ARIGAMI_DIR, { recursive: true });
  fs.writeFileSync(PENDING_FILE, source.trim() + '\n');
  return PENDING_FILE;
}

export function getPending(): string | null {
  const s = readText(PENDING_FILE).trim();
  return s || null;
}

export function clearPending(): void {
  try {
    fs.unlinkSync(PENDING_FILE);
  } catch {}
}

export function readProvenance(): Provenance | null {
  try {
    return JSON.parse(fs.readFileSync(PROVENANCE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

// ---- memory seed merge (append, never overwrite) -----------------------------

/** Pure: lines from `seed` (bullets + headings + prose) not already in `existing`. */
export function mergeSeed(existing: string, seed: string): { content: string; added: number } {
  const norm = (l: string) => l.replace(/^[-*]\s+/, '').trim().toLowerCase();
  if (!existing.trim()) return { content: seed.replace(/\s+$/, '') + '\n', added: seed.split('\n').filter((l) => l.trim()).length };
  const have = new Set(existing.split('\n').map(norm).filter(Boolean));
  const add: string[] = [];
  for (const line of seed.split('\n')) {
    const n = norm(line);
    if (!n || have.has(n)) continue;
    if (/^#/.test(line.trim())) continue; // don't duplicate section headings into an existing file
    add.push(line.replace(/\s+$/, ''));
    have.add(n);
  }
  if (!add.length) return { content: existing, added: 0 };
  return { content: existing.replace(/\n+$/, '') + '\n' + add.join('\n') + '\n', added: add.length };
}

// ---- apply ------------------------------------------------------------------

export interface ApplyOptions {
  /** Skip cron registration (CLI mode with a live host that owns triggers.json). */
  skipCron?: boolean;
  /** Skip repos.json upsert. */
  skipRepos?: boolean;
  sessionId?: string;
}

export async function applyBundle(b: Bundle, opts: ApplyOptions = {}): Promise<ApplyReport> {
  const v = validate(b);
  if (!v.ok) throw new Error('invalid bundle: ' + v.errors.join('; '));
  const report: ApplyReport = {
    name: b.manifest.name,
    version: b.manifest.version,
    source: b.source,
    trusted: b.trusted,
    appliedAt: new Date().toISOString(),
    repos: [],
    skills: [],
    memory: { user: 0, memory: 0 },
    cron: [],
    errors: [],
  };

  // 1. repos → repos.json (seed-then-auto-fix, same as onboarding.applyProfile)
  if (!opts.skipRepos && b.manifest.repos?.length) {
    try {
      const ob = await import('./onboarding.js');
      report.repos = ob.upsertRepos(b.manifest.repos as any).map((r: any) => r.name);
    } catch (e) {
      report.errors.push(`repos: ${(e as Error).message}`);
    }
  }

  // 2. skills → M3 proposals (trusted+new ⇒ auto-applied; else pending)
  if (b.skills.length) {
    const sp = await import('./skill-proposals.js');
    const sk = await import('./skills.js');
    for (const s of b.skills) {
      const current = sk.readSkillContent(s.name); // effective copy; applies land in $ARIGAMI_DIR/skills
      if (current && current === s.content) {
        report.skills.push({ name: s.name, status: 'unchanged' });
        continue;
      }
      const dup = sp.listProposals().find((p) => p.name === s.name && p.status === 'pending');
      if (dup) {
        const pending = readText(path.join(sp.PROPOSALS_DIR, dup.id, 'content.md'));
        if (pending === s.content) {
          report.skills.push({ name: s.name, status: 'pending', proposalId: dup.id });
          continue;
        }
      }
      const r = sp.proposeSkill({
        name: s.name,
        content: s.content,
        rationale: `from profile bundle "${b.manifest.name}"${b.manifest.version ? ` v${b.manifest.version}` : ''} (${b.trusted ? 'shipped' : 'external'}: ${b.source})`,
        evidence: b.readme ? b.readme.slice(0, 2000) : '',
        sessionId: opts.sessionId,
      });
      if ('error' in r) {
        report.skills.push({ name: s.name, status: 'error', error: r.error });
        continue;
      }
      // §7.12: shipped bundle + brand-new skill ⇒ approved. Changing an EXISTING
      // skill always goes to the human, even from a shipped bundle.
      if (b.trusted && !current) {
        const a = sp.applyProposal(r.proposal.id);
        if ('error' in a) report.skills.push({ name: s.name, status: 'error', proposalId: r.proposal.id, error: a.error });
        else report.skills.push({ name: s.name, status: 'applied', proposalId: r.proposal.id });
      } else {
        report.skills.push({ name: s.name, status: 'pending', proposalId: r.proposal.id });
      }
    }
  }

  // 3. memory seed → append missing lines only
  if (b.memorySeed.user || b.memorySeed.memory) {
    const mem = await import('./memory.js');
    fs.mkdirSync(mem.MEMORY_DIR, { recursive: true });
    for (const [key, file] of [['user', mem.USER_MD], ['memory', mem.MEMORY_MD]] as const) {
      const seed = b.memorySeed[key];
      if (!seed) continue;
      const before = readText(file);
      const merged = mergeSeed(before, seed);
      if (merged.added > 0) {
        fs.writeFileSync(file, merged.content);
        report.memory[key] = merged.added;
      }
    }
  }

  // 4. cron → triggers (disabled unless enabled:true on a trusted bundle)
  if (!opts.skipCron && b.cron.length) {
    const tr = await import('./triggers.js');
    const existing = tr.listTriggers().filter((t: any) => t.type === 'cron');
    for (const c of b.cron) {
      const tag = `[${b.manifest.name}] ${c.name || 'cron'}`;
      const found = existing.find((t: any) => t.name === tag);
      if (found) {
        report.cron.push({ id: found.id, name: tag, enabled: !!(found as any).enabled });
        continue;
      }
      try {
        const t = await tr.createCronTrigger({
          name: tag,
          prompt: c.prompt,
          schedule: { kind: c.schedule.kind, value: String(c.schedule.value) },
          sessionMode: c.sessionMode,
          deliver: c.deliver,
          autonomous: !!c.autonomous && b.trusted,
        });
        const enabled = c.enabled === true && b.trusted;
        if (!enabled) tr.patchTrigger(t.id, { enabled: false });
        report.cron.push({ id: t.id, name: tag, enabled });
      } catch (e) {
        report.errors.push(`cron "${tag}": ${(e as Error).message}`);
      }
    }
  }

  // 5. provenance
  const prev = readProvenance();
  const history = [...(prev?.history || [])];
  if (prev) history.push({ name: prev.name, version: prev.version, source: prev.source, appliedAt: prev.appliedAt });
  fs.mkdirSync(ARIGAMI_DIR, { recursive: true });
  fs.writeFileSync(PROVENANCE_FILE, JSON.stringify({ ...report, history: history.slice(-20) }, null, 2) + '\n');
  if (getPending() && (getPending() === b.source || getPending() === b.dir)) clearPending();
  return report;
}

/** resolve + load + validate + apply in one go. */
export async function applySource(source: string, opts: ApplyOptions = {}): Promise<ApplyReport> {
  const r = resolveSource(source);
  const b = loadBundle(r.dir, r.source);
  return applyBundle(b, opts);
}

// ---- CLI (bin/host profile …) -------------------------------------------------
// bun server/profiles.ts list|validate <src>|apply <src> [--skip-cron]|pending <src>|current
if (import.meta.main) {
  const [cmd, arg, ...rest] = process.argv.slice(2);
  const out = (o: unknown) => process.stdout.write(JSON.stringify(o, null, 2) + '\n');
  try {
    if (cmd === 'list') out(listBundles());
    else if (cmd === 'validate') {
      const r = resolveSource(arg);
      const b = loadBundle(r.dir, r.source);
      const v = validate(b);
      out({ ...summarize(b), ...v });
      process.exitCode = v.ok ? 0 : 1;
    } else if (cmd === 'apply') {
      const skipCron = rest.includes('--skip-cron');
      if (!skipCron) (await import('./triggers.js')).load();
      const rep = await applySource(arg, { skipCron });
      if (!skipCron) (await import('./triggers.js')).flush();
      out(rep);
      process.exitCode = rep.errors.length ? 1 : 0;
    } else if (cmd === 'pending') {
      const r = resolveSource(arg); // fetch/validate now so the wizard finds a local dir
      const b = loadBundle(r.dir, r.source);
      const v = validate(b);
      if (!v.ok) throw new Error('invalid bundle: ' + v.errors.join('; '));
      out({ pending: setPending(r.dir), name: b.manifest.name, dir: r.dir, warnings: v.warnings });
    } else if (cmd === 'current') out({ current: readProvenance(), pending: getPending() });
    else {
      process.stderr.write('usage: bun server/profiles.ts list | validate <src> | apply <src> [--skip-cron] | pending <src> | current\n');
      process.exitCode = 2;
    }
  } catch (e) {
    process.stderr.write(`error: ${(e as Error).message}\n`);
    process.exitCode = 1;
  }
}
