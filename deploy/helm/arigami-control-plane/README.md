# arigami-control-plane

Deploys the control-plane (`control-plane/`, designed in `docs/CONTROL-PLANE.md`)
into Kubernetes: OIDC sign-in that provisions one `arigami-tenant` release per
user, reconciles image digests, takes backups, and hands a signed-in user
straight into their own cockpit.

This chart does **not** deploy a tenant. It deploys the thing that installs
tenants. One release per cluster.

```
helm upgrade --install control-plane deploy/helm/arigami-control-plane \
  --namespace arigami --create-namespace \
  --set image.tag=sha256:… \
  --set config.orgDomain=arigami.example.com \
  --set config.tenantImageTag=sha256:… \
  --set config.oidcIssuer=https://accounts.google.com \
  --set config.oidcClientId=… \
  --set config.allowedEmailDomains=example.com \
  --set config.tenantIngressClass=contour \
  --set config.tenantIngressNamespaces=projectcontour \
  --set ingress.host=arigami.example.com \
  --set ingress.tls.enabled=true \
  --set existingSecret=arigami-control-plane
```

## The image

Built from `control-plane/Dockerfile` **with the repository root as build
context**, because it bakes `deploy/helm/arigami-tenant`:

```
docker build -f control-plane/Dockerfile \
  -t <registry>/arigami-control-plane:<tag> .
```

~560 MB: bun, the `kubectl` and `helm` binaries the provisioner shells out to
(`Bun.spawn`), and the tenant chart at `/charts/arigami-tenant`. The tenant
chart travels inside the image so a control-plane can never install a chart
revision it was not tested against; point `CP_HELM_CHART_PATH` elsewhere if you
would rather decouple them.

Pin `image.tag` to a digest. `latest` is for a scratch cluster only.

## Blast radius — read before installing

The control-plane creates a **namespace per tenant** and `helm upgrade
--install`s into it. Kubernetes RBAC cannot scope a rule by object-name prefix,
so *"may manage namespaces named `u-*`"* is not expressible. `templates/rbac.yaml`
is therefore a **ClusterRole**, cluster-wide over its resource kinds:

| Grant | Why | What it also permits |
|---|---|---|
| `namespaces: create, delete` | provision / delete a tenant | delete **any** namespace in the cluster |
| CRUD on pods, services, secrets, SAs, configmaps, PVCs, quotas, limitranges | the objects the tenant chart renders, plus Helm's release Secret | read **every** Secret in the cluster |
| `pods/exec: create` | `kubectl exec` support access and `kubectl cp` backups | a shell in **any** pod |
| CRUD on statefulsets (+`/scale`) | rollout, suspend/resume | — |
| CRUD on ingresses, networkpolicies | per-tenant host and isolation | rewrite **any** namespace's isolation |
| `persistentvolumes: read` (optional, `rbac.persistentVolumeRead`) | capacity accounting | — |

`secrets` + `pods/exec` cluster-wide is, in practice, cluster-admin. If that is
not acceptable — and on a shared production cluster it usually is not — there
are two honest alternatives:

1. **Give it its own cluster.** The grant stops mattering when the only thing
   in the cluster is Arigami.
2. **Drop the control-plane and declare tenants in git.** A tenant is one
   `arigami-tenant` release; an ApplicationSet or Flux Kustomization can
   materialise it from a file per tenant, and nothing needs cluster-scoped
   write at all. You lose self-service signup and gain a GitOps-native
   deployment. This is the better fit for a cluster that already has ArgoCD or
   Flux owning everything.

Set `rbac.create=false` to bind an existing, hand-reviewed ClusterRole instead.

## Values that will bite you

| Value | Why it matters |
|---|---|
| `config.allowedEmailDomains` | Empty means **nobody can sign up**. That is the safe default, not a bug. |
| `config.orgDomain` | Tenants are addressed at `u-<id>.<orgDomain>` — needs a wildcard DNS record and a matching certificate, or per-tenant DNS from external-dns. Required. |
| `config.publicUrl` | Baked into the OIDC `redirect_uri`; must match what the IdP has registered *exactly*. Derived from `ingress.host` when unset. |
| `config.tenantIngressNamespaces` | Required. The tenant NetworkPolicy has no default (arigami-tenant 0.2.0) — with the wrong value every object is healthy and the tenant is unreachable. |
| `config.arigamiBundle` | Its `git clone` has **no timeout** (known gap, `docs/DEVOPS-HANDOFF.md`). An unreachable URL leaves each new tenant short of Ready with empty logs. Verify reachability *from a pod*. |
| `existingSecret` | Prefer it over `secretEnv`. `--set` values also land in Helm's own release Secret, so `secretEnv` puts the OIDC client secret in two places. |
| `persistence.size` | Sized for backups, not the sqlite file: `config.backupKeep` archives **per tenant**, each a tar of that tenant's `/data`. |

The **first account ever to sign in becomes org-admin**. Install, sign in
yourself, then publish the URL.

## Shape

StatefulSet, `replicas: 1`, one RWO PVC at `/data` — sqlite has a single writer
and the reconcile loop must not run twice, the same stateful-singleton rule the
tenant chart documents. Do not raise `replicaCount`.

Unlike the tenant, this pod runs as uid 1000 with no root pass at all: nothing
chowns the volume (`fsGroup` does), so it satisfies the `restricted` Pod
Security Standard as shipped.

Kubernetes credentials come from the mounted ServiceAccount token —
`serviceAccount.automountServiceAccountToken` is `true` here, the exact opposite
of the tenant chart, and there is no kubeconfig to supply.
