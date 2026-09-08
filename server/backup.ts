// B4-full — export / import: the migration primitive (laptop ↔ VPS ↔ Docker)
// and the showcase primitive (K3 bundles).
//
// Two shapes, both tar.gz:
//
//   FULL BACKUP   everything under $ARIGAMI_DIR — config, accounts/secrets
//                 (as they are on disk; the archive is NOT encrypted, keep it
//                 private), sessions, memory, skills, profiles, chat, uploads —
//                 minus the disposable/host-bound bits in EXCLUDES (run/, chrome
//                 profiles, logs, caches, previous .bak dirs). A manifest
//                 `arigami-export.json` {format, version, commit, createdAt,
//                 host:{platform,arch}} rides at the archive root; import
//                 validates it (refuses a newer major), refuses while sessions
//                 are working unless `force`, swaps the directory in with a
//                 timestamped `.bak` of the previous one, and asks for a host
//                 restart (host-control.ts, B4-lite).
//
//   PROFILE BUNDLE exactly what profiles.ts can apply and nothing else:
//                 profile.json (registered repos + non-secret settings),
//                 skills/ (the user dir, F2), memory-seed/{USER,MEMORY}.md,
//                 cron.json (cron triggers), README.md. Never accounts,
//                 secrets, users, chat, sessions, state, uploads. `export
//                 bundle` → `profile apply` round-trips (test/backup.test.ts).
//
// Everything here is plain files + the system `tar` (streamed, so a multi-GB
// backup never lives in memory). No new ports, no new state outside
// $ARIGAMI_DIR (§0.1 #2, #6).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import type { Readable } from 'node:stream';
import { ARIGAMI_DIR } from './lib/instance.js';
import { CRON_TAG_RE, cronBundleKey } from './lib/cron-key.js';
import { resourceRoot } from './lib/resource-root.js';
export { cronBundleKey };

const REPO_ROOT = resourceRoot();

/** Bump the MAJOR when a restored dir would not be understood by an older host. */
export const BACKUP_FORMAT = 1;
export const MANIFEST_NAME = 'arigami-export.json';
export const TMP_DIR = path.join(ARIGAMI_DIR, 'tmp');

/**
 * Top-level entries of $ARIGAMI_DIR that a full backup leaves out: host-bound
 * (run/ = pid + lock of THIS process), regenerable (user-plugin/ is a symlink
 * shim, chrome-base/ is rebuilt from the saved logins), huge caches
 * (chrome-sessions/), logs, our own scratch space and previous restores.
 */
// EXT: `ext-plugin/` joins the list for the same reason as `user-plugin/` — it
// is GENERATED from the installed extensions' docs on every load, so restoring
// a stale copy would only shadow the real thing.
export const EXCLUDES = ['run', 'chrome-sessions', 'chrome-base', 'logs', 'user-plugin', 'ext-plugin', 'tmp', 'backups', 'node_modules'];
// A2: an agent's persistent Chrome profile is a cache like chrome-base (cookies, huge) — never exported.
// M1 (RESEARCH-ARIGAMI-NATIVE-MCP §4.5): Claude Code's `.credentials.json` holds
// the `mcpOAuth` grants in PLAINTEXT and they are bound to this machine's
// loopback OAuth flow — a restore elsewhere could not use them and an archive is
// not encrypted. It lives in $CLAUDE_CONFIG_DIR (outside $ARIGAMI_DIR) today; the
// glob keeps it out even if a future layout puts a Claude config under the
// instance dir. The ownership records (agents/<slug>/connections.json,
// mcp-connections.json) DO travel — they are names and URLs, no secrets, and the
// capability check re-reports "needs authentication" on the new machine.
export const CREDENTIAL_GLOBS = ['.credentials.json', '*/.credentials.json', './*/.credentials.json'];
// EXT: the user repo ($ARIGAMI_DIR/user) IS backed up — it holds the
// extensions, the skills and the mcp catalog — but never its installed
// dependencies, which `bun install` rebuilds.
const EXCLUDE_GLOBS = ['*.bak-*', '.bak-*', '*.tmp', './agents/*/browser', './user/node_modules', './user/extensions/*/node_modules', ...CREDENTIAL_GLOBS];
/** Root-level only (F4 #7): `mcp-logs.txt`, `wa-logs.txt` … are logs that don't live under logs/. */
export const ROOT_EXCLUDE_GLOBS = ['./*-logs.txt'];

