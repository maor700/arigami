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
import { Readable } from 'node:stream';
import { ARIGAMI_DIR } from './lib/instance.js';
import { CRON_TAG_RE, cronBundleKey } from './lib/cron-key.js';
import { resourceRoot } from './lib/resource-root.js';
import * as jsTar from './lib/tar.js';
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
// dependencies, which `bun install` rebuilds (nor its @arigami/sdk symlink,
// same reason — see dynamicExcludeGlobs() for its sibling, the $ARIGAMI_DIR/skills
// symlink, which can't be a static glob because it isn't always a symlink).
const EXCLUDE_GLOBS = ['*.bak-*', '.bak-*', '*.tmp', './agents/*/browser', './user/node_modules', './user/extensions/*/node_modules', ...CREDENTIAL_GLOBS];
// B4 backup portability (#1): WhatsApp allows exactly ONE linked device.
// Restoring this archive's Baileys auth onto a second machine while the
// first is still paired kicks the first one off — a live conflict, not a
// theoretical one (it happened here twice in one day while this feature was
// being tested). Native installs keep that auth OUTSIDE $ARIGAMI_DIR
// entirely (whatsapp-bridge.ts: ~/.local/lib/whatsapp-mcp/auth_info — never
// reaches this tar); only the Docker layout roots it inside, at
// whatsapp/auth_info (docker/entrypoint.sh symlinks it there). Excluded from
// both export and import by default for that reason; `whatsapp: true` opts
// in on either side (CLI: `export --full --whatsapp` / `import --whatsapp`)
// — the caller must warn the human that the archive's WhatsApp number will
// log out of whatever machine is currently using it the moment this lands.
export const WHATSAPP_AUTH_GLOB = './whatsapp/auth_info';
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
  /** non-fatal notices the caller should surface to the human (e.g. WhatsApp auth included) */
  warnings: string[];
}

export interface ImportOptions {
  force?: boolean;
  /** injectable for tests — how many sessions have a turn in flight */
  busyCount?: () => number;
  /** restore target (default ARIGAMI_DIR) */
  dir?: string;
  now?: () => Date;
  /** restore the WhatsApp auth dir if the archive has one (default false — see WHATSAPP_AUTH_GLOB) */
  whatsapp?: boolean;
}

