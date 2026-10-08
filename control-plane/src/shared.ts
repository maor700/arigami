// Shared org workspaces — one tenant that several org members open (docs/CONTROL-PLANE.md "Shared workspaces").
//
// A tenant row is now one of two kinds:
//
//   personal  the K8S-2 shape: one per user, `subject` = that user's OIDC subject, only they get in.
//   shared    created by an org-admin, `subject` = `shared:<name>`, opened by its MEMBERS. Usually the org host
//             (ARIGAMI_ORG_HOST=1) where `scope: org` cron jobs and shared agents live.
//
// Both keep the same namespace scheme (u-<10 hex of sha256(subject)>), the same chart, the same reconcile loop —
// a shared workspace is a tenant with a member list, nothing more. Who may open it:
//
//   member_policy = 'explicit'  only the e-mails in tenant_members, each with its own role
//   member_policy = 'org'       every signed-in org user, with `default_role`; an explicit row overrides the role
//
// Roles are the control plane's vocabulary; the tenant host only knows admin/user/viewer (server/auth.ts), so
// owner and admin both become a tenant admin, member a tenant user, viewer a read-only tenant viewer that can
// never run a turn. `owner` is the accountable person(s) for the workspace; it grants nothing over `admin`.
//
// Everything here is storage + pure decisions. The HTTP routes live in shared-routes.ts, the operations
// (provision / push roster / delete) in shared-ops.ts, the CLI in shared-cli.ts.
import type { Database } from 'bun:sqlite';
import type { Tenant } from './db.js';

export type TenantKind = 'personal' | 'shared';
export type SharedRole = 'owner' | 'admin' | 'member' | 'viewer';
export type MemberPolicy = 'explicit' | 'org';
/** The tenant host's own roles (server/auth.ts Role). The handoff and the roster speak this vocabulary. */
export type TenantRole = 'admin' | 'user' | 'viewer';

export const SHARED_ROLES: readonly SharedRole[] = ['owner', 'admin', 'member', 'viewer'];
export const MEMBER_POLICIES: readonly MemberPolicy[] = ['explicit', 'org'];
export const SHARED_SUBJECT_PREFIX = 'shared:';
/** DNS-label-ish, so the name can appear in URLs and logs without escaping surprises. */
export const NAME_RE = /^[a-z][a-z0-9-]{0,30}[a-z0-9]$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** A tenant row as read from the DB: the shared-workspace columns are always there. */
export type SharedTenant = Tenant & {
  kind: TenantKind;
  name: string;
  member_policy: MemberPolicy;
  default_role: SharedRole;
  org_host: number;
  roster_gen: number;
  roster_synced_gen: number;
};

export interface Member {
  ns: string;
  email: string;
  role: SharedRole;
  added_by: string;
  added_at: string;
}

export function isSharedRole(r: unknown): r is SharedRole {
  return typeof r === 'string' && (SHARED_ROLES as readonly string[]).includes(r);
}
export function isMemberPolicy(p: unknown): p is MemberPolicy {
  return typeof p === 'string' && (MEMBER_POLICIES as readonly string[]).includes(p);
}
export function normEmail(e: string): string {
  return String(e || '').trim().toLowerCase();
}
export function validEmail(e: string): boolean {
  return EMAIL_RE.test(normEmail(e));
}
export function sharedSubject(name: string): string {
  return SHARED_SUBJECT_PREFIX + name;
}

export function tenantRoleFor(role: SharedRole): TenantRole {
  if (role === 'owner' || role === 'admin') return 'admin';
  if (role === 'member') return 'user';
  return 'viewer';
}

// ---- the access decision (pure; the gate, the picker and the handoff all ask this one function) ----------------

export interface Who {
  subject: string;
  email: string;
}

export type Access =
  | { allow: true; role: SharedRole; via: 'owner' | 'member' | 'org-policy' }
  | { allow: false; reason: 'no-tenant' | 'not-owner' | 'not-member' | 'deleted' };

