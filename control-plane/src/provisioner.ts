// Renders deploy/helm/arigami-tenant into a tenant's own namespace, waits for
// Ready, and tears it down again on delete.
//
// Helm CLI, not a Helm SDK: there is no maintained JS/TS Helm SDK (the real
// one is a Go library); shelling out to the `helm` binary is exactly the
// mechanism docs/K8S.md's K8S-1 proof used and documented command-by-command
// — reusing it keeps this service's behaviour identical to what was already
// proven on k3d, instead of reimplementing chart templating/apply ordering
// in JS on unproven ground.
import type { Config } from './config.js';
import type { Tenant } from './db.js';

export class ProvisionError extends Error {
  constructor(message: string, public readonly stderr: string) {
    super(message);
    this.name = 'ProvisionError';
  }
}

async function run(cmd: string[], opts: { timeoutMs?: number } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' });
  const timeout = opts.timeoutMs
    ? setTimeout(() => {
        try {
          proc.kill();
        } catch {}
      }, opts.timeoutMs)
    : null;
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (timeout) clearTimeout(timeout);
  return { code, stdout, stderr };
}

export function tenantUrl(cfg: Config, ns: string): string {
  const id = ns.replace(/^u-/, '');
  return `${cfg.urlScheme}://u-${id}.${cfg.orgDomain}`;
}

// Idempotent: `helm upgrade --install` on the same release name/values is a
// no-op apply, not a duplicate install — re-running this for a tenant that
// is already `running` does not disturb its live pod (no template field the
// StatefulSet cares about changes unless desired_digest/bundle actually
// changed, in which case a normal rolling recreate is exactly what should
// happen). `--create-namespace` makes namespace creation idempotent too.
export async function provisionTenant(cfg: Config, t: Tenant): Promise<{ url: string }> {
  const args = [
    'helm', 'upgrade', '--install', t.release, cfg.helmChartPath,
    '--namespace', t.ns, '--create-namespace',
    '--set', `tenant.id=${t.ns.replace(/^u-/, '')}`,
    '--set', `image.repository=${cfg.imageRepository}`,
    '--set', `image.tag=${t.desired_digest}`,
    '--set', `ingress.domain=${cfg.orgDomain}`,
    '--set-string', `env.ARIGAMI_BUNDLE=${cfg.arigamiBundle}`,
    '--wait', '--timeout', `${cfg.helmTimeoutSec}s`,
  ];
  if (cfg.helmExtraValuesFile) args.push('-f', cfg.helmExtraValuesFile);

  const res = await run(args, { timeoutMs: (cfg.helmTimeoutSec + 30) * 1000 });
  if (res.code !== 0) throw new ProvisionError(`helm upgrade --install failed for ${t.release} (exit ${res.code})`, res.stderr);
  return { url: tenantUrl(cfg, t.ns) };
}

// Deletes the whole namespace: takes the StatefulSet, Service(s), PVC and its
// backing volume with it (docs/K8S.md §8) — "delete a tenant = delete the
// namespace" per PRD-ARIGAMI-K8S.md §2. `helm uninstall` first so Helm's own
// release bookkeeping doesn't dangle if something re-creates the namespace
// later; the namespace delete is what actually removes the PVC/PV.
//
// Honest gap carried over from K8S-1 (docs/K8S.md "§5 smoke test" finding):
// `local-path-provisioner`'s PV reclaim is an ASYNC controller. This
// function's `kubectl delete namespace --wait` returns once the namespace
// object itself is gone; it does NOT wait for the backing volume's cleanup
// job to finish. A caller that needs "the disk is actually free" (backup
// verification, capacity accounting) must poll `kubectl get pv` separately —
// out of scope here, same as it was in K8S-1.
export async function deleteTenant(cfg: Config, t: Tenant): Promise<void> {
  await run(['helm', 'uninstall', t.release, '--namespace', t.ns, '--wait', '--timeout', `${cfg.helmTimeoutSec}s`]);
  const res = await run(['kubectl', 'delete', 'namespace', t.ns, '--wait=true', `--timeout=${cfg.helmTimeoutSec}s`], {
    timeoutMs: (cfg.helmTimeoutSec + 30) * 1000,
  });
  // "not found" is success (already deleted — idempotent delete).
  if (res.code !== 0 && !/not found/i.test(res.stderr)) {
    throw new ProvisionError(`namespace delete failed for ${t.ns} (exit ${res.code})`, res.stderr);
  }
}

// Admin "suspend" action (dormancy mechanics proved in K8S-1 §7; the
// AUTOMATION that decides when to do this is K8S-3 — this is just the lever).
export async function suspendTenant(cfg: Config, t: Tenant): Promise<void> {
  const res = await run(['kubectl', '-n', t.ns, 'scale', `statefulset/${t.release}`, '--replicas=0']);
  if (res.code !== 0) throw new ProvisionError(`scale-to-zero failed for ${t.ns} (exit ${res.code})`, res.stderr);
}

export async function resumeTenant(cfg: Config, t: Tenant): Promise<void> {
  const res = await run(['kubectl', '-n', t.ns, 'scale', `statefulset/${t.release}`, '--replicas=1']);
  if (res.code !== 0) throw new ProvisionError(`scale-up failed for ${t.ns} (exit ${res.code})`, res.stderr);
}
