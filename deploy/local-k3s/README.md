# The multi-tenant stack on a local Kubernetes — read it, run it, port it

The whole thing the cloud will run, on one plain local cluster (k3s, k3d or kind), installed **the proper way**:
an ingress controller, an OIDC IdP, and the control plane from its Helm chart **inside** the cluster with its
cluster-scoped RBAC. Tenants are not installed by hand: the control plane creates one per user at first sign-in,
exactly as it will in the cloud. Everything is plain http on `*.localtest.me` (a public DNS name that resolves to
127.0.0.1). Nothing is exposed beyond 127.0.0.1.

```
deploy/local-k3s/
  up.sh / down.sh            bring it up / take it away again (idempotent, touches nothing else in the cluster)
  e2e.sh                     the proof: sign-ins, tenants, gate, NetworkPolicy, restarts, upgrades, backup
  values/ingress-nginx.yaml  ingress-nginx on a NodePort (cloud: LoadBalancer + static IP)
  values/control-plane.yaml  deploy/helm/arigami-control-plane, pinned digests, the nginx tenant gate
  values/cp-src-overlay.yaml CP_SRC_OVERLAY=1: this checkout's control-plane/src over the published image
  manifests/mock-idp.yaml    control-plane/test/fixtures/mock-idp.ts in an oven/bun pod (cloud: your IdP)
  manifests/coredns-custom.yaml  in-cluster names for the local domains (cloud: real DNS)
```

## Run it

```sh
export KUBECONFIG=~/.kube/<your-local-cluster>   # required: the scripts never guess a context
./up.sh                                           # ~40 s once images are on the node
kubectl port-forward -n ingress-nginx --address 127.0.0.1 svc/ingress-nginx-controller 8080:80
google-chrome --proxy-server=http://127.0.0.1:8080 --user-data-dir="$(mktemp -d)" http://arigami.localtest.me/
./e2e.sh                                          # on a FRESH up.sh: the first sign-in becomes org-admin
./down.sh                                         # ~2.5 min, mostly waiting for namespaces to terminate
```

**Why a proxy.** The control plane builds tenant URLs as `http://u-<id>.<orgDomain>` with no port, and the gate
rejects anything else as a return URL. So every URL has to be on port 80, and binding 80 on the host needs
privileges. Instead, the port-forward on 127.0.0.1:8080 is used as an HTTP proxy. The browser sends
`GET http://u-<id>.arigami.localtest.me/…` to it, and nginx routes by that host. URLs stay byte-identical
everywhere (`curl -x`, `HTTP_PROXY=` for bun, `--proxy-server` for Chrome).

**How names resolve.**

| name | from the host | from inside the cluster |
|---|---|---|
| `arigami.localtest.me` (control plane) | 127.0.0.1 → port-forward → ingress-nginx | CoreDNS rewrite → `ingress-nginx-controller.ingress-nginx.svc` |
| `u-<id>.arigami.localtest.me` (tenants) | same | same |
| `idp.localtest.me` (mock IdP) | same | same |

The control plane fetches the IdP's discovery document, token endpoint and JWKS at **exactly** the issuer the
browser is sent to (`http://idp.localtest.me`). An OIDC issuer must match byte for byte, so this is the only
arrangement where both sides agree without special cases. On k3s/k3d the rewrite is the `coredns-custom`
ConfigMap, which k3s imports. On kind, up.sh splices the same two lines into the Corefile between markers, and
down.sh takes them out again. That kind path is written but **not exercised**: the reference run was k3s.

`up.sh` steps: ingress-nginx 4.15.1 (controller 1.15.1, NodePort 30080/30443) → CoreDNS rewrite → mock IdP
(ConfigMap from the repo file, rolled when the file changes) → control-plane namespace, the OIDC client Secret
created out of band (`existingSecret`), `helm upgrade --install` of the chart → an in-cluster smoke check. That
check is the control plane's pod fetching both the IdP's discovery and its own `/__health` through the ingress,
by public name:

