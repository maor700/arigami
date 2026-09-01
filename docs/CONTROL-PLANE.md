# Arigami control-plane (K8S-2)

Wave K8S-2 (`PRD-ARIGAMI-K8S.md` §2/§5) ships `control-plane/`: a small,
separately-deployable bun service that turns "an employee signs in with the
company IdP" into "their own running Arigami tenant", by rendering
`deploy/helm/arigami-tenant/` (K8S-1) into a namespace per user. Out of scope
here: the reconcile loop, dormancy *automation*, rings, and quotas UI — see
"What's deliberately not here yet" below (K8S-3).

## Why this shape

- **A separate service, not a route on the tenant app.** The control-plane
  manages OTHER Arigami instances' lifecycle; it must survive independently
  of any one tenant, and an org only ever runs one of it. It imports nothing
  from `server/` — same OIDC library (`openid-client`) and the same cookie
  hardening as `server/auth.ts` (HttpOnly, SameSite=Lax, Secure whenever the
  request was https), reimplemented locally rather than shared, so the two
  services can be deployed, scaled and rolled independently.
- **sqlite, not Postgres, for this pilot.** The control-plane's own state is
  one row per org user and one per tenant, written only by this one process
  — the same single-writer shape as the host's `users.json`/`sessions.json`
  (`server/auth.ts`), just with real transactions instead of read-modify-
  write-whole-file. `bun:sqlite` ships in the runtime — zero extra
  dependency, zero extra container to run and give RAM to. Postgres earns
  its keep once there's a SECOND writer (a reconcile loop running as its own
  process, K8S-3) or the fleet is large enough that sqlite's single-writer
  lock is the bottleneck — neither is true yet. The storage engine is
  isolated behind `src/db.ts`'s `Store` interface; nothing above it (the
  state machine, the provisioner, the HTTP routes) knows or cares.
- **`helm` CLI, not a Helm SDK.** There is no maintained JS/TS Helm SDK (the
  real one is a Go library). Shelling out to the `helm` binary — exactly the
  command sequence `docs/K8S.md`'s K8S-1 proof already ran and documented —
  keeps this service's behaviour identical to what was already proven on
  k3d, instead of reimplementing chart templating/apply ordering in JS on
  unproven ground. `provisionTenant` is `helm upgrade --install
  --create-namespace --wait`, which is naturally idempotent: re-running it
  for an already-running tenant is a no-op apply (unless `desired_digest`
  or the bundle actually changed, in which case a rollout is exactly what
  should happen), not a duplicate install.
- **Plain server-rendered HTML**, no SPA, no build step (`src/templates.ts`)
  — the task list here is small: a login page, a "starting" page with a
  meta-refresh, an "unavailable" page, and an admin table with three POST
  forms. A build pipeline would be pure overhead.

## The tenant lifecycle (state machine)

```
provisioning → running → dormant → archived → deleted
                  ↑          ↓         ↓
                  └──────────┴─────────┘        (dormant/archived can wake back to running)
```

`src/state-machine.ts` is the single source of truth for which edges are
legal; `src/db.ts`'s `setTenantState` validates every write against it (an
illegal edge throws `IllegalTransitionError`, not a silent no-op). `deleted`
is reachable from every other state (an admin can delete a tenant at any
point in its life; a failed provision also has nowhere better to go) and is
otherwise terminal.

K8S-2 only *drives* two of these edges itself: `provisioning → running` (the
provisioner, on a successful `helm upgrade --install`) and the two admin
actions in the tenant table (`suspend` → `dormant`, `delete` → `deleted`,
plus `resume` → `running`, including automatically on a dormant tenant's
next sign-in). `dormant → archived` is a legal edge in the schema — the PRD
asked for the column and the state — but nothing AUTOMATES it yet; that's
explicitly K8S-3 (dormancy automation / reconcile). A legal edge existing is
not the same as something driving it today.

## OIDC signup

