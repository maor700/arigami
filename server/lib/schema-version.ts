// Versioned, forward-migrating persistent state files.
//
// WHY: once the desktop updater applies a signed release while the human is
// asleep, nobody is watching the first boot on the new version. Today the owner runs
// the upgrade himself and sees it when a state file does not line up. That ends
// the moment the update is automatic — so the state files need the same
// contract the backup archive already has (server/backup.ts: BACKUP_FORMAT, a
// manifest that carries it, and an import that REFUSES a format it does not
// understand instead of guessing). This is that contract, applied per file
// inside $ARIGAMI_DIR. Same shape on purpose; the registry lives in
// ./state-schemas.ts.
//
// The four rules:
//
//   1. Every covered file carries `schemaVersion` at its root.
//   2. A file WITHOUT the field is version 1. Every installation on earth,
//      the owner's included, is in that state right now — it must load with nothing
//      lost. This is the compatibility hinge and the reason nothing here ever
//      requires the field to be present.
//   3. Forward migration only: a chain of steps run at boot, each idempotent,
//      each safe to re-run on its own output.
//   4. A file NEWER than this build is refused, loudly, and left untouched.
//      That happens when the updater rolls back to an older release after a bad
//      update — planned, not exotic. Stopping with a legible message beats
//      reading a file we do not understand and silently flattening it.
//
// And the safety net: nothing is rewritten without a `.bak-v<from>-<ts>` copy
// beside it first, so a crash mid-migration is recoverable by hand. (Those
// backups are already outside every archive — backup.ts EXCLUDE_GLOBS carries
// `*.bak-*` — and outside a profile bundle.)
//
// Zero-cost when nothing changed: a file already at the current version is not
// read-modify-written, not backed up, not touched. On a host whose schemas are
// all at v1 (which is all of them today) boot does exactly what it did before.
import fs from 'node:fs';
import path from 'node:path';

/** Root key holding the file's schema version. Absent ⇒ version 1 (rule 2). */
export const SCHEMA_VERSION_KEY = 'schemaVersion';

/** The version an existing, unstamped file is understood to be. */
export const FIRST_VERSION = 1;

export type Doc = Record<string, unknown>;

export interface MigrationStep {
  /** Version this step PRODUCES (so a 1→2 step has `to: 2`). */
  to: number;
  /** One line, printed when the step runs. */
  note: string;
  /**
   * Pure transform. Must be idempotent: `up(up(d))` deep-equals `up(d)`, because
   * a migration that dies after writing and before stamping runs again next boot.
   */
  up(doc: Doc): Doc;
}

export interface StateSchema {
  /** File's basename, for messages: 'state.json'. */
  name: string;
  /** Version this build writes and understands. */
  version: number;
  /** Steps to get from FIRST_VERSION up to `version`. May be empty. */
  steps: MigrationStep[];
}

/** Refusal (rule 4) and malformed-version errors. Never thrown for a MISSING field. */
export class SchemaVersionError extends Error {
  readonly code: 'too-new' | 'bad-version' | 'no-path';
  readonly file: string;
  readonly found: number | null;
  readonly supported: number;
  constructor(code: SchemaVersionError['code'], message: string, file: string, found: number | null, supported: number) {
    super(message);
    this.name = 'SchemaVersionError';
    this.code = code;
    this.file = file;
    this.found = found;
    this.supported = supported;
  }
}

const isPlainObject = (v: unknown): v is Doc =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * The version of a parsed document. Absent/null ⇒ FIRST_VERSION (rule 2).
 * Anything else that is not a positive integer is MALFORMED and throws — a
 * `"schemaVersion": "2"` or `0` means someone hand-edited the file, and
 * guessing is exactly what this module exists to prevent.
 */
export function docVersion(doc: unknown, name = 'state file'): number {
  if (!isPlainObject(doc)) return FIRST_VERSION;
  const raw = doc[SCHEMA_VERSION_KEY];
  if (raw === undefined || raw === null) return FIRST_VERSION;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1)
    throw new SchemaVersionError('bad-version', `${name}: "${SCHEMA_VERSION_KEY}" is ${JSON.stringify(raw)}, expected a positive integer`, name, null, FIRST_VERSION);
  return raw;
}

/** Return `doc` with the schema version stamped first (nice diffs). */
export function stamp<T extends Doc>(doc: T, schema: StateSchema): T {
  const { [SCHEMA_VERSION_KEY]: _drop, ...rest } = doc as Doc;
  return { [SCHEMA_VERSION_KEY]: schema.version, ...rest } as unknown as T;
}

export interface MigrateResult {
  doc: Doc;
  from: number;
  to: number;
  /** Notes of the steps that actually ran, in order. */
  applied: string[];
  /** false ⇒ the document is byte-identical in meaning; do not rewrite the file. */
  changed: boolean;
}

