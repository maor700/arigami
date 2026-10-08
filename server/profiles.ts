// K3 — Profile Bundles: the unit of install / showcase / export.
//
// A bundle is a directory (or a git repo) shaped like:
//   profile.json                 — manifest (name, version, title, repos[], …)
//   skills/<name>/SKILL.md       — skills to stage into the host pack
//   memory-seed/USER.md|MEMORY.md — bootstrap memory (merged, never overwrites)
//   cron.json                    — [{name, prompt, schedule:{kind,value}, enabled?}]
//   agents/<slug>/agent.json     — A4: agents (the Team section) the bundle ships (+ persona.md, assets/)
//   README.md                    — human description
//
// Sources, in resolution order (see resolveSource):
//   1. an existing directory path (absolute, ~/…, or relative to cwd)
//   2. a name under $ARIGAMI_DIR/profiles/<name>/ (installed / previously fetched)
//   3. a name under the shipped dir ($ARIGAMI_SHIPPED_BUNDLES_DIR, default <repo>/profiles/bundles/<name>/; empty by default, TRUSTED)
//   4. a git URL → shallow clone into $ARIGAMI_DIR/profiles/<name>/
//
// apply() is idempotent and additive: repos are upserted into repos.json
// (onboarding.ts), skills go through the M3 proposal pipeline — a shipped
// bundle's NEW skills are auto-applied (§7.12: built-in = approved), anything
// external or anything that would CHANGE an existing skill stays a pending
// proposal for the human — memory seed lines are appended only when missing,
// cron jobs are registered DISABLED unless `enabled:true`, agents are created
// under $ARIGAMI_DIR/agents/<slug> only when absent (an existing agent is the
// user's — never overwritten unless `force`), and the provenance lands in
// $ARIGAMI_DIR/profile.json.
//
// `bin/host profile apply <src>` cannot authenticate against a running host
// (the host bearer is in-memory, C1), so it stages the source into
// $ARIGAMI_DIR/pending-profile; the wizard (B3) or `POST /__api/profiles/apply
// {source:"pending"}` finishes the job. When no host is running the CLI applies
// in-process (`bun server/profiles.ts apply <src>`).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ARIGAMI_DIR } from './lib/instance.js';
import { CRON_TAG_RE, cronBundleKey } from './lib/cron-key.js';
import { tilde } from './lib/platform.js';
import { resourceRoot } from './lib/resource-root.js';
import { gitEnvFor } from './lib/git-auth.js';

const REPO_ROOT = resourceRoot();
// The product ships no example bundles (profiles come from the org profile repo / ~/.arigami/profiles); the dir
// is kept as a TRUSTED location and is overridable (tests, custom images). Absent/empty is fine.
export const SHIPPED_BUNDLES_DIR = process.env.ARIGAMI_SHIPPED_BUNDLES_DIR || path.join(REPO_ROOT, 'profiles', 'bundles');
export const USER_BUNDLES_DIR = path.join(ARIGAMI_DIR, 'profiles');
export const PROVENANCE_FILE = path.join(ARIGAMI_DIR, 'profile.json');
export const PENDING_FILE = path.join(ARIGAMI_DIR, 'pending-profile');

export const BUNDLE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
// Same shape as agents.ts SLUG_RE (kept local: validate() must not load the host modules).
const AGENT_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
// Same shape as extensions.ts EXT_NAME_RE (kept local for the same reason).
const EXT_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const AGENT_PERSONA_MAX = 4000;
const AGENT_ASSET_MAX_BYTES = 2 * 1024 * 1024;
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
  /** A4: optional allow-list; when present only these agents/ subdirs are loaded. */
  agents?: string[];
  /**
   * Extensions the profile installs. An `extensions/<name>/` directory in the bundle travels with it (the org's
   * profile repo is the only thing a tenant has to reach); an entry here adds a git source pinned by `ref`, and/or
   * the non-secret `settings` to seed. Only a TRUSTED bundle installs extensions — they run code.
   */
  extensions?: BundleExtensionRef[];
}