```
{"issuer":"http://idp.localtest.me","cpHealthViaIngress":{"ok":true}}
```

`down.sh` removes, in order: the tenants **this** control plane lists in its own sqlite (never a `u-*` name
pattern — another control plane may share the cluster), the control plane (release, namespace with its PVC,
ClusterRole/Binding), `idp`, `e2e-probe`, its own CoreDNS key, ingress-nginx. The cluster itself stays.

## Images: what is published, and what is not in it

Both images are pinned by digest in `values/control-plane.yaml`. Look up current tags anonymously:

```sh
T=$(curl -s "https://ghcr.io/token?scope=repository:maor700/arigami-control-plane:pull" | sed 's/.*"token":"\([^"]*\)".*/\1/')
curl -s -H "Authorization: Bearer $T" https://ghcr.io/v2/maor700/arigami-control-plane/tags/list
curl -sI -H "Authorization: Bearer $T" -H 'Accept: application/vnd.oci.image.index.v1+json' \
  https://ghcr.io/v2/maor700/arigami-control-plane/manifests/latest | grep -i docker-content-digest
```

On 2026-10-08 `latest` = `sha-411bd83` for both images (control plane `sha256:3c8955b0…`, tenant
`sha256:0080a389…`). That is master `411bd836`, so **the tenant gate (org SSO in front of every cockpit) is in the
published images**. Not in any published image:

* **profile rollout** to existing tenants. It lives on an unmerged branch (`child/profile-rollout-yioc`), so a
  profile bundle is still applied once, at first boot.
* **the control-plane fixes on this branch** (below). With the published control plane, three e2e checks fail
  for exactly those reasons. `CP_SRC_OVERLAY=1 ./up.sh` mounts this checkout's `control-plane/src` over the
  published image's `/app/src` (same node_modules, kubectl, helm, baked tenant chart), and then all checks pass.
  That is a way to prove a fix before a release, not a way to run anything real.

## What was proven (real output, 2026-10-08, single-node k3s v1.36.5)

`e2e.sh` against the published images (run C), and against the same images with this branch's control-plane
source (run B). Private IPs are elided here. The raw logs carry them, which is why they are not in the repo.

| # | check | published images | + this branch's control-plane src |
|---|---|---|---|
| 1 | first sign-in (`admin@example.com`, live-pilot.ts, real OIDC round-trip + PKCE) lands on `/admin` (200), role `admin` | PASS | PASS |
| 2 | `alice@` and `bob@` each get a tenant: `running` in the control plane, pod Ready — both landed **15–16 s** after sign-in (image already on the node) | PASS | PASS |
| 3 | handoff through the ingress: alice's control-plane cookie → `302 /__host/` + the tenant's own `arigami_sid`; then `/__api/health` 200, `/__host/` 200, websocket `/__ws` **101** | PASS | PASS |
| 3 | no session → sign-in redirect | **FAIL: nginx `500`** (auth endpoint answered 302) | PASS: `302 …/auth/login?rd=http://u-…%2F__host%2F` |
| 3 | a fresh browser opening its own tenant URL ends **inside** the cockpit | **FAIL: 500** at the first hop | PASS: login → IdP → callback → handoff → `/__host/` → `/__api/health` 200 |
| 3 | bob's session on alice's host → 403; org-admin's → 403; unknown tenant host → 404 (no Ingress) | PASS | PASS |
| 3 | `arigami_cp_sid` stripped before the tenant | PASS (rendered nginx.conf only, see gaps) | PASS (same) |
| 4 | tenant NetworkPolicy rendered **with the kube-dns Service IP** (`lookup`, in-cluster by the control plane) | PASS | PASS |
| 4 | from alice's pod: bob's Service IP, pod IP, Service DNS name, the control plane → all `Couldn't connect` | PASS | PASS |
| 4 | from alice's pod: `getent hosts example.com` and a cluster name resolve; `https://example.com/` → 200 | PASS | PASS |
| 4 | contrast: a pod in a namespace without policy reaches the control plane pod (`{"ok":true}`) but **not** bob's pod (`Connection refused`) — the CNI enforces, it is not a dead port | PASS | PASS |
| 5 | delete the control-plane pod: new pod uid; users/roles/tenants/states identical; 3 sessions kept; alice's old cookie still → her handoff; admin still admin | PASS | PASS |
| 6 | `helm upgrade --reuse-values --set-string env.TZ=Etc/UTC` on alice's release: revision 1→2, new pod, **same PVC uid**, marker file in `/data` survived, her cockpit session (stored on the PVC) still 200 | PASS | PASS |
| 7 | on-demand backup from the admin page | **FAIL: 500** (`gosu`: operation not permitted) | PASS: `arigami-backup-<stamp>.tgz` (≈12 KB) on the control plane's PVC |