export interface ImportResult {
  manifest: Manifest;
  restoredTo: string;
  backupDir: string | null;
  entries: number;
  restartRequired: true;
  /** the archive had a whatsapp/auth_info but it was left out of the restore (opts.whatsapp wasn't set) */
  whatsappSkipped: boolean;
  /** sessions whose folder does not exist on this machine and was cleared (cross-platform restore) */
  clearedCwds: number;
  /** sessions whose Claude Code conversation id was cleared — that store never travels in a backup */
  clearedConversations: number;
  /** the top-level entries actually put in place (a partial archive restores only its own) */
  restored: string[];
  /** the archive declared `include` — an overlay, not a whole-dir replacement */
  partial: boolean;
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

/**
 * B4 backup portability (#2): what exportFull() writes for accounts.json
 * instead of the raw file. A `keychain` account (accounts.js) is a live
 * pointer into THIS machine's OS credential store — it cannot travel, and
 * shipping it as-is is a dead reference that only fails once a session on
 * the new machine tries to authenticate. Kept as a record (not dropped) but
 * renamed off `type: 'keychain'` so accounts.js's seed() doesn't treat it as
 * "already have one" and skip adopting a real login the importing machine
 * has of its own, `pool: false` so auto-pick never round-robins into it, and
 * `needsReauth: true` to say plainly what it needs. `oauth-token` accounts
 * are untouched — the token itself is portable.
 *
 * Duplicated (not imported) from accounts.js's identical
 * sanitizeAccountsForExport: accounts.js pulls in bus.js (a live
 * WebSocketServer) and config.js at module load, side effects this
 * CLI-invokable module has no business paying for. The two are asserted
 * identical in test/backup.test.ts.
 */
export function sanitizeAccountsForExport(raw: { activeId?: string | null; accounts?: any[] } | null): any {
  if (!raw || !Array.isArray(raw.accounts)) return raw;
  if (!raw.accounts.some((a) => a && a.type === 'keychain')) return raw; // nothing to rewrite — same reference, byte-identical on re-serialize
  let activeId = raw.activeId ?? null;
  const accounts = raw.accounts.map((a) => {
    if (!a || a.type !== 'keychain') return a;
    if (activeId === a.id) activeId = null;
    const { type, pool, ...rest } = a;
    return { ...rest, type: 'keychain-stale', pool: false, needsReauth: true };
  });
  return { ...raw, activeId, accounts };
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

/** POSIX `/…`, a Windows drive (`C:\…` / `C:/…`) or a UNC path (`\\…`) — deliberately not `path.isAbsolute`, which only knows the running platform's own rules. */
function isAbsoluteAnyPlatform(p: string): boolean {
  return /^\//.test(p) || /^[a-zA-Z]:[\\/]/.test(p) || /^\\\\/.test(p);
}

/**
 * B4 backup portability (#3): `reposDir`/`defaultCwd` in config.json are
 * filesystem paths the EXPORTING machine wrote. A `~/…` token is already
 * portable — config.ts's tilde() resolves it fresh on whichever machine
 * loads the file, so those are left alone. An absolute path (a Linux repo
 * dir, a `C:\Users\...` dir) only means something there. When the archive's
 * manifest says the platform differs from this importing host, drop the
 * absolute ones instead of restoring them literally — config.ts falls back
 * to its own (portable) DEFAULTS the moment it next loads. A missing/absent
 * manifest platform is treated as "same" (nothing to resolve), not "assume
 * different" — safer against archives that predate the `host` field.
 */
export function resolveConfigPathsForImport(raw: Record<string, unknown> | null, manifestPlatform: string | undefined | null): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object') return raw;
  if (!manifestPlatform || manifestPlatform === process.platform) return raw;
  const out = { ...raw };
  let changed = false;
  for (const key of ['reposDir', 'defaultCwd']) {
    const v = out[key];
    if (typeof v === 'string' && v && !v.startsWith('~') && isAbsoluteAnyPlatform(v)) {
      delete out[key];
      changed = true;
    }
  }
  return changed ? out : raw;
}

/**
 * Cross-platform restore, part two: everything a restored session says about
 * the machine it came from — its folder, and its Claude Code conversation.
 *
 * resolveConfigPathsForImport() drops the source's reposDir/defaultCwd so this
 * host falls back to its own — but every RESTORED SESSION still carries the
 * absolute folder it was created in. Import a Linux VPS onto a Mac and all of
 * them read /home/arigami/repos, which is nowhere. Starting one then spawns
 * claude with a cwd that does not exist, and posix_spawn reports ENOENT naming
 * the BINARY: "claude failed to start: ENOENT … posix_spawn '/…/claude'",
 * while claude is right there. Reported live, and it cost a while to see.
 *
 * A folder that isn't on this machine is cleared, not guessed at: claude.js
 * falls back to HOME for an empty cwd, and the human retargets the session
 * from the cockpit. Remapping onto this host's reposDir would only move the
 * failure — the repo it names isn't cloned here either.
 *
 * The same goes for `claude.sessionId`. Claude Code keeps its conversations in
 * $CLAUDE_CONFIG_DIR (`~/.claude`), which is OUTSIDE $ARIGAMI_DIR and so is in
 * no backup — and it keys them by project directory, the very cwd we just
 * cleared. A restored id therefore names a conversation that cannot be here:
 * claude.js spawns `--resume <id>`, the CLI answers "No conversation found
 * with session ID: …", and the 5s retry in spawnProc() starts it fresh
 * anyway. Clearing the id up front skips the doomed attempt and the alarming
 * line in the transcript; Arigami's own transcript (chat/) travelled in the
 * archive and still renders, it is the CLI's context that is gone either way.
 *
 * Only when the platform differs, mirroring resolveConfigPathsForImport: a
 * same-platform restore is usually the same machine restoring itself, where
 * both the folders and the conversations really are still there.
 */
export function localizeSessionsForImport(
  stagingDir: string,
  manifestPlatform: string | undefined | null,
): { cwds: number; conversations: number } {
  const none = { cwds: 0, conversations: 0 };
  if (!manifestPlatform || manifestPlatform === process.platform) return none;
  const file = path.join(stagingDir, 'state.json');
  const doc = readJson<{ sessions?: Record<string, unknown>[] }>(file);
  if (!doc || !Array.isArray(doc.sessions)) return none;
  let cleared = 0;
  let conversations = 0;
  for (const s of doc.sessions) {
    const claude = (s.claude && typeof s.claude === 'object' ? s.claude : null) as Record<string, unknown> | null;
    if (claude && typeof claude.sessionId === 'string' && claude.sessionId) {
      claude.sessionId = null;
      conversations++;
    }
    const meta = (s.metadata && typeof s.metadata === 'object' ? s.metadata : null) as Record<string, unknown> | null;
    for (const [obj, key] of [[s, 'cwd'], [meta, 'worktree']] as [Record<string, unknown> | null, string][]) {
      if (!obj) continue;
      const v = obj[key];
      if (typeof v !== 'string' || !v || v.startsWith('~')) continue;
      if (!isAbsoluteAnyPlatform(v) || fs.existsSync(v)) continue;
      delete obj[key];
      cleared++;
    }
  }
  if (cleared || conversations) fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
  return { cwds: cleared, conversations };
}

function safeName(s: string): boolean {
  return !!s && s !== '.' && s !== '..' && !s.includes('/') && !s.includes('\\') && !s.includes('\0');
}

// --no-wildcards-match-slash / --wildcards-match-slash are GNU-tar-only flags
// (they control whether `*` in an --exclude pattern can cross a `/`). macOS
// ships BSD tar (libarchive) and Windows' tar.exe is bsdtar too — both reject
// these flags outright, and there's no equivalent bsdtar option that gives the
// same "root-only glob" semantics ROOT_EXCLUDE_GLOBS depends on. Rather than
// risk a wrong (and unnoticed) archive on a non-GNU tar, lib/tar.js — a
// streaming pure-JS tar reader/writer that implements the same glob semantics
// itself — stands in as the default there (useJsTar() below); GNU tar stays
// the default everywhere else. See lib/tar.js's header for why
// `server/archive.js`'s pure-JS reader can't be reused here (in-memory,
// zip-bomb-capped, read-only — none of which fit an uncapped streaming backup).
export type TarFlavor = 'gnu' | 'bsd' | 'unknown';

/** Pure parser for `tar --version` output, so the gnu/bsd decision is testable without spawning a real tar. */
export function parseTarFlavor(versionOutput: string): TarFlavor {
  if (/GNU tar/i.test(versionOutput)) return 'gnu';
  if (/bsdtar|libarchive/i.test(versionOutput)) return 'bsd';
  return 'unknown';
}

let _tarFlavor: TarFlavor | undefined;
function detectTarFlavor(): TarFlavor {
  if (_tarFlavor) return _tarFlavor;
  try {
    const r = spawnSync('tar', ['--version'], { encoding: 'utf8', timeout: 5000 });
    return (_tarFlavor = parseTarFlavor(`${r.stdout || ''}${r.stderr || ''}`));
  } catch {
    return (_tarFlavor = 'unknown');
  }
}

/**
 * `ARIGAMI_TAR=js` forces the pure-JS implementation everywhere (the escape
 * hatch for testing it on Linux without touching the system tar). Otherwise
 * it's automatic: GNU tar stays the default, and the JS implementation is
 * the fallback the moment the system tar isn't GNU (macOS/Windows) — see the
 * comment above TarFlavor for why that used to be a hard block instead.
 */
function useJsTar(): boolean {
  return process.env.ARIGAMI_TAR === 'js' || detectTarFlavor() !== 'gnu';
}

/**
 * The EXCLUDES/EXCLUDE_GLOBS/ROOT_EXCLUDE_GLOBS semantics as a JS predicate —
 * the same two-phase (root-only, then general) matching tarArgs() builds from
 * GNU tar's --wildcards-match-slash toggle. `dynamic` folds in per-call
 * excludes (WhatsApp auth, the live-checked `skills` symlink, the rewritten
 * accounts.json) that can't be static module-level lists — see
 * dynamicExcludeGlobs() and whatsappExcludeGlobs().
 */
function jsExcludeMatcher(dynamic: string[] = []): jsTar.ExcludeMatcher {
  return jsTar.makeExcludeMatcher([
    ...ROOT_EXCLUDE_GLOBS.map((pattern) => ({ pattern, slashCross: false })),
    ...EXCLUDES.map((e) => ({ pattern: `./${e}`, slashCross: true })),
    ...EXCLUDE_GLOBS.map((pattern) => ({ pattern, slashCross: true })),
    ...dynamic.map((pattern) => ({ pattern, slashCross: true })),
  ]);
}

function tarArgs(extra: string[] = [], dynamic: string[] = []): string[] {
  const flavor = detectTarFlavor();
  if (flavor !== 'gnu') {
    throw new Error(
      `backup export/import needs GNU tar (uses --wildcards-match-slash); this host's tar looks like ${
        flavor === 'bsd' ? 'BSD tar/libarchive (the macOS/Windows default)' : 'an unrecognized tar'
      } — install GNU tar and put it first on PATH (e.g. "brew install gnu-tar" on macOS gives "gtar"; alias/symlink it to "tar"), or export/import from a Linux host for now`
    );
  }
  const ex: string[] = [];
  // root-only globs: `*` must not cross a `/` so uploads/x-logs.txt is kept
  ex.push('--no-wildcards-match-slash');
  for (const g of ROOT_EXCLUDE_GLOBS) ex.push(`--exclude=${g}`);
  ex.push('--wildcards-match-slash');
  for (const e of EXCLUDES) ex.push(`--exclude=./${e}`);
  for (const g of EXCLUDE_GLOBS) ex.push(`--exclude=${g}`);
  for (const g of dynamic) ex.push(`--exclude=${g}`);
  return [...ex, ...extra];
}

/** WHATSAPP_AUTH_GLOB unless the caller opted in — shared by export and import. */
function whatsappExcludeGlobs(includeWhatsApp?: boolean): string[] {
  return includeWhatsApp ? [] : [WHATSAPP_AUTH_GLOB];
}

/**
 * Per-export dynamic excludes beyond the static lists:
 *  - `skills` only when it is CURRENTLY a symlink (extensions.ts's
 *    migrateSkills() rebuilds $ARIGAMI_DIR/skills → user/skills on every
 *    boot, and user/skills travels on its own) — a not-yet-migrated instance
 *    still keeps real files there and those must still ship. Only checked
 *    for a default ('.') export; an explicit `--include skills` is a
 *    deliberate ask and is left alone. Windows can't create a symlink
 *    without elevated privilege, so shipping a regenerable one is also a
 *    portability trap, not just dead weight.
 *  - accounts.json, when a rewritten copy is being substituted in from
 *    scratch/ (see exportFull) — the raw one must not also ride along.
 */
function dynamicExcludeGlobs(dir: string, opts: { skills?: boolean; accounts?: boolean; whatsapp?: boolean } = {}): string[] {
  const out: string[] = [];
  if (opts.skills) {
    try { if (fs.lstatSync(path.join(dir, 'skills')).isSymbolicLink()) out.push('./skills'); } catch {}
  }
  if (opts.accounts) out.push('./accounts.json');
  out.push(...whatsappExcludeGlobs(opts.whatsapp));
  return out;
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
 * `whatsapp: true` carries the WhatsApp Baileys auth along (off by default —
 * see WHATSAPP_AUTH_GLOB); the caller must warn the human before setting it.
 */
export function exportFull(opts: { include?: string[]; dir?: string; whatsapp?: boolean } = {}): ExportResult {
  const dir = opts.dir || ARIGAMI_DIR;
  if (!fs.existsSync(dir)) throw new Error(`${dir} does not exist`);
  const include = Array.isArray(opts.include) && opts.include.length ? opts.include.filter(safeName) : null;
  const scratch = fs.mkdtempSync(path.join(ensureTmp(dir), 'export-'));
  const manifest = buildManifest(include);
  fs.writeFileSync(path.join(scratch, MANIFEST_NAME), JSON.stringify(manifest, null, 2) + '\n');
  const scratchMembers = [MANIFEST_NAME];

  // #2: substitute a sanitized accounts.json, but only when there's actually
  // something to rewrite — an unaffected file must stay byte-identical (round-
  // trip tests, `bin/host export --include` diffing) rather than just re-
  // pretty-printed.
  const accountsFile = path.join(dir, 'accounts.json');
  let substitutedAccounts = false;
  if ((!include || include.includes('accounts.json')) && fs.existsSync(accountsFile)) {
    const raw = readJson<{ activeId?: string | null; accounts?: any[] }>(accountsFile);
    if (raw) {
      const sanitized = sanitizeAccountsForExport(raw);
      if (sanitized !== raw) {
        fs.writeFileSync(path.join(scratch, 'accounts.json'), JSON.stringify(sanitized, null, 2) + '\n');
        scratchMembers.push('accounts.json');
        substitutedAccounts = true;
      }
    }
  }

  const members = include
    ? include.filter((n) => !EXCLUDES.includes(n) && fs.existsSync(path.join(dir, n))).map((n) => `./${n}`)
    : ['.'];
  const dynamic = dynamicExcludeGlobs(dir, { skills: !include, accounts: substitutedAccounts, whatsapp: opts.whatsapp });
  const warnings: string[] = [];
  if (opts.whatsapp)
    warnings.push('WhatsApp pairing included: WhatsApp allows only one linked device at a time. Restoring this archive elsewhere logs out any other machine currently connected with this WhatsApp number.');
  const cleanup = () => {
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch {}
  };
  let stream: Readable;
  let done: Promise<number>;
  let kill: () => void;
  if (useJsTar()) {
    const r = jsTar.createTarGzStream([{ dir, members }, { dir: scratch, members: scratchMembers }], { exclude: jsExcludeMatcher(dynamic) });
    stream = r.stream;
    done = r.done;
    kill = r.kill;
  } else {
    const args = ['-czf', '-', ...tarArgs(['--ignore-failed-read', '-C', dir, ...members, '-C', scratch, ...scratchMembers], dynamic)];
    const p = spawn('tar', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    p.stderr.on('data', (c) => (err += c));
    stream = p.stdout;
    done = new Promise<number>((resolve) => p.on('close', (code) => resolve(code ?? 1)));
    kill = () => { try { p.kill('SIGTERM'); } catch {} };
    done.then((code) => {
      if (code !== 0 && code !== 1) console.error(`[backup] tar exited ${code}: ${err.trim().split('\n').pop()}`); // 1 = "file changed as we read it"
    });
  }
  done.then(cleanup);
  return { stream, filename: `arigami-backup-${stamp()}.tgz`, done, cleanup, kill, warnings };
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
export async function exportFullToFile(out: string, opts: { include?: string[]; dir?: string; whatsapp?: boolean } = {}): Promise<Manifest> {
  const r = exportFull(opts);
  const code = await exportToFile(r, out);
  if (code !== 0 && code !== 1) throw new Error(`tar exited ${code}`);
  for (const w of r.warnings) process.stderr.write(`warning: ${w}\n`);
  return await readManifestFromArchive(out);
}

function ensureTmp(dir: string): string {
  const t = path.join(dir, 'tmp');
  fs.mkdirSync(t, { recursive: true });
  return t;
}

// ---- archive inspection -----------------------------------------------------------

async function tarList(file: string): Promise<string[]> {
  if (useJsTar()) {
    try {
      return await jsTar.listTarGz(file);
    } catch (e) {
      throw new ImportError(`not a readable tar.gz: ${(e as Error).message}`);
    }
  }
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

export async function readManifestFromArchive(file: string): Promise<Manifest> {
  const entries = await tarList(file);
  assertSafeEntries(entries);
  const name = entries.find((e) => e === MANIFEST_NAME || e === `./${MANIFEST_NAME}`);
  if (!name) throw new ImportError(`not an Arigami backup (no ${MANIFEST_NAME} at the archive root)`);
  let text: string;
  if (useJsTar()) {
    const buf = await jsTar.extractFileFromTarGz(file, name);
    if (!buf) throw new ImportError('could not read the manifest from the archive');
    text = buf.toString('utf8');
  } else {
    const r = spawnSync('tar', ['-xzOf', file, name], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    if (r.status !== 0) throw new ImportError('could not read the manifest from the archive');
    text = r.stdout;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new ImportError(`${MANIFEST_NAME} is not valid JSON`); }
  return checkManifest(parsed);
}

export type ArchiveKind = 'full' | 'bundle';

/** What kind of archive is this? Bundles carry profile.json at the root, backups carry the manifest. */
export async function detectArchive(file: string): Promise<{ kind: ArchiveKind; entries: string[] }> {
  const entries = await tarList(file);
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
  const manifest = await readManifestFromArchive(file);
  const busy = opts.busyCount ? opts.busyCount() : 0;
  if (busy > 0 && !opts.force)
    throw new ImportError(`${busy} session(s) are working — wait for them, restart when idle, or import with force`, 409);
  const entries = (await tarList(file)).filter((e) => e !== MANIFEST_NAME && e !== `./${MANIFEST_NAME}`);
  // #1: same "one linked device" reasoning as export — an archive that DOES carry
  // a WhatsApp auth (an older archive, or one exported with `whatsapp: true`) is
  // still left out of the restore unless this import explicitly opts in too, so
  // a plain `import backup.tgz` never silently knocks the target's own pairing.
  const hasWhatsAppAuth = entries.some((e) => e.replace(/^\.\//, '').startsWith('whatsapp/auth_info'));
  const dynamic = whatsappExcludeGlobs(opts.whatsapp);

  const parent = path.dirname(dir);
  const ts = stamp(opts.now ? opts.now() : new Date());
  const staging = path.join(parent, `${path.basename(dir)}.import-${ts}`);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  if (useJsTar()) {
    try {
      await jsTar.extractTarGzToDir(file, staging, { exclude: jsExcludeMatcher(dynamic) });
    } catch (e) {
      fs.rmSync(staging, { recursive: true, force: true });
      throw new ImportError(`extract failed: ${(e as Error).message}`, 500);
    }
  } else {
    const x = spawnSync('tar', ['-xzf', file, '-C', staging, ...tarArgs([], dynamic)], { encoding: 'utf8' });
    if (x.status !== 0) {
      fs.rmSync(staging, { recursive: true, force: true });
      throw new ImportError(`extract failed: ${(x.stderr || '').trim().split('\n').pop() || 'tar failed'}`, 500);
    }
  }
  // the manifest stays in the restored dir as a record of where it came from
  fs.writeFileSync(path.join(staging, MANIFEST_NAME), JSON.stringify({ ...manifest, importedAt: new Date().toISOString() }, null, 2) + '\n');

  // #3: resolve machine-specific absolute paths anew on a cross-platform restore.
  const stagedConfig = path.join(staging, 'config.json');
  const rawConfig = readJson<Record<string, unknown>>(stagedConfig);
  if (rawConfig) {
    const resolved = resolveConfigPathsForImport(rawConfig, manifest.host?.platform);
    if (resolved !== rawConfig) fs.writeFileSync(stagedConfig, JSON.stringify(resolved, null, 2) + '\n');
  }

  // A PARTIAL archive (exported with `include`) is an overlay, not a
  // replacement. The manifest has said which top-level entries it carries
  // since buildManifest() was written; importFull simply never read it, and
  // swapped the whole dir regardless — so importing "just my memory and
  // agents" silently took users.json, config.json, chat/ and every session
  // with it. Merging is what makes `include` usable at all.
  const staged = fs.readdirSync(staging).filter((n) => n !== MANIFEST_NAME);
  const partial = Array.isArray(manifest.include) && manifest.include.length > 0;
  const localized = staged.includes('state.json')
    ? localizeSessionsForImport(staging, manifest.host?.platform)
    : { cwds: 0, conversations: 0 };

  if (partial) {
    const bak = path.join(parent, `${path.basename(dir)}.bak-${ts}`);
    fs.mkdirSync(bak, { recursive: true });
    for (const n of staged) {
      const from = path.join(dir, n);
      if (fs.existsSync(from)) fs.renameSync(from, path.join(bak, n));
      fs.renameSync(path.join(staging, n), path.join(dir, n));
    }
    // the record of where this came from, alongside the entries it replaced
    fs.copyFileSync(path.join(staging, MANIFEST_NAME), path.join(dir, MANIFEST_NAME));
    fs.rmSync(staging, { recursive: true, force: true });
    return {
      manifest, restoredTo: dir, backupDir: bak, entries: entries.length, restartRequired: true,
      whatsappSkipped: hasWhatsAppAuth && !opts.whatsapp,
      clearedCwds: localized.cwds, clearedConversations: localized.conversations,
      restored: staged, partial: true,
    };
  }

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
  return {
    manifest, restoredTo: dir, backupDir, entries: entries.length, restartRequired: true,
    whatsappSkipped: hasWhatsAppAuth && !opts.whatsapp,
    clearedCwds: localized.cwds, clearedConversations: localized.conversations,
    restored: staged, partial: false,
  };
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
  if (useJsTar()) {
    const r = jsTar.createTarGzStream([{ dir, members: ['.'] }]);
    return { stream: r.stream, filename, done: r.done, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }, kill: r.kill, warnings: [] };
  }
  const p = spawn('tar', ['-czf', '-', '-C', dir, '.'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const done = new Promise<number>((resolve) => p.on('close', (code) => resolve(code ?? 1)));
  return { stream: p.stdout, filename, done, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }, kill: () => { try { p.kill('SIGTERM'); } catch {} }, warnings: [] };
}

/** Extract a bundle archive into $ARIGAMI_DIR/profiles/<name>/ and return the dir (apply is profiles.ts's job). */
export async function unpackBundle(file: string): Promise<{ dir: string; name: string }> {
  const { kind } = await detectArchive(file);
  if (kind !== 'bundle') throw new ImportError('archive is not a profile bundle');
  const staging = fs.mkdtempSync(path.join(ensureTmp(ARIGAMI_DIR), 'bundle-import-'));
  if (useJsTar()) {
    try {
      await jsTar.extractTarGzToDir(file, staging, {});
    } catch (e) {
      fs.rmSync(staging, { recursive: true, force: true });
      throw new ImportError(`extract failed: ${(e as Error).message}`, 500);
    }
  } else {
    const x = spawnSync('tar', ['-xzf', file, '-C', staging], { encoding: 'utf8' });
    if (x.status !== 0) throw new ImportError(`extract failed: ${(x.stderr || '').trim().split('\n').pop() || 'tar failed'}`, 500);
  }
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
      const m = await exportFullToFile(file, { include, whatsapp: flag('--whatsapp') });
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
      const { kind } = await detectArchive(file);
      if (kind === 'bundle') {
        const u = await unpackBundle(file);
        const pf = await import('./profiles.js');
        const tr = await import('./triggers.js');
        tr.load();
        const rep = await pf.applySource(u.dir);
        tr.flush();
        out({ ok: true, kind, ...rep });
      } else {
        const r = await importFull(file, { force: flag('--force'), whatsapp: flag('--whatsapp') });
        if (r.whatsappSkipped) process.stderr.write('warning: this archive has a WhatsApp pairing (whatsapp/auth_info) — left OUT of the restore; re-run with --whatsapp once you\'re sure no other machine still needs that WhatsApp number\n');
        out({ ok: true, kind, ...r });
      }
    } else if (cmd === 'inspect') {
      const file = positional[0];
      const d = await detectArchive(file);
      out({ kind: d.kind, entries: d.entries.length, manifest: d.kind === 'full' ? await readManifestFromArchive(file) : null });
    } else {
      process.stderr.write('usage: bun server/backup.ts export --full [out.tgz] [--include a,b] [--whatsapp] | export --bundle [out-dir|out.tgz] [--name n] [--no-memory] | import <file.tgz> [--force] [--whatsapp] | inspect <file>\n');
      process.exitCode = 2;
    }
  } catch (e) {
    process.stderr.write(`error: ${(e as Error).message}\n`);
    process.exitCode = (e as ImportError).status === 409 ? 3 : 1;
  }
}
