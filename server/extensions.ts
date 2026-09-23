// EXT — the extension loader and registry.
//
// An extension is a directory the USER owns; the host loads it at RUNTIME. No
// core build, no `git pull` inside /opt/arigami, no restart: the manifest is
// read on boot / on reload, `listener.ts` and `hooks.ts` are `await import()`ed
// (Bun runs TS directly), tool servers are spawned per session from
// `--mcp-config`, docs are generated into a third `--plugin-dir`, and `ui/` is
// served as static files. See docs/EXTENSIONS.md and sdk/README.md.
//
//   $ARIGAMI_DIR/user/                 the user's OWN git repo (git init on first boot)
//     extensions/<name>/               manifest.json, ui/, listener.ts, tools/, docs/, hooks.ts
//     skills/                          $ARIGAMI_DIR/skills becomes a symlink here (one-time, idempotent)
//     mcp-catalog.json                 optional extra McpServerSpec rows
//     node_modules/@arigami/sdk        → <repo>/sdk (so `import '@arigami/sdk'` needs no install)
//   $ARIGAMI_DIR/extensions.json       host-owned state, 0600: enabled/settings/secrets/sha
//   $ARIGAMI_DIR/ext-plugin/           generated Claude Code plugin (the 3rd --plugin-dir)
//
// Trust model, stated once: extension code runs IN-PROCESS with the host's
// privileges — the same trust you already give a skill with Bash or an MCP
// server you added by hand. What the host does add is a deadline on every
// provider call, an incident on every failure, per-extension enable/disable,
// and the fact that nothing is ever auto-downloaded or auto-updated.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { ARIGAMI_DIR } from './lib/instance.js';
import { migrateFile, stamp, SchemaVersionError } from './lib/schema-version.js';
import { EXTENSIONS_SCHEMA } from './lib/state-schemas.js';
import { resourceRoot } from './lib/resource-root.js';
import { linkDir } from './lib/platform.js';
import { bunExec } from './lib/bun-exec.js';
import { appendIncident } from './incidents.js';
import { broadcast, emitLocal, subscribe } from './bus.js';
import * as registry from './listeners-registry.js';
import type {
  Manifest,
  ManifestDoc,
  ManifestTool,
  HookCtx,
  GateResult,
  Hooks,
  NotifyPayload,
  ListenerCtx,
} from './lib/ext-types.js';

const REPO_ROOT = resourceRoot();

/** The apiVersion this host implements. A manifest with a different MAJOR is refused. */
export const EXT_API_VERSION = 1;

export const USER_DIR = path.join(ARIGAMI_DIR, 'user');
export const EXT_DIR = path.join(USER_DIR, 'extensions');
// Where importFresh() stages a throwaway copy of an extension. Under user/ so
// `@arigami/sdk` still resolves by walking up, and OUTSIDE extensions/ so a
// staged copy is never mistaken for an installed extension.
const RELOAD_DIR = path.join(USER_DIR, '.arigami-reload');
export const USER_SKILLS_TARGET = path.join(USER_DIR, 'skills');
export const USER_MCP_CATALOG = path.join(USER_DIR, 'mcp-catalog.json');
export const EXT_STATE_FILE = path.join(ARIGAMI_DIR, 'extensions.json');

// Forward-migration of extensions.json (lib/schema-version.ts), run once on the
// first read. A file from a NEWER build is refused: we report "no extensions"
// (loudly, once) and BLOCK every write, so the human's enable flags, settings
// and secrets survive untouched for the build that wrote them. Unlike
// state.json/config.json this does not take the host down — an unreadable
// extension state costs the extensions, not the cockpit.
let extMigrated = false;
let extRefused = false;
function ensureExtMigrated(): void {
  if (extMigrated) return;
  extMigrated = true;
  try {
    migrateFile(EXT_STATE_FILE, EXTENSIONS_SCHEMA);
  } catch (e) {
    if (e instanceof SchemaVersionError) {
      extRefused = true;
      console.error(`[ext] ${e.message} Extensions are disabled this boot and extensions.json will not be written.`);
      return;
    }
    throw e;
  }
}
export const EXT_PLUGIN_DIR = path.join(ARIGAMI_DIR, 'ext-plugin');
/** Legacy location of the user skill pack — becomes a symlink into user/ (§1). */
export const LEGACY_SKILLS_DIR = path.join(ARIGAMI_DIR, 'skills');
const LOG_DIR = path.join(ARIGAMI_DIR, 'logs');

export const EXT_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
// `host:create-session` is deliberately in the `host:` namespace and not
// `session:` — every other permission here scopes a tab to the ONE session it
// already lives in, and this one does the opposite: it spawns a new agent
// process, with whatever permissionMode the caller asks for. It is the
// strongest grant an extension can hold, so it reads differently in the
// install dialog instead of hiding among its neighbours.
const KNOWN_PERMISSIONS = ['session:message', 'session:prompts', 'session:tabs', 'session:artifacts', 'session:listeners', 'session:inbox', 'host:create-session', 'notify'];
/** Surfaces a manifest tab may ask for. `slash:<name>` is matched separately. */
const KNOWN_OPEN_FROM = ['tab-bar', 'launcher'];
const GATE_NAMES = ['merge.before'];
/** A gate blocks a human's merge — generous, but never forever. */
const GATE_TIMEOUT_MS = 5 * 60_000;
const HOOK_TIMEOUT_MS = 60_000;
const MTIME_POLL_MS = 30_000;

// ---------------------------------------------------------------------------
// logging (per extension, never secrets)
// ---------------------------------------------------------------------------
function extLog(name: string, msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(path.join(LOG_DIR, `ext-${name}.log`), line);
  } catch {
    /* logging must never break a load */
  }
}
// STDERR on purpose: this module is also a CLI (`bun server/extensions.ts …`,
// behind `bin/host ext`) whose STDOUT is a JSON document. Progress lines on
// stdout would corrupt it — and the host captures both streams anyway.
const hostLog = (msg: string) => process.stderr.write(`[ext] ${msg}\n`);

// ---------------------------------------------------------------------------
// §1 — the user repo: $ARIGAMI_DIR/user
// ---------------------------------------------------------------------------
const GITIGNORE = ['node_modules/', '*.sqlite', '*.sqlite-*', '.env', '.env.*', '*.log', '.arigami-reload.*', '.arigami-reload/', ''].join('\n');

function isDir(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}
function isRealDir(p: string): boolean {
  try { return fs.lstatSync(p).isDirectory(); } catch { return false; }
}
function isSymlink(p: string): boolean {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; }
}
function exists(p: string): boolean {
  try { fs.lstatSync(p); return true; } catch { return false; }
}

function git(args: string[], cwd: string, timeout = 60_000) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, timeout });
}

/**
 * Make sure $ARIGAMI_DIR/user exists, is a git repo, and owns the skill pack.
 * Idempotent, logged, and NEVER deletes anything: the one destructive-looking
 * step (turning $ARIGAMI_DIR/skills into a symlink) either renames the real
 * directory into user/skills, or — when both exist — copies the dirs that are
 * missing and moves the old one aside as skills.replaced-<ts>.
 */
export function ensureUserRepo(): { ok: boolean; steps: string[] } {
  const steps: string[] = [];
  try {
    if (!isDir(USER_DIR)) { fs.mkdirSync(USER_DIR, { recursive: true }); steps.push('created user/'); }
    fs.mkdirSync(EXT_DIR, { recursive: true });

    const gi = path.join(USER_DIR, '.gitignore');
    if (!fs.existsSync(gi)) { fs.writeFileSync(gi, GITIGNORE); steps.push('wrote user/.gitignore'); }

    if (!isDir(path.join(USER_DIR, '.git'))) {
      const r = git(['init', '--quiet'], USER_DIR);
      if (r.status === 0) steps.push('git init user/');
      else steps.push(`git init failed: ${(r.stderr || '').trim().slice(0, 120)}`);
    }

    steps.push(...migrateSkills());
    steps.push(...ensureSdkLink());
  } catch (e) {
    steps.push(`error: ${(e as Error).message}`);
    for (const s of steps) hostLog(s);
    return { ok: false, steps };
  }
  for (const s of steps) hostLog(s);
  return { ok: true, steps };
}

/** $ARIGAMI_DIR/skills → user/skills. Four cases, all idempotent, none destructive. */
function migrateSkills(): string[] {
  const steps: string[] = [];
  // already migrated?
  if (isSymlink(LEGACY_SKILLS_DIR)) {
    let target = '';
    try { target = fs.readlinkSync(LEGACY_SKILLS_DIR); } catch {}
    if (path.resolve(path.dirname(LEGACY_SKILLS_DIR), target) === USER_SKILLS_TARGET) {
      fs.mkdirSync(USER_SKILLS_TARGET, { recursive: true });
      return steps; // nothing to say — the steady state
    }
    steps.push(`skills: $ARIGAMI_DIR/skills is a symlink to ${target} (not user/skills) — left alone`);
    return steps;
  }

  if (!exists(LEGACY_SKILLS_DIR)) {
    fs.mkdirSync(USER_SKILLS_TARGET, { recursive: true });
    linkDir(USER_SKILLS_TARGET, LEGACY_SKILLS_DIR);
    steps.push('skills: created user/skills and linked $ARIGAMI_DIR/skills → user/skills');
    return steps;
  }

  if (!isRealDir(LEGACY_SKILLS_DIR)) {
    steps.push(`skills: $ARIGAMI_DIR/skills exists and is not a directory — migration skipped`);
    return steps;
  }

  if (!exists(USER_SKILLS_TARGET)) {
    fs.renameSync(LEGACY_SKILLS_DIR, USER_SKILLS_TARGET);
    linkDir(USER_SKILLS_TARGET, LEGACY_SKILLS_DIR);
    steps.push('skills: moved $ARIGAMI_DIR/skills → user/skills and linked it back');
    return steps;
  }

  // Both exist: copy only what user/skills does NOT have, then park the old one.
  const copied: string[] = [];
  for (const d of fs.readdirSync(LEGACY_SKILLS_DIR)) {
    const from = path.join(LEGACY_SKILLS_DIR, d);
    const to = path.join(USER_SKILLS_TARGET, d);
    if (exists(to) || !isRealDir(from)) continue;
    fs.cpSync(from, to, { recursive: true });
    copied.push(d);
  }
  const parked = `${LEGACY_SKILLS_DIR}.replaced-${Date.now()}`;
  fs.renameSync(LEGACY_SKILLS_DIR, parked);
  linkDir(USER_SKILLS_TARGET, LEGACY_SKILLS_DIR);
  steps.push(
    `skills: merged ${copied.length} missing skill(s) into user/skills${copied.length ? ` (${copied.join(', ')})` : ''}; ` +
      `kept the old directory as ${path.basename(parked)}; linked $ARIGAMI_DIR/skills → user/skills`
  );
  return steps;
}