/**
 * May `who` open tenant `t`? Fail closed: anything not positively matched is a no. An org-admin gets nothing
 * extra here — they manage membership on /admin and must add themselves to get in, like anyone else.
 * A deleted tenant admits nobody (its members table may still have rows until the delete finishes).
 */
export function decideAccess(t: Tenant | null, who: Who, member: Member | null): Access {
  if (!t) return { allow: false, reason: 'no-tenant' };
  if (t.state === 'deleted') return { allow: false, reason: 'deleted' };
  const kind: TenantKind = t.kind === 'shared' ? 'shared' : 'personal';
  if (kind === 'personal') {
    return t.subject === who.subject ? { allow: true, role: 'owner', via: 'owner' } : { allow: false, reason: 'not-owner' };
  }
  const email = normEmail(who.email);
  if (member && normEmail(member.email) === email && member.ns === t.ns && isSharedRole(member.role)) {
    return { allow: true, role: member.role, via: 'member' };
  }
  if (t.member_policy === 'org' && isSharedRole(t.default_role) && email) {
    return { allow: true, role: t.default_role, via: 'org-policy' };
  }
  return { allow: false, reason: 'not-member' };
}

/**
 * What the tenant host is told about its members (POST /__api/auth/roster, server/org-access.ts). The tenant
 * revokes every local session/API token of a user who is no longer on it, and moves roles to match.
 */
export interface Roster {
  /** tenants.roster_gen at mint time — the tenant ignores a roster older than the last one it applied */
  gen: number;
  policy: MemberPolicy;
  defaultRole: TenantRole | null;
  members: Record<string, TenantRole>;
}

export function rosterFor(t: Tenant, members: Member[]): Roster {
  const out: Record<string, TenantRole> = {};
  for (const m of members) if (isSharedRole(m.role)) out[normEmail(m.email)] = tenantRoleFor(m.role);
  const policy: MemberPolicy = t.member_policy === 'org' ? 'org' : 'explicit';
  return {
    gen: Number(t.roster_gen) || 0,
    policy,
    defaultRole: policy === 'org' && isSharedRole(t.default_role) ? tenantRoleFor(t.default_role) : null,
    members: out,
  };
}

// ---- storage ---------------------------------------------------------------------------------------------------

/** Additive, idempotent: safe on a fresh DB, on a K8S-3 DB, and on re-run. Called from db.ts openDb. */
export function migrateShared(db: Database): void {
  const cols = new Set((db.query('PRAGMA table_info(tenants)').all() as { name: string }[]).map((c) => c.name));
  const add = (name: string, ddl: string) => {
    if (!cols.has(name)) db.exec(`ALTER TABLE tenants ADD COLUMN ${name} ${ddl}`);
  };
  add('kind', "TEXT NOT NULL DEFAULT 'personal'");
  add('name', "TEXT NOT NULL DEFAULT ''");
  add('member_policy', "TEXT NOT NULL DEFAULT 'explicit'");
  add('default_role', "TEXT NOT NULL DEFAULT 'member'");
  add('org_host', 'INTEGER NOT NULL DEFAULT 0');
  // Roster generations: every membership change bumps roster_gen; a successful push into the pod records it in
  // roster_synced_gen. gen != synced = the pod still has to hear about it (retried, shared-ops.ts).
  add('roster_gen', 'INTEGER NOT NULL DEFAULT 0');
  add('roster_synced_gen', 'INTEGER NOT NULL DEFAULT 0');
  db.exec(`
    CREATE TABLE IF NOT EXISTS tenant_members (
      ns TEXT NOT NULL,
      email TEXT NOT NULL,
      role TEXT NOT NULL,
      added_by TEXT NOT NULL DEFAULT '',
      added_at TEXT NOT NULL,
      PRIMARY KEY (ns, email)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS tenants_shared_name ON tenants(name) WHERE kind = 'shared';
  `);
}