export interface BundleExtensionRef {
  name: string;
  /** git URL, pinned by `ref`; omit for an extension that ships as `extensions/<name>/` in the bundle */
  source?: string;
  ref?: string;
  /** non-secret settings, seeded only when the host has none stored for this extension */
  settings?: Record<string, unknown>;
}

/** An extension as the bundle describes it: a vendored directory and/or a pinned git source. */
export interface BundleExtension extends BundleExtensionRef {
  dir?: string | null;
}

export interface BundleCron {
  name: string;
  /** stable identity across export/import hops ("<bundle>/<slug>"); derived from the bundle name when absent */
  key?: string;
  prompt: string;
  schedule: { kind: 'cron' | 'interval' | 'at'; value: string };
  enabled?: boolean;
  autonomous?: boolean;
  sessionMode?: string;
  folderName?: string;
  deliver?: { push?: boolean; whatsapp?: string; master?: string };
  /**
   * Who runs it. `user` (default): every instance that applies the bundle runs its own copy, for its own owner
   * (e.g. "PRs waiting for MY review"). `org`: one shared job for the whole organisation — it must run in ONE place,
   * so an ordinary tenant does not register it; only a host started with ARIGAMI_ORG_HOST=1 does.
   */
  scope?: 'user' | 'org';
  /** A4: slug of a bundle/host agent the runs are born from (A2 cronjob({agent})); dropped when absent on the host */
  agent?: string;
}

/** A4: one `agents/<slug>/` directory of a bundle. `record` is agent.json as shipped (user data, no secrets). */
export interface BundleAgent {
  slug: string;
  record: Record<string, unknown>;
  persona: string;
  /** file names under agents/<slug>/assets/ (copied on apply) */
  assets: string[];
  dir: string;
}

export interface Bundle {
  dir: string;
  source: string;
  trusted: boolean;
  manifest: BundleManifest;
  skills: { name: string; content: string }[];
  memorySeed: { user?: string; memory?: string };
  cron: BundleCron[];
  agents: BundleAgent[];
  extensions: BundleExtension[];
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
  /** `scope: org` jobs this host did not register (it is not the org host) */
  cronSkipped?: { name: string; reason: string }[];
  /** extensions the profile installs/updates (only for a trusted bundle) */
  extensions?: { name: string; status: 'installed' | 'updated' | 'unchanged' | 'skipped' | 'error'; sha?: string; error?: string; deps?: 'ok' | 'missing'; depsError?: string }[];
  /** A4: agents shipped by the bundle — created when absent, left alone when present (unless force) */
  agents: { slug: string; status: 'created' | 'updated' | 'unchanged' | 'error'; assets?: number; skippedSkills?: string[]; error?: string }[];
  /** git ref (tag/branch/sha) the bundle was checked out at, when it came from a git source with a ref */
  ref?: string;
  /** the commit the bundle was applied from (git sources) — what the control-plane compares against */
  commit?: string;
  errors: string[];
}

export interface Provenance extends ApplyReport {
  history?: { name: string; version?: string; source: string; appliedAt: string; commit?: string }[];
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
  return { dir, source, trusted: isShippedDir(dir), manifest, skills, memorySeed, cron, agents: loadAgents(dir, Array.isArray(manifest.agents) ? new Set(manifest.agents) : null), extensions: loadExtensions(dir, manifest), readme: readText(path.join(dir, 'README.md')) };
}

/** `extensions/<name>/` directories shipped in the bundle, merged with the manifest's `extensions[]` entries. */
function loadExtensions(dir: string, manifest: BundleManifest): BundleExtension[] {
  const out = new Map<string, BundleExtension>();
  const root = path.join(dir, 'extensions');
  if (isDir(root)) {
    for (const name of fs.readdirSync(root).sort()) {
      const d = path.join(root, name);
      if (isDir(d) && fs.existsSync(path.join(d, 'manifest.json'))) out.set(name, { name, dir: d });
    }
  }
  const refs = Array.isArray(manifest.extensions) ? manifest.extensions : [];
  for (const r of refs) {
    if (!r || typeof r !== 'object' || typeof r.name !== 'string') continue;
    out.set(r.name, { ...(out.get(r.name) || {}), ...r, dir: out.get(r.name)?.dir ?? null });
  }
  return [...out.values()];
}