/** user/node_modules/@arigami/sdk → <repo>/sdk, so extensions import the SDK with no install. */
function ensureSdkLink(): string[] {
  const dir = path.join(USER_DIR, 'node_modules', '@arigami');
  const link = path.join(dir, 'sdk');
  const target = path.join(REPO_ROOT, 'sdk');
  try {
    fs.mkdirSync(dir, { recursive: true });
    let ok = false;
    try { ok = isSymlink(link) && path.resolve(path.dirname(link), fs.readlinkSync(link)) === target; } catch {}
    if (ok) return [];
    if (exists(link)) fs.rmSync(link, { recursive: true, force: true });
    linkDir(target, link);
    return ['linked user/node_modules/@arigami/sdk → <repo>/sdk'];
  } catch (e) {
    return [`@arigami/sdk link failed: ${(e as Error).message}`];
  }
}

// ---- autoCommit -------------------------------------------------------------
let commitTimer: NodeJS.Timeout | null = null;
let pendingReasons: string[] = [];

/**
 * Commit whatever changed in the user repo, debounced 5s and coalesced. The
 * user's own name/email is used when git has one; otherwise a neutral identity
 * is passed with -c so a fresh box still gets versioned history.
 */
export function autoCommit(reason: string): void {
  pendingReasons.push(reason);
  if (commitTimer) return;
  commitTimer = setTimeout(() => {
    commitTimer = null;
    const reasons = [...new Set(pendingReasons)];
    pendingReasons = [];
    doCommit(reasons.join(', '));
  }, 5_000);
  if (typeof commitTimer.unref === 'function') commitTimer.unref();
}

