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
import { fileURLToPath } from 'node:url';
import type { Readable } from 'node:stream';
import { ARIGAMI_DIR } from './lib/instance.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
export const EXCLUDES = ['run', 'chrome-sessions', 'chrome-base', 'logs', 'user-plugin', 'tmp', 'backups', 'node_modules'];
const EXCLUDE_GLOBS = ['*.bak-*', '.bak-*', '*.tmp'];

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
  return { stream: p.stdout, filename: `arigami-backup-${stamp()}.tgz`, done, cleanup };
}

/** Full export straight to a file (CLI). */
export async function exportFullToFile(out: string, opts: { include?: string[]; dir?: string } = {}): Promise<Manifest> {
  const r = exportFull(opts);
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  const w = fs.createWriteStream(out);
  r.stream.pipe(w);
  const code = await r.done;
  await new Promise<void>((res, rej) => { w.on('finish', () => res()); w.on('error', rej); });
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
  /** bundle name (profile.json "name"); default: provenance name or "exported-host" */
  name?: string;
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
}

const CRON_TAG_RE = /^\[[a-z0-9-]+\]\s+/;

/** Strip host-bound bits from a live cron trigger so the bundle re-applies anywhere. */
export function bundleCronFromTrigger(t: any): any {
  return {
    name: String(t.name || 'cron').replace(CRON_TAG_RE, ''),
    prompt: t.prompt,
    schedule: { kind: t.schedule?.kind, value: String(t.schedule?.value ?? '') },
    enabled: !!t.enabled,
    autonomous: !!t.autonomous,
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
  const prov = readJson(path.join(dir, 'profile.json'));
  const name = (opts.name || prov?.name || 'exported-host').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'exported-host';
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
    title: opts.title || prov?.title || `Exported from an Arigami host`,
    description: opts.description || `Profile bundle exported on ${new Date().toISOString().slice(0, 10)} (Arigami ${version}): ${repos.length} repo(s), the instance's user skills, memory seed and cron jobs. Contains no secrets, accounts, chat or sessions.`,
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
  for (const f of ['USER.md', 'MEMORY.md']) {
    const src = path.join(dir, 'memory', f);
    if (!fs.existsSync(src)) continue;
    fs.mkdirSync(path.join(out, 'memory-seed'), { recursive: true });
    fs.copyFileSync(src, path.join(out, 'memory-seed', f));
    memorySeed.push(f);
  }

  const triggers = opts.cron ?? (readJson<any>(path.join(dir, 'triggers.json'))?.triggers ?? readJson<any[]>(path.join(dir, 'triggers.json')) ?? []);
  const cron = (Array.isArray(triggers) ? triggers : []).filter((t) => t && t.type === 'cron' && t.prompt).map(bundleCronFromTrigger);
  fs.writeFileSync(path.join(out, 'cron.json'), JSON.stringify(cron, null, 2) + '\n');

  fs.writeFileSync(
    path.join(out, 'README.md'),
    `# ${manifest.title}\n\n${manifest.description}\n\n` +
      `Apply on another host:\n\n\`\`\`sh\nbin/host profile apply ${path.basename(out)}/   # or point at this directory / a git repo of it\n\`\`\`\n\n` +
      `| part | contents |\n|---|---|\n` +
      `| \`profile.json\` | ${repos.length} repo(s)${Object.keys(settings).length ? `, settings: ${Object.keys(settings).join(', ')}` : ''} |\n` +
      `| \`skills/\` | ${skills.length ? skills.join(', ') : '—'} |\n` +
      `| \`memory-seed/\` | ${memorySeed.length ? memorySeed.join(', ') : '—'} |\n` +
      `| \`cron.json\` | ${cron.length} job(s) (registered disabled on apply unless the bundle is shipped) |\n\n` +
      `Not included, by design: accounts, API keys, users/pairing, chat history, sessions, uploads. Use a full backup (\`bin/host export --full\`) for those.\n`,
  );
  return { dir: out, name, skills, cron: cron.length, repos: repos.length, memorySeed };
}

/** tar.gz stream of a bundle dir (the export UI download). */
export function tarDir(dir: string, filename: string): ExportResult {
  const p = spawn('tar', ['-czf', '-', '-C', dir, '.'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const done = new Promise<number>((resolve) => p.on('close', (code) => resolve(code ?? 1)));
  return { stream: p.stdout, filename, done, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} } };
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
// bun server/backup.ts export --full <out.tgz> [--include a,b] | export --bundle <out-dir|out.tgz> | import <file.tgz> [--force] | inspect <file>
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
      const r = exportBundle({ out: asTgz ? undefined : target, name: val('--name'), cron: tr.listTriggers() });
      if (asTgz) {
        const t = tarDir(r.dir, path.basename(target));
        const w = fs.createWriteStream(target);
        t.stream.pipe(w);
        await t.done;
        await new Promise<void>((res) => w.on('finish', () => res()));
        t.cleanup();
        out({ ok: true, file: path.resolve(target), name: r.name, skills: r.skills, cron: r.cron, repos: r.repos, memorySeed: r.memorySeed });
      } else out({ ok: true, ...r });
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
      process.stderr.write('usage: bun server/backup.ts export --full [out.tgz] [--include a,b] | export --bundle [out-dir|out.tgz] [--name n] | import <file.tgz> [--force] | inspect <file>\n');
      process.exitCode = 2;
    }
  } catch (e) {
    process.stderr.write(`error: ${(e as Error).message}\n`);
    process.exitCode = (e as ImportError).status === 409 ? 3 : 1;
  }
}
