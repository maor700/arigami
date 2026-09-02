// K8S-3 §2 — upgrade a tenant from running_digest to desired_digest without
// losing data or interrupting work:
//
//   busy? ──yes──▶ UpgradeBlockedError (retry next reconcile tick)
//     │no
//   record helm revision ▶ helm upgrade (new digest) ▶ verify /__health
//     │ok                                                 │fail
//   done (caller sets running_digest)          helm rollback to recorded rev
//                                              ▶ verify /__health
//                                              ▶ UpgradeRolledBackError
//
// Pure orchestration over injected deps so test/upgrade.test.ts can drive
// every path without a cluster; src/reconcile.ts and the admin routes supply
// the real provisioner functions. The busy check FAILS CLOSED (an unreadable
// tenant throws in tenantBusySessions → no upgrade), mirroring the host's own
// import guard (server/backup.ts refuses while sessions are working).
//
// The window between "busy: 0" and the pod's SIGTERM is not zero — a turn
// that starts in those few seconds is killed by the rollout, exactly like a
// cockpit-initiated restart after its drain (docs/K8S.md "Graceful shutdown,
// honestly"). This gate removes the common case (upgrading over a user who is
// actively working), not every race; closing it fully needs a host-side
// "quiesce" mode, which is out of scope this wave.
import type { Tenant } from './db.js';

export interface UpgradeDeps {
  busySessions(t: Tenant): Promise<number>;
  revision(t: Tenant): Promise<number>;
  /** helm upgrade --install with t.desired_digest as the image digest/tag */
  provision(t: Tenant): Promise<{ url: string }>;
  verifyHealth(t: Tenant): Promise<void>;
  rollback(t: Tenant, rev: number): Promise<void>;
}

export interface UpgradeResult {
  from: string;
  to: string;
  revisionBefore: number;
}

export class UpgradeBlockedError extends Error {
  constructor(public readonly busySessions: number, ns: string) {
    super(`${ns} has ${busySessions} session(s) with a turn in flight — not upgrading`);
    this.name = 'UpgradeBlockedError';
  }
}

export class UpgradeRolledBackError extends Error {
  constructor(ns: string, toDigest: string, public readonly cause2: Error, public readonly revision: number) {
    super(`${ns} upgrade to ${toDigest} failed (${cause2.message}) — rolled back to revision ${revision}`);
    this.name = 'UpgradeRolledBackError';
  }
}

export class UpgradeFailedError extends Error {
  constructor(ns: string, toDigest: string, public readonly cause2: Error, public readonly rollbackError: Error) {
    super(
      `${ns} upgrade to ${toDigest} failed (${cause2.message}) AND rollback failed (${rollbackError.message}) — tenant needs an operator`,
    );
    this.name = 'UpgradeFailedError';
  }
}

/**
 * Returns normally only when the tenant is healthy on the NEW digest.
 * Throws UpgradeBlockedError (tenant busy — safe to retry later),
 * UpgradeRolledBackError (tenant healthy again on the OLD digest), or
 * UpgradeFailedError (tenant needs a human). The caller owns the db write
 * (setRunningDigest) — this module never touches storage.
 */
export async function upgradeTenant(deps: UpgradeDeps, t: Tenant, toDigest: string): Promise<UpgradeResult> {
  const busy = await deps.busySessions(t); // throws when unreadable — fail closed
  if (busy > 0) throw new UpgradeBlockedError(busy, t.ns);

  const rev = await deps.revision(t);
  const next: Tenant = { ...t, desired_digest: toDigest };
  try {
    await deps.provision(next);
    await deps.verifyHealth(next);
  } catch (e) {
    const cause = e as Error;
    // t may arrive with desired_digest already = toDigest (the reconcile loop
    // reads it straight off the row) — the post-rollback identity is the
    // digest that was RUNNING before this attempt.
    const prev: Tenant = { ...t, desired_digest: t.running_digest };
    try {
      await deps.rollback(prev, rev);
      await deps.verifyHealth(prev);
    } catch (re) {
      throw new UpgradeFailedError(t.ns, toDigest, cause, re as Error);
    }
    throw new UpgradeRolledBackError(t.ns, toDigest, cause, rev);
  }
  return { from: t.running_digest, to: toDigest, revisionBefore: rev };
}