`src/auth.ts`, mirroring `server/auth.ts`'s flow shape (PKCE, `state`/`nonce`
carried in a short-lived HttpOnly cookie, not server-side storage):

1. `GET /auth/login` → discovers the issuer, builds the authorization URL,
   sets `arigami_cp_oidc` (10 min, path-scoped to `/auth`).
2. `GET /auth/callback` → exchanges the code, reads `email`/`sub` from the
   ID token claims (falling back to `/userinfo` if the provider omits
   `email` from claims), checks `emailAllowed` against `ALLOWED_EMAIL_DOMAINS`
   (`src/domains.ts`), then:
   - **First user ever** (no admin row exists yet) → created as `admin`,
     no tenant is auto-provisioned for them (the PRD's "org-admin" role is
     about managing tenants, not necessarily using one).
   - **Everyone else** → created as `user`; a tenant row is created in
     `provisioning` and `provisionTenant` fires in the background
     (fire-and-forget; the HTTP response doesn't block on a helm install
     that can take up to a minute).
3. `GET /` for a signed-in `user` shows "your workspace is starting…"
   (meta-refresh) while `provisioning`/`dormant`(+resume), or a 302 straight
   to `https://u-<id>.<org-domain>` once `running`.
4. `GET /admin` (org-admin only) lists every tenant — email, namespace,
   state, last seen, running image — with suspend/resume/delete forms that
   POST to `/admin/tenants/:subject/:action`, each gated through the SAME
   state-machine validation as everything else (a 409, not a crash, if the
   action doesn't apply to the tenant's current state).

## Provisioner

`src/provisioner.ts`, four functions, all operating on one tenant row at a
time:

- **`provisionTenant`** — `helm upgrade --install <release> deploy/helm/
  arigami-tenant -n <ns> --create-namespace --set-string tenant.id=<id>
  --set image.repository=<org repo> --set-string image.tag=<desired digest>
  --set ingress.domain=<org domain> --set-string
  env.ARIGAMI_BUNDLE=<org bundle> --wait --timeout <n>s [-f
  <extra values file>]`. Returns `https://u-<id>.<org-domain>`.
- **`deleteTenant`** — `helm uninstall` then `kubectl delete namespace
  --wait`; "not found" on either is treated as success (idempotent delete).
- **`suspendTenant`** / **`resumeTenant`** — `kubectl scale
  statefulset/<fullname> --replicas=0`/`1` (the dormancy *lever*; the
  *automation* that decides when to pull it is K8S-3).

### A real bug this caught (and why it's worth reading)

Live on the very first k3d run: `helm upgrade --install --set
tenant.id=7021319228 …` failed with

```
Error: Unable to continue with install: could not get information about the
resource NetworkPolicy "arigami-%!s(int64=7021319228)-deny-cross-tenant" in
namespace "u-7021319228": invalid resource name "...": [may not contain '%']
```

`tenant.id` is `tenantIdFor(subject)` — the first 10 hex characters of
`sha256(subject)` — which is all-digits with non-trivial probability
(`(10/16)^10 ≈ 9%`), and plain `helm --set` parses an all-digits value as an
**int64**, not a string. The chart's `templates/_helpers.tpl` does
`printf "arigami-%s" .Values.tenant.id`, and Go's `%s` on an int64 prints
`%!s(int64=…)` — which then fails K8s name validation outright. Fixed by
using `--set-string` for `tenant.id` and `image.tag` (anything that could
plausibly be all-digits), not `--set`. This is exactly the kind of bug that
only shows up against a real cluster — a mocked `helm` call would never
have hit Go's template formatter.

