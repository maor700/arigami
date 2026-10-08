// K8S-3 — the reconcile loop: the thing K8S-2 deliberately left out. One
// interval in the same process (sqlite stays single-writer), each tick:
//
//   1. every `running` tenant with desired_digest != running_digest gets an
//      upgrade attempt (src/upgrade.ts). Busy tenants are SKIPPED, not
//      queued — the next tick retries, so "upgrade when the user goes idle"
//      falls out of the loop with no extra machinery.
//   2. the org profile rollout (src/profile-rollout.ts): CP_ARIGAMI_BUNDLE_REF
//      is resolved to one commit and every running tenant that has not applied
//      it is asked to re-apply — same "busy → skip, next tick retries" rule,
//      canary ring first, stopping on the first failed apply.
//   3. every `running` tenant whose newest backup is older than
//      CP_BACKUP_INTERVAL_SEC gets one taken (src/backup.ts) — the
//      "control-plane job" flavour of the PRD's backup CronJob.
//
// One lifecycle action per tenant per tick: a tenant that was upgraded is left
// out of the profile pass, and one that had a profile apply is not backed up,
// until the next tick.
//
// Ticks never overlap (an in-flight tick skips the timer's next fire) and
// tenants are handled sequentially — helm/kubectl fan-out on a pilot-sized
// fleet buys nothing and makes failures unreadable.
import type { Config } from './config.js';
import type { Store, Tenant } from './db.js';
import { upgradeTenant, UpgradeBlockedError, UpgradeRolledBackError, type UpgradeDeps } from './upgrade.js';
import * as provisioner from './provisioner.js';
import { backupTenant, listBackups } from './backup.js';
import {
  profilePass, realProfileOps, resolveDesired, rolloutEnabled, redact, DESIRED_META_KEY,
  type DesiredProfile, type DesiredRecord, type ProfileOps, type ProfileSummary,
} from './profile-rollout.js';

export interface ReconcileOps {
  upgradeDeps: UpgradeDeps;
  backup(t: Tenant): Promise<unknown>;
  newestBackupMs(ns: string): number | null;
  /** profile rollout; absent = off (no CP_ARIGAMI_BUNDLE git source, or CP_PROFILE_ROLLOUT=0) */
  profile?: { resolve(): Promise<DesiredProfile>; ops: ProfileOps };
}

export function realOps(cfg: Config): ReconcileOps {
  return {
    upgradeDeps: {
      busySessions: (t) => provisioner.tenantBusySessions(cfg, t),
      revision: (t) => provisioner.helmRevision(cfg, t),
      provision: (t) => provisioner.provisionTenant(cfg, t),
      verifyHealth: (t) => provisioner.verifyTenantHealth(cfg, t),
      rollback: (t, rev) => provisioner.rollbackTenant(cfg, t, rev),
    },
    backup: (t) => backupTenant(cfg, t),
    newestBackupMs: (ns) => listBackups(cfg, ns)[0]?.mtimeMs ?? null,
    ...(rolloutEnabled(cfg) ? { profile: { resolve: () => resolveDesired(cfg), ops: realProfileOps(cfg) } } : {}),
  };
}

export interface TickSummary {
  upgraded: string[];
  blocked: string[];
  rolledBack: string[];
  failed: string[];
  backedUp: string[];
  backupFailed: string[];
  profile?: ProfileSummary;
}

