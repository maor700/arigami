// Storage: sqlite (bun:sqlite — built into the runtime, zero extra deps).
//
// Why sqlite and not Postgres for this pilot: the control-plane's own state
// is small (one row per org user, one per tenant) and single-writer — this
// process is the only thing that ever mutates it, same shape as the main
// host's users.json/sessions.json (server/auth.ts), just with real
// transactions instead of read-modify-write-whole-file. Postgres would earn
// its keep once there is a SECOND writer (a reconcile loop running as its
// own process/replica, K8S-3) or the fleet is large enough that a single
// sqlite file's single-writer lock becomes the bottleneck — neither is true
// yet at pilot scale. Swapping the store later means replacing this module;
// nothing above it (state-machine.ts, provisioner.ts, http routes) knows the
// storage engine.
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { canTransition, IllegalTransitionError, type TenantState } from './state-machine.js';
import { newSecret as newHandoffSecret } from './handoff.js';

export type Role = 'admin' | 'user';

export interface OrgUser {
  subject: string;
  email: string;
  role: Role;
  created_at: string;
}

export interface Tenant {
  subject: string;
  email: string;
  ns: string;
  release: string;
  desired_digest: string;
  running_digest: string;
  ring: string;
  state: TenantState;
  created_at: string;
  last_seen_at: string;
  /**
   * K8S-3: per-tenant HMAC secret, generated here and injected into the pod as
   * ARIGAMI_HANDOFF_SECRET, that lets this service sign a one-shot sign-in for
   * a user it already authenticated (src/handoff.ts). Never leaves this row and
   * the tenant's own Secret; never rendered in a page.
   */
  handoff_secret: string;
  /**
   * Profile rollout (src/profile-rollout.ts). profile_commit/ref: what the
   * tenant reported it last applied cleanly (read back from the tenant, never
   * assumed). profile_failed_commit/failures/next_at: an unresolved failed
   * apply — retried with backoff, and while it exists for the desired commit
   * the rollout to every OTHER tenant is halted (the canary rule).
   */
  profile_commit: string;
  profile_ref: string;
  profile_checked_at: number;
  profile_failed_commit: string;
  profile_failures: number;
  profile_next_at: number;
  profile_error: string;
}

export interface WebSession {
  token: string;
  subject: string;
  exp: number;
  created_at: number;
}

// DNS-label-safe, deterministic, collision-resistant enough for a pilot
// fleet (10 hex chars of sha256 = 40 bits): the same subject always maps to
// the same namespace, so re-running provisioning for the same user is
// naturally idempotent at the naming layer too.
export function tenantIdFor(subject: string): string {
  return crypto.createHash('sha256').update(subject).digest('hex').slice(0, 10);
}

export function openDb(dbPath: string): Database {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath, { create: true });
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      subject TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tenants (
      subject TEXT PRIMARY KEY REFERENCES users(subject),
      email TEXT NOT NULL,
      ns TEXT NOT NULL UNIQUE,
      release TEXT NOT NULL,
      desired_digest TEXT NOT NULL DEFAULT '',
      running_digest TEXT NOT NULL DEFAULT '',
      ring TEXT NOT NULL DEFAULT 'stable',
      state TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      subject TEXT NOT NULL,
      exp INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  // Additive migrations for databases created before a column existed. Kept
  // here (not a migrations framework) because the schema is three tables and
  // every change so far is "add a column with a default" — a tenant row from
  // K8S-2 keeps working, it just has no handoff secret and falls back to the
  // pairing screen (src/handoff.ts signInUrl).
  const tenantCols = new Set((db.query('PRAGMA table_info(tenants)').all() as { name: string }[]).map((c) => c.name));
  if (!tenantCols.has('handoff_secret')) db.exec("ALTER TABLE tenants ADD COLUMN handoff_secret TEXT NOT NULL DEFAULT ''");
  for (const [col, ddl] of [
    ['profile_commit', "TEXT NOT NULL DEFAULT ''"],
    ['profile_ref', "TEXT NOT NULL DEFAULT ''"],
    ['profile_checked_at', 'INTEGER NOT NULL DEFAULT 0'],
    ['profile_failed_commit', "TEXT NOT NULL DEFAULT ''"],
    ['profile_failures', 'INTEGER NOT NULL DEFAULT 0'],
    ['profile_next_at', 'INTEGER NOT NULL DEFAULT 0'],
    ['profile_error', "TEXT NOT NULL DEFAULT ''"],
  ] as const)
    if (!tenantCols.has(col)) db.exec(`ALTER TABLE tenants ADD COLUMN ${col} ${ddl}`);
  return db;
}

