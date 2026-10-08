// Shared workspaces — the operations behind the admin page and `bun src/cli.ts shared …` (one implementation,
// two front doors). Storage and the access decision are in shared.ts.
//
// Provisioning is NOT forked: a shared workspace is created with db.createTenant like any tenant, rendered by the
// same provisioner.provisionTenant (which adds the two chart flags from sharedHelmArgs), and from then on the
// reconcile loop upgrades and backs it up in the same pass as every personal tenant.
//
// Membership changes take effect in two places:
//   1. the edge, at once — GET /auth/verify reads tenant_members on every request, nothing is cached;
//   2. inside the pod — the roster (who is still a member, with which role) is pushed over loopback
//      (provisioner.pushRoster), and the tenant drops every session, API token and open socket of anyone who is
//      no longer on it (server/org-access.ts). A failed push leaves roster_gen != roster_synced_gen and is
//      retried by startRosterSync until it lands.
import type { Config } from './config.js';
import type { Store, Tenant } from './db.js';
import { canTransition } from './state-machine.js';
import { mintRoster } from './handoff.js';
import {
  NAME_RE, SHARED_ROLES, isMemberPolicy, isSharedRole, normEmail, rosterFor, sharedSubject, validEmail,
  type MemberPolicy, type SharedRole, type Member, type SharedTenant,
} from './shared.js';

export interface SharedDeps {
  cfg: Config;
  store: Store;
  provisioner: {
    provisionTenant(cfg: Config, t: Tenant): Promise<{ url: string }>;
    deleteTenant(cfg: Config, t: Tenant): Promise<void>;
  };
  /** Absent (tests, a provisioner without exec) = the roster is never pushed and stays dirty. */
  pushRoster?: (cfg: Config, t: Tenant, token: string) => Promise<void>;
  log: (m: string) => void;
}

export class SharedError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
    this.name = 'SharedError';
  }
}

/** Extra `helm upgrade --install` args for a shared tenant (provisioner.ts). Empty for a personal one. */
export function sharedHelmArgs(t: Pick<Tenant, 'kind' | 'org_host'>): string[] {
  if (t.kind !== 'shared') return [];
  const out = ['--set', 'sharedWorkspace=true'];
  if (t.org_host) out.push('--set', 'orgHost=true');
  return out;
}

function mustFind(deps: SharedDeps, name: string): SharedTenant {
  const t = deps.store.findShared(name);
  if (!t) throw new SharedError(`no shared workspace named "${name}"`, 404);
  if (t.state === 'deleted') throw new SharedError(`shared workspace "${name}" is deleted`, 409);
  return t;
}

export interface CreateOpts {
  name: string;
  policy?: MemberPolicy;
  defaultRole?: SharedRole;
  orgHost?: boolean;
  by: string;
  /** Initial members, e.g. the creating admin as owner. */
  members?: { email: string; role: SharedRole }[];
}

/**
 * Create the row (and members) synchronously; provisioning runs in `provisioned`, which a caller may await (the
 * CLI) or leave running (the admin page — the row is already `provisioning`, the list shows it).
 */
export function createShared(deps: SharedDeps, o: CreateOpts): { tenant: SharedTenant; provisioned: Promise<boolean> } {
  const { cfg, store, log } = deps;
  const name = String(o.name || '').trim().toLowerCase();
  if (!NAME_RE.test(name)) throw new SharedError('name must be 2-32 chars: lowercase letters, digits and dashes, starting with a letter');
  const policy = o.policy ?? 'explicit';
  const defaultRole = o.defaultRole ?? 'member';
  if (!isMemberPolicy(policy)) throw new SharedError('policy must be explicit or org');
  if (!isSharedRole(defaultRole)) throw new SharedError(`default role must be one of ${SHARED_ROLES.join(', ')}`);
  // A deleted workspace keeps its row (and its namespace name) — reusing the name would silently resurrect the
  // address, so a new workspace needs a new name.
  if (store.findShared(name)) throw new SharedError(`a shared workspace named "${name}" already exists (or existed)`, 409);
  const orgHost = o.orgHost !== false;
  // `scope: org` cron jobs run on EVERY host started with ARIGAMI_ORG_HOST=1 — two org hosts = every org job twice.
  if (orgHost) {
    const other = store.listShared().find((t) => t.org_host && t.state !== 'deleted');
    if (other) throw new SharedError(`"${other.name}" is already the org host — create this one with orgHost off`, 409);
  }
  for (const m of o.members || []) {
    if (!validEmail(m.email) || !isSharedRole(m.role)) throw new SharedError(`bad member ${m.email} (${m.role})`);
  }
  const subject = sharedSubject(name);
  store.createTenant(subject, '', { desiredDigest: cfg.imageTag });
  store.markShared(subject, { name, policy, defaultRole, orgHost });
  let tenant = store.findShared(name)!;
  for (const m of o.members || []) store.upsertMember(tenant.ns, m.email, m.role, o.by);
  if (o.members?.length) store.bumpRoster(tenant.ns);
  tenant = store.findShared(name)!;
  log(`[shared] ${name} (${tenant.ns}) created by ${o.by}: policy=${policy} default=${defaultRole} orgHost=${orgHost}`);

  const provisioned = (async () => {
    try {
      const { url } = await deps.provisioner.provisionTenant(cfg, tenant);
      store.setRunningDigest(subject, tenant.desired_digest);
      store.setTenantState(subject, 'running');
      log(`[shared] ${name} running at ${url}`);
      await syncRoster(deps, name);
      return true;
    } catch (e) {
      // Same as a personal tenant: stays `provisioning`, an admin can retry (idempotent helm upgrade --install).
      log(`[shared] ${name} provisioning failed: ${(e as Error).message}`);
      return false;
    }
  })();
  return { tenant, provisioned };
}