/** The synchronous half of autoCommit — also used by tests and `bin/host ext`. */
export function doCommit(reason: string): boolean {
  try {
    if (!isDir(path.join(USER_DIR, '.git'))) return false;
    const st = git(['status', '--porcelain'], USER_DIR, 20_000);
    if (st.status !== 0 || !(st.stdout || '').trim()) return false;
    git(['add', '-A'], USER_DIR, 30_000);
    const r = git(
      ['-c', 'user.name=Arigami', '-c', 'user.email=arigami@localhost', 'commit', '-q', '-m', `arigami: ${reason}`],
      USER_DIR,
      30_000
    );
    if (r.status !== 0) {
      hostLog(`autoCommit failed: ${(r.stderr || r.stdout || '').trim().slice(0, 200)}`);
      return false;
    }
    hostLog(`user repo committed: ${reason}`);
    return true;
  } catch (e) {
    hostLog(`autoCommit failed: ${(e as Error).message}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// extensions.json — host-owned state (enable, settings, secrets, sha)
// ---------------------------------------------------------------------------
export interface ExtState {
  enabled: Record<string, boolean>;
  settings: Record<string, Record<string, unknown>>;
  secrets: Record<string, Record<string, string>>;
  sha: Record<string, string>;
  /**
   * The TRUSTED tier, per extension — granted by a human, never by a manifest.
   * `manifest.trusted` alone is only a REQUEST: the loader serves a tab
   * unsandboxed only when this map also says so, which is what stops a
   * `git pull` (or `ext update`) from silently escalating an installed
   * extension into the cockpit's own origin.
   */
  trusted: Record<string, boolean>;
  /** One-shot migrations the host has already run (id → true). */
  migrated: Record<string, boolean>;
}
const EMPTY_STATE: ExtState = { enabled: {}, settings: {}, secrets: {}, sha: {}, trusted: {}, migrated: {} };

const objOf = (v: unknown): Record<string, any> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as any) : {});

export function readState(): ExtState {
  ensureExtMigrated();
  if (extRefused) return { enabled: {}, settings: {}, secrets: {}, sha: {}, trusted: {}, migrated: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(EXT_STATE_FILE, 'utf8'));
    return {
      enabled: objOf(raw?.enabled),
      settings: objOf(raw?.settings),
      secrets: objOf(raw?.secrets),
      sha: objOf(raw?.sha),
      // Absent in a state file written before the trusted tier existed — which
      // is exactly right: nothing is trusted until a human says so.
      trusted: objOf(raw?.trusted),
      migrated: objOf(raw?.migrated),
    };
  } catch {
    return { enabled: {}, settings: {}, secrets: {}, sha: {}, trusted: {}, migrated: {} };
  }
}

export function writeState(s: ExtState): void {
  ensureExtMigrated();
  if (extRefused) return;
  fs.mkdirSync(path.dirname(EXT_STATE_FILE), { recursive: true });
  fs.writeFileSync(EXT_STATE_FILE, JSON.stringify(stamp(s as unknown as Record<string, unknown>, EXTENSIONS_SCHEMA), null, 2), { mode: 0o600 });
  try { fs.chmodSync(EXT_STATE_FILE, 0o600); } catch {}
}

/** Settings = manifest defaults, overridden by whatever the human saved. */
function settingsFor(m: Manifest | null, st: ExtState): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const schema = m?.settings?.schema || {};
  for (const [k, def] of Object.entries(schema)) if (def && 'default' in def) out[k] = def.default;
  Object.assign(out, st.settings[m?.name || ''] || {});
  return out;
}

// ---------------------------------------------------------------------------
// manifest parsing + validation (pure — no side effects, no imports executed
// except the listener/hooks probe, which is what `validate` is for)
// ---------------------------------------------------------------------------
export interface ValidateResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  manifest?: Manifest;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

export function parseManifest(dir: string): { manifest?: Manifest; error?: string } {
  const file = path.join(dir, 'manifest.json');
  let raw: string;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return { error: `no manifest.json in ${dir}` }; }
  try { return { manifest: JSON.parse(raw) as Manifest }; } catch (e) { return { error: `manifest.json is not valid JSON: ${(e as Error).message}` }; }
}

/** Path inside the extension dir, traversal-checked. Returns null when it escapes. */
function insideDir(dir: string, rel: string): string | null {
  const full = path.normalize(path.join(dir, rel));
  return full === dir || full.startsWith(dir + path.sep) ? full : null;
}

export async function validateExtension(dir: string): Promise<ValidateResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const { manifest: m, error } = parseManifest(dir);
  if (!m) return { ok: false, errors: [error || 'unreadable manifest'], warnings };

  if (!EXT_NAME_RE.test(str(m.name))) errors.push('name must match ^[a-z0-9][a-z0-9-]*$');
  else if (path.basename(dir) !== m.name) warnings.push(`directory is "${path.basename(dir)}" but the manifest name is "${m.name}"`);
  if (!str(m.version)) errors.push('version is required');
  const major = Math.floor(Number(m.apiVersion));
  if (!Number.isFinite(major)) errors.push('apiVersion is required (a number)');
  else if (major !== EXT_API_VERSION) errors.push(`apiVersion ${m.apiVersion} is not supported by this host (needs ${EXT_API_VERSION})`);
  else if (Number(m.apiVersion) > EXT_API_VERSION) warnings.push(`apiVersion ${m.apiVersion} is newer than this host's ${EXT_API_VERSION} — unknown features are ignored`);

  // The trusted tier is a REQUEST here, nothing more — whether it is granted is
  // read from extensions.json by the loader (see loadOne).
  if (m.trusted !== undefined && typeof m.trusted !== 'boolean') errors.push('trusted must be true or false');
  else if (m.trusted === true && !(m.tabs || []).length) warnings.push('trusted is only about tabs, and this manifest declares none');

  const file = (rel: string, what: string) => {
    const full = rel ? insideDir(dir, rel) : null;
    if (!full) { errors.push(`${what}: "${rel}" is outside the extension directory`); return null; }
    if (!fs.existsSync(full)) { errors.push(`${what}: file not found — ${rel}`); return null; }
    return full;
  };

  for (const t of m.tabs || []) {
    if (!str(t.id)) errors.push('tabs[]: id is required');
    if (!str(t.title)) errors.push(`tabs[${t.id}]: title is required`);
    const full = file(str(t.entry), `tabs[${t.id}].entry`);
    if (full && !full.startsWith(path.join(dir, 'ui') + path.sep)) errors.push(`tabs[${t.id}].entry must live under ui/`);
    // A warning and not an error: openFrom was pass-through until launcher
    // tabs existed, so a manifest written against an older host may carry a
    // value this one has never heard of, and refusing to load it would be a
    // downgrade. Naming it is still worth doing — an unnoticed typo here is a
    // tab that simply never appears anywhere.
    for (const from of t.openFrom || []) {
      const v = String(from || '').trim();
      if (!v) continue;
      if (KNOWN_OPEN_FROM.includes(v) || /^slash:\/?[\w:-]+$/.test(v)) continue;
      warnings.push(
        `tabs[${t.id}].openFrom: "${v}" is not a surface this host offers (${KNOWN_OPEN_FROM.join(', ')}, slash:<name>) — the tab will not appear there`
      );
    }
    // The launcher surface exists to create sessions. A tab that asks for it
    // without the permission renders, and then every button on it fails at the
    // last step — say so at validate time instead.
    if ((t.openFrom || []).includes('launcher') && !(m.permissions || []).includes('host:create-session'))
      warnings.push(
        `tabs[${t.id}] opens from the launcher but the manifest does not request "host:create-session" — it will be able to list and pick, but not to start anything`
      );
  }

  for (const d of m.docs || []) {
    if (!SKILL_NAME_RE.test(str(d.skill))) errors.push(`docs[]: skill "${d.skill}" must match ^[a-z0-9][a-z0-9-]*$`);
    if (!str(d.description).trim()) errors.push(`docs[${d.skill}]: description is required — it is the "when to use" text Claude reads`);
    file(str(d.file), `docs[${d.skill}].file`);
  }

  for (const t of (m.tools || []) as ManifestTool[]) {
    if (!str(t.name)) errors.push('tools[]: name is required');
    if (t.kind === 'module') file(str((t as any).module), `tools[${t.name}].module`);
    else if (t.kind === 'mcp') { if (!str((t as any).command)) errors.push(`tools[${t.name}]: command is required for kind "mcp"`); }
    else errors.push(`tools[${(t as ManifestTool).name}]: kind must be "mcp" or "module"`);
  }

  for (const w of m.webhooks || []) {
    if (!/^[A-Za-z0-9_.-]{1,32}$/.test(str(w.id))) errors.push(`webhooks[]: id "${w.id}" must be 1-32 chars of [A-Za-z0-9_.-]`);
    if (!(m.listeners || []).some((l) => l.type === w.listener)) errors.push(`webhooks[${w.id}]: no listener of type "${w.listener}" in this manifest`);
  }

  for (const p of m.permissions || []) {
    const known = KNOWN_PERMISSIONS.includes(p) || /^tools:[a-z0-9_-]+$/i.test(p) || /^events:[a-z0-9.*-]+$/i.test(p);
    if (!known) warnings.push(`unknown permission "${p}" — it grants nothing`);
  }

  if (m.daemons?.length) warnings.push(`daemons[] is parsed but NOT run by this host version (${m.daemons.length} declared)`);

  // The only side-effectful check: does the declared export actually exist?
  for (const l of m.listeners || []) {
    if (!str(l.type)) { errors.push('listeners[]: type is required'); continue; }
    if (registry.isBuiltinListenerType(l.type)) { errors.push(`listeners[]: "${l.type}" is a built-in listener type`); continue; }
    const full = file(str(l.module), `listeners[${l.type}].module`);
    if (!full) continue;
    try {
      const mod = await importFresh(full);
      const p = (mod as any)[str(l.export)];
      if (!p) errors.push(`listeners[${l.type}]: ${l.module} has no export "${l.export}"`);
      else if (typeof p.poll !== 'function' || typeof p.register !== 'function') errors.push(`listeners[${l.type}]: export "${l.export}" is not a ListenerProvider (needs register() and poll())`);
      else if (p.type !== l.type) warnings.push(`listeners[${l.type}]: the provider's own type is "${p.type}"`);
    } catch (e) {
      errors.push(`listeners[${l.type}]: importing ${l.module} threw — ${(e as Error).message}`);
    }
  }

  if (m.hooks?.module) {
    const full = file(str(m.hooks.module), 'hooks.module');
    if (full) {
      try {
        const mod = await importFresh(full);
        const h = pickHooks(mod);
        for (const g of m.hooks.gates || []) {
          if (!GATE_NAMES.includes(g)) warnings.push(`hooks.gates: "${g}" is not a gate this host runs (${GATE_NAMES.join(', ')})`);
          else if (typeof h.gates?.[g] !== 'function') errors.push(`hooks.gates: "${g}" is declared but ${m.hooks.module} exports no such gate`);
        }
        for (const ev of m.hooks.events || []) if (typeof h.on?.[ev] !== 'function') warnings.push(`hooks.events: "${ev}" is declared but ${m.hooks.module} has no handler for it`);
      } catch (e) {
        errors.push(`hooks: importing ${m.hooks.module} threw — ${(e as Error).message}`);
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings, manifest: m };
}

function pickHooks(mod: any): Hooks & { channels?: Record<string, any> } {
  const h = mod?.hooks ?? mod?.default ?? mod ?? {};
  return { on: h.on || mod?.on, gates: h.gates || mod?.gates, channels: h.channels || mod?.channels };
}

function mtimeOf(p: string): number {
  try { return Math.floor(fs.statSync(p).mtimeMs); } catch { return 0; }
}

// ---- re-importing a module that changed on disk -----------------------------
// The usual `import(url + '?v=<mtime>')` cache-bust does NOT work under Bun:
// Bun keys its module cache on the resolved PATH and ignores the query, so the
// second import silently returns the FIRST module. A symlink does not help
// either — Bun resolves it to its realpath and hits the same cache entry. (Both
// verified before settling on the below; the spec's `?v=` assumption is a
// Node-ism.)
//
// What does work is a real second file: the loader copies the module next to
// itself under a unique hidden name, imports THAT, and deletes it. Same
// directory, so the module's own relative imports and its `@arigami/sdk`
// resolution (node_modules walk-up from user/) are unaffected.
//
// If even the copy fails (read-only mount), we import the plain path: correct on
// a FRESH host — the first import of a path is always current — and only a LIVE
// reload of that one file would need a restart, which the log then says.
let loadSeq = 0;
let importSeq = 0;

/**
 * Import a module and actually get the version on disk.
 *
 * This used to copy the file to `.arigami-reload.<n>.<file>` BESIDE itself and
 * import that. It worked exactly once per host process and then every later
 * import failed with "Cannot find module" — Bun caches a directory's listing,
 * so a file created in an already-resolved directory is invisible to the
 * resolver. The visible symptom was that the FIRST .ts module a host ever
 * loaded worked and every one after it broke, which meant the shipped `hello`
 * example could not load at all and no extension could contribute a listener
 * or hooks alongside another. Reproduced on a clean master before changing
 * anything.
 *
 * Two things were tried and rejected. A `?v=<n>` query busts nothing — Bun
 * keys its module cache on the resolved path and ignores the query, so an
 * edited file kept serving the old exports, which defeats the entire purpose.
 * Copying into a subdirectory of the extension works, but `cpSync` refuses to
 * copy a directory into itself and a lone file there loses its relative
 * siblings.
 *
 * So: copy the whole extension into a fresh directory per import. A directory
 * that did not exist cannot be in the resolver's cache, and copying the tree
 * keeps `./sibling.ts` working — which the old single-file copy did not: it
 * would happily serve a STALE sibling after an edit. The copy lives under
 * `$ARIGAMI_DIR/user/` so `@arigami/sdk` still resolves by walking up, and
 * NOT under `user/extensions/`, where it would be mistaken for an extension.
 */
async function importFresh(full: string): Promise<any> {
  const extRoot = path.dirname(full).startsWith(EXT_DIR)
    ? path.join(EXT_DIR, path.relative(EXT_DIR, full).split(path.sep)[0])
    : path.dirname(full);
  const rel = path.relative(extRoot, full);
  const shadow = path.join(RELOAD_DIR, `${path.basename(extRoot)}-${loadSeq}-${++importSeq}`);
  try {
    fs.mkdirSync(RELOAD_DIR, { recursive: true });
    fs.cpSync(extRoot, shadow, {
      recursive: true,
      // node_modules would make this expensive for nothing: resolution walks
      // up to user/node_modules anyway.
      filter: (src) => path.basename(src) !== 'node_modules',
    });
  } catch (e) {
    hostLog(`could not shadow ${path.basename(extRoot)} for a fresh import (${(e as Error)?.message}) — an edit needs a host restart`);
    return import(pathToFileURL(full).href);
  }
  try {
    return await import(pathToFileURL(path.join(shadow, rel)).href);
  } finally {
    try { fs.rmSync(shadow, { recursive: true, force: true }); } catch { /* swept next boot */ }
  }
}

/**
 * Sweep staging a crash may have left behind: the whole .arigami-reload dir,
 * plus the `.arigami-reload.*` single files the previous scheme wrote, which
 * are still on disk in any instance that ran the old loader.
 */
function sweepReloadAliases(dir: string): void {
  // Staging from a crashed load. Cheap and unconditional: the directory only
  // ever holds copies, so anything still here is by definition abandoned.
  try { fs.rmSync(RELOAD_DIR, { recursive: true, force: true }); } catch { /* next boot */ }
  const seen = new Set<string>();
  const walk = (d: string, depth: number) => {
    if (depth > 3 || seen.has(d)) return;
    seen.add(d);
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const full = path.join(d, e.name);
      if (e.name.startsWith('.arigami-reload.')) { try { fs.rmSync(full, { force: true }); } catch {} }
      else if (e.isDirectory()) walk(full, depth + 1);
    }
  };
  walk(dir, 0);
}

// ---------------------------------------------------------------------------
// the registry
// ---------------------------------------------------------------------------
export interface ExtEntry {
  name: string;
  dir: string;
  manifest: Manifest | null;
  enabled: boolean;
  state: 'loaded' | 'disabled' | 'error';
  /** the manifest asked for the trusted tier */
  trustRequested: boolean;
  /** …AND the human granted it in extensions.json. Only this serves a tab unsandboxed. */
  trusted: boolean;
  error?: string;
  warnings: string[];
  sha?: string;
  /** newest mtime across the files a reload watches */
  mtime: number;
  contributions: { tools: number; listeners: number; docs: number; tabs: number; hooks: number; gates: number; channels: number; webhooks: number };
  // live, not serialised
  unsubs: (() => void)[];
  gates: Record<string, (ev: any, ctx: HookCtx) => any>;
  channels: Record<string, (p: NotifyPayload, ctx: HookCtx) => any>;
  listenerTypes: string[];
}

const extensions = new Map<string, ExtEntry>();
let loaded = false;
let reloading: Promise<void> | null = null;
let summaryCache = '';

export const isLoaded = () => loaded;
export const getExtension = (name: string): ExtEntry | undefined => extensions.get(name);
export const enabledExtensions = (): ExtEntry[] => [...extensions.values()].filter((e) => e.state === 'loaded');
/** Is this extension served at the TRUSTED tier right now? (ext-serve.ts asks.) */
export const isTrusted = (name: string): boolean => extensions.get(name)?.trusted === true;

/** The wire view (GET /__api/extensions). Never leaks settings values or secrets. */
export function listExtensions() {
  const st = readState();
  return [...extensions.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((e) => ({
      name: e.name,
      version: e.manifest?.version || null,
      title: e.manifest?.title || e.name,
      description: e.manifest?.description || '',
      enabled: e.enabled,
      state: e.state,
      /** the tier the tab is actually served at — 'trusted' needs BOTH the manifest and the state file */
      tier: e.trusted ? 'trusted' : 'sandboxed',
      trusted: e.trusted,
      trustRequested: e.trustRequested,
      error: e.error || null,
      warnings: e.warnings,
      sha: e.sha || null,
      dir: e.dir,
      apiVersion: e.manifest?.apiVersion ?? null,
      permissions: e.manifest?.permissions || [],
      settingsSchema: e.manifest?.settings?.schema || null,
      settings: st.settings[e.name] || {},
      /** which secret KEYS are set — never the values */
      secretKeys: Object.keys(st.secrets[e.name] || {}),
      contributions: e.contributions,
      tabs: (e.manifest?.tabs || []).map((t) => ({ id: t.id, title: t.title, icon: t.icon || null, entry: t.entry, openFrom: t.openFrom || [] })),
      listenerTypes: e.listenerTypes,
      docs: (e.manifest?.docs || []).map((d) => ({ skill: d.skill, description: d.description })),
      toolServers: e.state === 'loaded' ? Object.keys(serversFor(e)) : [],
    }));
}

function dirsIn(root: string): string[] {
  try {
    return fs.readdirSync(root).filter((d) => EXT_NAME_RE.test(d) && fs.existsSync(path.join(root, d, 'manifest.json'))).sort();
  } catch {
    return [];
  }
}

function watchedFiles(dir: string, m: Manifest | null): string[] {
  const out = [path.join(dir, 'manifest.json')];
  if (!m) return out;
  for (const l of m.listeners || []) { const f = insideDir(dir, str(l.module)); if (f) out.push(f); }
  if (m.hooks?.module) { const f = insideDir(dir, str(m.hooks.module)); if (f) out.push(f); }
  for (const d of m.docs || []) { const f = insideDir(dir, str(d.file)); if (f) out.push(f); }
  for (const t of (m.tools || []) as ManifestTool[]) if (t.kind === 'module') { const f = insideDir(dir, str((t as any).module)); if (f) out.push(f); }
  return out;
}

const newestMtime = (files: string[]) => files.reduce((a, f) => Math.max(a, mtimeOf(f)), 0);

function shaOf(dir: string): string | undefined {
  if (!isDir(path.join(dir, '.git'))) return undefined;
  const r = git(['rev-parse', '--short', 'HEAD'], dir, 10_000);
  return r.status === 0 ? (r.stdout || '').trim() : undefined;
}

/** Load one extension into the registry. Never throws — a failure is an `error` entry. */
async function loadOne(name: string, st: ExtState): Promise<ExtEntry> {
  const dir = path.join(EXT_DIR, name);
  const entry: ExtEntry = {
    name,
    dir,
    manifest: null,
    enabled: st.enabled[name] !== false,
    state: 'error',
    trustRequested: false,
    trusted: false,
    warnings: [],
    mtime: 0,
    contributions: { tools: 0, listeners: 0, docs: 0, tabs: 0, hooks: 0, gates: 0, channels: 0, webhooks: 0 },
    unsubs: [],
    gates: {},
    channels: {},
    listenerTypes: [],
  };
  sweepReloadAliases(dir);
  const { manifest, error } = parseManifest(dir);
  entry.manifest = manifest || null;
  entry.mtime = newestMtime(watchedFiles(dir, manifest || null));
  entry.sha = shaOf(dir);
  if (!manifest) { entry.error = error; return entry; }

  if (!entry.enabled) {
    entry.state = 'disabled';
    extLog(name, 'disabled — parsed, contributes nothing');
    return entry;
  }

  const v = await validateExtension(dir);
  entry.warnings = v.warnings;
  if (!v.ok) { entry.error = v.errors.join('; '); return entry; }

  // The trusted tier: the manifest asks, extensions.json decides. A manifest
  // that starts asking (an `ext update`, a hand-edit, a `git pull`) therefore
  // changes nothing on its own — the tab stays sandboxed and the extension
  // carries a warning until a human grants it.
  entry.trustRequested = manifest.trusted === true;
  entry.trusted = entry.trustRequested && st.trusted[name] === true;
  if (entry.trustRequested && !entry.trusted)
    entry.warnings.push(
      'this extension asks for the TRUSTED tier (its tab would run without the sandbox, with your full cockpit session) and this host has not granted it — the tab stays sandboxed. Grant it in Settings › Extensions, or reinstall with `bin/host ext add --trust`.'
    );

  const settings = settingsFor(manifest, st);
  const secrets = st.secrets[name] || {};

  // listeners
  for (const l of manifest.listeners || []) {
    const full = insideDir(dir, str(l.module))!;
    const mod = await importFresh(full);
    const provider = (mod as any)[str(l.export)];
    registry.register(
      {
        ...provider,
        type: l.type,
        schema: provider.schema ?? l.schema,
        fireOn: provider.fireOn ?? l.fireOn,
        defaultIntervalSec: provider.defaultIntervalSec ?? l.defaultIntervalSec,
      },
      { ext: name }
    );
    entry.listenerTypes.push(l.type);
  }
  entry.contributions.listeners = entry.listenerTypes.length;

  // hooks / gates / notification channels
  if (manifest.hooks?.module) {
    const full = insideDir(dir, str(manifest.hooks.module))!;
    const mod = await importFresh(full);
    const h = pickHooks(mod);
    for (const [ev, fn] of Object.entries(h.on || {})) {
      if (typeof fn !== 'function') continue;
      entry.unsubs.push(subscribeHook(name, ev, fn as any));
      entry.contributions.hooks++;
    }
    for (const g of manifest.hooks.gates || []) {
      const fn = h.gates?.[g];
      if (typeof fn === 'function') { entry.gates[g] = fn as any; entry.contributions.gates++; }
    }
    for (const [id, fn] of Object.entries(h.channels || {})) {
      if (typeof fn !== 'function') continue;
      entry.channels[id] = fn as any;
      entry.contributions.channels++;
    }
  }

  entry.contributions.tools = (manifest.tools || []).length;
  entry.contributions.docs = (manifest.docs || []).length;
  entry.contributions.tabs = (manifest.tabs || []).length;
  entry.contributions.webhooks = (manifest.webhooks || []).length;
  entry.state = 'loaded';
  void settings;
  void secrets;
  extLog(
    name,
    `loaded v${manifest.version} [${entry.trusted ? 'TRUSTED — tab runs unsandboxed' : 'sandboxed'}] — ${entry.contributions.tools} tool server(s), ${entry.contributions.listeners} listener type(s), ` +
      `${entry.contributions.docs} doc(s), ${entry.contributions.tabs} tab(s), ${entry.contributions.hooks} hook(s), ${entry.contributions.gates} gate(s)`
  );
  return entry;
}

/** One bus subscription per hook handler; the returned fn is the unsubscribe. */
function subscribeHook(ext: string, event: string, fn: (ev: any, ctx: HookCtx) => any): () => void {
  return subscribe((msg: any) => {
    if (!msg || msg.type !== event) return;
    const { type, ...payload } = msg;
    runHook(ext, event, fn, payload);
  });
}

function runHook(ext: string, event: string, fn: (ev: any, ctx: HookCtx) => any, payload: any): void {
  const ctx = hookCtx(ext);
  Promise.race([
    Promise.resolve().then(() => fn(payload, ctx)),
    new Promise((_, reject) => {
      const t = setTimeout(() => reject(new Error(`hook "${event}" exceeded ${HOOK_TIMEOUT_MS / 1000}s`)), HOOK_TIMEOUT_MS);
      if (typeof t.unref === 'function') t.unref();
    }),
  ]).catch((e: Error) => {
    // A hook that throws is the extension's problem, never the host's.
    extLog(ext, `hook ${event} failed: ${e.message}`);
    // …with ONE exception: a failing `incident` hook must not file an incident.
    // appendIncident broadcasts, the broadcast re-enters this hook, it throws
    // again — an unbounded loop that would take the host down. The extension's
    // own log is the report for that case.
    if (event === 'incident') return;
    appendIncident({ sessionId: payload?.sessionId || '', action: `ext:${ext}:hook:${event}`, health: 'BLOCKED_SYSTEM', reason: e.message.slice(0, 300), outcome: 'hook-failed' } as any);
  });
}

// ---------------------------------------------------------------------------
// load / reload
// ---------------------------------------------------------------------------
function teardown(e: ExtEntry): void {
  for (const u of e.unsubs) { try { u(); } catch {} }
  e.unsubs = [];
  registry.unregisterExt(e.name);
}

/** Full (re)scan of EXT_DIR. Safe to call at any time; serialised with itself. */
export async function reload(opts: { only?: string[]; reason?: string } = {}): Promise<{ extensions: ReturnType<typeof listExtensions> }> {
  if (reloading) await reloading.catch(() => {});
  let done!: () => void;
  reloading = new Promise<void>((r) => (done = r));
  loadSeq++;
  try {
    ensureUserRepo();
    const st = readState();
    const names = dirsIn(EXT_DIR);
    const only = opts.only?.length ? new Set(opts.only) : null;

    // gone from disk → forget (state keeps its history)
    for (const [name, e] of [...extensions]) if (!names.includes(name)) { teardown(e); extensions.delete(name); }

    for (const name of names) {
      if (only && !only.has(name) && extensions.has(name)) continue;
      const prev = extensions.get(name);
      if (prev) teardown(prev);
      let entry: ExtEntry;
      try {
        entry = await loadOne(name, st);
      } catch (e) {
        entry = {
          name, dir: path.join(EXT_DIR, name), manifest: prev?.manifest || null, enabled: st.enabled[name] !== false,
          state: 'error', trustRequested: false, trusted: false, error: (e as Error).message, warnings: [], mtime: newestMtime(watchedFiles(path.join(EXT_DIR, name), prev?.manifest || null)),
          contributions: { tools: 0, listeners: 0, docs: 0, tabs: 0, hooks: 0, gates: 0, channels: 0, webhooks: 0 },
          unsubs: [], gates: {}, channels: {}, listenerTypes: [],
        };
      }
      if (entry.state === 'error') {
        extLog(name, `load failed: ${entry.error}`);
        hostLog(`"${name}" failed to load: ${entry.error}`);
        appendIncident({ sessionId: '', action: `ext:${name}:load`, health: 'BLOCKED_SYSTEM', reason: (entry.error || '').slice(0, 300), outcome: 'not-loaded' } as any);
      }
      extensions.set(name, entry);
      if (entry.sha) { st.sha[name] = entry.sha; }
    }

    writeState(st);
    ensureExtPlugin();
    refreshFamilies();
    refreshUserCatalog();
    summaryCache = buildSummaryLine();
    loaded = true;
    try { broadcast({ type: 'extensions-updated', extensions: listExtensions() }); } catch {}
    return { extensions: listExtensions() };
  } finally {
    done();
    reloading = null;
  }
}

export const loadAll = reload;

// ---- mtime poll -------------------------------------------------------------
let pollTimer: NodeJS.Timeout | null = null;

/** Boot: load everything, then watch mtimes (no fs.watch anywhere in this codebase). */
export async function start(): Promise<void> {
  try {
    await reload({ reason: 'boot' });
  } catch (e) {
    hostLog(`boot load failed: ${(e as Error).message}`);
  }
  if (pollTimer) return;
  pollTimer = setInterval(() => { void pollMtimes(); }, MTIME_POLL_MS);
  if (typeof pollTimer.unref === 'function') pollTimer.unref();
}

export function stop(): void {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

export async function pollMtimes(): Promise<string[]> {
  const changed: string[] = [];
  try {
    for (const name of dirsIn(EXT_DIR)) {
      const e = extensions.get(name);
      const dir = path.join(EXT_DIR, name);
      const mt = newestMtime(watchedFiles(dir, e?.manifest || parseManifest(dir).manifest || null));
      if (!e || mt > e.mtime) changed.push(name);
    }
    for (const [name] of extensions) if (!fs.existsSync(path.join(EXT_DIR, name, 'manifest.json'))) changed.push(name);
    if (changed.length) {
      hostLog(`change detected in ${changed.join(', ')} — reloading`);
      await reload({ only: changed, reason: 'mtime' });
    }
  } catch (e) {
    hostLog(`mtime poll failed: ${(e as Error).message}`);
  }
  return changed;
}

// ---------------------------------------------------------------------------
// §4 — what the core asks us for
// ---------------------------------------------------------------------------

/** The MCP server entries one extension contributes (see the naming note in docs). */
// Resolved lazily and NOT at module load: config.ts and auth.ts both import
// their way back here, so a top-level import would close the cycle.
//
// No fallback literal on purpose. cfg.hostBase is always set (config.ts derives
// it from bind+port), so a hardcoded default here would be dead code that can
// only ever be wrong — and being wrong is the exact bug this function exists to
// fix. If it cannot be resolved, the key is left unset and mcp/ext-mcp.js's own
// documented default applies.
function hostBaseUrl(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('./lib/config.js').cfg?.hostBase || '';
  } catch {
    return '';
  }
}

function hostApiToken(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('./auth.js').auth?.hostToken || '';
  } catch {
    return '';
  }
}

function serversFor(e: ExtEntry, hostAuth = false): Record<string, { command: string; args: string[]; cwd: string; env: Record<string, string> }> {
  const out: Record<string, any> = {};
  const m = e.manifest;
  if (!m) return out;
  const tools = (m.tools || []) as ManifestTool[];
  const st = readState();
  const hostBase = hostBaseUrl();
  const settings = settingsFor(m, st);
  const secrets = st.secrets[e.name] || {};
  for (const t of tools) {
    // One tool entry → `ext-<name>`; several → `ext-<name>-<tool>`, so the
    // A3 family patterns (`mcp__ext-<name>__*`, `mcp__ext-<name>-*`) cover both.
    const key = tools.length === 1 ? `ext-${e.name}` : `ext-${e.name}-${t.name}`;
    const env: Record<string, string> = {
      EXT_DIR: e.dir,
      EXT_NAME: e.name,
      EXT_SETTINGS: JSON.stringify(settings),
      // `ctx.host.api` (mcp/ext-mcp.js) reads these two, and until they were
      // set here it only worked by accident: a tool server launched inside a
      // SESSION inherits ARIGAMI_URL/ARIGAMI_TOKEN from the session's env
      // (server/claude.js), but the same server launched by callExtTool — the
      // path a TAB takes — inherited neither, fell back to the hardcoded
      // default port in mcp/ext-mcp.js, and quietly talked to whatever else
      // was listening there. Found by running a tab on an isolated instance on
      // another port: its write went to a completely different host, which
      // answered "no such session".
      //
      ...(hostBase ? { ARIGAMI_URL: hostBase } : {}),
      // The TOKEN is deliberately NOT set here. On the session path this env
      // rides into `--mcp-config` and the server inherits the session's own
      // ARIGAMI_TOKEN, which is scoped to that one session; putting the host
      // token here would override it and silently widen every in-session
      // extension tool to full host scope. Only callExtTool — the tab path,
      // where there is no session to be scoped to — adds it.
      ...(hostAuth ? { ARIGAMI_TOKEN: hostApiToken() } : {}),
      // Senders (lib/outbound.ts): ext-mcp holds these for the owner's approval
      // when an agent calls them. A host call (hostAuth: after that approval,
      // or a tab the owner is using) runs them.
      EXT_OUTBOUND: JSON.stringify(Array.isArray((m as any).outbound) ? (m as any).outbound.map(String) : []),
      ...(hostAuth ? { EXT_HOST_CALL: '1' } : {}),
    };
    for (const [k, v] of Object.entries(t.env || {})) env[k] = String(v).replaceAll('${EXT_DIR}', e.dir);
    // Secrets ride as env and are NEVER logged or returned by the REST view.
    for (const [k, v] of Object.entries(secrets)) env[k] = String(v);
    out[key] =
      t.kind === 'module'
        ? { ...bunExec('ext', [insideDir(e.dir, str((t as any).module)) || '']), cwd: e.dir, env }
        : { command: (t as any).command, args: ((t as any).args || []).map((a: string) => String(a).replaceAll('${EXT_DIR}', e.dir)), cwd: e.dir, env };
  }
  return out;
}

/**
 * The `--mcp-config` contribution of every ENABLED extension, for one owner.
 * (Owner-scoped extensions are a later step; A3's allowlist already controls
 * which of these tools an agent may call, through the `ext:<name>` family.)
 */
export function extServersFor(_owner: string = 'global'): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const e of enabledExtensions()) Object.assign(out, serversFor(e));
  return out;
}

/** `ext:<name>` → the tool patterns of that extension (agent-policy FAMILIES). */
export function extFamilies(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const e of enabledExtensions()) {
    if (!e.manifest?.tools?.length) continue;
    out[`ext:${e.name}`] = [`mcp__ext-${e.name}__*`, `mcp__ext-${e.name}-*`];
  }
  return out;
}