/**
 * Files a PROFILE BUNDLE must never contain — asserted by the test suite, and
 * the reason bundle export builds a fresh directory instead of filtering a
 * tar of $ARIGAMI_DIR.
 */
export const SECRET_FILES = [
  'accounts.json', 'secrets.env', 'users.json', 'share-secret', 'share-tokens.json', 'share-revoked.json',
  'vapid-keys.json', 'push-subscriptions.json', 'linear-oauth.json', 'config.json', 'state.json',
  'sessions.json', 'children.json', 'triggers.json', 'webhooks.jsonl', 'sms.jsonl', 'funnel.jsonl',
];

// ---- types --------------------------------------------------------------------

export interface Manifest {
  kind: 'arigami-backup';
  format: number;
  version: string; // package.json version of the exporting host
  commit: string | null;
  createdAt: string;
  host: { platform: string; arch: string; release: string; runtime: string };
  include: string[] | null; // null = everything (minus EXCLUDES)
  excludes: string[];
}

export interface ExportResult {
  stream: Readable;
  filename: string;
  /** stop tar early (client went away) — `done` still settles */
  kill: () => void;
  /** resolves with tar's exit code once the stream ends */
  done: Promise<number>;
  cleanup: () => void;
}

export interface ImportOptions {
  force?: boolean;
  /** injectable for tests — how many sessions have a turn in flight */
  busyCount?: () => number;
  /** restore target (default ARIGAMI_DIR) */
  dir?: string;
  now?: () => Date;
}

export interface ImportResult {
  manifest: Manifest;
  restoredTo: string;
  backupDir: string | null;
  entries: number;
  restartRequired: true;
}

export class ImportError extends Error {
  status: number;
  constructor(msg: string, status = 400) {
    super(msg);
    this.status = status;
  }
}

// ---- helpers ------------------------------------------------------------------

function readJson<T = any>(p: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function packageVersion(): string {
  return String(readJson(path.join(REPO_ROOT, 'package.json'))?.version || '0.0.0');
}

function gitCommit(): string | null {
  const r = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 5000 });
  return r.status === 0 ? r.stdout.trim() : null;
}

export function stamp(d = new Date()): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

export function major(v: string | undefined | null): number {
  const m = /^\s*v?(\d+)/.exec(String(v ?? ''));
  return m ? Number(m[1]) : 0;
}

function safeName(s: string): boolean {
  return !!s && s !== '.' && s !== '..' && !s.includes('/') && !s.includes('\\') && !s.includes('\0');
}

function tarArgs(extra: string[] = []): string[] {
  const ex: string[] = [];
  // root-only globs: `*` must not cross a `/` so uploads/x-logs.txt is kept
  ex.push('--no-wildcards-match-slash');
  for (const g of ROOT_EXCLUDE_GLOBS) ex.push(`--exclude=${g}`);
  ex.push('--wildcards-match-slash');
  for (const e of EXCLUDES) ex.push(`--exclude=./${e}`);
  for (const g of EXCLUDE_GLOBS) ex.push(`--exclude=${g}`);
  return [...ex, ...extra];
}

/** Manifest for a backup taken right now. */
export function buildManifest(include: string[] | null = null): Manifest {
  return {
    kind: 'arigami-backup',
    format: BACKUP_FORMAT,
    version: packageVersion(),
    commit: gitCommit(),
    createdAt: new Date().toISOString(),
    host: { platform: process.platform, arch: process.arch, release: os.release(), runtime: `bun ${typeof Bun !== 'undefined' ? Bun.version : '?'}` },
    include,
    excludes: [...EXCLUDES],
  };
}

/**
 * Check an archive manifest against this host. Throws ImportError (400) on a
 * malformed manifest, (409) on a newer major format/version.
 */
