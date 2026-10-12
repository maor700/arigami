// Hardware tiers: change which Helm values overlay (machine size, disk, node pool) a running tenant uses.
//
// This is the image-upgrade path (src/upgrade.ts) with a different change: only while the tenant has no turn in
// flight, helm upgrade with the new overlay, wait healthy, roll back if it is not, and only THEN record the tier.
// Disk is the one thing that cannot go both ways: a PVC can grow, never shrink, so a smaller size is refused up
// front, and a StorageClass that cannot expand is reported before anything is touched.
import type { Config } from './config.js';
import type { Store, Tenant } from './db.js';
import { upgradeTenant, type UpgradeDeps } from './upgrade.js';
import * as provisioner from './provisioner.js';

export class TierError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
    this.name = 'TierError';
  }
}

export interface TierDeps extends UpgradeDeps {
  /** current PVC request + whether its StorageClass allows expansion (null = could not tell) */
  pvcInfo(t: Tenant): Promise<{ size: string; expandable: boolean | null; storageClass: string }>;
  expandPvc(t: Tenant, size: string): Promise<void>;
  /** delete the StatefulSet object but keep pod + PVC (volumeClaimTemplates are immutable) */
  orphanStatefulSet(t: Tenant): Promise<void>;
}

export function realTierDeps(cfg: Config): TierDeps {
  return {
    busySessions: (t) => provisioner.tenantBusySessions(cfg, t),
    revision: (t) => provisioner.helmRevision(cfg, t),
    provision: (t) => provisioner.provisionTenant(cfg, t),
    verifyHealth: (t) => provisioner.verifyTenantHealth(cfg, t),
    rollback: (t, rev) => provisioner.rollbackTenant(cfg, t, rev),
    pvcInfo: (t) => provisioner.pvcInfo(cfg, t),
    expandPvc: (t, size) => provisioner.expandPvc(cfg, t, size),
    orphanStatefulSet: (t) => provisioner.orphanStatefulSet(cfg, t),
  };
}

const UNITS: Record<string, number> = {
  '': 1, k: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15,
  Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, Pi: 1024 ** 5,
};
/** Kubernetes quantity ("50Gi", "500G", "1073741824") -> bytes. NaN when it is not one. */
export function parseQuantity(q: string): number {
  const m = /^(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti|Pi|k|M|G|T|P)?$/.exec(String(q).trim());
  return m ? Number(m[1]) * UNITS[m[2] || ''] : NaN;
}

/** persistence.size the tenant would get on `tier`: overlay > CP_HELM_EXTRA_VALUES > the chart's default. undefined = unknown. */
export async function effectiveDiskSize(cfg: Config, tier: string): Promise<string | undefined> {
  const pick = (v: any): string | undefined => (typeof v?.persistence?.size === 'string' ? v.persistence.size : undefined);
  const fromOverlay = pick(cfg.tiers[tier]);
  if (fromOverlay) return fromOverlay;
  for (const file of [cfg.helmExtraValuesFile, `${cfg.helmChartPath}/values.yaml`]) {
    if (!file) continue;
    try {
      const v = pick(Bun.YAML.parse(await Bun.file(file).text()));
      if (v) return v;
    } catch {}
  }
  return undefined;
}

// One change at a time per tenant, in this process (sqlite has one writer, so there is one process). The reconcile
// loop consults it so an image upgrade does not race a tier change on the same release.
const inFlight = new Set<string>();
export const tierChangeInFlight = (ns: string): boolean => inFlight.has(ns);

export interface TierResult {
  ns: string;
  from: string;
  to: string;
  disk: { from: string | null; to: string | null; grew: boolean };
}

/**
 * Move `t` to `tier`. Throws TierError (400/404/409 with a message fit for the admin page / CLI),
 * UpgradeBlockedError (a turn is in flight — nothing was touched), UpgradeRolledBackError / UpgradeFailedError.
 * Records the tier in `store` only after the tenant is healthy on it.
 */
export async function setTier(cfg: Config, store: Pick<Store, 'setTier'>, deps: TierDeps, t: Tenant, tier: string): Promise<TierResult> {
  if (!Object.keys(cfg.tiers).length) throw new TierError('no tiers are configured (CP_TIERS is empty)');
  if (!cfg.tiers[tier]) throw new TierError(`unknown tier "${tier}" — known tiers: ${Object.keys(cfg.tiers).join(', ')}`);
  if (t.state !== 'running') throw new TierError(`${t.ns} is ${t.state}; a tier change needs a running tenant`, 409);
  const from = provisioner.effectiveTier(cfg, t);
  if (from === tier) {
    if ((t.tier || '') !== tier) store.setTier(t.subject, tier); // make an implicit default explicit; nothing to roll out
    return { ns: t.ns, from, to: tier, disk: { from: null, to: null, grew: false } };
  }
  if (inFlight.has(t.ns)) throw new TierError(`${t.ns} already has a change in progress`, 409);

  // Pre-flight, read-only: the disk can only grow, and the class must be able to.
  const wanted = await effectiveDiskSize(cfg, tier);
  const pvc = wanted ? await deps.pvcInfo(t) : null;
  let grow = false;
  if (wanted && pvc) {
    const w = parseQuantity(wanted);
    const c = parseQuantity(pvc.size);
    if (Number.isFinite(w) && Number.isFinite(c)) {
      if (w < c) throw new TierError(`tier "${tier}" asks for a ${wanted} disk but ${t.ns} already has ${pvc.size}; a persistent disk can only grow — pick a tier with at least ${pvc.size}`, 409);
      if (w > c) {
        if (pvc.expandable === false) throw new TierError(`tier "${tier}" needs the disk to grow from ${pvc.size} to ${wanted}, but StorageClass "${pvc.storageClass || '(default)'}" does not allow volume expansion (allowVolumeExpansion: false) — nothing was changed`, 409);
        if (pvc.expandable === null) throw new TierError(`tier "${tier}" needs the disk to grow from ${pvc.size} to ${wanted}, but whether StorageClass "${pvc.storageClass || '(default)'}" can expand could not be determined — nothing was changed`, 409);
        grow = true;
      }
    }
  }

  inFlight.add(t.ns);
  try {
    const next: Tenant = { ...t, tier };
    const guarded: UpgradeDeps = {
      ...deps,
      provision: async (n) => {
        // Only reached once upgradeTenant saw no turn in flight.
        if (grow) {
          await deps.expandPvc(n, wanted!);
          await deps.orphanStatefulSet(n);
        }
        return deps.provision(n);
      },
      rollback: async (p, rev) => {
        // The live StatefulSet carries the new claim size; helm cannot roll its template back, so detach it first.
        if (grow) await deps.orphanStatefulSet(p);
        return deps.rollback(p, rev);
      },
    };
    // The image does not change: toDigest is what is running. (A pending image upgrade stays pending.)
    await upgradeTenant(guarded, next, t.running_digest || t.desired_digest);
    store.setTier(t.subject, tier);
    return { ns: t.ns, from, to: tier, disk: { from: pvc?.size ?? null, to: wanted ?? null, grew: grow } };
  } finally {
    inFlight.delete(t.ns);
  }
}