/** A4: `agents/<slug>/{agent.json, persona.md, assets/}` — read as shipped; validate() checks the shape. */
function loadAgents(dir: string, want: Set<string> | null): BundleAgent[] {
  const root = path.join(dir, 'agents');
  if (!isDir(root)) return [];
  const out: BundleAgent[] = [];
  for (const slug of fs.readdirSync(root).sort()) {
    const adir = path.join(root, slug);
    if (!isDir(adir) || (want && !want.has(slug))) continue;
    const raw = readText(path.join(adir, 'agent.json'));
    let record: Record<string, unknown> = {};
    if (raw) {
      try {
        record = JSON.parse(raw);
      } catch (e) {
        throw new Error(`agents/${slug}/agent.json is not valid JSON: ${(e as Error).message}`);
      }
    }
    let assets: string[] = [];
    try {
      assets = fs
        .readdirSync(path.join(adir, 'assets'), { withFileTypes: true })
        .filter((e) => e.isFile() && !e.name.startsWith('.'))
        .map((e) => e.name)
        .sort();
    } catch {
      /* no assets */
    }
    out.push({ slug, record: record && typeof record === 'object' && !Array.isArray(record) ? record : {}, persona: readText(path.join(adir, 'persona.md')), assets, dir: adir });
  }
  return out;
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
    for (const k of ['plugins', 'workflows', 'skills', 'agents'] as const)
      if (mf[k] != null && !(Array.isArray(mf[k]) && mf[k].every((x: unknown) => typeof x === 'string')))
        errors.push(`profile.json: "${k}" must be an array of strings`);
  }
  for (const x of b.extensions) {
    const at = `extensions/${x.name}`;
    if (!EXT_NAME_RE.test(x.name)) { errors.push(`${at}: invalid extension name (lowercase letters, digits, hyphens)`); continue; }
    if (!x.dir && !(typeof x.source === 'string' && x.source.trim())) errors.push(`${at}: needs an extensions/${x.name}/ directory in the bundle or a "source" git URL`);
    if (x.dir) {
      try {
        const m = JSON.parse(readText(path.join(x.dir, 'manifest.json')));
        if (m?.name !== x.name) errors.push(`${at}/manifest.json: "name" (${JSON.stringify(m?.name)}) must match the directory name`);
      } catch {
        errors.push(`${at}/manifest.json is not valid JSON`);
      }
    }
    if (x.ref != null && (typeof x.ref !== 'string' || !/^[A-Za-z0-9._/-]{1,100}$/.test(x.ref) || x.ref.startsWith('-'))) errors.push(`${at}: "ref" must be a tag, branch or commit`);
    if (x.source != null && typeof x.source !== 'string') errors.push(`${at}: "source" must be a string`);
    if (x.settings != null) {
      if (typeof x.settings !== 'object' || Array.isArray(x.settings)) errors.push(`${at}: "settings" must be an object`);
      else for (const k of Object.keys(x.settings)) if (/token|secret|password|api[_-]?key/i.test(k)) errors.push(`${at}: settings."${k}" looks like a secret — extension settings in a bundle must not carry secrets`);
    }
  }
  if (b.extensions.length && !b.trusted) warnings.push(`${b.extensions.length} extension(s) from an external bundle will NOT be installed — extensions run code, so only a trusted bundle installs them`);
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
    if (c.scope != null && c.scope !== 'user' && c.scope !== 'org') errors.push(`cron[${i}].scope must be "user" or "org"`);
    if (c.enabled === true && !b.trusted) warnings.push(`cron[${i}] asks to start enabled — external bundle, will be registered disabled`);
    if (c.agent != null) {
      if (typeof c.agent !== 'string' || !AGENT_SLUG_RE.test(c.agent)) errors.push(`cron[${i}].agent must be an agent slug`);
      else if (!b.agents.some((a) => a.slug === c.agent)) warnings.push(`cron[${i}] is born from agent "${c.agent}" which this bundle does not ship — used only if the host has it`);
    }
  });
  const bundleSkills = new Set(b.skills.map((s) => s.name));
  const shippedSkills = new Set(shippedSkillNames());
  for (const a of b.agents) {
    const at = `agents/${a.slug}`;
    if (!AGENT_SLUG_RE.test(a.slug)) {
      errors.push(`${at}: invalid agent slug (lowercase letters, digits, hyphens; ≤ 40 chars)`);
      continue;
    }
    const r = a.record as any;
    if (!fs.existsSync(path.join(a.dir, 'agent.json'))) errors.push(`${at}/agent.json missing`);
    else if (!r || typeof r !== 'object') errors.push(`${at}/agent.json must be an object`);
    else {
      if (typeof r.name !== 'string' || !r.name.trim()) errors.push(`${at}/agent.json: "name" is required`);
      if (r.slug != null && r.slug !== a.slug) errors.push(`${at}/agent.json: "slug" (${JSON.stringify(r.slug)}) must match the directory name`);
      if (r.emoji != null && (typeof r.emoji !== 'string' || [...r.emoji].length > 4)) errors.push(`${at}/agent.json: "emoji" must be a single glyph`);
      if (r.color != null && !/^#[0-9a-fA-F]{6}$/.test(String(r.color))) errors.push(`${at}/agent.json: "color" must be #rrggbb`);
      if (r.model != null && !/^[A-Za-z0-9._:-]{1,80}$/.test(String(r.model))) errors.push(`${at}/agent.json: invalid "model"`);
      for (const k of ['skills', 'tools', 'domains', 'autoApprove'] as const)
        if (r[k] != null && !(Array.isArray(r[k]) && r[k].every((x: unknown) => typeof x === 'string')))
          errors.push(`${at}/agent.json: "${k}" must be an array of strings`);
      if (r.budget != null && (typeof r.budget !== 'object' || (r.budget.tokensPerDay != null && !(Number(r.budget.tokensPerDay) >= 0))))
        errors.push(`${at}/agent.json: "budget" must be {tokensPerDay: number}`);
      if (r.homeSessionId != null) warnings.push(`${at}/agent.json: "homeSessionId" is instance-local and will be ignored`);
      for (const k of ['token', 'secret', 'password', 'apiKey', 'api_key']) if (k in r) errors.push(`${at}/agent.json: "${k}" — agents must not carry secrets`);
      if (Array.isArray(r.skills))
        for (const sk of r.skills as string[])
          if (!bundleSkills.has(sk) && !shippedSkills.has(sk))
            warnings.push(`${at}: references skill "${sk}" that is neither in this bundle nor shipped — it is dropped on hosts that do not have it`);
    }
    if (a.persona.length > AGENT_PERSONA_MAX) errors.push(`${at}/persona.md exceeds ${AGENT_PERSONA_MAX} chars (keep it to ~20 lines)`);
    for (const f of a.assets) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(f)) errors.push(`${at}/assets/${f}: unsafe file name`);
      else if (fs.statSync(path.join(a.dir, 'assets', f)).size > AGENT_ASSET_MAX_BYTES) errors.push(`${at}/assets/${f} exceeds ${AGENT_ASSET_MAX_BYTES} bytes`);
    }
  }
  if (!b.readme) warnings.push('README.md missing');
  if (!b.trusted && b.skills.length) warnings.push(`${b.skills.length} skill(s) from an external bundle will be staged as pending proposals`);
  return { ok: errors.length === 0, errors, warnings };
}

