# Charts

| chart | what it deploys |
|---|---|
| [`arigami-tenant`](arigami-tenant/) | one Arigami instance for one tenant — this file |
| [`arigami-control-plane`](arigami-control-plane/) | the service that provisions tenants (OIDC signup, reconcile, backups). Read its README's **Blast radius** section first: it needs cluster-scoped RBAC. |

# `arigami-tenant` — one Helm release per tenant

K8S-1 (`PRD-ARIGAMI-K8S.md`, design writeup in [docs/K8S.md](../../docs/K8S.md)):
one release = one namespace = one tenant = one Arigami instance. Full mechanics
proof (with `kubectl` output) is in `docs/K8S.md`; this file is the
value-by-value reference for actually installing it.

## Install

```sh
kubectl create namespace u-<id>
helm install u-<id> deploy/helm/arigami-tenant -n u-<id> \
  -f deploy/helm/arigami-tenant/values-real.yaml \
  --set tenant.id=<id> \
  --set ingress.domain=<org-domain>
```

`values.yaml` alone (no `-f`) already points at the real
`ghcr.io/maor700/arigami:latest` image with the PRD's measured resource
sizing — `values-real.yaml` layers a *worked example* on top: a pinned tag,
cert-manager annotations, WebSocket-friendly ingress timeouts. See its
comments for the full smoke-test command.

Upgrade: `helm upgrade u-<id> deploy/helm/arigami-tenant -n u-<id> -f … --set image.tag=<new>`.
Because this is a `StatefulSet` with one replica, the upgrade recreates the
one pod (no surge, no two-pods-at-once) — see docs/K8S.md "Why this shape".

Delete a tenant entirely: `kubectl delete namespace u-<id>` (proven in
docs/K8S.md §8 to take the PVC and its backing volume with it — check your
storage class's reclaim policy if that's not what you want).

## Values