The policy evidence, verbatim apart from the IPs:

```
alice -> bob's Service IP: curl: (7) Failed to connect to <ip> port 3099 after 0 ms: Couldn't connect to server
alice -> bob's pod IP: curl: (7) Failed to connect to <ip> port 3099 after 0 ms: Couldn't connect to server
alice -> the control plane: curl: (7) Failed to connect to arigami-control-plane.arigami.svc.cluster.local port 8090 after 62 ms: …
alice: getent hosts example.com -> 2606:4700:10::ac42:93f3 example.com
alice -> https://example.com/: 200
probe (no policy) -> control plane pod IP: {"ok":true}
probe (no policy) -> bob's pod IP: wget: can't connect to remote host (<ip>): Connection refused
```

### Found here and fixed (separate commits on this branch)

| symptom on this stack | cause | fix |
|---|---|---|
| reconcile log: `backup error: in-pod export failed (exit 1)`; admin "Backup now" → 500 | tenant chart 0.2.0 runs the pod as uid 1000; the control plane still wrapped every `kubectl exec` in `gosu node:node`, which needs root. This also broke restore and, since it fails closed, **every image upgrade** (busy check, post-upgrade health) | `provisioner.ts tenantExecArgv`: gosu only when the pod runs as root; support commands in `docs/K8S-OPERATIONS.md` |
| tenant without a session → `500 Internal Server Error` | nginx `auth_request` treats a 302 from the auth endpoint as an error | `/auth/verify?redirect=0` answers 401 → nginx `auth-signin`; the callback sends an own non-running workspace to `/workspace` (no login loop) |
| after the gate's sign-in, a fresh browser lands on the cockpit's pairing screen (`/__api/health` 401) | the callback returned to the bare tenant URL; the cockpit had no session of its own | the callback goes through the handoff for the user's own running workspace |
| every tenant Ingress answered 503 | `auth-proxy-set-headers` pointing at a ConfigMap in another namespace is rejected ("cross namespace usage … not allowed"), and the controller then fails the whole Ingress closed | `auth-snippet` sets `X-Forwarded-Host/-Uri` (values/control-plane.yaml) |
| a hand-written `auth-signin …?rd=$scheme://$host$request_uri` | not escaped: an `&` in the original URL cuts the return URL short | no `rd` in `auth-signin`: ingress-nginx appends an escaped one |
| admin actions → 404 for a subject a browser percent-encodes (`auth0\|…`, one with `/`) | form action not encoded, route not decoded | encode in `templates.ts`, decode in the routes |
| NOTES printed `…/arigami:sha256:…` | NOTES.txt joined a digest with `:` | `@` for digests (the pods were always right) |

### Known gaps — not fixed, decide or carry

* **ingress-nginx is retired upstream** (best-effort maintenance ended March 2026). It is used here because it
  was asked for, and the nginx flavour of the gate is now tested. For the cloud, pick a maintained controller
  (Gateway API implementation, Traefik, Contour/Envoy…). The gate contract is the same: an external-auth call
  to `/auth/verify`, 2xx = pass. Use `?redirect=0` if that controller cannot relay a redirect, plus a way to
  set `X-Forwarded-Host/-Uri` and to strip the `arigami_cp_sid` cookie.