export function createSharedStore(db: Database) {
  const now = () => new Date().toISOString();
  const one = (sql: string, ...args: any[]): SharedTenant | null => (db.query(sql).get(...args) as SharedTenant) || null;

  /** A user's OWN tenant. Never a shared one, even if an IdP hands out a subject that looks like `shared:<name>`. */
  function findPersonalTenant(subject: string): SharedTenant | null {
    return one("SELECT * FROM tenants WHERE subject = ? AND kind = 'personal'", subject);
  }
  function findShared(name: string): SharedTenant | null {
    return one("SELECT * FROM tenants WHERE kind = 'shared' AND name = ?", String(name || '').toLowerCase());
  }
  function listShared(): SharedTenant[] {
    return db.query("SELECT * FROM tenants WHERE kind = 'shared' ORDER BY name ASC").all() as SharedTenant[];
  }
  /** After db.createTenant inserted the row with the column defaults: turn it into a shared one. */
  function markShared(subject: string, opts: { name: string; policy: MemberPolicy; defaultRole: SharedRole; orgHost: boolean }): void {
    db.query(
      "UPDATE tenants SET kind = 'shared', name = ?, email = '', member_policy = ?, default_role = ?, org_host = ? WHERE subject = ?",
    ).run(opts.name, opts.policy, opts.defaultRole, opts.orgHost ? 1 : 0, subject);
  }
  function setPolicy(ns: string, policy: MemberPolicy, defaultRole: SharedRole): void {
    db.query('UPDATE tenants SET member_policy = ?, default_role = ? WHERE ns = ?').run(policy, defaultRole, ns);
  }

  function getMember(ns: string, email: string): Member | null {
    return (db.query('SELECT * FROM tenant_members WHERE ns = ? AND email = ?').get(ns, normEmail(email)) as Member) || null;
  }
  function listMembers(ns: string): Member[] {
    return db.query('SELECT * FROM tenant_members WHERE ns = ? ORDER BY email ASC').all(ns) as Member[];
  }
  function upsertMember(ns: string, email: string, role: SharedRole, addedBy: string): Member {
    const m: Member = { ns, email: normEmail(email), role, added_by: normEmail(addedBy) || addedBy, added_at: now() };
    db.query(
      `INSERT INTO tenant_members (ns, email, role, added_by, added_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(ns, email) DO UPDATE SET role = excluded.role`,
    ).run(m.ns, m.email, m.role, m.added_by, m.added_at);
    return getMember(ns, email)!;
  }
  function removeMember(ns: string, email: string): boolean {
    return db.query('DELETE FROM tenant_members WHERE ns = ? AND email = ?').run(ns, normEmail(email)).changes > 0;
  }
  function deleteMembers(ns: string): void {
    db.query('DELETE FROM tenant_members WHERE ns = ?').run(ns);
  }

  /** Shared workspaces `who` may open, with the role they would get. Same decision as the gate. */
  function sharedFor(who: Who): { tenant: SharedTenant; role: SharedRole }[] {
    const out: { tenant: SharedTenant; role: SharedRole }[] = [];
    for (const t of listShared()) {
      const a = decideAccess(t, who, getMember(t.ns, who.email));
      if (a.allow) out.push({ tenant: t, role: a.role });
    }
    return out;
  }

  function bumpRoster(ns: string): number {
    db.query('UPDATE tenants SET roster_gen = roster_gen + 1 WHERE ns = ?').run(ns);
    return (db.query('SELECT roster_gen FROM tenants WHERE ns = ?').get(ns) as { roster_gen: number } | null)?.roster_gen ?? 0;
  }
  function markRosterSynced(ns: string, gen: number): void {
    // Never move backwards: a slow push of an older roster must not mark a newer change as delivered.
    db.query('UPDATE tenants SET roster_synced_gen = ? WHERE ns = ? AND roster_synced_gen < ?').run(gen, ns, gen);
  }
  function rosterDirty(): SharedTenant[] {
    return db.query("SELECT * FROM tenants WHERE kind = 'shared' AND roster_gen != roster_synced_gen ORDER BY name ASC").all() as SharedTenant[];
  }

  return {
    findPersonalTenant, findShared, listShared, markShared, setPolicy,
    getMember, listMembers, upsertMember, removeMember, deleteMembers, sharedFor,
    bumpRoster, markRosterSynced, rosterDirty,
  };
}
