# Arigami on Kubernetes — DevOps hand-off (one page)

**Goal.** An org signs an employee in with its IdP → they get their own running
Arigami instance (Linux desktop + agent harness) in Kubernetes, pre-configured
with the company's profile bundle. One tenant = one namespace = one pod.

## What you are receiving

| Piece | Where | Read |
|---|---|---|
| Tenant Helm chart | `deploy/helm/arigami-tenant/` (+ `README.md`) | `docs/K8S.md` |
| Control-plane service (OIDC signup → provisions tenants; reconcile, upgrades w/ rollback, backup/restore, dormancy lever) | `control-plane/` | `docs/CONTROL-PLANE.md` |
| Runtime image | `Dockerfile`, `docker-compose.yml` | `docs/DOCKER.md`, `docs/DEPLOY.md` |
| Product plan + decisions | `/PRD-ARIGAMI-K8S.md`, `/SPEC-ARIGAMI-K8S3.md` (repo root of the workspace) | — |

Everything above is on `master`. All claims in the docs were exercised on a
real k3d cluster with the real image; the evidence (commands + output) is
inline in `docs/K8S.md` and `docs/CONTROL-PLANE.md` — do not trust the
summary, read the proofs.

## Shape, in five lines

1. **StatefulSet, `replicas: 1`, Recreate.** Arigami is a stateful singleton
   (sessions write git worktrees to disk, one scheduler per process). Two pods
   on one volume corrupt state. Never scale it horizontally.
2. **RWO PVC on `/data`**; `/dev/shm` is a 1Gi memory `emptyDir` (Chrome needs it).
3. **Per-tenant namespace** with `ResourceQuota`, `LimitRange`, and a
   `NetworkPolicy` that denies cross-tenant traffic (ingress only from the
   ingress controller's namespace).
4. **Ingress `u-<id>.<org-domain>`** + cert-manager TLS.
5. **`ARIGAMI_BUNDLE=<git url>`** in the pod env applies the org's profile
   bundle on first boot (skills, memory seed, agents, cron). This is what makes
   the harness "already configured for the company".

## Control-plane in one paragraph

Small bun service, sqlite state (justified in its doc; switch to Postgres when
there is a second writer). `GET /auth/login` → company OIDC (PKCE) →
first-ever user becomes org-admin, everyone else gets a tenant row in
`provisioning` and `helm upgrade --install` fires in the background. Tenant
lifecycle: `provisioning → running → dormant → archived → deleted`
(`src/state-machine.ts` is the single source of truth). Reconcile loop rolls
upgrades only when no turn is in flight, verifies health, rolls back on
failure. Backups: `kubectl cp` of `/data` to `CP_BACKUP_DIR`, pruned to
`CP_BACKUP_KEEP`. After sign-in the user lands **inside** their cockpit via a
one-shot HMAC hand-off token (`ARIGAMI_HANDOFF_SECRET`, per tenant) — no
pairing code. Config knobs are all `CP_*` env vars, listed in
`docs/CONTROL-PLANE.md`.

## What to decide / do on your side

- **Cluster + storage class.** Any conformant cluster. Needs an RWO storage
  class with reasonable IOPS (git + sqlite on it), ~2–4Gi per tenant to start.
- **Sizing.** Real working pod: request 300Mi / limit 1.5Gi RAM, 200m / 2 CPU
  (the `k8s3-pilot-values.yaml` overlay). Budget ~1–1.5 GB RAM per *active*
  tenant with Chrome open. A 3.8 GB box holds exactly one — see the envelope
  table in `docs/K8S.md`.
- **Image registry.** `ghcr.io/maor700/arigami` is not public yet; build from
  the `Dockerfile` (2.9 GB) and push to your registry; pin by digest
  (`CP_IMAGE_TAG=sha256:…`), not `latest`.
- **IdP.** Any OIDC provider (Okta, Entra, Google). Set
  `CP_OIDC_ISSUER/CLIENT_ID/CLIENT_SECRET`, `ALLOWED_EMAIL_DOMAINS`.
- **Secrets.** Handoff secrets ride in via `--set`, which Helm also stores in
  its release Secret. If you want the key in exactly one place, create the
  Secret out-of-band and point `existingSecret` at it (chart supports it).
- **Bundle URL must be reachable from pods** and the clone has no timeout
  yet (known gap: an unreachable bundle stalls first boot — see below).

## Known gaps (honest list)

- `applyBundleEnv`'s `git clone` has no timeout: unreachable
  `ARIGAMI_BUNDLE` → pod never becomes ready, empty logs. Fix queued.
- PV reclaim is async after namespace delete; capacity accounting must poll
  `kubectl get pv`.
- Dormancy **automation** (scale-to-zero on idle, wake-on-request, alarm clock
  for scheduled tasks) is designed but not built (K8S-5). The lever
  (`suspend`/`resume` = scale 0/1) exists and works.
- `CP_ARIGAMI_BUNDLE_REF` is accepted, not wired.
- No managed-cloud run yet; only k3d on a single node.

## Quick start (what the pilot proof actually ran)

```
k3d cluster create demo --servers 1 --agents 0 -p "127.0.0.1:8770:80@loadbalancer"
docker build -t <registry>/arigami:<tag> . && k3d image import <registry>/arigami:<tag> -c demo
cd control-plane && CP_IMAGE_REPOSITORY=<registry>/arigami CP_IMAGE_TAG=<tag> \
  CP_OIDC_ISSUER=… CP_OIDC_CLIENT_ID=… CP_OIDC_CLIENT_SECRET=… \
  ALLOWED_EMAIL_DOMAINS=yourco.com CP_ORG_DOMAIN=arigami.yourco.com \
  CP_ARIGAMI_BUNDLE=https://github.com/yourco/arigami-profile-bundle bun src/index.ts
```
Then sign in at the control-plane URL; the second user gets a tenant.
`control-plane/test/fixtures/local-e2e.ts` runs the whole signup experience
with Kubernetes stubbed out, if you want to see the UX without a cluster.

Questions: the two docs first, then the commit history of `deploy/helm`,
`control-plane/` and `server/profiles.ts`.