export async function reconcileTick(
  cfg: Config,
  store: Store,
  ops: ReconcileOps,
  log: (m: string) => void = console.log,
  now: () => number = Date.now,
): Promise<TickSummary> {
  const sum: TickSummary = { upgraded: [], blocked: [], rolledBack: [], failed: [], backedUp: [], backupFailed: [] };
  const touched = new Set<string>(); // tenants that already had their lifecycle action this tick
  for (const t of store.listTenants()) {
    if (t.state !== 'running') continue;

    if (t.desired_digest && t.desired_digest !== t.running_digest) {
      touched.add(t.ns);
      try {
        const r = await upgradeTenant(ops.upgradeDeps, t, t.desired_digest);
        store.setRunningDigest(t.subject, t.desired_digest);
        sum.upgraded.push(t.ns);
        log(`[reconcile] ${t.ns} upgraded ${r.from || '(unset)'} -> ${r.to}`);
      } catch (e) {
        if (e instanceof UpgradeBlockedError) {
          sum.blocked.push(t.ns);
          log(`[reconcile] ${t.ns} busy (${e.busySessions}) — upgrade deferred`);
        } else if (e instanceof UpgradeRolledBackError) {
          sum.rolledBack.push(t.ns);
          log(`[reconcile] ${t.ns} ${e.message}`);
          // running_digest untouched → desired != running still, BUT retrying a
          // digest that just failed every tick would flap the tenant forever;
          // an operator has to either fix the digest (set a new one) or clear
          // it. Park the tenant by making desired = running.
          store.setDesiredDigest(t.subject, t.running_digest);
        } else {
          sum.failed.push(t.ns);
          log(`[reconcile] ${t.ns} upgrade error: ${(e as Error).message}`);
        }
      }
    }
  }

  if (ops.profile) {
    let desired: DesiredProfile | null = null;
    try {
      desired = await ops.profile.resolve();
      store.setMeta(DESIRED_META_KEY, { ref: desired.ref, commit: desired.commit, resolvedAt: desired.resolvedAt } satisfies DesiredRecord);
    } catch (e) {
      // Cannot tell what "latest" is → change nothing this tick; keep the last known commit on the page, with why.
      const msg = redact((e as Error).message);
      const prev = store.getMeta<DesiredRecord>(DESIRED_META_KEY);
      store.setMeta(DESIRED_META_KEY, { ref: cfg.arigamiBundleRef, commit: prev?.commit || '', resolvedAt: prev?.resolvedAt || 0, error: msg } satisfies DesiredRecord);
      log(`[profile] cannot resolve the desired profile — rollout skipped this tick: ${msg}`);
    }
    if (desired) {
      try {
        const r = await profilePass(cfg, store, ops.profile.ops, desired, { skip: touched, log, now: now() });
        sum.profile = r.summary;
        for (const ns of r.touched) touched.add(ns);
      } catch (e) {
        log(`[profile] pass error: ${(e as Error).message}`);
      }
    }
  }

  for (const t of store.listTenants()) {
    if (t.state !== 'running' || touched.has(t.ns)) continue;
    if (cfg.backupIntervalSec > 0) {
      const newest = ops.newestBackupMs(t.ns);
      if (newest === null || now() - newest > cfg.backupIntervalSec * 1000) {
        try {
          await ops.backup(t);
          sum.backedUp.push(t.ns);
          log(`[reconcile] ${t.ns} backed up`);
        } catch (e) {
          sum.backupFailed.push(t.ns);
          log(`[reconcile] ${t.ns} backup error: ${(e as Error).message}`);
        }
      }
    }
  }
  return sum;
}

export function startReconcile(cfg: Config, store: Store, ops: ReconcileOps = realOps(cfg), log: (m: string) => void = console.log): { stop(): void } {
  if (!cfg.reconcileSec || cfg.reconcileSec <= 0) return { stop() {} };
  let inFlight = false;
  const timer = setInterval(async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      await reconcileTick(cfg, store, ops, log);
    } catch (e) {
      log(`[reconcile] tick error: ${(e as Error).message}`);
    } finally {
      inFlight = false;
    }
  }, cfg.reconcileSec * 1000);
  log(
    `[reconcile] loop every ${cfg.reconcileSec}s (backups: ${cfg.backupIntervalSec > 0 ? `every ${cfg.backupIntervalSec}s, keep ${cfg.backupKeep}` : 'off'}; ` +
      `profile rollout: ${ops.profile ? `${cfg.arigamiBundleRef || 'default branch'}` : 'off'})`,
  );
  return { stop: () => clearInterval(timer) };
}