export function checkManifest(m: unknown, here: { format?: number; version?: string } = {}): Manifest {
  const mf = m as Manifest;
  if (!mf || typeof mf !== 'object' || mf.kind !== 'arigami-backup') throw new ImportError(`not an Arigami backup (missing or invalid ${MANIFEST_NAME})`);
  const hereFormat = here.format ?? BACKUP_FORMAT;
  const hereVersion = here.version ?? packageVersion();
  if (typeof mf.format !== 'number' || !Number.isFinite(mf.format)) throw new ImportError('manifest has no "format" number');
  if (mf.format > hereFormat)
    throw new ImportError(`backup format ${mf.format} is newer than this host understands (${hereFormat}) — upgrade the host first`, 409);
  if (major(mf.version) > major(hereVersion))
    throw new ImportError(`backup was taken by Arigami ${mf.version}, newer than this host (${hereVersion}) — upgrade the host first`, 409);
  return mf;
}

// ---- full export ----------------------------------------------------------------

/**
 * Stream a tar.gz of $ARIGAMI_DIR (+ manifest at the root). `include` limits
 * the archive to the given top-level entries (e.g. ['memory','skills']).
 * The manifest is written to a scratch dir under $ARIGAMI_DIR/tmp and added
 * with a second `-C`, so the live directory is never mutated by an export.
 */