export function createStore(db: Database) {
  const now = () => new Date().toISOString();

  function findUserBySubject(subject: string): OrgUser | null {
    return (db.query('SELECT * FROM users WHERE subject = ?').get(subject) as OrgUser) || null;
  }
  function findUserByEmail(email: string): OrgUser | null {
    return (db.query('SELECT * FROM users WHERE email = ?').get(email.toLowerCase()) as OrgUser) || null;
  }
  function hasAdmin(): boolean {
    return !!db.query("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1").get();
  }
  function createUser(subject: string, email: string, role: Role): OrgUser {
    const u: OrgUser = { subject, email: email.toLowerCase(), role, created_at: now() };
    db.query('INSERT INTO users (subject, email, role, created_at) VALUES (?, ?, ?, ?)').run(
      u.subject, u.email, u.role, u.created_at,
    );
    return u;
  }
  function listUsers(): OrgUser[] {
    return db.query('SELECT * FROM users ORDER BY created_at ASC').all() as OrgUser[];
  }

  function findTenantBySubject(subject: string): Tenant | null {
    return (db.query('SELECT * FROM tenants WHERE subject = ?').get(subject) as Tenant) || null;
  }
  function listTenants(): Tenant[] {
    return db.query('SELECT * FROM tenants ORDER BY created_at ASC').all() as Tenant[];
  }
  function createTenant(subject: string, email: string, opts: { desiredDigest: string; ring?: string; handoffSecret?: string }): Tenant {
    const id = tenantIdFor(subject);
    const ns = `u-${id}`;
    const t: Tenant = {
      subject,
      email: email.toLowerCase(),
      ns,
      release: ns,
      desired_digest: opts.desiredDigest,
      running_digest: '',
      ring: opts.ring || 'stable',
      state: 'provisioning',
      created_at: now(),
      last_seen_at: now(),
      handoff_secret: opts.handoffSecret ?? newHandoffSecret(),
      profile_commit: '',
      profile_ref: '',
      profile_checked_at: 0,
      profile_failed_commit: '',
      profile_failures: 0,
      profile_next_at: 0,
      profile_error: '',
    };
    db.query(
      `INSERT INTO tenants (subject, email, ns, release, desired_digest, running_digest, ring, state, created_at, last_seen_at, handoff_secret)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(t.subject, t.email, t.ns, t.release, t.desired_digest, t.running_digest, t.ring, t.state, t.created_at, t.last_seen_at, t.handoff_secret);
    return t;
  }
  // Validated against state-machine.ts — callers never write an illegal edge
  // by accident (the provisioner, the admin HTTP routes, and the tests all
  // go through this one function).
  function setTenantState(subject: string, next: TenantState): Tenant {
    const t = findTenantBySubject(subject);
    if (!t) throw new Error(`no tenant for subject ${subject}`);
    if (!canTransition(t.state, next)) throw new IllegalTransitionError(t.state, next);
    db.query('UPDATE tenants SET state = ? WHERE subject = ?').run(next, subject);
    return { ...t, state: next };
  }
  function setRunningDigest(subject: string, digest: string): void {
    db.query('UPDATE tenants SET running_digest = ? WHERE subject = ?').run(digest, subject);
  }
  // K8S-3: what the reconcile loop converges the tenant TOWARD. Set by the
  // admin page / CLI; the loop upgrades when running_digest differs (and the
  // tenant has no turn in flight).
  function setDesiredDigest(subject: string, digest: string): void {
    db.query('UPDATE tenants SET desired_digest = ? WHERE subject = ?').run(digest, subject);
  }
  /** Rollout ring: `canary` tenants get a new profile first (src/profile-rollout.ts rolloutOrder). */
  function setRing(subject: string, ring: string): void {
    db.query('UPDATE tenants SET ring = ? WHERE subject = ?').run(ring, subject);
  }
  // Profile rollout bookkeeping (src/profile-rollout.ts).
  /** The tenant confirmed `commit` is applied cleanly — clears any failure/backoff. */
  function setProfileApplied(subject: string, commit: string, ref: string, at = Date.now()): void {
    db.query(
      `UPDATE tenants SET profile_commit = ?, profile_ref = ?, profile_checked_at = ?,
         profile_failed_commit = '', profile_failures = 0, profile_next_at = 0, profile_error = '' WHERE subject = ?`,
    ).run(commit, ref, at, subject);
  }
  /** A failed apply of `commit`; consecutive failures of the same commit count up. */
  function setProfileFailed(subject: string, commit: string, error: string, nextAt: number): void {
    const t = findTenantBySubject(subject);
    const failures = t && t.profile_failed_commit === commit ? t.profile_failures + 1 : 1;
    db.query('UPDATE tenants SET profile_failed_commit = ?, profile_failures = ?, profile_next_at = ?, profile_error = ? WHERE subject = ?').run(
      commit, failures, nextAt, error.slice(0, 2000), subject,
    );
  }
  /** Admin "retry now": keep the failure on record (the rollout stays halted) but drop the wait. */
  function clearProfileBackoff(subject: string): void {
    db.query('UPDATE tenants SET profile_next_at = 0 WHERE subject = ?').run(subject);
  }
  function getMeta<T>(key: string): T | null {
    const r = db.query('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | null;
    if (!r) return null;
    try {
      return JSON.parse(r.value) as T;
    } catch {
      return null;
    }
  }
  function setMeta(key: string, value: unknown): void {
    db.query('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
  }

  function touchLastSeen(subject: string): void {
    db.query('UPDATE tenants SET last_seen_at = ? WHERE subject = ?').run(now(), subject);
  }

  function createSession(subject: string, days: number): WebSession {
    const s: WebSession = {
      token: crypto.randomBytes(32).toString('base64url'),
      subject,
      exp: Date.now() + days * 86_400_000,
      created_at: Date.now(),
    };
    db.query('INSERT INTO sessions (token, subject, exp, created_at) VALUES (?, ?, ?, ?)').run(
      s.token, s.subject, s.exp, s.created_at,
    );
    return s;
  }
  function findSession(token: string): WebSession | null {
    const s = db.query('SELECT * FROM sessions WHERE token = ?').get(token) as WebSession | null;
    if (!s) return null;
    if (s.exp <= Date.now()) {
      db.query('DELETE FROM sessions WHERE token = ?').run(token);
      return null;
    }
    return s;
  }
  function deleteSession(token: string): void {
    db.query('DELETE FROM sessions WHERE token = ?').run(token);
  }

  return {
    findUserBySubject, findUserByEmail, hasAdmin, createUser, listUsers,
    findTenantBySubject, listTenants, createTenant, setTenantState, setRunningDigest, setDesiredDigest, touchLastSeen,
    setRing, setProfileApplied, setProfileFailed, clearProfileBackoff, getMeta, setMeta,
    createSession, findSession, deleteSession,
  };
}

export type Store = ReturnType<typeof createStore>;