/** Names of the skills shipped with the repo (<repo>/skills/<name>/SKILL.md) — no host modules needed. */
function shippedSkillNames(): string[] {
  try {
    const root = path.join(REPO_ROOT, 'skills');
    return fs.readdirSync(root).filter((n) => SKILL_NAME_RE.test(n) && fs.existsSync(path.join(root, n, 'SKILL.md')));
  } catch {
    return [];
  }
}

// ---- sources ----------------------------------------------------------------

export interface ResolvedSource {
  dir: string;
  source: string;
  fetched: boolean;
}

function gitClone(url: string, dest: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const attempt = (args: string[]) =>
    spawnSync('git', ['clone', ...args, '--quiet', url, dest], {
      encoding: 'utf8',
      env: gitEnvFor(url),
      timeout: 120_000,
    });
  let r = attempt(['--depth', '1']);
  // K8S-3: a bundle can live on a static file host (dumb HTTP transport —
  // git's fallback protocol; e.g. a bare repo behind any web server), which
  // cannot serve shallow clones. Bundles are small — retry full.
  if (r.status !== 0 && /shallow/i.test(r.stderr || '')) {
    fs.rmSync(dest, { recursive: true, force: true });
    r = attempt([]);
  }
  if (r.status !== 0) throw new Error(`git clone failed: ${(r.stderr || r.stdout || '').trim().split('\n').pop() || 'unknown error'}`);
}