export function exportFull(opts: { include?: string[]; dir?: string } = {}): ExportResult {
  const dir = opts.dir || ARIGAMI_DIR;
  if (!fs.existsSync(dir)) throw new Error(`${dir} does not exist`);
  const include = Array.isArray(opts.include) && opts.include.length ? opts.include.filter(safeName) : null;
  const scratch = fs.mkdtempSync(path.join(ensureTmp(dir), 'export-'));
  const manifest = buildManifest(include);
  fs.writeFileSync(path.join(scratch, MANIFEST_NAME), JSON.stringify(manifest, null, 2) + '\n');
  const members = include
    ? include.filter((n) => !EXCLUDES.includes(n) && fs.existsSync(path.join(dir, n))).map((n) => `./${n}`)
    : ['.'];
  const args = ['-czf', '-', ...tarArgs(['--ignore-failed-read', '-C', dir, ...members, '-C', scratch, MANIFEST_NAME])];
  const p = spawn('tar', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  p.stderr.on('data', (c) => (err += c));
  const done = new Promise<number>((resolve) => p.on('close', (code) => resolve(code ?? 1)));
  const cleanup = () => {
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch {}
  };
  done.then((code) => {
    cleanup();
    if (code !== 0 && code !== 1) console.error(`[backup] tar exited ${code}: ${err.trim().split('\n').pop()}`); // 1 = "file changed as we read it"
  });
  return { stream: p.stdout, filename: `arigami-backup-${stamp()}.tgz`, done, cleanup, kill: () => { try { p.kill('SIGTERM'); } catch {} } };
}

/**
 * Resolve when `w` has flushed everything. Created BEFORE piping: on a big
 * archive the file stream's 'finish' fires before tar's 'close' settles
 * `done`, and a listener attached after the fact waits forever (F4 #1 — the
 * CLI "hang" after a complete 38 MB export).
 */
export function whenFinished(w: fs.WriteStream): Promise<void> {
  return new Promise<void>((res, rej) => {
    if (w.writableFinished) return res();
    w.once('finish', () => res());
    w.once('error', rej);
  });
}

/** Pipe an export stream into a file; resolves with tar's exit code once both tar and the file are done. */
export async function exportToFile(r: ExportResult, out: string): Promise<number> {
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  const w = fs.createWriteStream(out);
  const finished = whenFinished(w);
  r.stream.pipe(w);
  const code = await r.done;
  await finished;
  return code;
}

/** Full export straight to a file (CLI). */
export async function exportFullToFile(out: string, opts: { include?: string[]; dir?: string } = {}): Promise<Manifest> {
  const code = await exportToFile(exportFull(opts), out);
  if (code !== 0 && code !== 1) throw new Error(`tar exited ${code}`);
  return readManifestFromArchive(out);
}

function ensureTmp(dir: string): string {
  const t = path.join(dir, 'tmp');
  fs.mkdirSync(t, { recursive: true });
  return t;
}

// ---- archive inspection -----------------------------------------------------------

function tarList(file: string): string[] {
  const r = spawnSync('tar', ['-tzf', file], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new ImportError(`not a readable tar.gz: ${(r.stderr || '').trim().split('\n').pop() || 'tar failed'}`);
  return r.stdout.split('\n').filter(Boolean);
}

/** Reject anything that could escape the target dir. GNU tar strips these anyway; we refuse outright. */
export function assertSafeEntries(entries: string[]): void {
  for (const e of entries) {
    const n = e.replace(/^\.\//, '');
    if (path.isAbsolute(e) || n.split('/').includes('..') || e.includes('\0'))
      throw new ImportError(`archive contains an unsafe path: ${e}`);
  }
}

export function readManifestFromArchive(file: string): Manifest {
  const entries = tarList(file);
  assertSafeEntries(entries);
  const name = entries.find((e) => e === MANIFEST_NAME || e === `./${MANIFEST_NAME}`);
  if (!name) throw new ImportError(`not an Arigami backup (no ${MANIFEST_NAME} at the archive root)`);
  const r = spawnSync('tar', ['-xzOf', file, name], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (r.status !== 0) throw new ImportError('could not read the manifest from the archive');
  let parsed: unknown;
  try { parsed = JSON.parse(r.stdout); } catch { throw new ImportError(`${MANIFEST_NAME} is not valid JSON`); }
  return checkManifest(parsed);
}

export type ArchiveKind = 'full' | 'bundle';

/** What kind of archive is this? Bundles carry profile.json at the root, backups carry the manifest. */
export function detectArchive(file: string): { kind: ArchiveKind; entries: string[] } {
  const entries = tarList(file);
  assertSafeEntries(entries);
  const has = (n: string) => entries.some((e) => e === n || e === `./${n}`);
  if (has(MANIFEST_NAME)) return { kind: 'full', entries };
  if (has('profile.json')) return { kind: 'bundle', entries };
  throw new ImportError(`archive is neither a full backup (${MANIFEST_NAME}) nor a profile bundle (profile.json)`);
}

// ---- full import -------------------------------------------------------------------

/**
 * Restore a full backup over `dir` (default $ARIGAMI_DIR):
 *   1. validate manifest (kind/format/version) and entry paths
 *   2. stop-the-world guard: refuse (409) while sessions are working unless force
 *   3. extract to a staging dir next to the target
 *   4. move the current dir aside as `<dir>.bak-<stamp>` and the staging dir in;
 *      when the target is a mount point (Docker volume: rename → EBUSY) fall
 *      back to swapping the CONTENTS with the .bak under `<dir>/backups/`
 *   5. carry `run/` (this host's pid + lock) over so the running process keeps
 *      its identity until it restarts
 * The caller restarts the host afterwards (REST → host-control; CLI → bin/host).
 */
export async function importFull(file: string, opts: ImportOptions = {}): Promise<ImportResult> {
  const dir = path.resolve(opts.dir || ARIGAMI_DIR);
  const manifest = readManifestFromArchive(file);
  const busy = opts.busyCount ? opts.busyCount() : 0;
  if (busy > 0 && !opts.force)
    throw new ImportError(`${busy} session(s) are working — wait for them, restart when idle, or import with force`, 409);
  const entries = tarList(file).filter((e) => e !== MANIFEST_NAME && e !== `./${MANIFEST_NAME}`);

  const parent = path.dirname(dir);
  const ts = stamp(opts.now ? opts.now() : new Date());
  const staging = path.join(parent, `${path.basename(dir)}.import-${ts}`);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  const x = spawnSync('tar', ['-xzf', file, '-C', staging, ...tarArgs()], { encoding: 'utf8' });
  if (x.status !== 0) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw new ImportError(`extract failed: ${(x.stderr || '').trim().split('\n').pop() || 'tar failed'}`, 500);
  }
  // the manifest stays in the restored dir as a record of where it came from
  fs.writeFileSync(path.join(staging, MANIFEST_NAME), JSON.stringify({ ...manifest, importedAt: new Date().toISOString() }, null, 2) + '\n');

  let backupDir: string | null = null;
  if (!fs.existsSync(dir)) {
    fs.renameSync(staging, dir);
  } else {
    const bak = path.join(parent, `${path.basename(dir)}.bak-${ts}`);
    try {
      fs.renameSync(dir, bak);
      fs.renameSync(staging, dir);
      backupDir = bak;
      // keep this process's pid/lock alive until the restart
      moveIfExists(path.join(bak, 'run'), path.join(dir, 'run'));
    } catch (e) {
      // mount point (Docker volume) or cross-device: swap contents instead
      if (fs.existsSync(bak) && !fs.existsSync(dir)) fs.renameSync(bak, dir); // undo a half swap
      backupDir = swapContents(dir, staging, ts);
    }
  }
  fs.rmSync(staging, { recursive: true, force: true });
  return { manifest, restoredTo: dir, backupDir, entries: entries.length, restartRequired: true };
}

function moveIfExists(from: string, to: string): void {
  try {
    if (!fs.existsSync(from)) return;
    fs.rmSync(to, { recursive: true, force: true });
    fs.renameSync(from, to);
  } catch {}
}

/** In-place restore: everything in `dir` (except run/ and backups/) → dir/backups/<ts>.bak/, then staging's entries in. */
function swapContents(dir: string, staging: string, ts: string): string {
  const bak = path.join(dir, 'backups', `${ts}.bak`);
  fs.mkdirSync(bak, { recursive: true });
  for (const n of fs.readdirSync(dir)) {
    if (n === 'run' || n === 'backups') continue;
    fs.renameSync(path.join(dir, n), path.join(bak, n));
  }
  for (const n of fs.readdirSync(staging)) fs.renameSync(path.join(staging, n), path.join(dir, n));
  return bak;
}

// ---- profile bundle export ---------------------------------------------------------

export interface BundleExportOptions {
  /**
   * bundle name (profile.json "name"); default "exported-host". Never the
   * last applied bundle's provenance name (F4 #2): that re-tagged every cron
   * as "[<that bundle>] …" and duplicated them on re-import.
   */
  name?: string;
  /** include memory/USER.md + MEMORY.md as memory-seed/ (default true; `--no-memory` → false — F4 #4) */
  memory?: boolean;
  title?: string;
  description?: string;
  /** write here (created / emptied) — default $ARIGAMI_DIR/tmp/bundle-<stamp>/ */
  out?: string;
  /** cron triggers to include — injected by callers that already loaded triggers.ts */
  cron?: any[];
  repos?: any[];
  settings?: Record<string, unknown>;
}

export interface BundleExportResult {
  dir: string;
  name: string;
  skills: string[];
  cron: number;
  repos: number;
  memorySeed: string[];
  /** A4: agents/<slug>/ (agent.json without homeSessionId, persona.md, assets/) */
  agents: string[];
  /** true when memory-seed/ carries USER.md/MEMORY.md — personal profile, review before sharing */
  memoryWarning: boolean;
}

/**
 * Strip host-bound bits from a live cron trigger so the bundle re-applies
 * anywhere. `key` (F4 #2) is the trigger's existing bundleKey — the one it was
 * created from, whichever bundle that was — or "<exportName>/<slug>" for a
 * hand-made trigger; profiles.ts matches on it so importing an export back
 * into the same instance updates instead of duplicating.
 */
export function bundleCronFromTrigger(t: any, exportName = 'exported-host'): any {
  const name = String(t.name || 'cron').replace(CRON_TAG_RE, '');
  return {
    name,
    key: typeof t.bundleKey === 'string' && t.bundleKey ? t.bundleKey : cronBundleKey(exportName, name),
    prompt: t.prompt,
    schedule: { kind: t.schedule?.kind, value: String(t.schedule?.value ?? '') },
    enabled: !!t.enabled,
    autonomous: !!t.autonomous,
    // A4: the agent the runs are born from — the bundle ships agents/ too, so the slug travels
    ...(typeof t.agent === 'string' && t.agent ? { agent: t.agent } : {}),
    // "existing:<sessionId>" points at a session on THIS host — meaningless elsewhere
    ...(t.sessionMode && !/^existing:/.test(t.sessionMode) ? { sessionMode: t.sessionMode } : {}),
    // deliver.whatsapp (a phone JID) and deliver.master (a session id) are personal / host-bound
    ...(t.deliver && typeof t.deliver.push === 'boolean' ? { deliver: { push: t.deliver.push } } : {}),
  };
}

/** Repo entry minus local-machine paths (envSource.files) — everything else is what profiles.ts consumes. */
export function bundleRepoFromEntry(r: any): any {
  const out: any = { name: r.name, source: r.source };
  for (const k of ['branch', 'installCmd', 'devCmd', 'testCmd']) if (r[k]) out[k] = r[k];
  if (r.envSource?.kind && r.envSource.kind !== 'copy') out.envSource = { kind: r.envSource.kind, ...(r.envSource.value ? { value: r.envSource.value } : {}) };
  return out;
}

/** Non-secret, portable settings from config.json. Keys are an allow-list on purpose. */
export function portableSettings(cfg: Record<string, any> | null): Record<string, unknown> {
  if (!cfg) return {};
  const out: Record<string, unknown> = {};
  for (const k of ['defaultModel', 'voiceLang', 'sttModel', 'palette', 'devServerPorts', 'dispatcher', 'brain']) if (cfg[k] != null) out[k] = cfg[k];
  return out;
}

function copyDir(from: string, to: string): void {
  fs.cpSync(from, to, { recursive: true, dereference: true, filter: (s) => !/(^|\/)(node_modules|\.git)(\/|$)/.test(s) });
}

/**
 * Build a Profile Bundle directory from this instance. Reads: repos.json,
 * config.json (allow-listed keys), $ARIGAMI_DIR/skills, memory/{USER,MEMORY}.md,
 * and the cron triggers passed in (or triggers.json when none are given).
 */
export function exportBundle(opts: BundleExportOptions = {}): BundleExportResult {
  const dir = ARIGAMI_DIR;
  const name = (opts.name || 'exported-host').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'exported-host';
  const out = path.resolve(opts.out || path.join(ensureTmp(dir), `bundle-${stamp()}`));
  const rel = path.relative(dir, out);
  if (out === dir || (!rel.startsWith('..') && !path.isAbsolute(rel) && !rel.startsWith('tmp'))) throw new Error(`refusing to write a bundle into ${out} (inside $ARIGAMI_DIR)`);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });

  const repos = (opts.repos ?? readJson<any[]>(path.join(dir, 'repos.json')) ?? []).filter((r) => r && r.name && r.source).map(bundleRepoFromEntry);
  const settings = opts.settings ?? portableSettings(readJson(path.join(dir, 'config.json')));
  const version = packageVersion();
  const manifest = {
    name,
    version: '1.0.0',
    title: opts.title || `Exported from an Arigami host`,
    description: opts.description || `Profile bundle exported on ${new Date().toISOString().slice(0, 10)} (Arigami ${version}): ${repos.length} repo(s), the instance's user skills, memory seed, cron jobs and agents. Contains no secrets, accounts, chat or sessions.`,
    repos,
    plugins: [],
    workflows: [],
    issueSource: 'none',
    settings,
    exportedFrom: { arigami: version, commit: gitCommit(), at: new Date().toISOString() },
  };
  fs.writeFileSync(path.join(out, 'profile.json'), JSON.stringify(manifest, null, 2) + '\n');

  const skills: string[] = [];
  const userSkills = path.join(dir, 'skills');
  if (fs.existsSync(userSkills)) {
    for (const n of fs.readdirSync(userSkills).sort()) {
      if (!/^[a-z0-9][a-z0-9-]*$/.test(n) || !fs.existsSync(path.join(userSkills, n, 'SKILL.md'))) continue;
      copyDir(path.join(userSkills, n), path.join(out, 'skills', n));
      skills.push(n);
    }
  }

  const memorySeed: string[] = [];
  for (const f of opts.memory === false ? [] : ['USER.md', 'MEMORY.md']) {
    const src = path.join(dir, 'memory', f);
    if (!fs.existsSync(src)) continue;
    fs.mkdirSync(path.join(out, 'memory-seed'), { recursive: true });
    fs.copyFileSync(src, path.join(out, 'memory-seed', f));
    memorySeed.push(f);
  }

  // A4: agents are user data a bundle may ship — record (minus the instance-local
  // home session), persona and assets. Never memory/, browser/ or identity.json.
  const agents: string[] = [];
  const agentsDir = path.join(dir, 'agents');
  if (fs.existsSync(agentsDir)) {
    for (const slug of fs.readdirSync(agentsDir).sort()) {
      const rec = readJson<any>(path.join(agentsDir, slug, 'agent.json'));
      if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(slug) || !rec || rec.slug !== slug) continue;
      const { homeSessionId: _h, ...portable } = rec;
      const to = path.join(out, 'agents', slug);
      fs.mkdirSync(to, { recursive: true });
      fs.writeFileSync(path.join(to, 'agent.json'), JSON.stringify(portable, null, 2) + '\n');
      const persona = path.join(agentsDir, slug, 'persona.md');
      if (fs.existsSync(persona)) fs.copyFileSync(persona, path.join(to, 'persona.md'));
      const assets = path.join(agentsDir, slug, 'assets');
      if (fs.existsSync(assets) && fs.readdirSync(assets).length) copyDir(assets, path.join(to, 'assets'));
      agents.push(slug);
    }
  }

  const triggers = opts.cron ?? (readJson<any>(path.join(dir, 'triggers.json'))?.triggers ?? readJson<any[]>(path.join(dir, 'triggers.json')) ?? []);
  const cron = (Array.isArray(triggers) ? triggers : []).filter((t) => t && t.type === 'cron' && t.prompt).map((t) => bundleCronFromTrigger(t, name));
  fs.writeFileSync(path.join(out, 'cron.json'), JSON.stringify(cron, null, 2) + '\n');

  fs.writeFileSync(
    path.join(out, 'README.md'),
    `# ${manifest.title}\n\n${manifest.description}\n\n` +
      `Apply on another host:\n\n\`\`\`sh\nbin/host profile apply ${path.basename(out)}/   # or point at this directory / a git repo of it\n\`\`\`\n\n` +
      `| part | contents |\n|---|---|\n` +
      `| \`profile.json\` | ${repos.length} repo(s)${Object.keys(settings).length ? `, settings: ${Object.keys(settings).join(', ')}` : ''} |\n` +
      `| \`skills/\` | ${skills.length ? skills.join(', ') : '—'} |\n` +
      `| \`memory-seed/\` | ${memorySeed.length ? memorySeed.join(', ') + ' — the exporting user\'s own profile/notes; review before sharing (export with \`--no-memory\` to leave them out)' : '—'} |\n` +
      `| \`cron.json\` | ${cron.length} job(s) (registered disabled on apply unless the bundle is shipped) |\n` +
      `| \`agents/\` | ${agents.length ? agents.join(', ') + ' — created on apply when absent; an existing agent is left alone unless `--force`' : '—'} |\n\n` +
      `Not included, by design: accounts, API keys, users/pairing, chat history, sessions, uploads. Use a full backup (\`bin/host export --full\`) for those.\n`,
  );
  return { dir: out, name, skills, cron: cron.length, repos: repos.length, memorySeed, agents, memoryWarning: memorySeed.length > 0 };
}

