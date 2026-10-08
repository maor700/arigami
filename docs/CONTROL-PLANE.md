# Arigami control-plane (K8S-2)

Wave K8S-2 (`PRD-ARIGAMI-K8S.md` §2/§5) ships `control-plane/`: a small,
separately-deployable bun service that turns "an employee signs in with the
company IdP" into "their own running Arigami tenant", by rendering
`deploy/helm/arigami-tenant/` (K8S-1) into a namespace per user. K8S-3 (see
"K8S-3 — reconcile, upgrades, backups" below) added the reconcile loop,
no-turn-in-flight-gated upgrades with rollback, and per-tenant
backup/restore. Still out of scope: dormancy *automation* (K8S-5), rings,
quotas UI — see "What's deliberately not here yet" at the end.

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
asked for the column and the state — but nothing AUTOMATES it yet; dormancy
automation moved to K8S-5 (K8S-3 shipped the reconcile loop for UPGRADES and
backups only). A legal edge existing is not the same as something driving it
today.

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

### Two supported signup modes

- **Company** — `ALLOWED_EMAIL_DOMAINS=example.com[,example.org]`, any
  standards-compliant OIDC IdP (Okta, Entra, a company's own). Only emails
  on those domains get in; everyone else's callback 403s before a user row
  is ever created.
- **Open / solo operator** — `ALLOWED_EMAIL_DOMAINS=*`, `CP_OIDC_ISSUER`
  pointed at a consumer IdP (`https://accounts.google.com` is the standard
  one; GitHub also speaks OIDC). No company domain required — register an
  OAuth client for yourself in the Google Cloud Console (a personal Google
  account is enough, ~5 minutes, no organisation), and "Sign in with
  Google" IS the signup form: anyone with a Google account can authenticate
  and gets a tenant. This is still real authentication, not an open door —
  Google verified the email — there is just no allow-list narrowing WHICH
  authenticated emails may in. Useful for a demo or a personal
  multi-project setup where "who's allowed" isn't a domain question at all.

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
  *automation* that decides when to pull it moved to K8S-5).

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
| `CP_COOKIE_PARENT_DOMAIN` | `false` | scope the session cookie to `CP_ORG_DOMAIN` so an edge can gate tenant hosts on `GET /auth/verify` ("Org SSO in front of every cockpit"); boot fails if `CP_PUBLIC_URL` is not under `CP_ORG_DOMAIN` |
| `CP_OIDC_ISSUER` / `CP_OIDC_CLIENT_ID` / `CP_OIDC_CLIENT_SECRET` | — | the company IdP; OIDC is off (login 500s) until issuer+clientId are set |
| `ALLOWED_EMAIL_DOMAINS` | — | comma-separated; **empty allows nobody**, not everybody. A literal `*` entry means **open signup** — anyone who authenticates with the configured OIDC provider gets in, any email domain. Meant for a solo operator / demo with no company domain to gate on: point `CP_OIDC_ISSUER` at Google (or GitHub), set `ALLOWED_EMAIL_DOMAINS=*`, and "sign in with Google" is the entire signup flow — still real authentication (Google verified the email), just no domain allow-list on top of it. |
| `CP_ORG_DOMAIN` | `localtest.me` | tenants live at `u-<id>.<this>` |
| `CP_URL_SCHEME` | `https` | `http` only makes sense for a local/k3d proof with no TLS in-cluster |
| `CP_IMAGE_REPOSITORY` | `ghcr.io/maor700/arigami` | what image every new tenant gets |
| `CP_IMAGE_TAG` | `latest` | a real deployment should pin a digest/release tag, not `latest` (same advice as `values-real.yaml`) |
| `CP_ARIGAMI_BUNDLE` | — | git URL applied to every tenant on first boot (`server/profiles.ts` `applyBundleEnv`) — this is what makes the harness "already configured for the company" — and, after that, kept current by the profile rollout ([below](#profile-rollout)) |
| `CP_ARIGAMI_GIT_TOKEN` | — | read-only token for the org's **private** profile repo (and the extensions in it), handed to each tenant as `secretEnv.ARIGAMI_GIT_TOKEN`; the user never signs in to GitHub for it. Sent only to `ARIGAMI_GIT_TOKEN_HOSTS` (default `github.com`) as an HTTP header — see `profiles/README.md`. Same Helm-release-Secret trade-off as the handoff secret. |
| `CP_ARIGAMI_BUNDLE_REF` | — (default branch) | tag / branch / commit of the profile every tenant converges to. Passed to new tenants as the chart's `env.ARIGAMI_BUNDLE_REF` (first boot checks it out) and resolved to one commit on every reconcile tick for the [profile rollout](#profile-rollout). |
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

## K8S-3 — reconcile, upgrades, backups (2026-09-01)

Wave K8S-3 (`SPEC-ARIGAMI-K8S3.md`) makes a tenant correct, operable and
upgradable **while it simply stays running** — dormancy/scale-to-zero moved
to K8S-5 by explicit user decision. What landed here:

### The idle gate: "no turn in flight", reused not reinvented

The host already knows when it is busy: `server/host-control.ts
busySessions()` — sessions whose claude turn is in flight, the same count the
cockpit's restart-drain uses. K8S-3 exposes it on the already-public
`/__health` endpoint **to loopback callers only** (`healthBody()`): a
`kubectl exec <pod> -- curl 127.0.0.1:3099/__health` sees
`{ok:true,busySessions:N}`, while the same URL through the ingress still
answers exactly `{ok:true}` — tenant activity is never visible to the open
internet through the probe path. Both halves verified live (see evidence).

The control-plane reads it with `tenantBusySessions()` (`src/provisioner.ts`)
— `kubectl exec` + loopback curl, because the control-plane machine has
kubectl access but is not necessarily on the tenants' ingress network. The
check **fails closed**: an unreachable tenant or a pre-K8S-3 image (no
`busySessions` field) throws, and no upgrade/restore happens.

### Upgrades (§2): desired_digest → running_digest, with rollback

`src/upgrade.ts` — pure orchestration, every path unit-tested
(`test/upgrade.test.ts`) and every path also driven live on k3d:

```
busy? ──yes──▶ UpgradeBlockedError (reconcile retries next tick)
  │no
record helm revision ─▶ helm upgrade (new digest) ─▶ verify /__health
  │ok                                                  │fail
done (running_digest := desired)          helm rollback to recorded revision
                                          ─▶ delete stuck pod ─▶ rollout status
                                          ─▶ verify /__health ─▶ UpgradeRolledBackError
```

Notes an operator should actually know:

- The rollback deletes the pod outright after `helm rollback` — a pod stuck
  in `ImagePullBackOff` on the bad image can pin a StatefulSet rollout
  (`rollbackTenant`, src/provisioner.ts); this is the standard stuck-STS
  escape hatch, made automatic.
- **A StatefulSet upgrade replaces the pod** — the tenant is DOWN from the
  moment the old pod terminates until the new one is Ready, and a FAILED
  upgrade extends that outage to `CP_HELM_TIMEOUT_SEC` + rollback time
  (~6 min in the live proof). That is why the busy gate matters: nobody's
  turn is in flight when it starts. The PVC (all state) is untouched either
  way.
- The busy check closes the common case, not every race: a turn that starts
  in the seconds between the check and the pod's SIGTERM is killed like any
  external restart (docs/K8S.md "Graceful shutdown, honestly"). A host-side
  quiesce mode would close it fully — future work, stated here rather than
  implied away.
- After a rollback, the tenant is **parked**: `desired_digest` is reset to
  `running_digest` so the loop doesn't flap the tenant through the same bad
  digest forever. An operator sets a new digest to retry. (`src/reconcile.ts`)
- `image.tag=sha256:…` digests render as `repo@sha256:…` since K8S-3
  (chart `imageRef` helper); the k3d proof uses tags-as-digests because the
  image never leaves the local store (no registry to digest-pin against).

### The reconcile loop

`src/reconcile.ts`, in the same process (sqlite stays single-writer): every
`CP_RECONCILE_SEC` (default 60s) each `running` tenant with
`desired_digest != running_digest` gets an upgrade attempt — busy tenants
are skipped and retried next tick, so "upgrade when the user goes idle"
falls out of the loop with no extra machinery. Ticks never overlap; tenants
are handled sequentially. The same tick takes scheduled backups (below).
K8S-2's "nothing notices desired != running" gap is closed.

### Backups & restore (§3): the EXISTING export/import, orchestrated

`src/backup.ts` reuses `server/backup.ts` (B4-full) unchanged:

- **Backup** = `kubectl exec … bun server/backup.ts export
  --full` in-pod (as uid 1000 — through gosu only when the pod runs as root, `tenantExecArgv`), then `kubectl cp` the archive to
  `CP_BACKUP_DIR/<ns>/arigami-backup-<stamp>.tgz` on the control-plane's own
  disk — NOT the tenant's PVC; a backup living on the volume it protects
  dies with it. Pruned to `CP_BACKUP_KEEP` (default 7) per tenant. On-demand
  from the admin page ("Backup now") or CLI; scheduled by the reconcile loop
  every `CP_BACKUP_INTERVAL_SEC` (default daily; 0 = off).
- **Restore** = busy-gate (same fail-closed check) → `kubectl cp` the
  archive in → in-pod `bun server/backup.ts import <file> --force` (the
  `--force` only skips the in-pod CLI's busy check, which cannot see the
  live host's state — the control-plane already made the real check) →
  `rollout restart` → Ready + `/__health` verified. The host CLI itself
  keeps the previous state as a timestamped `.bak` beside the dir. Restore
  is CLI-only on purpose (an overwrite should not be one misclick on a web
  form): `bun src/cli.ts restore <tenant> <archive.tgz>` — and it takes ANY
  tenant's archive, which is the migration path.
- **Why exec-in-pod, not a CronJob/Job**: the §5 decision is "a tenant is
  exactly one pod" — the namespace quota has zero request headroom for a
  backup pod on purpose, a Job would need the RWO volume (only mountable
  beside the pod) and RBAC, and the export CLI already runs perfectly well
  inside the pod that has everything. The reconcile loop is the PRD
  CronJob's "control-plane job" flavour.

### Admin surface & CLI

The admin page gained a per-tenant image column (`running → desired` with
the pending arrow), a digest form (records intent; the reconcile loop
applies it — the form never blocks on helm), backup counts and a "Backup
now" button. `src/cli.ts` is the scriptable/operator surface:
`tenants | set-digest | upgrade | backup | backups | restore`, plus the
profile rollout's `set-ring | profile | profile-retry` ([below](#profile-rollout)).

The admin page also shows a **Profile (applied → desired)** column, a banner
with the desired ref → commit, and — while a failed apply holds the rollout —
which tenant failed, why, when it retries, and a "Retry now" button.

### New env (all optional, defaults in parentheses)

| var | default | meaning |
|---|---|---|
| `CP_TENANT_PORT` | `3099` | tenant host port for the loopback health/busy checks |
| `CP_RECONCILE_SEC` | `60` | reconcile tick; `0` = loop off |
| `CP_BACKUP_DIR` | `./data/backups` | per-tenant archives, on the control-plane's disk |
| `CP_BACKUP_INTERVAL_SEC` | `86400` | scheduled backup age threshold; `0` = on-demand only |
| `CP_BACKUP_KEEP` | `7` | newest N archives kept per tenant |
| `CP_ORG_NAME` | `your organisation` | shown on the waiting page ("Applying …'s setup") |
| `CP_PROFILE_ROLLOUT` | `1` | profile rollout on/off (it is only ever on when `CP_ARIGAMI_BUNDLE` is a git source) |
| `CP_PROFILE_RETRY_BASE_SEC` | `60` | first retry after a failed profile apply; doubles per consecutive failure |
| `CP_PROFILE_RETRY_MAX_SEC` | `3600` | backoff ceiling |
| `CP_PROFILE_RECHECK_SEC` | `3600` | re-read a converged tenant's provenance this often, so drift (someone re-applied something else in-tenant) is noticed and corrected; `0` = never |
| `CP_PROFILE_BATCH` | `0` | max profile applies per tick (`0` = no limit); `1` makes the rollout one tenant per tick |

### Landing the user IN their workspace (K8S-3 follow-on, 2026-09-02)

Driving the pilot by hand surfaced two rough edges that no test would have
caught, because both are about what the wait FEELS like:

**The pairing screen had to go.** A tenant is a fresh Arigami, and a fresh
Arigami asks for a one-time pairing code — possession of the code proves you
can read the server's filesystem (`server/auth.ts`). In an orchestrated fleet
that proof is both redundant (the control-plane authenticated this person
against the company IdP seconds ago) and impossible (the code is inside a pod
the user cannot get a shell on). So:

- `control-plane/src/handoff.ts` mints a token — `base64url(payload).base64url(HMAC)`,
  the same wire format as K2's share tokens — naming the user's email, with a
  2-minute life and a random `jti`.
- The tenant redeems it at `GET /__api/auth/handoff?t=…` (`server/handoff.ts`,
  `server/api.ts`): verify signature → create-or-reuse the user row for that
  email → session cookie → 302 to `/__host/`. The user lands inside.
- The secret is per tenant, generated at tenant creation (`tenants.handoff_secret`)
  and injected into the pod as chart `secretEnv.ARIGAMI_HANDOFF_SECRET`.

What keeps this from being a skeleton key, and why each part is there:

| control | why |
|---|---|
| no secret in env ⇒ every token rejected | a standalone host is byte-for-byte as safe as before this existed |
| single-use `jti`, **persisted** to `$ARIGAMI_DIR/handoff-used.json` | a token in a browser history / proxy log is already spent, and a pod restart must not re-open it |
| `MAX_TTL_MS` enforced by the VERIFIER (10 min) | a buggy or compromised minter still cannot issue a long-lived key |
| token names one email | a leaked token cannot admit a different person |
| per-tenant secret | tenant A's token is worthless against tenant B (asserted in `test/handoff-contract.test.ts`) |
| refuse if the spend cannot be recorded | never silently downgrade to replayable |

Two implementations exist on purpose (this service imports nothing from
`server/`), so the format is a cross-codebase contract —
`test/handoff-contract.test.ts` in the ROOT suite imports both and pins it in
both directions. Coverage: `test/handoff.test.ts` (tamper, wrong secret,
expiry, over-long life, replay, pruning) and `test/handoff-host.test.ts`
(the route against a REAL host running `ARIGAMI_AUTH=pairing`: cookie works,
replay 403s with no cookie, wrong secret gets nothing, and the unauthenticated
API stays 401).

**The wait became legible.** The old starting page was
`<meta http-equiv="refresh" content="4">` and one sentence. Now
`src/progress.ts` reads real state — pod phase, container waiting reason, and
the host's own `ARIGAMI_BUNDLE applied` log line — and `stepsFor()` (pure,
fully unit-tested) turns it into named steps the page ticks through while an
elapsed timer runs:

```
✓ Your account
✓ Reserving your private space
◐ Fetching the workspace image      ← "First-time setups take the longest here."
  Applying <org>'s setup
  Starting your workspace
```

Rules it follows, deliberately: a step only advances on something Kubernetes
actually reported (no invented percentages); phases we cannot distinguish are
ONE honest step; `ImagePullBackOff`/`CrashLoopBackOff` end the spinner and say
an administrator is needed; and passing `SLOW_MS` only adds "this is taking
longer than usual" — it never fakes progress or declares failure. `configure`
precedes `start` because the bundle really is applied before the host listens
(`server/index.ts`). The page polls `GET /api/progress` and navigates itself
the moment the tenant is ready, to a redirect the server minted — so "ready"
and "signed in" are the same step for the user. `<noscript>` keeps the old
meta-refresh.

Preview without a cluster: `bun test/fixtures/preview-starting.ts out.html`
renders the shipped page and the real `stepsFor` output with replayed timing.

New env: `CP_ORG_NAME` (default `your organisation`) — the name shown in
"Applying …'s setup".

**Not proven live yet.** Everything above is unit- and route-tested, and the
page was rendered and reviewed; the end-to-end "sign in → watch the steps →
land inside the cockpit" run needs a cluster, and this box had no RAM headroom
left for one at the time (the demo cluster is under the project controller's
stand-down). That run is the remaining verification.

### K8S-3 proof on k3d (2026-09-01)

Same discipline as K8S-1/K8S-2: disposable single-node k3d cluster
(`arigami-k8s3`, `--no-lb`, metrics-server/servicelb off) on the box that
also runs the live host; the live `arigami` process, host firewall and
docker store outside this cluster untouched; everything deleted BY NAME at
the end (`docker ps -a` and `docker images` both empty afterward). The REAL
image, built locally from this worktree's Dockerfile (the registry is still
not publicly pullable — same finding as K8S-1 §5), as two tags `k8s3-a` /
`k8s3-b` with distinct image IDs standing in for digests A/B (nothing to
digest-pin against without a registry; the chart's new `imageRef` helper is
what makes real `sha256:` pins render correctly).

Fixtures (all in `control-plane/test/fixtures/` + `scripts/`):

- **`mock-idp.ts`** — a real-enough OIDC IdP (discovery, RS256-signed
  id_tokens, JWKS, PKCE S256 actually verified) that the production
  `openid-client` flow in `src/auth.ts` accepts with full validation ON.
  This closes K8S-2's honest gap: the OIDC callback path now has live
  coverage. Who signs in = query params on the authorize URL.
- **`make-org-bundle.sh`** — the fake org bundle (placeholder skill, agent,
  enabled cron, memory seed, repo entry; never the operator's real
  profiles), served to pods from INSIDE the cluster (hostPath + a pod
  reusing the imported image — the pilot box's firewall drops
  bridge→host-port traffic, and opening it for a disposable proof was out of
  bounds; a real org's bundle is just an https git URL).
- **`k3d-pilot-up.sh` / `k3d-pilot-down.sh`** — §1's "one command to seed
  the org config, one to tear it down", for the k3d flavour.

#### §1 — the pilot flow, two tenants, real org bundle

- `root@fake-org.test` signs in first → org-admin, admin page 200, no
  tenant (by design). `alice@` and `bob@` sign in → tenants
  `u-1876ee0cb3` / `u-2968035f97` provisioned by the control-plane, both
  `running`. `eve@evil.test` authenticates at the IdP but the callback 403s:
  `eve@evil.test is not on an allowed domain` — before any user row exists.
- First boot logged `ARIGAMI_BUNDLE applied: "fake-org"`, and in-pod:
  `skills/org-onboarding` ACTIVE, `agents/org-helper` created,
  `org-daily-checkin` cron registered ENABLED, `org-handbook` in
  repos.json, `FAKE-ORG-SEED-1` in memory/MEMORY.md, provenance in
  profile.json — the "already configured for the company" promise, which
  required the two host fixes this wave shipped (env bundles are trusted;
  dumb-HTTP clone fallback — the SECOND of which this run itself caught
  live: the first boot failed with `dumb http transport does not support
  shallow capabilities`, the host started anyway, and the next boot applied
  cleanly. Both halves of "bundle failure never blocks boot" observed.)
- Cockpit through the ingress (Traefik, Host-header routing):
  `/__health` → `{"ok":true}`, `/__host/` serves the SPA, a wrong Host →
  404. Signed in via the pairing code, created a session
  (`POST /__api/sessions` → `sess_…`) — and a turn WITHOUT Claude auth
  fails exactly as designed: `Not logged in · Please run /login` plus a
  JIT-setup card for the `claude` capability in the chat. **Documented, not
  proven: a real working turn** — that needs Claude credentials (org-injected
  `secretEnv` or the user connecting through the card), which this proof
  deliberately never touches.

#### §2 — upgrade A→B, refuse-while-busy, rollback

- **Busy gate, live**: a turn was made to stay in flight deterministically
  by stubbing the `claude` binary in the pod with a `sleep` (a real turn
  needs real credentials; everything downstream of the spawn — session
  `working` state, `busySessions`, the loopback `/__health` field, the
  `kubectl exec` read, the reconcile decision — is the production path).
  With the turn in flight: loopback `/__health` →
  `{"ok":true,"busySessions":1}` while the SAME endpoint through the
  ingress → `{"ok":true}` (the privacy split, both observed). Admin set the
  digest to `k8s3-b` on the admin form → reconcile log:
  `u-1876ee0cb3 busy (1) — upgrade deferred`, tick after tick.
- **Convergence**: the moment the turn ended, the next tick ran
  `u-1876ee0cb3 upgraded k8s3-a -> k8s3-b`. Pod now on
  `…arigami:k8s3-b`; state intact across the rollout: the marker file, the
  whole chat history (including the killed turn's error line), skills,
  users — all on the PVC, untouched.
- **Rollback**: admin set `k8s3-broken` (no such image) on tenant B. The
  rollout replaced the pod, which sat in `ImagePullBackOff` — note
  honestly: a StatefulSet upgrade means the tenant is DOWN from old-pod
  termination until rollback completes (~6 min here: 300s helm wait + the
  rollback), which is exactly why the busy gate holds upgrades until nobody
  is mid-turn. `helm history` tells the story verbatim — rev 2
  `failed: … context deadline exceeded`, rev 3 `Rollback to 1` — the
  provisioner deleted the stuck pod, the pod came back Ready on `k8s3-a`,
  `/__health` ok, the marker intact, and the tenant was PARKED
  (`desired_digest` reset to `k8s3-a`) so the loop can't flap it. Every one
  of these paths is also a unit test (`test/upgrade.test.ts`,
  `test/reconcile.test.ts`).

#### §3 — backup/restore round-trip between two tenants

- **On-demand** ("Backup now" on the admin page): in-pod
  `server/backup.ts export --full` + `kubectl cp` → a `tgz` under
  `CP_BACKUP_DIR/u-1876ee0cb3/` on the control-plane's disk, whose listing
  shows the manifest, chat, triggers.json, profile.json, skills/, agents/.
- **Scheduled**: with `CP_BACKUP_INTERVAL_SEC=600` the next reconcile tick
  backed up tenant B on its own (`[reconcile] u-2968035f97 backed up`) and
  correctly SKIPPED tenant A, whose archive was fresher than the interval.
- **The round-trip**: `bun src/cli.ts restore u-2968035f97 <tenant A's
  archive>` — busy-gate, `kubectl cp` in, in-pod
  `server/backup.ts import --force`, rollout restart, health verify.
  Tenant B then contained tenant A's state, verified in-pod: A's marker
  file, A's chat session, A's users (the paired alice + support users), the
  org trigger/agent/skill/memory-seed — and B's previous state preserved
  in-pod at `/data/.arigami.bak-<stamp>` (the host CLI's own safety net).

#### Resource envelope

Tracking `available` MB (the OOM predictor) and free disk on the shared
3.8GB VPS, live host running throughout:

| step | available MB | disk free |
|---|---|---|
| before anything | ~1100 | 13G |
| images built (A+B, cached layers) | 1663 | 7.4G |
| cluster + 2 real tenants + fixtures | 1179–1324 | 7.3G |
| upgrade/rollback/backup phase | 1135–1280 | 7.3G |
| cluster deleted, images removed by name | 1663 | 13G |

Never near the ~400MB / 2GB floors. The two-real-tenant fit needed the
`ci/k8s3-pilot-values.yaml` overlay (300Mi requests — mechanics sizing, NOT
production sizing; a real tenant keeps values.yaml's 2Gi/8Gi).

#### What this proof does NOT show (stated, not shrugged)

- A real Claude turn end-to-end (no credentials in tenants, on purpose).
- A real IdP (the mock exercises the full client-side flow; a corporate
  IdP's quirks — clock skew, opaque errors, logout — remain untested).
- Real digest pins (`sha256:…`) against a registry — chart renders them
  (helm-template-verified) but the pilot had no registry to pull from.
- Multi-node behaviour, real storage classes, TLS — K8S-4 territory
  (docs/K8S-OPERATIONS.md sketches the dedicated-box path).

## Org SSO in front of every cockpit (tenant gate, 2026-10-08)

Before this, a request to `u-<id>.<orgDomain>` reached the tenant pod with nothing in front of it; only the
tenant's own pairing/handoff cookie stood between the internet and a cockpit that can drive a machine. Now the
edge asks the control plane about every tenant request first, using the sign-in the control plane already has —
no extra IdP, no oauth2-proxy.

```
browser ── https://u-<id>.<orgDomain>/… ──> edge ── forward_auth: GET /auth/verify (same headers) ──> control plane
                                             │        200 ─> proxy to the tenant
                                             │        302 ─> /auth/login?rd=<that URL>   (no / expired session)
                                             │        302 ─> /workspace                  (own tenant, not running)
                                             │        403                                 (anyone else, any bad host)
                                             └─ 5xx/timeout (control plane down)        ─> denied: fail closed
```

**Decision: owner only — org-admins included in the 403.** A cockpit drives a machine with its owner's
connected accounts (mail, WhatsApp, cloud tokens). An admin already holds suspend/resume/backup/delete on
`/admin`; passing the edge would add nothing they need (the tenant's handoff is email-bound to the owner, so
they'd meet a pairing screen) while making one stolen admin session reach every cockpit. An admin's own
workspace (`/workspace`) passes like anyone's. Support access, if ever needed, should be an explicit,
audited, per-tenant grant — not a role bit.

How it is built (`src/gate.ts`, the `/auth/verify` route in `src/server.ts`):

- **Shared session cookie.** `CP_COOKIE_PARENT_DOMAIN=1` sets `Domain=<orgDomain>` on `arigami_cp_sid` (still
  `HttpOnly; SameSite=Lax`, `Secure` on https) so the browser sends it to the tenant hosts. Default **off**.
  The service refuses to boot with the flag on if `CP_PUBLIC_URL` is not `orgDomain` or under it (the browser
  would silently drop the cookie). Login also expires any old host-only twin; logout clears both scopes; when
  both are sent, each value is tried. The OIDC state cookie stays host-only.
- **The tenant never sees it.** The edge strips `arigami_cp_sid` from the `Cookie` header before proxying to
  the pod, so nothing running in a cockpit can replay its owner's control-plane session.
- **Host → tenant.** `X-Forwarded-Host` (falling back to `Host`) must be exactly `u-<hex>.<orgDomain>`; the
  namespace is looked up (`tenants.ns`), and the session's subject must be the tenant's. "No such tenant" and
  "not yours" are the same 403, so the gate does not enumerate addresses. The edge sets these headers itself
  (Caddy overwrites client-sent `X-Forwarded-*` unless told to trust a proxy) — and the answer is only ever
  "this cookie may / may not open this host", so a direct caller learns nothing about anyone else.
- **Return URL, no open redirect, no loop.** `/auth/login?rd=` and the callback both pass `rd` through
  `safeReturnUrl`: a path on this service (not `//…`, no backslash), this service's origin, or
  `<scheme>://u-<hex>.<orgDomain>` on the default port with no credentials. Anything else falls back to `/`.
  `rd` rides inside the OIDC state cookie, never to the IdP. Loop guards: tenant targets are refused while the
  cookie is host-only; `/auth/verify` answers **503**, not 302, when the flag is off; `/auth/login` always does
  the OIDC round-trip (short-circuiting on a session the gate could not see would bounce forever).
- **Handoff still works.** `/` → `302 u-<id>…/__api/auth/handoff?t=…` → the edge asks `/auth/verify` → the
  cookie the user just got is there → 200 → the tenant redeems the token. Unchanged code on both sides.
- **Websockets** pass: forward_auth's subrequest carries the upgrade headers, the control plane answers a
  plain 200, and the edge then proxies the real upgrade to the pod. A 403/302 refuses the upgrade.
- **Inbound webhooks skip the gate** — `^/__api/webhooks/(sms|slack|github|custom/<id>)$`, mirrored from
  `server/webhooks.ts INBOUND_RE`. They come from machines with no session and each verifies its own HMAC/token
  in the tenant. Everything else, including the legacy unauthenticated `/__api/sms/inbound` and shared-artifact
  links (`/__artifacts/…?t=`), now needs the owner's session: a share link only opens for its owner.
- **Admin POSTs check `Origin`.** Every tenant host is same-site with the control plane, so `SameSite=Lax`
  never stopped a page served from a tenant posting to `/admin/…`; a POST with a foreign `Origin` is now 403.

Tests: `test/gate.test.ts` — own session (200), another user's tenant (403), no / unknown session (302 with
`rd`), admin (403 on others, 200 on own), bad hosts and look-alikes (403), not-running tenant (302
`/workspace`), flag off (503), stale host-only cookie next to a valid one, open-redirect attempts (`//`,
`/\`, look-alike suffix, `@`, credentials, wrong scheme/port, `javascript:`), callback honours only a valid
`rd`, cookie attributes on/off, logout, boot refusal, cross-origin admin POST.

Proved against a real Caddy 2.10 (not a cluster): `deploy/gke-lab/edge.yaml` rendered with `envsubst` passes
`caddy validate`; the same Caddyfile with only the listeners and upstreams pointed at localhost, in front of
this app and a fake tenant, gave 200 for the owner (with `arigami_cp_sid` removed and other cookies intact),
403 for another user and for an admin, 302 with `rd` for no session, a spoofed `X-Forwarded-Host` overwritten,
a websocket echo for the owner and a refused upgrade for anyone else, the webhook path through without a
session, and **502 with the control plane stopped** (the tenant never saw the request).

The ingress-nginx variant ("the proper way" in `deploy/gke-lab/README.md`) is proven in-cluster on a local k3s —
`deploy/local-k3s/` (values, `e2e.sh`, results). nginx `auth_request` answers any 3xx from the auth endpoint with a
500, so nginx asks `/auth/verify?redirect=0` and gets **401** where Caddy gets a 302 (no session, or the own workspace
not running); `auth-signin` → `/auth/login` then starts the sign-in, and `/auth/callback` sends a user back into their
OWN workspace through the handoff (or to `/workspace` when it is not running — no 401 → sign-in → 401 loop).
`X-Forwarded-Host`/`-Uri` come from an `auth-snippet` (nginx sends the control plane's own Host on the subrequest),
the cookie strip from a `configuration-snippet`. Not proven: the full browser round-trip through a real IdP on a
live lab.

## Profile rollout

The org ships ONE profile repo (`profile.json` + `skills/` + `agents/` +
`extensions/` + `cron.json`, see `profiles/README.md`). A tenant applies it
once, on first boot. Publishing a new version — a push to the branch
`CP_ARIGAMI_BUNDLE_REF` names, a new tag set as the ref, or a commit sha —
now reaches every existing tenant through the reconcile loop, mirroring how an
image digest converges:

```
tick ─▶ git ls-remote CP_ARIGAMI_BUNDLE  ─▶ desired = ONE commit (a moving branch cannot split the fleet)
     ─▶ for each running tenant, canary ring first, then oldest first:
          decideProfile()  converged / backoff / halted ─▶ skip
            │ needs it
          GET  /__api/profiles/rollout  (in-pod loopback, operator token)
            │ already on the commit, no errors ─▶ record it, no apply
            │ busySessions > 0 ─▶ skip, next tick retries
          POST /__api/profiles/rollout  {ref, commit as signed claims}
            │ ok ─▶ record the commit the tenant REPORTS
            │ failed ─▶ record error + backoff, HALT: stop this pass, and hold
            │           every other tenant until this one succeeds or a new
            │           commit is published
```

**The trusted entry point (tenant side, `server/profile-rollout.ts`).** A
directory/CLI/cookie apply is untrusted — extensions are `skipped`, new cron
jobs start disabled — because a user should not be able to grant themselves
code execution through a bundle. The org operator is different: the rollout
re-applies the bundle as **trusted** (extensions install/update in place via
`installOrUpdateExtension`, new skills go live, cron jobs land by `bundleKey`,
`scope: org` jobs are still skipped unless `ARIGAMI_ORG_HOST=1`; skills, agents
and memory seed stay additive — an existing skill the profile CHANGES still
becomes a pending proposal for the user). So it is gated on a credential only
the operator holds: an operator token (`kind: "operator"`) signed with the
per-tenant `ARIGAMI_HANDOFF_SECRET` the control-plane already injects
(`src/handoff.ts mintOperator` / `server/handoff.ts verifyOperator`, the same
wire format as the sign-in handoff, pinned by `test/handoff-contract.test.ts`).

- A cookie, a session token, an API token — even the tenant admin's — does
  not open `/__api/profiles/rollout`; neither does a sign-in token (different
  `kind`), nor a status token on the apply route (the action is a claim).
- The ref/commit are signed claims; the **source is not** — the tenant only
  ever applies its own `ARIGAMI_BUNDLE`. A captured token can re-apply the
  org's own repo at one commit, once: apply tokens are single-use (the jti is
  spent on disk, like a sign-in) and live ≤ 2 minutes.
- The token goes into the pod on **stdin** (`kubectl exec -i … curl -H @-`),
  never in a process argument list.
- The tenant refuses while a turn is in flight (409) or while another apply
  runs (409), so the control-plane's busy check is enforced at both ends.
- The bundle is fetched (`git fetch` of the ref, then the exact commit, token
  as a header via `server/lib/git-auth.ts`) and **validated before anything is
  touched**: a profile that fails validation returns 422 and leaves the tenant
  exactly as it was. Every attempt is recorded in `$ARIGAMI_DIR/profile-rollout.json`;
  a successful one writes `ref` + `commit` into the provenance (`profile.json`),
  which is what the control-plane reads back.

**Canary.** `bun src/cli.ts set-ring <tenant> canary` puts a tenant (yours, a
volunteer's) at the front of every rollout. Applies run one tenant at a time;
the first failure stops the pass and halts the commit for everyone else, so a
bad profile reaches exactly one tenant. `CP_PROFILE_BATCH=1` slows the rollout
to one tenant per tick for a longer soak. The failed tenant is retried with
exponential backoff (`CP_PROFILE_RETRY_BASE_SEC`, doubling, capped at
`CP_PROFILE_RETRY_MAX_SEC`); "Retry now" on the admin page (or
`bun src/cli.ts profile-retry <tenant>`) drops the wait. The halt ends when the
retry succeeds or a new commit is published — fixing the profile is the normal
way out.

**Not failures** (nothing recorded, retried next tick): a busy tenant, an
unreachable one (status unreadable → fail closed, no apply), a tenant whose
pod has no `ARIGAMI_BUNDLE` (provisioned before the bundle was configured — it
converges once re-provisioned), a tenant with no handoff secret (pre-K8S-3
row). If `git ls-remote` fails the tick rolls nothing out and the admin banner
shows why. One lifecycle action per tenant per tick: an image upgrade, a
profile apply and a backup never share a tick for the same tenant.

**Tests.** `test/profile-rollout.test.ts` (decision table, canary pass,
backoff, halt/release, tick integration, admin page) and
`test/profile-rollout.e2e.test.ts` — two REAL Arigami hosts, a real git repo
and real reconcile ticks, with only kubectl faked
(`test/fixtures/fake-kubectl.sh` runs the in-pod `curl` against the local
host): boot → confirm without re-apply → v2 canary-first with its extension
installed → a broken v3 fails on the canary, the other tenant is never called,
both stay healthy, backoff holds → a fixed v4 releases the halt. Tenant side:
`test/profile-rollout-host.test.ts` in the root suite (auth matrix, trusted
apply, single-use, broken profile, busy refusal).

## What's deliberately NOT in here yet (K8S-4/K8S-5)

- ~~Reconcile loop~~ — **landed in K8S-3** (above), including the
  "only upgrade when no session is in flight" gate.
- **Rings for images.** The profile rollout reads `ring` (`canary` first,
  `set-ring` in the CLI); image upgrades still do not — the reconcile loop
  upgrades every running tenant whose digest differs, in table order.
- **Dormancy automation** — moved to K8S-5 by explicit user decision
  (SPEC-ARIGAMI-K8S3.md: "right now I want to make this work properly; we'll
  optimize costs later"). `suspendTenant`/`resumeTenant` remain real levers; the
  admin page is still the only thing pulling them.
- **Quotas UI.** The chart's `ResourceQuota`/`LimitRange` are fixed at
  provision time from the chart's own defaults (or `CP_HELM_EXTRA_VALUES`);
  there's no per-org or per-tenant sizing control surface.
- **A "failed" tenant state.** A `provisionTenant` failure leaves the
  tenant in `provisioning` (logged, not surfaced anywhere in the UI beyond
  "still starting" never resolving) rather than a distinct state an admin
  could see and retry from. Simplicity choice for the pilot, not a schema
  limitation — `deleted` is reachable from `provisioning` so a stuck tenant
  can still be cleaned up. (K8S-3 softened the UPGRADE flavour of this:
  a failed upgrade rolls back and parks with the tenant still `running`;
  first-provision failures still just sit in `provisioning`.)
- **Alerting on in-tenant failures** (Claude auth expiry, PVC pressure) —
  the signals exist in-pod; nothing forwards them to the control-plane. See
  docs/K8S-OPERATIONS.md's runbook for the manual paths.
- **Managed-cloud specifics** (GKE/EKS IAM, a real cert-manager/DNS setup,
  a real multi-user pilot) — K8S-4.