/**
 * Pure, in-memory migration. No IO, no backup — `migrateFile` wraps this.
 * Throws SchemaVersionError on a too-new document (rule 4) or a gap in the chain.
 */
export function migrateDoc(doc: Doc, schema: StateSchema): MigrateResult {
  const from = docVersion(doc, schema.name);
  if (from > schema.version)
    throw new SchemaVersionError(
      'too-new',
      `${schema.name} was written by a newer Arigami (schemaVersion ${from}); this build understands up to ${schema.version}. ` +
        `Refusing to read it rather than risk losing data — upgrade Arigami again, or restore the matching ${schema.name}.bak-* beside it.`,
      schema.name,
      from,
      schema.version
    );

  const steps = [...schema.steps].filter((s) => s.to > from && s.to <= schema.version).sort((a, b) => a.to - b.to);
  let at = from;
  let out: Doc = doc;
  const applied: string[] = [];
  for (const s of steps) {
    if (s.to !== at + 1)
      throw new SchemaVersionError('no-path', `${schema.name}: no migration from version ${at} to ${s.to} — the step chain has a gap`, schema.name, at, schema.version);
    out = s.up(out);
    if (!isPlainObject(out)) throw new SchemaVersionError('no-path', `${schema.name}: migration step ${at}→${s.to} did not return an object`, schema.name, at, schema.version);
    applied.push(`${at}→${s.to} ${s.note}`);
    at = s.to;
  }
  if (at !== schema.version)
    throw new SchemaVersionError('no-path', `${schema.name}: no migration from version ${at} to ${schema.version} — a step is missing`, schema.name, at, schema.version);

  return { doc: stamp(out, schema), from, to: schema.version, applied, changed: from !== schema.version };
}

export type MigrateFileStatus =
  | 'absent'      // no such file — a fresh install; nothing to do
  | 'unreadable'  // present but not parseable JSON / not an object — left alone
  | 'current'     // already at this version — NOT touched
  | 'migrated';   // backed up, migrated, rewritten

export interface MigrateFileResult {
  status: MigrateFileStatus;
  file: string;
  from?: number;
  to?: number;
  applied?: string[];
  /** Path of the `.bak-v<from>-<ts>` copy taken before the rewrite. */
  backup?: string;
  /** Parse error text when status is 'unreadable'. */
  error?: string;
}

const ts = (d = new Date()): string => d.toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');

/** `<file>.bak-v<from>-<20260909-141530>`; already excluded from backups/bundles. */
export function backupPath(file: string, from: number, now = new Date()): string {
  return `${file}.bak-v${from}-${ts(now)}`;
}

/**
 * Migrate one state file in place, at boot, before its owner parses it.
 *
 * Never rewrites a file that is already current. Never rewrites one it could not
 * parse (that is the owner module's existing tolerance, and clobbering a
 * corrupt-but-recoverable file is worse than ignoring it). Always takes the
 * backup BEFORE the first byte of the new file is written, and writes through a
 * temp file + rename so an interrupted write cannot leave a half file behind.
 *
 * Throws SchemaVersionError when the file is newer than this build (rule 4) —
 * the caller decides whether that is fatal (for state.json and config.json it is).
 */
export function migrateFile(file: string, schema: StateSchema, opts: { log?: (m: string) => void; now?: Date } = {}): MigrateFileResult {
  // stderr, not stdout: `bin/host` subcommands print JSON on stdout and a boot
  // notice landing in the middle of it would corrupt the caller's parse.
  const log = opts.log ?? ((m: string) => console.error(m));
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { status: 'absent', file };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { status: 'unreadable', file, error: (e as Error).message };
  }
  if (!isPlainObject(parsed)) return { status: 'unreadable', file, error: 'top level is not a JSON object' };

  const res = migrateDoc(parsed, schema); // may throw SchemaVersionError — deliberate
  if (!res.changed) return { status: 'current', file, from: res.from, to: res.to };

  // Backup first — a failure here aborts the migration rather than proceeding
  // without a way back.
  const bak = backupPath(file, res.from, opts.now);
  fs.copyFileSync(file, bak);

  let mode = 0o600;
  try { mode = fs.statSync(file).mode & 0o777; } catch {}
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(res.doc, null, 2) + '\n', { mode });
  try { fs.chmodSync(tmp, mode); } catch {}
  fs.renameSync(tmp, file);

  log(`[schema] ${path.basename(file)}: ${res.from} → ${res.to}${res.applied.length ? ' — ' + res.applied.join('; ') : ' (stamp only)'}; backup: ${path.basename(bak)}`);
  return { status: 'migrated', file, from: res.from, to: res.to, applied: res.applied, backup: bak };
}