export type SyncResult = { pushed: true; gen: number } | { pushed: false; reason: string };

/** Push the current roster into the pod. Never throws; a miss stays dirty and startRosterSync retries it. */
export async function syncRoster(deps: SharedDeps, name: string): Promise<SyncResult> {
  const t = deps.store.findShared(name);
  if (!t) return { pushed: false, reason: 'no such workspace' };
  if (t.state !== 'running') return { pushed: false, reason: `workspace is ${t.state}; pushed when it runs again` };
  if (!deps.pushRoster) return { pushed: false, reason: 'no roster transport configured' };
  if (!t.handoff_secret) return { pushed: false, reason: 'tenant has no handoff secret' };
  const gen = t.roster_gen;
  try {
    const token = mintRoster(t.handoff_secret, rosterFor(t, deps.store.listMembers(t.ns)));
    await deps.pushRoster(deps.cfg, t, token);
    deps.store.markRosterSynced(t.ns, gen);
    return { pushed: true, gen };
  } catch (e) {
    deps.log(`[shared] ${name}: roster push failed (will retry): ${(e as Error).message}`);
    return { pushed: false, reason: (e as Error).message };
  }
}

export async function addMember(deps: SharedDeps, name: string, email: string, role: SharedRole, by: string): Promise<{ member: Member; sync: SyncResult }> {
  const t = mustFind(deps, name);
  if (!validEmail(email)) throw new SharedError(`not an e-mail address: ${email}`);
  if (!isSharedRole(role)) throw new SharedError(`role must be one of ${SHARED_ROLES.join(', ')}`);
  const member = deps.store.upsertMember(t.ns, email, role, by);
  deps.store.bumpRoster(t.ns);
  deps.log(`[shared] ${name}: ${normEmail(email)} is ${role} (by ${by})`);
  return { member, sync: await syncRoster(deps, name) };
}

export async function removeMember(deps: SharedDeps, name: string, email: string, by: string): Promise<{ removed: boolean; sync: SyncResult }> {
  const t = mustFind(deps, name);
  const removed = deps.store.removeMember(t.ns, email);
  if (!removed) throw new SharedError(`${normEmail(email)} is not a member of ${name}`, 404);
  deps.store.bumpRoster(t.ns);
  deps.log(`[shared] ${name}: ${normEmail(email)} removed (by ${by})`);
  return { removed, sync: await syncRoster(deps, name) };
}

export async function setPolicy(deps: SharedDeps, name: string, policy: MemberPolicy, defaultRole: SharedRole, by: string): Promise<{ sync: SyncResult }> {
  const t = mustFind(deps, name);
  if (!isMemberPolicy(policy)) throw new SharedError('policy must be explicit or org');
  if (!isSharedRole(defaultRole)) throw new SharedError(`default role must be one of ${SHARED_ROLES.join(', ')}`);
  deps.store.setPolicy(t.ns, policy, defaultRole);
  deps.store.bumpRoster(t.ns);
  deps.log(`[shared] ${name}: policy=${policy} default=${defaultRole} (by ${by})`);
  return { sync: await syncRoster(deps, name) };
}

export async function deleteShared(deps: SharedDeps, name: string, by: string): Promise<void> {
  const t = mustFind(deps, name);
  if (!canTransition(t.state, 'deleted')) throw new SharedError(`cannot delete a workspace in state ${t.state}`, 409);
  await deps.provisioner.deleteTenant(deps.cfg, t);
  deps.store.setTenantState(t.subject, 'deleted');
  deps.store.deleteMembers(t.ns);
  deps.log(`[shared] ${name} (${t.ns}) deleted by ${by}`);
}

/** One pass of the retry loop: every running shared tenant whose roster the pod has not acknowledged yet. */
export async function rosterSyncTick(deps: SharedDeps): Promise<string[]> {
  const pushed: string[] = [];
  for (const t of deps.store.rosterDirty()) {
    if (t.state !== 'running') continue;
    const r = await syncRoster(deps, t.name);
    if (r.pushed) pushed.push(t.name);
  }
  return pushed;
}

/** Separate from the reconcile loop on purpose: a membership change should not wait behind an upgrade or a backup. */
export function startRosterSync(deps: SharedDeps, everyMs = 30_000): { stop(): void } {
  let inFlight = false;
  const timer = setInterval(async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      await rosterSyncTick(deps);
    } catch (e) {
      deps.log(`[shared] roster sync tick error: ${(e as Error).message}`);
    } finally {
      inFlight = false;
    }
  }, everyMs);
  (timer as any).unref?.();
  return { stop: () => clearInterval(timer) };
}