* **Snippets are on** (`allowSnippetAnnotations`, `annotations-risk-level: Critical`) for the cookie strip and
  the auth headers. That is acceptable only because nothing but the control plane creates Ingresses here.
  The strip is proven by the rendered `nginx.conf`, not by observing a request at the pod.
* **Inbound webhooks are gated too** under nginx (`POST /__api/webhooks/github` without a session → 302). One
  `auth-url` covers the whole Ingress, and Caddy's per-path bypass has no nginx equivalent in a single Ingress.
  A second, ungated Ingress for `^/__api/webhooks/(sms|slack|github|custom/<id>)$` would be needed: a tenant
  chart change.
* **`tenantValues` changes do not reach existing tenants.** The control plane only re-runs helm for a tenant
  when its digest changes. Observed live: after changing the annotations, the existing tenant's Ingress kept the
  old ones until it was upgraded by hand. A hand `helm upgrade --reuse-values` also *merges* annotation maps:
  a removed key stays. Same family as the missing profile rollout.
* kubectl in the control-plane image is v1.33.4; this cluster is v1.36. Everything worked, but that is outside
  kubectl's ±1 minor skew policy. Match the image's `KUBECTL_VERSION` to the cloud cluster.
* Restricted tenant egress subtracts RFC1918, so a tenant cannot reach **any** in-cluster Service, not even
  the org domain's ingress. That is intended, but anything a tenant must call inside the cluster needs
  `networkPolicy.egress.extraRules`.