/** tar.gz stream of a bundle dir (the export UI download). */
export function tarDir(dir: string, filename: string): ExportResult {
  const p = spawn('tar', ['-czf', '-', '-C', dir, '.'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const done = new Promise<number>((resolve) => p.on('close', (code) => resolve(code ?? 1)));
  return { stream: p.stdout, filename, done, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }, kill: () => { try { p.kill('SIGTERM'); } catch {} } };
}

/** Extract a bundle archive into $ARIGAMI_DIR/profiles/<name>/ and return the dir (apply is profiles.ts's job). */
export function unpackBundle(file: string): { dir: string; name: string } {
  const { kind } = detectArchive(file);
  if (kind !== 'bundle') throw new ImportError('archive is not a profile bundle');
  const staging = fs.mkdtempSync(path.join(ensureTmp(ARIGAMI_DIR), 'bundle-import-'));
  const x = spawnSync('tar', ['-xzf', file, '-C', staging], { encoding: 'utf8' });
  if (x.status !== 0) throw new ImportError(`extract failed: ${(x.stderr || '').trim().split('\n').pop() || 'tar failed'}`, 500);
  const mf = readJson(path.join(staging, 'profile.json'));
  const name = String(mf?.name || '');
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) { fs.rmSync(staging, { recursive: true, force: true }); throw new ImportError('profile.json has no valid "name"'); }
  const dest = path.join(ARIGAMI_DIR, 'profiles', name);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.rmSync(dest, { recursive: true, force: true });
  fs.renameSync(staging, dest);
  return { dir: dest, name };
}

