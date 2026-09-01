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
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      subject TEXT NOT NULL,
      exp INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
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
  function createTenant(subject: string, email: string, opts: { desiredDigest: string; ring?: string }): Tenant {
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
    };
    db.query(
      `INSERT INTO tenants (subject, email, ns, release, desired_digest, running_digest, ring, state, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(t.subject, t.email, t.ns, t.release, t.desired_digest, t.running_digest, t.ring, t.state, t.created_at, t.last_seen_at);
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
    findTenantBySubject, listTenants, createTenant, setTenantState, setRunningDigest, touchLastSeen,
    createSession, findSession, deleteSession,
  };
}

export type Store = ReturnType<typeof createStore>;