* Not exercised here: a real agent turn (needs Claude credentials), a cold image pull (the tenant image was
  already in the node's store), the kind CoreDNS path, TLS.

## What the cloud must provide

The lessons from the public lab (symptom → cause → fix) are in [deploy/gke-lab/README.md](../gke-lab/README.md#what-it-took-to-get-here-symptom--cause--what-is-now-encoded).
They are not repeated here. This is the shopping list, each line mapped to the local stand-in it replaces.

| need | local stand-in | the cloud must provide | notes |
|---|---|---|---|
| **Load balancer + static IP** | NodePort 30080 + `kubectl port-forward` on 127.0.0.1 | an L4 LoadBalancer for the ingress controller with a **reserved static IP** (`controller.service.type=LoadBalancer`, `loadBalancerIP`) | TCP 80/443 only. Websockets must pass: the cockpit's `/__ws` and the VNC bridge. Timeouts ≥ 1 h, as in values/ingress-nginx.yaml |
| **Wildcard DNS** | `*.localtest.me` → 127.0.0.1, CoreDNS rewrite inside | `<orgDomain>` **and** `*.<orgDomain>` → the static IP | tenants are `u-<10 hex>.<orgDomain>`, created at sign-in time. Per-tenant records (external-dns) work too, but wildcard is simpler. Delete `coredns-custom.yaml` |
| **TLS** | none (http) | a wildcard certificate for `*.<orgDomain>` + `<orgDomain>` (DNS-01), or cert-manager HTTP-01 per host | then `config.urlScheme=https`, `ingress.tls.enabled=true` on the control plane, `tenantValues.ingress.tls.enabled=true`: tenants derive `ARIGAMI_PUBLIC_URL` from it, and OAuth providers refuse `http://` redirects |
| **OIDC client** | `manifests/mock-idp.yaml` (anyone can be anyone) | one confidential **web** client at the org IdP; redirect URI **`https://<orgDomain>/auth/callback`** (= `CP_PUBLIC_URL` + `/auth/callback`, from `ingress.host`); scopes `openid email profile` | `config.oidcIssuer`, `config.oidcClientId`, the secret in `existingSecret` (`CP_OIDC_CLIENT_SECRET`). Restrict to the org (e.g. an "Internal" consent screen) **and** set `config.allowedEmailDomains`. The first account to sign in becomes org-admin: sign in yourself first |
| **StorageClass, RWO** | k3s `local-path` (node-local; sizes not enforced) | a default class with **network-attached ReadWriteOnce** volumes (PD/EBS/Ceph RBD…), `WaitForFirstConsumer`, volume expansion on | per tenant one PVC (chart default **30Gi**, 5Gi here), control plane one (20Gi default: its backups live there). Decide `reclaimPolicy` (`Delete` = deleting a tenant deletes its data) |
| **A CNI that ENFORCES NetworkPolicy** | k3s's built-in policy controller (proven above) | Calico/Cilium/Dataplane V2 with enforcement **on**: a cluster without it accepts the policies and ignores them (lab lesson #1) | if the cloud runs NodeLocal DNSCache, keep the kube-dns Service IP rule (rendered by `lookup` when the control plane installs; `dnsServiceCidrs` for offline renders). Rerun section 4 of `e2e.sh` there; it needs only kubectl |
| **Ingress controller** | ingress-nginx 4.15.1 (retired upstream) | a maintained controller that supports external auth, setting request headers on the auth call, and stripping a cookie (see known gaps) | name its namespace in `config.tenantIngressNamespaces` and its class in `config.tenantIngressClass`: a wrong value gives healthy, unreachable tenants |
| **Cluster-scoped RBAC** | cluster-admin kubeconfig installs the chart's ClusterRole | permission to create a ClusterRole/Binding (on GKE: `roles/container.admin`) | read the chart README's **Blast radius**: `secrets` + `pods/exec` cluster-wide ≈ cluster-admin, so a dedicated cluster is the honest answer |
| **Node sizing** | one 8 vCPU / 32 GB VM | per tenant: **requests 1 CPU / 2 GiB, limits 4 CPU / 8 GiB** (chart defaults; the namespace quota admits exactly that one pod) | measured here, idle with no session: tenant ≈ 130 m CPU right after boot, 4 m settled, 73–76 MiB; ingress-nginx 2–4 m / 100–103 MiB; control plane 15–20 m / 8–9 MiB; IdP 8 m / 10 MiB; tenant `/data` after first boot 4–9 MB; tenant image 764 MB in the node store. Working-session numbers (1–1.3 GB per session, 2.5–3.5 GB heavy user) are the chart's measured figures, not re-measured here. Schedulable by requests: (allocatable − system) / (1 CPU, 2 GiB). On-demand nodes for the control plane |
| **Secrets** | `kubectl create secret` in up.sh | external-secrets / sealed-secrets / SOPS for `CP_OIDC_CLIENT_SECRET` (`existingSecret`) | each tenant's `ARIGAMI_HANDOFF_SECRET` is generated by the control plane and passed with `--set`, so it also sits in that tenant's Helm release Secret. The control plane's sqlite (sessions, handoff secrets) is on its PVC: treat that volume as a secret |
| **Egress** | the VM's NAT | tenants need the public internet: git hosts, the model API, package registries, OIDC discovery; image pulls from ghcr.io (or a mirror) | tenant policy `restricted` = DNS + 0.0.0.0/0 minus RFC1918 and the metadata endpoint. A cloud egress firewall/NAT must allow 443 out; an allow-list of hosts is possible but must be maintained |
| **Backups** | archives on the control plane's PVC (`/data/backups/<ns>/`, daily, keep 7) | off-cluster copies of **the control-plane PVC** (sqlite + all tenant archives), e.g. VolumeSnapshots or an object-storage sync, plus snapshots of tenant PVCs if RPO < 24 h | needs this branch's exec fix: published control-plane images cannot back up a 0.2.0 tenant (proven above) |
| **Images** | public ghcr.io, pulled by k3s containerd | pull access to `ghcr.io/maor700/arigami` / `arigami-control-plane`, or a mirror; pin **digests** (`image.tag` / `config.tenantImageTag`) | the control plane bakes the tenant chart: a tenant chart change ships only with a new control-plane image |