/** The user's own mcp-catalog.json rows are cached in mcp-catalog.ts — re-read them. */
function refreshUserCatalog(): void {
  try {
    (require('./mcp-catalog.js') as typeof import('./mcp-catalog.js')).refreshUserCatalog();
  } catch {
    /* catalog module not loaded in this process */
  }
}

function refreshFamilies(): void {
  try {
    // Late require keeps agent-policy free of an import cycle through us.
    const p = require('./agent-policy.js') as typeof import('./agent-policy.js');
    p.setExtFamilies(extFamilies());
  } catch {
    /* policy module not loaded in this process (tests) */
  }
}

// ---- docs → ext-plugin skills ----------------------------------------------
const stripFrontmatter = (s: string) => s.replace(/^---\n[\s\S]*?\n---\n?/, '');
const yamlish = (s: string) => String(s).replace(/\r?\n/g, ' ').trim();

function skillMarkdown(e: ExtEntry, d: ManifestDoc, siblings: ManifestDoc[]): string {
  const body = (() => {
    try { return stripFrontmatter(fs.readFileSync(path.join(e.dir, d.file), 'utf8')); } catch { return ''; }
  })();
  const others = siblings.filter((x) => x.skill !== d.skill);
  const servers = Object.keys(serversFor(e));
  const lines = [
    '---',
    `name: ${d.skill}`,
    `description: ${yamlish(d.description)}`,
    '---',
    '',
    `<!-- generated from ${e.name}/${d.file} by the Arigami extension loader — edit the extension, not this file -->`,
    '',
    body.trim(),
    '',
  ];
  if (servers.length) {
    lines.push(`## Tools`, '', `This extension's tools are available as ${servers.map((s) => `\`mcp__${s}__*\``).join(', ')}.`, '');
  }
  if (others.length) {
    lines.push('## Other docs', '');
    for (const o of others) lines.push(`- \`${path.join(e.dir, o.file)}\` — ${yamlish(o.description)}`);
    lines.push('');
  }
  lines.push(`Extension directory: \`${e.dir}\``, '');
  return lines.join('\n');
}