A second, related bug the same run caught: `suspendTenant`/`resumeTenant`
targeted `statefulset/<t.release>` (the *Helm release name*, which this
service is free to choose — it uses `u-<id>`), but the chart's actual
StatefulSet name is `arigami-<tenant.id>` **regardless of the release
name** (`_helpers.tpl`'s `fullname` never reads `.Release.Name`). Fixed by
adding `provisioner.ts`'s `fullname(ns)` helper and using it for every
`kubectl` reference to the StatefulSet/pod, keeping `t.release` for what it
actually is — the string handed to `helm upgrade`/`uninstall`.

### Honest gap carried over from K8S-1: PV reclaim is async

`deleteTenant`'s `kubectl delete namespace --wait` returns once the
namespace OBJECT is gone — it does not wait for `local-path-provisioner`'s
cleanup job to actually free the backing volume (`docs/K8S.md` "§5 smoke
test" finding). A caller that needs "the disk is actually free" (capacity
accounting, backup verification) must poll `kubectl get pv` separately —
not implemented here, same gap K8S-1 documented and didn't fix.

## Proof on k3d (2026-09-01)

Ran on the same box that runs the live Arigami host — k3d only, `--no-lb`,
metrics-server/servicelb disabled, single node; the same
`arigami-cp-stub:k8s2` throwaway busybox image K8S-1 used the pattern for
(`control-plane/test/fixtures/stub.Dockerfile`, ~2MB, built locally,
`k3d image import`ed, never pushed anywhere); cluster name `arigami-cp-k8s2`,
never touching the live host or its process. Resource envelope (tracking
`available`, the number that predicts an OOM, not `free`):

| step | available MB |
|---|---|
| before anything | 1864 |
| cluster created | 1599 |
| stub image built + imported | 1546 |
| both tenants provisioned + evidence captured | 1488 |
| cluster + images deleted | 1979 |

Never dropped below ~1.4GB available — comfortably clear of the ~400MB
floor. `docker ps -a` / `docker images` both empty before and after.

### Both real code paths, driven directly

The evidence below comes from `control-plane/test/fixtures/live-demo.ts`, a
script that calls the actual `provisionTenant`/`deleteTenant` from
`src/provisioner.ts` (not raw kubectl/helm reimplemented for the demo) and
prints kubectl output at each step:

```
tenant A: u-43ac647142 (release u-43ac647142)
tenant B: u-7021319228 (release u-7021319228)

=== provisionTenant(A) ===
{ url: "http://u-43ac647142.localtest.me" }
=== provisionTenant(B) ===
{ url: "http://u-7021319228.localtest.me" }

$ kubectl -n u-43ac647142 get all,pvc,resourcequota,networkpolicy
NAME                       READY   STATUS    RESTARTS   AGE
pod/arigami-43ac647142-0   1/1     Running   0          16s
...
persistentvolumeclaim/data-arigami-43ac647142-0   Bound   ...   200Mi   RWO   local-path
...
resourcequota/arigami-43ac647142-quota   16s   requests.cpu: 50m/200m, ... pods: 1/6, ...
networkpolicy.networking.k8s.io/arigami-43ac647142-deny-cross-tenant   <none>

$ kubectl -n u-7021319228 get all,pvc,resourcequota,networkpolicy
(same shape, distinct namespace/PVC/quota/policy — u-7021319228)

=== isolation probe: A -> B (<pod-ip>), expect BLOCKED ===
$ kubectl -n u-43ac647142 exec arigami-43ac647142-0 -- wget -qO- -T 5 http://<pod-ip>:3099/__health
(exit 1) wget: can't connect to remote host (<pod-ip>): Connection refused

=== deleteTenant(A) ===
$ kubectl get namespace u-43ac647142
(exit 1) Error from server (NotFound): namespaces "u-43ac647142" not found

$ kubectl -n u-7021319228 get pod arigami-7021319228-0
NAME                   READY   STATUS    RESTARTS   AGE
arigami-7021319228-0   1/1     Running   0          16s
```

Note tenant A's id (`43ac647142`) has hex letters, tenant B's (`7021319228`)
is all-digits — this run happened to reproduce the exact `--set-string` bug
condition above on tenant B, and it provisioned cleanly with the fix in
place.

### The automated integration test (`bun test`, gated)

`control-plane/test/provisioner.k3d.test.ts` runs the same lifecycle as
actual assertions, `RUN_K3D_TESTS=1 bun test test/provisioner.k3d.test.ts`
(off by default — `bun test test/` alone reports it `1 skip`, no docker/k3d
needed):

1. **Provisions two tenants into separate, running namespaces** — both
   pods `Running`, distinct `ns`.
2. **Re-provisioning the same tenant is idempotent** — same `helm upgrade
   --install` call again produces exactly one pod (no duplicate), same PVC
   name as before.
3. **Cross-tenant `NetworkPolicy` blocks A from reaching B; same-namespace
   still works** — the negative control (same-namespace probe succeeds)
   is what proves the policy discriminates rather than happening to block
   everything.
4. **Deleting tenant A removes its namespace and leaves tenant B
   untouched** — `kubectl get namespace <A>` 404s; tenant B's pod is still
   `Running` and still answers `/__health`.

Live result: **4 pass, 0 fail** (32s). `afterAll` always tears the cluster
down (even on failure — proved by the earlier failing runs during
development, which still left `docker ps -a` empty afterward) and prints
the before/after resource envelope.

### What's unit-tested only (no live k8s)

- The full state machine (`test/state-machine.test.ts`): every legal edge,
  every illegal edge rejected with the right error, `deleted` unreachable-
  from-itself and terminal.
- The domain allow-list (`test/domains.test.ts`): case-insensitivity,
  suffix-matching false positives (`notexample.com`, `example.com.evil.net`),
  a listed subdomain not implying its parent domain, empty allow-list
  denying everyone.
- The store (`test/db.test.ts`): deterministic tenant-id derivation,
  `setTenantState` refusing an illegal edge and leaving state untouched,
  session expiry.
- HTTP routing/gating (`test/server.test.ts`) against a **fake**
  provisioner (no k8s): login/starting/running/dormant/deleted page
  selection, admin-only gating (403 for a plain user, 302-to-`/` for
  anonymous), and every admin action's state-machine gate (409 on an
  illegal action, e.g. suspending a still-provisioning tenant).