// ---- CLI (bin/host export|import) ----------------------------------------------------
// bun server/backup.ts export --full <out.tgz> [--include a,b] | export --bundle <out-dir|out.tgz> [--name n] [--no-memory] | import <file.tgz> [--force] | inspect <file>
if (import.meta.main) {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const flag = (f: string) => argv.includes(f);
  const val = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
  const positional = argv.slice(1).filter((a, i, all) => !a.startsWith('--') && all[i - 1] !== '--include' && all[i - 1] !== '--name');
  const out = (o: unknown) => process.stdout.write(JSON.stringify(o, null, 2) + '\n');
  try {
    if (cmd === 'export' && flag('--full')) {
      const file = positional[0] || `arigami-backup-${stamp()}.tgz`;
      const include = val('--include')?.split(',').map((s) => s.trim()).filter(Boolean);
      const m = await exportFullToFile(file, { include });
      out({ ok: true, file: path.resolve(file), bytes: fs.statSync(file).size, manifest: m });
    } else if (cmd === 'export' && flag('--bundle')) {
      const tr = await import('./triggers.js');
      tr.load();
      const target = positional[0];
      const asTgz = !!target && /\.(tgz|tar\.gz)$/.test(target);
      const r = exportBundle({ out: asTgz ? undefined : target, name: val('--name'), memory: !flag('--no-memory'), cron: tr.listTriggers() });
      if (asTgz) {
        const t = tarDir(r.dir, path.basename(target));
        const code = await exportToFile(t, target);
        t.cleanup();
        if (code !== 0) throw new Error(`tar exited ${code}`);
        out({ ok: true, file: path.resolve(target), name: r.name, skills: r.skills, cron: r.cron, repos: r.repos, memorySeed: r.memorySeed, memoryWarning: r.memoryWarning });
      } else out({ ok: true, ...r });
      if (r.memoryWarning) process.stderr.write(`warning: bundle includes memory-seed/${r.memorySeed.join(', ')} (the user's own profile/notes) — review before sharing, or export with --no-memory\n`);
    } else if (cmd === 'import') {
      const file = positional[0];
      if (!file) throw new Error('usage: import <file.tgz> [--force]');
      const { kind } = detectArchive(file);
      if (kind === 'bundle') {
        const u = unpackBundle(file);
        const pf = await import('./profiles.js');
        const tr = await import('./triggers.js');
        tr.load();
        const rep = await pf.applySource(u.dir);
        tr.flush();
        out({ ok: true, kind, ...rep });
      } else {
        const r = await importFull(file, { force: flag('--force') });
        out({ ok: true, kind, ...r });
      }
    } else if (cmd === 'inspect') {
      const file = positional[0];
      const d = detectArchive(file);
      out({ kind: d.kind, entries: d.entries.length, manifest: d.kind === 'full' ? readManifestFromArchive(file) : null });
    } else {
      process.stderr.write('usage: bun server/backup.ts export --full [out.tgz] [--include a,b] | export --bundle [out-dir|out.tgz] [--name n] [--no-memory] | import <file.tgz> [--force] | inspect <file>\n');
      process.exitCode = 2;
    }
  } catch (e) {
    process.stderr.write(`error: ${(e as Error).message}\n`);
    process.exitCode = (e as ImportError).status === 409 ? 3 : 1;
  }
}