/**
 * $ARIGAMI_DIR/ext-plugin — the third --plugin-dir. Same shim shape as
 * skills.ts ensureUserPlugin(), except the skills are GENERATED (from every
 * enabled extension's docs[]) rather than symlinked, so stale ones are removed.
 */
export function ensureExtPlugin(): string {
  try {
    const skillsRoot = path.join(EXT_PLUGIN_DIR, 'skills');
    fs.mkdirSync(path.join(EXT_PLUGIN_DIR, '.claude-plugin'), { recursive: true });
    fs.mkdirSync(skillsRoot, { recursive: true });
    const manifestFile = path.join(EXT_PLUGIN_DIR, '.claude-plugin', 'plugin.json');
    const want = JSON.stringify(
      { name: 'arigami-ext', description: 'Documentation contributed by the extensions installed on this Arigami instance ($ARIGAMI_DIR/user/extensions)', version: '0.1.0' },
      null,
      2
    );
    let cur = '';
    try { cur = fs.readFileSync(manifestFile, 'utf8'); } catch {}
    if (cur !== want) fs.writeFileSync(manifestFile, want);

    const wanted = new Set<string>();
    for (const e of enabledExtensions()) {
      const docs = e.manifest?.docs || [];
      for (const d of docs) {
        if (!SKILL_NAME_RE.test(d.skill)) continue;
        wanted.add(d.skill);
        const dest = path.join(skillsRoot, d.skill);
        fs.mkdirSync(dest, { recursive: true });
        const md = skillMarkdown(e, d, docs);
        const file = path.join(dest, 'SKILL.md');
        let prev = '';
        try { prev = fs.readFileSync(file, 'utf8'); } catch {}
        if (prev !== md) fs.writeFileSync(file, md);
      }
    }
    for (const d of fs.readdirSync(skillsRoot)) {
      if (wanted.has(d)) continue;
      fs.rmSync(path.join(skillsRoot, d), { recursive: true, force: true });
    }
  } catch (e) {
    hostLog(`ext-plugin generation failed: ${(e as Error).message}`);
  }
  return EXT_PLUGIN_DIR;
}

