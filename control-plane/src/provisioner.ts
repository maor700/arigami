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

async function run(cmd: string[], opts: { timeoutMs?: number; stdin?: string } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe', ...(opts.stdin !== undefined ? { stdin: new Blob([opts.stdin]) } : {}) });
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

// The chart's object name prefix (StatefulSet, pod ordinal 0, Services) is
// `arigami-<tenant.id>` — templates/_helpers.tpl's `fullname` builds it
// straight from `.Values.tenant.id`, NOT from `.Release.Name` (proved live:
// `helm install u-demo … --set tenant.id=demo` produces pod
// `arigami-demo-0`, docs/K8S.md). The tenants table's `release` column is
// the HELM release name (what `helm upgrade`/`uninstall` take) — a
// different string from this. Conflating the two here was a real bug caught
// by the k3d integration test: suspend/resume `kubectl scale
// statefulset/<release>` targeted a StatefulSet that doesn't exist.
export function fullname(ns: string): string {
  return `arigami-${ns.replace(/^u-/, '')}`;
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
    // --set-string, not --set: tenant.id and image.tag are hex/short ids
    // that can be all-digits (e.g. a sha256 prefix like "7021319228"), and
    // plain --set parses a numeric-looking value as an int64 — which then
    // renders as "%!s(int64=...)" wherever the chart does `printf "...-%s"
    // .Values.tenant.id` (templates/_helpers.tpl), breaking every derived
    // object name. Found live on the very first k3d run of this provisioner.
    '--set-string', `tenant.id=${t.ns.replace(/^u-/, '')}`,
    '--set', `image.repository=${cfg.imageRepository}`,
    '--set-string', `image.tag=${t.desired_digest}`,
    '--set', `ingress.domain=${cfg.orgDomain}`,
    '--set-string', `env.ARIGAMI_BUNDLE=${cfg.arigamiBundle}`,
    // First boot checks the bundle out at the ref the rollout converges to; later versions arrive through the
    // trusted re-apply (src/profile-rollout.ts), never through a pod restart.
    '--set-string', `env.ARIGAMI_BUNDLE_REF=${cfg.arigamiBundleRef}`,
    '--wait', '--timeout', `${cfg.helmTimeoutSec}s`,
  ];
  // CP_INGRESS_CLASS was read into config and never passed to helm until now,
  // so every tenant Ingress rendered without an ingressClassName and fell to
  // whatever controller the cluster treats as default — the wrong one, on any
  // cluster running more than one.
  if (cfg.ingressClassName) args.push('--set-string', `ingress.className=${cfg.ingressClassName}`);
  // The chart (0.2.0+) has no default here and fails to render without it.
  cfg.ingressNamespaces.forEach((ns, i) => {
    args.push('--set-string', `networkPolicy.ingressNamespaces[${i}]=${ns}`);
  });
  // K8S-3: the per-tenant handoff secret rides in as chart `secretEnv`, so the
  // chart renders it into the tenant's own Secret and the pod reads it as an
  // env var — this is what lets a user who signed in here land in their
  // workspace without a pairing code (src/handoff.ts). Trade-off stated in
  // values.yaml: `--set` values are also stored in Helm's release Secret, so
  // an org that wants the secret to exist in exactly one place should switch
  // the chart to `existingSecret` and create it out-of-band.
  if (t.handoff_secret) args.push('--set-string', `secretEnv.ARIGAMI_HANDOFF_SECRET=${t.handoff_secret}`);
  // The org's private profile repo: one read-only token for every tenant, so a user never has to sign in to GitHub
  // for the profile (and the extensions inside it) to install. Same chart `secretEnv` route, same Helm-release trade-off.
  if (cfg.arigamiGitToken) args.push('--set-string', `secretEnv.ARIGAMI_GIT_TOKEN=${cfg.arigamiGitToken}`);
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

// ---- K8S-3: the in-pod surface (exec) -----------------------------------------
//
// The chart's pod ordinal-0 name, and a `kubectl exec` into it. Everything
// below talks to the tenant host over LOOPBACK from inside its own pod — not
// through the ingress — because (a) the control-plane machine has kubectl
// access but is not necessarily on the tenants' ingress network, and (b) the
// busy signal is deliberately loopback-only (server/host-control.ts
// healthBody: /__health only reports busySessions to 127.0.0.1, so tenant
// activity is never visible to the open internet through the probe path).
// `gosu node:node` because kubectl exec lands in the container as root (the
// entrypoint's chown-then-drop dance, docs/DOCKER.md) — anything that touches
// $ARIGAMI_DIR must run as the same user as the host process or it leaves
// root-owned files the host can no longer write.
export function tenantPod(ns: string): string {
  return `${fullname(ns)}-0`;
}

export async function execInTenant(
  cfg: Config,
  t: Tenant,
  cmd: string[],
  opts: { timeoutMs?: number; stdin?: string } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  // `-i` only when there is something to feed: a credential goes in on stdin, never in argv (visible in `ps`).
  return run(['kubectl', '-n', t.ns, 'exec', ...(opts.stdin !== undefined ? ['-i'] : []), tenantPod(t.ns), '--', 'gosu', 'node:node', ...cmd], {
    timeoutMs: opts.timeoutMs ?? 30_000,
    stdin: opts.stdin,
  });
}

/**
 * Profile rollout: one operator call to the tenant host over loopback (same
 * route as the busy probe). The token rides on stdin as a header file
 * (`curl -H @-`) so it never appears in a process list; it is short-lived and,
 * for an apply, single-use anyway. Returns the HTTP status and parsed body.
 */
export async function tenantOperatorCall(
  cfg: Config,
  t: Tenant,
  method: 'GET' | 'POST',
  token: string,
  opts: { timeoutMs?: number } = {},
): Promise<{ status: number; body: any }> {
  const maxSec = Math.ceil((opts.timeoutMs ?? 30_000) / 1000);
  const res = await execInTenant(
    cfg,
    t,
    ['curl', '-sS', '-m', String(maxSec), '-X', method, '-H', '@-', '-w', '\n%{http_code}', `http://127.0.0.1:${cfg.tenantPort}/__api/profiles/rollout`],
    { timeoutMs: (maxSec + 15) * 1000, stdin: `x-arigami-operator: ${token}\n` },
  );
  if (res.code !== 0) throw new ProvisionError(`profile call to ${t.ns} failed (exit ${res.code})`, res.stderr.slice(0, 500));
  const nl = res.stdout.lastIndexOf('\n');
  const status = Number(res.stdout.slice(nl + 1).trim());
  let body: any = null;
  try { body = JSON.parse(res.stdout.slice(0, nl)); } catch { body = { error: res.stdout.slice(0, Math.max(0, nl)).slice(0, 300) }; }
  if (!Number.isFinite(status) || status === 0) throw new ProvisionError(`profile call to ${t.ns} got no HTTP status`, res.stdout.slice(0, 300));
  return { status, body };
}

/**
 * "No turn in flight" — the host's own idle signal (server/host-control.ts
 * busySessions: sessions whose claude turn is running, the same count the
 * cockpit restart-drain uses). Throws when it cannot be determined, so
 * callers FAIL CLOSED: an unreachable/ancient tenant is treated as "do not
 * upgrade", never as idle.
 */
export async function tenantBusySessions(cfg: Config, t: Tenant): Promise<number> {
  const res = await execInTenant(cfg, t, ['curl', '-fsS', '-m', '5', `http://127.0.0.1:${cfg.tenantPort}/__health`]);
  if (res.code !== 0) throw new ProvisionError(`cannot read ${t.ns}'s /__health (exit ${res.code})`, res.stderr);
  let body: any;
  try { body = JSON.parse(res.stdout); } catch { throw new ProvisionError(`${t.ns}'s /__health returned non-JSON`, res.stdout.slice(0, 200)); }
  if (body?.ok !== true) throw new ProvisionError(`${t.ns}'s /__health is not ok`, res.stdout.slice(0, 200));
  if (typeof body.busySessions !== 'number')
    throw new ProvisionError(`${t.ns}'s host does not report busySessions — image predates K8S-3?`, res.stdout.slice(0, 200));
  return body.busySessions;
}

/** Post-upgrade health: the pod answers {ok:true} on loopback. Retries — a just-rolled pod needs a moment. */
export async function verifyTenantHealth(cfg: Config, t: Tenant, opts: { attempts?: number; delayMs?: number } = {}): Promise<void> {
  const attempts = opts.attempts ?? 12;
  const delayMs = opts.delayMs ?? 5_000;
  let last = '';
  for (let i = 0; i < attempts; i++) {
    const res = await execInTenant(cfg, t, ['curl', '-fsS', '-m', '5', `http://127.0.0.1:${cfg.tenantPort}/__health`]);
    if (res.code === 0) {
      try { if (JSON.parse(res.stdout)?.ok === true) return; } catch {}
      last = res.stdout.slice(0, 200);
    } else last = res.stderr.slice(0, 200);
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new ProvisionError(`${t.ns} not healthy after ${attempts} attempts`, last);
}

/** Current Helm revision of the tenant's release — what a failed upgrade rolls back to. */
export async function helmRevision(cfg: Config, t: Tenant): Promise<number> {
  const res = await run(['helm', 'status', t.release, '--namespace', t.ns, '-o', 'json']);
  if (res.code !== 0) throw new ProvisionError(`helm status failed for ${t.release} (exit ${res.code})`, res.stderr);
  const v = Number(JSON.parse(res.stdout)?.version);
  if (!Number.isFinite(v) || v < 1) throw new ProvisionError(`helm status returned no revision for ${t.release}`, res.stdout.slice(0, 200));
  return v;
}

/**
 * Roll the release back to revision `rev`, deterministically:
 *   1. `helm rollback` (no --wait) re-applies the old manifests;
 *   2. delete the pod outright — a pod stuck in ImagePullBackOff on the bad
 *      image would otherwise pin the StatefulSet's rollout (the controller
 *      won't always replace a never-Ready pod on its own; this is the
 *      documented "delete the pod" escape hatch for stuck STS rollouts);
 *   3. `kubectl rollout status` waits for the recreated pod, now on the old
 *      image against the same PVC, to be Ready.
 */
export async function rollbackTenant(cfg: Config, t: Tenant, rev: number): Promise<void> {
  const rb = await run(['helm', 'rollback', t.release, String(rev), '--namespace', t.ns], { timeoutMs: 60_000 });
  if (rb.code !== 0) throw new ProvisionError(`helm rollback to ${rev} failed for ${t.release} (exit ${rb.code})`, rb.stderr);
  await run(['kubectl', '-n', t.ns, 'delete', 'pod', tenantPod(t.ns), '--ignore-not-found', '--wait=false'], { timeoutMs: 30_000 });
  const st = await run(
    ['kubectl', '-n', t.ns, 'rollout', 'status', `statefulset/${fullname(t.ns)}`, `--timeout=${cfg.helmTimeoutSec}s`],
    { timeoutMs: (cfg.helmTimeoutSec + 30) * 1000 },
  );
  if (st.code !== 0) throw new ProvisionError(`rollback rollout for ${t.ns} did not become Ready (exit ${st.code})`, st.stderr);
}

// Admin "suspend" action (dormancy mechanics proved in K8S-1 §7; the
// AUTOMATION that decides when to do this is K8S-3 — this is just the lever).
export async function suspendTenant(cfg: Config, t: Tenant): Promise<void> {
  const res = await run(['kubectl', '-n', t.ns, 'scale', `statefulset/${fullname(t.ns)}`, '--replicas=0']);
  if (res.code !== 0) throw new ProvisionError(`scale-to-zero failed for ${t.ns} (exit ${res.code})`, res.stderr);
}

export async function resumeTenant(cfg: Config, t: Tenant): Promise<void> {
  const res = await run(['kubectl', '-n', t.ns, 'scale', `statefulset/${fullname(t.ns)}`, '--replicas=1']);
  if (res.code !== 0) throw new ProvisionError(`scale-up failed for ${t.ns} (exit ${res.code})`, res.stderr);
}