export const GIT_REF_RE = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/;
export const COMMIT_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** The local checkout a git-URL bundle lives in ($ARIGAMI_DIR/profiles/<name>). */
export function bundleCheckoutDir(url: string): string {
  const name = nameFromUrl(url);
  if (!BUNDLE_NAME_RE.test(name)) throw new Error(`cannot derive a bundle name from ${url}`);
  return path.join(USER_BUNDLES_DIR, name);
}

/**
 * Put the git bundle at `url` on `ref` (tag / branch / sha; empty = the remote's default branch) and, when `commit`
 * is given, on exactly that commit — the control-plane resolves a moving ref ONCE and rolls the same commit to every
 * tenant, so a branch that moves mid-rollout cannot hand two tenants two different profiles. Auth is the header from
 * lib/git-auth.ts (never the URL). Leaves the checkout detached; returns the commit it ended on.
 */
export function checkoutBundleRef(url: string, ref = '', commit = ''): { dir: string; commit: string } {
  if (!isGitUrl(url)) throw new Error('a ref can only be applied to a git bundle source');
  if (ref && !GIT_REF_RE.test(ref)) throw new Error(`not a valid git ref: ${JSON.stringify(ref)}`);
  if (commit && !COMMIT_RE.test(commit)) throw new Error(`not a full commit sha: ${JSON.stringify(commit)}`);
  const dest = bundleCheckoutDir(url);
  if (!isDir(path.join(dest, '.git'))) {
    if (isDir(dest)) throw new Error(`${dest} exists and is not a git checkout — remove it or pass the directory instead`);
    gitClone(url, dest);
  }
  const env = gitEnvFor(url);
  const git = (args: string[], timeout = 120_000) => spawnSync('git', args, { cwd: dest, encoding: 'utf8', env, timeout });
  const tail = (r: ReturnType<typeof git>) => (r.stderr || r.stdout || '').trim().split('\n').pop() || `exit ${r.status}`;
  // Fetch by URL (not `origin`) so the checkout always follows the configured source; shallow first, full when the
  // transport cannot do shallow (a bundle served by a plain static file host — see gitClone).
  const fetch = (what: string) => {
    let r = git(['fetch', '--quiet', '--depth', '1', url, what]);
    if (r.status !== 0 && /shallow|depth/i.test(r.stderr || '')) r = git(['fetch', '--quiet', url, what]);
    return r;
  };
  let target = commit;
  const f = fetch(ref || 'HEAD');
  if (f.status !== 0 && !commit) throw new Error(`git fetch ${ref || 'HEAD'} failed: ${tail(f)}`);
  if (!commit) target = 'FETCH_HEAD';
  // The ref moved on since the control-plane resolved it (or names nothing fetchable): fetch the commit itself.
  else if (git(['cat-file', '-e', `${commit}^{commit}`]).status !== 0) {
    const fc = fetch(commit);
    if (fc.status !== 0) throw new Error(`git fetch ${commit} failed: ${tail(fc)}`);
  }
  const co = git(['checkout', '--quiet', '--force', '--detach', target]);
  if (co.status !== 0) throw new Error(`git checkout ${ref || commit || 'HEAD'} failed: ${tail(co)}`);
  git(['clean', '-ffdxq']); // a file the new commit deleted must not linger in the bundle
  const head = git(['rev-parse', 'HEAD']).stdout.trim();
  if (commit && head !== commit) throw new Error(`checked out ${head}, expected ${commit}`);
  return { dir: dest, commit: head };
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
      spawnSync('git', ['pull', '--ff-only', '--quiet'], { cwd: dest, encoding: 'utf8', env: gitEnvFor(source), timeout: 60_000 });
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
  agents: string[];
  extensions: string[];
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
    agents: b.agents.map((a) => a.slug),
    extensions: b.extensions.map((x) => x.name),
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
        out.push({ name: n, dir: d, trusted: false, skills: [], cron: 0, agents: [], extensions: [], hasMemorySeed: false, valid: false, errors: [(e as Error).message] });
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
  /** A4: overwrite an EXISTING agent's record/persona/assets with the bundle's (default: leave the user's edits alone). */
  force?: boolean;
  /** Register `scope: org` cron jobs (this host IS the organisation host). Also ARIGAMI_ORG_HOST=1. */
  orgHost?: boolean;
  sessionId?: string;
  /** git ref/commit the bundle was checked out at — recorded in the provenance (checkoutBundleRef) */
  ref?: string;
  commit?: string;
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
    extensions: [],
    agents: [],
    ...(opts.ref ? { ref: opts.ref } : {}),
    ...(opts.commit ? { commit: opts.commit } : {}),
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

  // 2b. agents → $ARIGAMI_DIR/agents/<slug> (A4). User data: created only when
  // absent; an existing agent is the user's and is left untouched (report
  // 'unchanged') unless `force`. Skills the agent references must exist on
  // THIS host (bundle skills were staged just above; on an external bundle
  // they are still pending) — unknown ones are dropped and reported, never a
  // failure. Assets are copied when missing (all of them under force).
  if (b.agents.length) {
    const ag = await import('./agents.js');
    const sk = await import('./skills.js');
    for (const a of b.agents) {
      const rec = a.record as Record<string, any>;
      const wanted: string[] = Array.isArray(rec.skills) ? rec.skills.map(String) : [];
      const skills = wanted.filter((n) => sk.isSkillDir(n));
      const skippedSkills = wanted.filter((n) => !sk.isSkillDir(n));
      const input = {
        slug: a.slug,
        name: String(rec.name || a.slug),
        ...(rec.emoji ? { emoji: String(rec.emoji) } : {}),
        ...(rec.color ? { color: String(rec.color) } : {}),
        ...(rec.model ? { model: String(rec.model) } : {}),
        skills,
        ...(Array.isArray(rec.tools) ? { tools: rec.tools.map(String) } : {}),
        ...(Array.isArray(rec.domains) ? { domains: rec.domains.map(String) } : {}),
        ...(rec.budget && typeof rec.budget === 'object' ? { budget: { tokensPerDay: Number(rec.budget.tokensPerDay) || 0 } } : {}),
        ...(Array.isArray(rec.autoApprove) ? { autoApprove: rec.autoApprove.map(String) } : {}),
        persona: a.persona,
      };
      const existing = ag.getAgent(a.slug);
      let status: ApplyReport['agents'][number]['status'];
      if (existing && !opts.force) status = 'unchanged';
      else {
        const r = existing ? ag.updateAgent(a.slug, input) : ag.createAgent(input);
        if (!r.ok) {
          report.agents.push({ slug: a.slug, status: 'error', error: r.error, ...(skippedSkills.length ? { skippedSkills } : {}) });
          continue;
        }
        status = existing ? 'updated' : 'created';
      }
      let copied = 0;
      if (a.assets.length) {
        const dest = path.join(ag.agentDir(a.slug), 'assets');
        fs.mkdirSync(dest, { recursive: true });
        for (const f of a.assets) {
          const to = path.join(dest, f);
          if (fs.existsSync(to) && !opts.force) continue;
          fs.copyFileSync(path.join(a.dir, 'assets', f), to);
          copied++;
        }
      }
      report.agents.push({ slug: a.slug, status, ...(copied ? { assets: copied } : {}), ...(skippedSkills.length && status !== 'unchanged' ? { skippedSkills } : {}) });
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

  // 3b. extensions → installed / updated from the bundle (a trusted bundle only: they run code)
  if (b.extensions.length) {
    const ex = await import('./extensions.js');
    report.extensions = [];
    for (const x of b.extensions) {
      if (!b.trusted) {
        report.extensions.push({ name: x.name, status: 'skipped', error: 'external bundle — extensions run code and are installed only from a trusted bundle' });
        continue;
      }
      try {
        // deps: a trusted bundle's extensions may `bun install` what their package.json declares
        // (lifecycle scripts off). Offline is not an apply error — the extension carries the status.
        const r = await ex.installOrUpdateExtension({ name: x.name, dir: x.dir, source: x.source, ref: x.ref }, { trust: true, deps: true });
        const deps = r.deps && r.deps.status !== 'none' ? { deps: r.deps.ok ? ('ok' as const) : ('missing' as const), ...(r.deps.ok ? {} : { depsError: r.deps.error }) } : {};
        if (!r.ok) {
          report.extensions.push({ name: x.name, status: r.status === 'installed' ? 'installed' : 'error', error: r.error, ...deps });
          if (!r.status) report.errors.push(`extension "${x.name}": ${r.error}`);
        } else {
          report.extensions.push({ name: x.name, status: r.status!, ...(r.sha ? { sha: r.sha } : {}), ...deps });
        }
        // seed settings once; a user's own edits are never overwritten
        if (x.settings && Object.keys(x.settings).length && r.status && ex.readState().settings[x.name] === undefined) await ex.patchExtension(x.name, { settings: x.settings });
      } catch (e) {
        report.extensions.push({ name: x.name, status: 'error', error: (e as Error).message });
        report.errors.push(`extension "${x.name}": ${(e as Error).message}`);
      }
    }
  }

  // 4. cron → triggers (disabled unless enabled:true on a trusted bundle).
  // Idempotent (F4 #2): a trigger is identified by its bundleKey ("<bundle>/
  // <slug>", carried through export → import), falling back to the tagged
  // name and then to an untagged same-name+same-prompt trigger (hand-made,
  // exported, imported back). A match is UPDATED (prompt/schedule/name), never
  // duplicated; its enabled state is left alone.
  if (!opts.skipCron && b.cron.length) {
    const tr = await import('./triggers.js');
    const ag = await import('./agents.js');
    // A4: the run is born from the bundle's agent when the host has it (created just above).
    const agentFor = (c: BundleCron): string | undefined => (c.agent && ag.getAgent(c.agent) ? c.agent : undefined);
    const existing = tr.listTriggers().filter((t: any) => t.type === 'cron') as any[];
    const claimed = new Set<string>();
    const orgHost = opts.orgHost === true || process.env.ARIGAMI_ORG_HOST === '1';
    for (const c of b.cron) {
      const tag = `[${b.manifest.name}] ${c.name || 'cron'}`;
      // An org-wide job must run once, not once per tenant: only the designated org host registers it.
      if (c.scope === 'org' && !orgHost) {
        (report.cronSkipped ||= []).push({ name: tag, reason: 'scope: org — runs on the organisation host only (ARIGAMI_ORG_HOST=1)' });
        continue;
      }
      const key = typeof c.key === 'string' && c.key ? c.key : cronBundleKey(b.manifest.name, c.name || 'cron');
      const plain = String(c.name || 'cron').replace(CRON_TAG_RE, '');
      const found =
        existing.find((t) => !claimed.has(t.id) && t.bundleKey === key) ||
        existing.find((t) => !claimed.has(t.id) && t.name === tag) ||
        existing.find((t) => !claimed.has(t.id) && !t.bundleKey && String(t.name).replace(CRON_TAG_RE, '') === plain && String(t.prompt).trim() === String(c.prompt).trim());
      if (found) {
        claimed.add(found.id);
        try {
          const patch: Record<string, unknown> = { bundleKey: key };
          if (typeof c.folderName === 'string') patch.folderName = c.folderName;
          if (String(found.prompt).trim() !== String(c.prompt).trim()) patch.prompt = c.prompt;
          if (agentFor(c) && found.agent !== agentFor(c)) patch.agent = agentFor(c);
          if (found.schedule?.kind !== c.schedule.kind || String(found.schedule?.value ?? '') !== String(c.schedule.value)) patch.schedule = { kind: c.schedule.kind, value: String(c.schedule.value) };
          if (found.name !== tag && !/^\[/.test(String(found.name))) patch.name = tag; // adopt the tag on a hand-made trigger, keep an earlier bundle's tag
          const t = tr.patchTrigger(found.id, patch) || found;
          report.cron.push({ id: t.id, name: t.name, enabled: !!t.enabled });
        } catch (e) {
          report.errors.push(`cron "${tag}": ${(e as Error).message}`);
        }
        continue;
      }
      try {
        const t = await tr.createCronTrigger({
          name: tag,
          prompt: c.prompt,
          schedule: { kind: c.schedule.kind, value: String(c.schedule.value) },
          sessionMode: c.sessionMode,
          folderName: c.folderName,
          deliver: c.deliver,
          autonomous: !!c.autonomous && b.trusted,
          bundleKey: key,
          agent: agentFor(c),
        });
        claimed.add(t.id);
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
  if (prev) history.push({ name: prev.name, version: prev.version, source: prev.source, appliedAt: prev.appliedAt, ...(prev.commit ? { commit: prev.commit } : {}) });
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

// K8S-1 (PRD-ARIGAMI-K8S.md §2/§4.1): a Kubernetes provisioner (or anyone
// launching the image with no TTY at all — a plain `docker run -e
// ARIGAMI_BUNDLE=…`) has no wizard and no host bearer token to call
// `POST /__api/profiles/apply` with, so env is the only channel it has. This
// is the same `applySource` the wizard/CLI use, just triggered by env instead
// of a human — and gated on PROVENANCE_FILE so it only ever fires on a truly
// fresh $ARIGAMI_DIR: once a bundle (this one, a different one via `host
// profile apply`, or the wizard) has landed, later restarts are a no-op, the
// same way `--unattended` precompletion only runs once (onboarding.ts).
export async function applyBundleEnv(): Promise<ApplyReport | null> {
  const source = process.env.ARIGAMI_BUNDLE;
  if (!source) return null;
  if (fs.existsSync(PROVENANCE_FILE)) return null;
  // K8S-3: the env-supplied bundle is TRUSTED — same level as a shipped one.
  // Whoever set this env var controls the pod spec / machine (the org's
  // control-plane, a `docker run -e` operator) and could ship anything
  // anyway; the pending-proposal gate exists to protect a user from bundles
  // handed to them mid-flight, not from their own platform operator. This is
  // what makes an org tenant boot with the company's skills ACTIVE and its
  // cron jobs (marked enabled) actually running, instead of a cockpit full
  // of approval prompts on first sign-in.
  //
  // ARIGAMI_BUNDLE_REF (tag/branch/sha) pins the first boot to the profile
  // version the control-plane is rolling out; later versions arrive through
  // the trusted re-apply (server/profile-rollout.ts), not through a restart.
  const ref = String(process.env.ARIGAMI_BUNDLE_REF || '').trim();
  if (isGitUrl(source)) {
    const co = checkoutBundleRef(source, ref, COMMIT_RE.test(ref) ? ref : '');
    return applyBundle({ ...loadBundle(co.dir, source), trusted: true }, { ...(ref ? { ref } : {}), commit: co.commit });
  }
  const r = resolveSource(source);
  const b = loadBundle(r.dir, r.source);
  return applyBundle({ ...b, trusted: true });
}

// ---- CLI (bin/host profile …) -------------------------------------------------
// bun server/profiles.ts list|validate <src>|apply <src> [--skip-cron] [--force]|pending <src>|current
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
      const force = rest.includes('--force');
      if (!skipCron) (await import('./triggers.js')).load();
      const rep = await applySource(arg, { skipCron, force });
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
      process.stderr.write('usage: bun server/profiles.ts list | validate <src> | apply <src> [--skip-cron] [--force] | pending <src> | current\n');
      process.exitCode = 2;
    }
  } catch (e) {
    process.stderr.write(`error: ${(e as Error).message}\n`);
    process.exitCode = 1;
  }
}