/** Skills the ext-plugin currently exposes (skills.ts lists them read-only). */
export function extPluginSkills(): { name: string; ext: string; description: string; dir: string }[] {
  const out: { name: string; ext: string; description: string; dir: string }[] = [];
  for (const e of enabledExtensions())
    for (const d of e.manifest?.docs || [])
      if (SKILL_NAME_RE.test(d.skill)) out.push({ name: d.skill, ext: e.name, description: d.description, dir: path.join(EXT_PLUGIN_DIR, 'skills', d.skill) });
  return out;
}

/** true when the plugin has at least one skill — spawnProc only passes it then. */
export function extPluginHasSkills(): boolean {
  try { return fs.readdirSync(path.join(EXT_PLUGIN_DIR, 'skills')).some((d) => fs.existsSync(path.join(EXT_PLUGIN_DIR, 'skills', d, 'SKILL.md'))); } catch { return false; }
}

// ---- the system-reminder line ----------------------------------------------
function buildSummaryLine(): string {
  const parts: string[] = [];
  for (const e of enabledExtensions()) {
    const bits: string[] = [];
    const skills = (e.manifest?.docs || []).map((d) => `/arigami-ext:${d.skill}`);
    if (skills.length) bits.push(`skill${skills.length > 1 ? 's' : ''} ${skills.join(', ')}`);
    const servers = Object.keys(serversFor(e));
    if (servers.length) bits.push(`tools ${servers.map((s) => `mcp__${s}__*`).join(', ')}`);
    if (e.listenerTypes.length) bits.push(`listener type${e.listenerTypes.length > 1 ? 's' : ''} ${e.listenerTypes.join(', ')}`);
    if (e.manifest?.tabs?.length) bits.push(`${e.manifest.tabs.length} tab${e.manifest.tabs.length > 1 ? 's' : ''}`);
    parts.push(bits.length ? `${e.name} (${bits.join(', ')})` : e.name);
  }
  return parts.length ? `Extensions installed: ${parts.join('; ')}.` : '';
}

/** Cached; refreshed on every reload. '' when nothing is installed. */
export const summaryLine = (): string => summaryCache;

// ---------------------------------------------------------------------------
// hook / listener context
// ---------------------------------------------------------------------------
export function hookCtx(ext: string): HookCtx {
  const e = extensions.get(ext);
  const st = readState();
  const dir = e?.dir || path.join(EXT_DIR, ext);
  return {
    async sendPrompt(sessionId: string, text: string) {
      const api = await import('./api.js');
      return api.deliverToSession(String(sessionId), String(text)) as any;
    },
    async notify(payload: NotifyPayload) {
      const n = await import('./notify.js');
      await n.notify(payload);
    },
    async exec(cmd: string[], opts: { cwd?: string; timeoutMs?: number } = {}) {
      const [bin, ...args] = cmd;
      const proc = Bun.spawn([bin, ...args], { cwd: opts.cwd || dir, stdout: 'pipe', stderr: 'pipe', env: process.env as Record<string, string> });
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; try { proc.kill(); } catch {} }, opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : 120_000);
      try {
        const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
        return { code: timedOut ? 124 : Number(code), stdout, stderr, timedOut };
      } finally {
        clearTimeout(timer);
      }
    },
    fetch: globalThis.fetch,
    log: (msg: string) => extLog(ext, String(msg)),
    settings: settingsFor(e?.manifest || null, st),
    secrets: st.secrets[ext] || {},
    appendCard(sessionId: string, card: Record<string, unknown>) {
      import('./claude.js')
        .then((c: any) => c.appendChat(String(sessionId), { kind: 'ext-card', ext, ...card }))
        .catch(() => {});
    },
    has: (feature: string) => hostHas(feature),
    apiVersion: EXT_API_VERSION,
    extDir: dir,
  };
}

/** ctx.has('…') — "what does the host I am running on actually have?" */
function hostHas(feature: string): boolean {
  switch (String(feature)) {
    case 'notify':
    case 'sendPrompt':
    case 'exec':
    case 'appendCard':
    case 'listeners':
    case 'gates':
    case 'tabs':
      return true;
    case 'daemons':
      return false;
    default:
      return false;
  }
}

/** The ctx a listener provider gets (a subset of HookCtx + the deadline signal). */
export function listenerCtx(ext: string | undefined, signal: AbortSignal, listenerId?: string, sessionId?: string): ListenerCtx {
  const name = ext || 'core';
  const e = ext ? extensions.get(ext) : undefined;
  const st = readState();
  return {
    log(msg: string) {
      extLog(name, `${listenerId ? `[${listenerId}] ` : ''}${msg}`);
      if (listenerId)
        import('./listeners.js').then((l: any) => l.llogPublic?.(listenerId, 'info', String(msg))).catch(() => {});
    },
    fetch: globalThis.fetch,
    secrets: ext ? st.secrets[ext] || {} : {},
    settings: settingsFor(e?.manifest || null, st),
    signal,
    extDir: e?.dir || EXT_DIR,
    apiVersion: EXT_API_VERSION,
    inbox: {
      // Scoped to THIS listener's session and to one operation. A provider has
      // no other route to the host on purpose, and this keeps it that way:
      // appending to one inbox is not a REST client.
      add(items) {
        if (!sessionId) return 0;
        // require() and not a top-level import: state.ts imports its way back
        // here through the extension loader.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const st = require('./state.js');
        const added = st.addInboxItems(sessionId, Array.isArray(items) ? items : []);
        if (!added?.length) return 0;
        // Same reason as the REST route: the core kicks the drafting run, so a
        // provider only has to describe what arrived.
        if (added.some((i: { signal?: boolean }) => i.signal)) {
          try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            require('./claude.js').enrichInbox(sessionId);
          } catch (err) {
            extLog(name, `inbox enrich failed: ${(err as Error)?.message}`);
          }
        }
        return added.length;
      },
    },
  };
}

// ---------------------------------------------------------------------------
// gates
// ---------------------------------------------------------------------------
export interface GateFailure { ok: false; reason: string; ext: string }
export type GateVerdict = { ok: true } | GateFailure;

/**
 * Run every registered gate for `name`, sequentially, each under its own
 * timeout. A gate that throws or times out FAILS CLOSED with its message —
 * blocking is what a gate is for.
 */
export async function runGates(name: string, ev: Record<string, unknown>): Promise<GateVerdict> {
  for (const e of enabledExtensions()) {
    const fn = e.gates[name];
    if (!fn) continue;
    const ctx = hookCtx(e.name);
    let r: GateResult;
    try {
      r = (await Promise.race([
        Promise.resolve().then(() => fn(ev, ctx)),
        new Promise<never>((_, reject) => {
          const t = setTimeout(() => reject(new Error(`gate "${name}" exceeded ${GATE_TIMEOUT_MS / 60000} minutes`)), GATE_TIMEOUT_MS);
          if (typeof t.unref === 'function') t.unref();
        }),
      ])) as GateResult;
    } catch (err) {
      const reason = (err as Error)?.message || String(err);
      extLog(e.name, `gate ${name} threw: ${reason}`);
      return { ok: false, reason, ext: e.name };
    }
    if (!r || r.ok !== true) {
      const reason = (r as any)?.reason ? String((r as any).reason) : `gate "${name}" refused`;
      extLog(e.name, `gate ${name} refused: ${reason.slice(0, 200)}`);
      return { ok: false, reason, ext: e.name };
    }
    extLog(e.name, `gate ${name} passed`);
  }
  return { ok: true };
}