| key | default | what it does |
|---|---|---|
| `tenant.id` | `demo` | short DNS-label id; derives the Ingress host (`u-<id>.<ingress.domain>`) and object names |
| `image.repository` / `.tag` | `ghcr.io/maor700/arigami` / `latest` | pin a real release tag for anything beyond a smoke test |
| `command` / `args` | `[]` | override the image's entrypoint/cmd — only used for the k3d stub proof, leave empty for the real image |
| `networkPolicy.ingressNamespaces` | *(none — required)* | namespaces allowed to reach the tenant. **0.2.0 removed the `ingress-nginx` default**: it was wrong on every other cluster and failed silently (healthy pod, unreachable tenant), so rendering now fails instead. A list, because the path often crosses two namespaces (Envoy plus an auth proxy). The old singular `networkPolicy.ingressNamespace` still works. |
| `networkPolicy.egress.mode` | `restricted` | `restricted` = DNS + public internet, RFC1918 and the cloud metadata endpoint carved out — so a session cannot reach unrelated in-cluster services. `open` restores the pre-0.2.0 posture. |
| `podSecurityContext` | non-root, `fsGroup: 1000` | **0.2.0 default.** The pod no longer starts as root: `fsGroup` hands the volume over already owned, which is what lets it pass a `restricted` Pod Security Standard. `{}` restores the root-then-gosu start. |
| `replicaCount` | `1` | **never raise this.** 1 = running, 0 = scaled-to-zero/dormant (K8S-3). Arigami is a stateful singleton (`server/state.ts`) |
| `terminationGracePeriodSeconds` | `30` | see docs/K8S.md "Graceful shutdown, honestly" — today's SIGTERM handler exits in ~1s regardless, this is headroom not a guarantee |
| `resources.requests` / `.limits` | `1CPU/2Gi` / `4CPU/8Gi` | measured on the live host 2026-09-01 (PRD §2): idle ≈150MB, one session ≈1-1.3GB, a heavy user 2.5-3.5GB. OOMKill mid-task is the #1 K8s-only failure mode (docs/DOCKER.md) |
| `persistence.enabled` | `true` | `false` only for a throwaway/CI pod — no PVC, `emptyDir` instead, **all state lost on pod delete** |
| `persistence.accessModes` | `[ReadWriteOnce]` | never RWX — one writer (SQLite, worktrees) |
| `persistence.size` | `30Gi` | PRD-measured default; `storageClassName` empty = cluster default |
| `shm.sizeLimit` | `1Gi` | `/dev/shm`, memory-backed — Chrome needs it, counts against the pod's memory limit |
| `service.port` | `3099` | matches the image's own `ARIGAMI_PORT` default (`Dockerfile`) — no reason to change it in K8s, there's no host-port collision to avoid like the Docker Compose `:3199` shift |
| `ingress.enabled` / `.className` / `.domain` / `.host` | `true` / `""` / `<org-domain>` / `""` | `host` explicit wins; else derived `u-<tenant.id>.<domain>` |
| `ingress.tls.enabled` / `.secretName` | `false` / `""` | empty secretName + cert-manager annotations (see `values-real.yaml`) = cert-manager mints one named `<fullname>-tls` |
| `serviceAccount.automountServiceAccountToken` | `false` | Arigami never calls the K8s API today — no token in the filesystem |
| `resourceQuota.*` | sized around the one pod + headroom | namespace-wide caps — see docs/K8S.md §3 for a live enforcement proof |
| `limitRange.*` | `250m/256Mi` default request, `1CPU/512Mi` default limit | safety net for any container in the namespace that doesn't specify its own resources (the StatefulSet always does) |
| `networkPolicy.enabled` | `true` | deny cross-tenant — see docs/K8S.md §6 for the A/B/C proof |
| `networkPolicy.ingressNamespace` | `ingress-nginx` | the namespace your ingress controller pods run in — traffic from here is allowed in addition to same-namespace. k3d's bundled Traefik lives in `kube-system` instead; `ci/stub-values.yaml` overrides accordingly |
| `probes.path` | `/__health` | **not** `/__api/health` — that one requires a session, see docs/K8S.md "Probes: which endpoint" |
| `probes.startup.*` | 5s × 60 = 5 min budget | covers a slow `ARIGAMI_BUNDLE` git clone on first boot before `server.listen()` |
| `env.ARIGAMI_BUNDLE` | `""` | git URL (or a name shipped under `profiles/bundles/`) applied once on this tenant's first boot — see docs/K8S.md "ARIGAMI_BUNDLE" |
| `secretEnv` / `existingSecret` | `{}` / `""` | `secretEnv` has the chart create a `Secret` from plain values (fine for a throwaway tenant, avoid for real ones — it goes through `--set`/shell history); `existingSecret` points at one your provisioner/external-secrets already created |
| `podSecurityContext` | `{}` | left to the image's own entrypoint — `docker/entrypoint.sh` starts as root ON PURPOSE (first-boot PVC chown) then drops to `node` itself via `gosu`. Forcing `runAsNonRoot: true` here breaks that on a fresh PVC. `ci/stub-values.yaml` sets it for the (unprivileged) stub image, since that one has no such constraint |

## `ci/stub-values.yaml`

What K8S-1 actually ran on k3d to prove the mechanics without pulling the
real 2.89GB image (`PRD-ARIGAMI-K8S.md` §6: the box had well under 10GB free
disk). Points at a 3-line busybox-httpd image
(`{"ok":true}` at `/__health`) built locally and `k3d image import`ed — never
pushed anywhere. Not meant for anything but that proof; see docs/K8S.md for
the full run with `kubectl` output.

## What this wave does NOT do

Out of scope per `PRD-ARIGAMI-K8S.md` §4 (K8S-2/3): no control-plane, no OIDC
signup flow, no reconcile loop, no dormancy automation, no managed-cloud
(GKE/EKS) values. The chart's `replicaCount: 0` and `env.ARIGAMI_BUNDLE` exist
specifically so those later waves have something to drive without touching
this chart again.