- **Not tested anywhere, live or otherwise**: the actual OIDC round-trip
  against a real IdP (no test IdP was available in this environment) —
  `oidcStart`/`oidcCallback` reuse the exact PKCE/state/nonce shape
  `server/auth.ts` already ships and tests indirectly via its own OIDC unit
  tests, but this service's own callback handler has no live-IdP coverage.

## Env contract

All read once at boot (`src/config.ts`):

| var | default | meaning |
|---|---|---|
| `CP_PORT` | `8090` | HTTP port |
| `CP_PUBLIC_URL` | `http://localhost:<port>` | this service's own origin — builds the OIDC `redirect_uri` and decides the `Secure` cookie flag |
| `CP_DB_PATH` | `./data/control-plane.db` | sqlite file |
| `CP_COOKIE_DAYS` | `30` | session cookie lifetime |
| `CP_TRUST_PROXY` | `false` | honour `X-Forwarded-Proto` (only meaningful behind a TLS-terminating proxy) |
| `CP_OIDC_ISSUER` / `CP_OIDC_CLIENT_ID` / `CP_OIDC_CLIENT_SECRET` | — | the company IdP; OIDC is off (login 500s) until issuer+clientId are set |
| `ALLOWED_EMAIL_DOMAINS` | — | comma-separated; **empty allows nobody**, not everybody |
| `CP_ORG_DOMAIN` | `localtest.me` | tenants live at `u-<id>.<this>` |
| `CP_URL_SCHEME` | `https` | `http` only makes sense for a local/k3d proof with no TLS in-cluster |
| `CP_IMAGE_REPOSITORY` | `ghcr.io/maor700/arigami` | what image every new tenant gets |
| `CP_IMAGE_TAG` | `latest` | a real deployment should pin a digest/release tag, not `latest` (same advice as `values-real.yaml`) |
| `CP_ARIGAMI_BUNDLE` | — | git URL applied to every tenant on first boot (`server/profiles.ts` `applyBundleEnv`) — this is what makes the harness "already configured for the company" |
| `CP_ARIGAMI_BUNDLE_REF` | — | **accepted, not wired to anything yet** — same gap `docs/K8S.md` documented for the chart itself: `applyBundleEnv`'s `gitClone` always clones the default branch. A future wave adding ref-pinning needs to plumb this through the chart's `env.ARIGAMI_BUNDLE_REF` (chart change) as well as here. |
| `CP_HELM_CHART_PATH` | `../deploy/helm/arigami-tenant` | which chart to render |
| `CP_RELEASE_PREFIX` | `u-` | release/namespace name prefix |
| `CP_HELM_EXTRA_VALUES` | — | optional extra `-f` layered on every install (used by the test/demo to swap in the stub image's resource/security overrides) |
| `CP_HELM_TIMEOUT_SEC` | `120` | `helm --wait --timeout` |
| `CP_INGRESS_CLASS` | — | not currently read by the provisioner (the chart's own `ingress.className` default is used) — reserved for a future per-org override |

## Running it

```
cd control-plane
bun install
CP_OIDC_ISSUER=https://idp.example.com \
CP_OIDC_CLIENT_ID=arigami-control-plane \
CP_OIDC_CLIENT_SECRET=... \
ALLOWED_EMAIL_DOMAINS=example.com \
CP_ORG_DOMAIN=arigami.example.com \
CP_IMAGE_TAG=sha256:<pinned digest> \
CP_ARIGAMI_BUNDLE=https://github.com/<org>/arigami-profile-bundle \
KUBECONFIG=/path/to/kubeconfig \
bun run start
```

`helm` and `kubectl` must be on `PATH`, pointed (via `KUBECONFIG` or the
current context) at the cluster that will host tenants — the provisioner
shells out to both, it does not talk to the k8s API directly.

Tests: `bun test test/` (fast, no k8s needed — the k3d suite reports `1
skip`); `RUN_K3D_TESTS=1 bun test test/provisioner.k3d.test.ts` for the live
proof (needs docker + k3d/kubectl/helm on `PATH`, ~30s, creates and deletes
its own `arigami-cp-k8s2` cluster).

## What's deliberately NOT in here yet (K8S-3)

- **Reconcile loop.** Nothing today notices that `desired_digest !=
  running_digest` and rolls a tenant forward on its own — an admin (or a
  future automated caller) has to re-trigger `provisionTenant` explicitly.
  There is also no "only upgrade when no session is in flight" check the
  PRD's §2 describes.
- **Rings.** The `ring` column exists in the schema (per the PRD's table
  shape) and defaults to `"stable"`, but nothing reads it to stage a
  rollout across cohorts.
- **Dormancy automation.** `suspendTenant`/`resumeTenant` are real levers
  (scale-to-zero/-one, proved on k3d in K8S-1 §7); nothing decides "N idle
  hours → suspend" or "M days dormant → archive" on its own. The admin page
  is the only thing pulling these levers today.
- **Quotas UI.** The chart's `ResourceQuota`/`LimitRange` are fixed at
  provision time from the chart's own defaults (or `CP_HELM_EXTRA_VALUES`);
  there's no per-org or per-tenant sizing control surface.
- **A "failed" tenant state.** A `provisionTenant` failure leaves the
  tenant in `provisioning` (logged, not surfaced anywhere in the UI beyond
  "still starting" never resolving) rather than a distinct state an admin
  could see and retry from. Simplicity choice for the pilot, not a schema
  limitation — `deleted` is reachable from `provisioning` so a stuck tenant
  can still be cleaned up.
- **Managed-cloud specifics** (GKE/EKS IAM, a real cert-manager/DNS setup,
  a real multi-user pilot) — K8S-4.