export const hasGates = (name: string): boolean => enabledExtensions().some((e) => !!e.gates[name]);

// ---------------------------------------------------------------------------
// notification channels contributed by extensions
// ---------------------------------------------------------------------------
export function extChannels(): { id: string; ext: string; send: (p: NotifyPayload) => Promise<void> }[] {
  const out: { id: string; ext: string; send: (p: NotifyPayload) => Promise<void> }[] = [];
  for (const e of enabledExtensions())
    for (const [id, fn] of Object.entries(e.channels))
      out.push({
        id,
        ext: e.name,
        send: async (p: NotifyPayload) => {
          await fn(p, hookCtx(e.name));
        },
      });
  return out;
}

// ---------------------------------------------------------------------------
// webhooks — `ext-<name>-<id>` → the listener provider's onWebhook
// ---------------------------------------------------------------------------
/** Parse a custom webhook id. Returns null when it isn't an extension webhook. */
export function parseWebhookId(customId: string): { ext: string; id: string } | null {
  const m = /^ext-([a-z0-9][a-z0-9-]*?)-([A-Za-z0-9_.]{1,32})$/.exec(String(customId || ''));
  if (!m) return null;
  // The extension name may itself contain '-', so prefer the longest known name.
  for (const name of [...extensions.keys()].sort((a, b) => b.length - a.length)) {
    const prefix = `ext-${name}-`;
    if (customId.startsWith(prefix)) return { ext: name, id: customId.slice(prefix.length) };
  }
  return { ext: m[1], id: m[2] };
}

/** The listener type a given extension webhook feeds, or null. */
export function webhookListenerType(ext: string, id: string): string | null {
  const e = extensions.get(ext);
  if (!e || e.state !== 'loaded') return null;
  const w = (e.manifest?.webhooks || []).find((x) => x.id === id);
  return w ? w.listener : null;
}

// ---------------------------------------------------------------------------
// install / remove / update
// ---------------------------------------------------------------------------
const isGitUrl = (s: string) => /^(https?:\/\/|git@|ssh:\/\/|git:\/\/)/.test(s) || /\.git$/.test(s);
const nameFromUrl = (u: string) => (u.replace(/\/+$/, '').replace(/\.git$/, '').split(/[/:]/).pop() || '').toLowerCase();

export interface AddResult {
  ok: boolean;
  name?: string;
  dir?: string;
  manifest?: Manifest;
  permissions?: string[];
  /** the manifest asked for the trusted tier */
  trustRequested?: boolean;
  /** …and the caller granted it (`--trust`, or the cockpit's confirmation) */
  trusted?: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Install from a directory (copied) or a git URL (shallow clone). Refuses to
 * overwrite an existing extension — an update is `POST /:name/update`. Nothing
 * is ever fetched on its own: `source` came from a human or from a session
 * acting for one, and the returned `permissions` are what the caller shows
 * before enabling it.
 *
 * `opts.trust` grants the TRUSTED tier in the same breath — the caller (the CLI
 * with `--trust` / its y/N prompt, or the cockpit's install dialog) is the one
 * that named the consequence to the human. Without it a `trusted` manifest still
 * installs, sandboxed, and says so.
 */
export async function addExtension(source: string, opts: { trust?: boolean } = {}): Promise<AddResult> {
  const src = String(source || '').trim();
  if (!src) return { ok: false, errors: ['source required (a directory or a git URL)'], warnings: [] };
  ensureUserRepo();

  let name: string;
  let dir: string;
  if (isGitUrl(src)) {
    name = nameFromUrl(src);
    if (!EXT_NAME_RE.test(name)) return { ok: false, errors: [`cannot derive an extension name from ${src}`], warnings: [] };
    dir = path.join(EXT_DIR, name);
    if (exists(dir)) return { ok: false, errors: [`extension "${name}" already exists — use update, or remove it first`], warnings: [] };
    const r = spawnSync('git', ['clone', '--depth', '1', '--quiet', src, dir], { encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, timeout: 120_000 });
    if (r.status !== 0) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
      return { ok: false, errors: [`git clone failed: ${(r.stderr || r.stdout || '').trim().split('\n').pop() || 'unknown error'}`], warnings: [] };
    }
  } else {
    const from = path.resolve(src.startsWith('~') ? src.replace(/^~/, process.env.HOME || '~') : src);
    if (!isDir(from) || !fs.existsSync(path.join(from, 'manifest.json')))
      return { ok: false, errors: [`${from} is not an extension directory (no manifest.json)`], warnings: [] };
    const parsed = parseManifest(from);
    name = str(parsed.manifest?.name) || path.basename(from);
    if (!EXT_NAME_RE.test(name)) return { ok: false, errors: [`invalid extension name "${name}"`], warnings: [] };
    dir = path.join(EXT_DIR, name);
    if (exists(dir)) return { ok: false, errors: [`extension "${name}" already exists — use update, or remove it first`], warnings: [] };
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    fs.cpSync(from, dir, { recursive: true, filter: (s) => !/(^|[\\/])(node_modules|\.git)$/.test(s) });
  }

  const v = await validateExtension(dir);
  if (v.manifest && v.manifest.name !== name) {
    // the directory name is the identity — keep them equal
    const want = path.join(EXT_DIR, v.manifest.name);
    if (EXT_NAME_RE.test(v.manifest.name) && !exists(want)) { fs.renameSync(dir, want); dir = want; name = v.manifest.name; }
  }
  const trustRequested = v.manifest?.trusted === true;
  const trusted = trustRequested && opts.trust === true;
  if (trusted) {
    const st = readState();
    st.trusted[name] = true;
    writeState(st);
  }
  hostLog(
    `installed "${name}" from ${isGitUrl(src) ? src : 'a local directory'}` +
      `${trusted ? ' — TRUSTED tier granted: its tab runs unsandboxed, with the cockpit session' : trustRequested ? ' — it asks for the TRUSTED tier; NOT granted, the tab stays sandboxed' : ''}` +
      `${v.ok ? '' : ' (with validation errors)'}`
  );
  await reload({ only: [name], reason: `add ${name}` });
  autoCommit(`add extension ${name}`);
  return { ok: v.ok, name, dir, manifest: v.manifest, permissions: v.manifest?.permissions || [], trustRequested, trusted, errors: v.errors, warnings: v.warnings };
}

/** Remove the directory. The extensions.json entry is KEPT (settings history). */
export async function removeExtension(name: string): Promise<{ ok: boolean; error?: string }> {
  if (!EXT_NAME_RE.test(name)) return { ok: false, error: `invalid extension name: ${name}` };
  const dir = path.join(EXT_DIR, name);
  if (!isDir(dir)) return { ok: false, error: `no such extension: ${name}` };
  const e = extensions.get(name);
  if (e) teardown(e);
  extensions.delete(name);
  fs.rmSync(dir, { recursive: true, force: true });
  hostLog(`removed "${name}" (settings kept in extensions.json)`);
  await reload({ reason: `remove ${name}` });
  autoCommit(`remove extension ${name}`);
  return { ok: true };
}

/** `git pull --ff-only` inside the extension dir. No auto-update anywhere else. */
export async function updateExtension(name: string): Promise<{ ok: boolean; output?: string; error?: string; sha?: string }> {
  if (!EXT_NAME_RE.test(name)) return { ok: false, error: `invalid extension name: ${name}` };
  const dir = path.join(EXT_DIR, name);
  if (!isDir(dir)) return { ok: false, error: `no such extension: ${name}` };
  if (!isDir(path.join(dir, '.git'))) return { ok: false, error: `"${name}" is not a git checkout — nothing to pull` };
  const r = git(['pull', '--ff-only'], dir, 120_000);
  if (r.status !== 0) return { ok: false, error: (r.stderr || r.stdout || 'git pull failed').trim().slice(0, 400) };
  await reload({ only: [name], reason: `update ${name}` });
  const sha = shaOf(dir);
  autoCommit(`update extension ${name}`);
  return { ok: true, output: (r.stdout || '').trim().slice(0, 400), sha };
}

/** PATCH /__api/extensions/:name — enable/disable, settings, and the trusted tier. */
export async function patchExtension(name: string, patch: { enabled?: boolean; settings?: Record<string, unknown>; secrets?: Record<string, string>; trusted?: boolean }) {
  if (!EXT_NAME_RE.test(name)) return { error: `invalid extension name: ${name}` };
  const st = readState();
  if (typeof patch.enabled === 'boolean') st.enabled[name] = patch.enabled;
  // Granting trust is an admin decision the caller has already confirmed; the
  // loader still only acts on it when the manifest asks for the tier too.
  if (typeof patch.trusted === 'boolean') {
    st.trusted[name] = patch.trusted;
    hostLog(`"${name}" trusted tier ${patch.trusted ? 'GRANTED — its tab now runs unsandboxed, with the cockpit session' : 'revoked — its tab is sandboxed again'}`);
  }
  if (patch.settings && typeof patch.settings === 'object') st.settings[name] = { ...(st.settings[name] || {}), ...patch.settings };
  if (patch.secrets && typeof patch.secrets === 'object') st.secrets[name] = { ...(st.secrets[name] || {}), ...patch.secrets };
  writeState(st);
  await reload({ only: [name], reason: `patch ${name}` });
  return { ok: true, extension: listExtensions().find((e) => e.name === name) || null };
}

// ---------------------------------------------------------------------------
// POST /__api/ext/:name/tool/:tool — one call to an extension's own MCP server
// ---------------------------------------------------------------------------
/** Does the manifest allow a tab to call this tool? (`tools:<name>` permission.) */
export function toolPermitted(ext: string, tool: string): boolean {
  const e = extensions.get(ext);
  if (!e || e.state !== 'loaded') return false;
  const perms = e.manifest?.permissions || [];
  return perms.includes(`tools:${tool}`) || perms.includes('tools:*');
}

/**
 * Run one tool of an extension through a short-lived MCP client over stdio.
 * One process per call is fine for wave 1 (a tab click, not a hot path).
 */
export async function callExtTool(ext: string, tool: string, args: Record<string, unknown>): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
  const e = extensions.get(ext);
  if (!e || e.state !== 'loaded') return { ok: false, error: `extension "${ext}" is not loaded` };
  // hostAuth: a tab call has no session, so `ctx.host.api` authenticates with
  // the per-boot host token. An extension's server code already runs with the
  // host's privileges by design (docs/EXTENSIONS.md §7) — this only lets it use
  // the REST API it is documented to have.
  const servers = serversFor(e, true);
  const keys = Object.keys(servers);
  if (!keys.length) return { ok: false, error: `extension "${ext}" declares no tools` };
  try {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    let lastErr = '';
    for (const key of keys) {
      const s = servers[key];
      // Never let a host call pass for a session call (the host process may itself
      // have been started from a session's shell and carry its marker).
      const { ARIGAMI_SESSION_ID: _sid, ...hostEnv } = process.env as Record<string, string>;
      const transport = new StdioClientTransport({ command: s.command, args: s.args, cwd: s.cwd, env: { ...hostEnv, ...s.env } });
      const client = new Client({ name: 'arigami-ext-caller', version: '0.1.0' }, { capabilities: {} });
      try {
        await client.connect(transport);
        const list = (await client.listTools()) as { tools?: { name: string }[] };
        if (!(list.tools || []).some((t) => t.name === tool)) { lastErr = `no tool "${tool}" on ${key}`; continue; }
        const r = (await client.callTool({ name: tool, arguments: args || {} })) as any;
        if (r?.isError) return { ok: false, error: String((r.content || []).map((c: any) => c.text || '').join('\n') || 'tool error') };
        return { ok: true, result: r?.structuredContent ?? r?.content ?? r };
      } finally {
        try { await client.close(); } catch {}
      }
    }
    return { ok: false, error: lastErr || `no tool "${tool}" in extension "${ext}"` };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

// ---------------------------------------------------------------------------
// user mcp-catalog.json — extra remote-MCP rows without a PR to the core
// ---------------------------------------------------------------------------
export interface UserMcpRow { slug: string; title: string; url: string; auth: 'oauth' | 'bearer'; domains: string[]; docs?: string; note?: string }

/** Validated rows from $ARIGAMI_DIR/user/mcp-catalog.json (invalid rows are dropped). */
export function readUserMcpCatalog(): UserMcpRow[] {
  let raw: unknown;
  try { raw = JSON.parse(fs.readFileSync(USER_MCP_CATALOG, 'utf8')); } catch { return []; }
  const rows = Array.isArray(raw) ? raw : Array.isArray((raw as any)?.servers) ? (raw as any).servers : [];
  const out: UserMcpRow[] = [];
  for (const r of rows as any[]) {
    const slug = str(r?.slug).toLowerCase();
    if (!/^[a-z0-9](?:[a-z0-9]|-(?!-)){0,38}[a-z0-9]$/.test(slug)) continue;
    const url = str(r?.url);
    if (!/^https?:\/\//.test(url)) continue;
    const auth = r?.auth === 'bearer' ? 'bearer' : r?.auth === 'oauth' ? 'oauth' : null;
    if (!auth) continue;
    const domains = Array.isArray(r?.domains) ? r.domains.filter((d: unknown) => typeof d === 'string') : [];
    if (!domains.length) { try { domains.push(new URL(url).hostname); } catch {} }
    out.push({ slug, title: str(r?.title) || slug, url, auth, domains, docs: str(r?.docs) || undefined, note: str(r?.note) || undefined });
  }
  return out;
}

// ---------------------------------------------------------------------------
// domain events — one place, so hooks and the WS see the same names
// ---------------------------------------------------------------------------
/** Emit a domain event to in-process subscribers (never to the WebSocket). */
export function emitDomain(name: string, payload: Record<string, unknown>): void {
  try { emitLocal(name, payload); } catch {}
}

// ---- CLI (bin/host ext …) ---------------------------------------------------
// Used when the host is DOWN (or no admin token is exported): the same
// functions, in-process, against $ARIGAMI_DIR. With the host up, bin/host goes
// through REST instead so the LIVE process reloads.
// bun server/extensions.ts list|validate <dir>|add <src> [--trust]|trust <name>|untrust <name>|
//   remove <name>|update [name]|reload|enable <name>|disable <name>|wants-trust <dir>
if (import.meta.main) {
  // Wrapped in an async IIFE (not a real top-level await) so this module has
  // no top-level await at all — `bun build --compile` refuses to bundle any
  // `require()` of a module that transitively does, and skills.ts/state.ts
  // both late-require this file. import.meta.main is false whenever this
  // file is imported rather than run directly, so this whole block — and the
  // process.exitCode / doCommit semantics it relies on — never executes in
  // that case; behavior when run as a CLI is unchanged (the event loop still
  // waits for this promise before the process can exit naturally).
  void (async () => {
  const argv = process.argv.slice(2);
  const [cmd, arg] = argv;
  const flag = (f: string) => argv.includes(f);
  const out = (o: unknown) => process.stdout.write(JSON.stringify(o, null, 2) + '\n');

  /** The local source's manifest, for the trust question. A git URL has none yet. */
  const localManifest = (src: string): Manifest | null => {
    const from = path.resolve(src.startsWith('~') ? src.replace(/^~/, process.env.HOME || '~') : src);
    return isDir(from) ? parseManifest(from).manifest || null : null;
  };

  /** One y/N on stdin. Only ever asked on a TTY — a script never gets a hidden prompt. */
  const askYes = async (question: string): Promise<boolean> =>
    new Promise((resolve) => {
      process.stderr.write(question);
      process.stdin.setEncoding('utf8');
      process.stdin.resume();
      process.stdin.once('data', (d: string) => {
        process.stdin.pause();
        resolve(/^\s*y(es)?\s*$/i.test(String(d)));
      });
    });
  try {
    if (cmd === 'list' || cmd === undefined) {
      await reload({ reason: 'cli list' });
      out({ extensions: listExtensions(), apiVersion: EXT_API_VERSION, dir: EXT_DIR });
    } else if (cmd === 'validate') {
      if (!arg) throw new Error('usage: bun server/extensions.ts validate <dir>');
      const v = await validateExtension(path.resolve(arg.startsWith('~') ? arg.replace(/^~/, process.env.HOME || '~') : arg));
      out(v);
      process.exitCode = v.ok ? 0 : 1;
    } else if (cmd === 'wants-trust') {
      // bin/host asks this BEFORE installing over REST, so the y/N below can be
      // asked in the shell the human is actually looking at. Exit 0 = yes.
      if (!arg) throw new Error('usage: bun server/extensions.ts wants-trust <dir>');
      const m = localManifest(arg);
      process.exitCode = m?.trusted === true ? 0 : 1;
    } else if (cmd === 'add') {
      if (!arg) throw new Error('usage: bun server/extensions.ts add <dir|git-url> [--trust]');
      let trust = flag('--trust');
      // A trusted tab is the cockpit's own origin — never grant that silently.
      if (!trust && localManifest(arg)?.trusted === true) {
        const line =
          `"${arg}" asks for the TRUSTED tier: its tab is served WITHOUT the sandbox, so it\n` +
          `runs with your full cockpit session — same as the core UI — and can call /__api as you.\n` +
          `Grant it? [y/N] `;
        if (process.stdin.isTTY) trust = await askYes(line);
        else process.stderr.write(line.replace('Grant it? [y/N] ', 'NOT granted (no terminal to ask on) — installing sandboxed; pass --trust to grant.\n'));
      }
      const r = await addExtension(arg, { trust });
      // The permissions are what the human is agreeing to — print them loudly.
      if (r.permissions?.length) process.stderr.write(`permissions requested by "${r.name}": ${r.permissions.join(', ')}\n`);
      if (r.trusted) process.stderr.write(`"${r.name}" is installed at the TRUSTED tier — its tab runs unsandboxed.\n`);
      else if (r.trustRequested) process.stderr.write(`"${r.name}" asked for the trusted tier and did NOT get it — its tab is sandboxed.\n`);
      out(r);
      process.exitCode = r.ok ? 0 : 1;
    } else if (cmd === 'trust' || cmd === 'untrust') {
      if (!arg) throw new Error(`usage: bun server/extensions.ts ${cmd} <name>`);
      out(await patchExtension(arg, { trusted: cmd === 'trust' }));
    } else if (cmd === 'remove') {
      if (!arg) throw new Error('usage: bun server/extensions.ts remove <name>');
      const r = await removeExtension(arg);
      out(r);
      process.exitCode = r.ok ? 0 : 1;
    } else if (cmd === 'update') {
      const names = arg ? [arg] : dirsIn(EXT_DIR);
      const results = [];
      for (const n of names) results.push({ name: n, ...(await updateExtension(n)) });
      out({ results });
      process.exitCode = results.some((r) => !r.ok) ? 1 : 0;
    } else if (cmd === 'reload') {
      out(await reload({ reason: 'cli reload' }));
    } else if (cmd === 'enable' || cmd === 'disable') {
      if (!arg) throw new Error(`usage: bun server/extensions.ts ${cmd} <name>`);
      out(await patchExtension(arg, { enabled: cmd === 'enable' }));
    } else {
      process.stderr.write('usage: bun server/extensions.ts list | validate <dir> | add <src> [--trust] | trust <name> | untrust <name> | remove <name> | update [name] | reload | enable <name> | disable <name>\n');
      process.exitCode = 2;
    }
    doCommit('extension change');
  } catch (e) {
    process.stderr.write(`error: ${(e as Error).message}\n`);
    process.exitCode = 1;
  }
  })();
}
