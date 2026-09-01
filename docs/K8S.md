# Arigami on Kubernetes (K8S-1)

Wave K8S-1 (`PRD-ARIGAMI-K8S.md`) ships `deploy/helm/arigami-tenant/`: one Helm
release = one tenant = one namespace = one Arigami instance. Out of scope
here: the control-plane, OIDC signup, the reconcile loop, dormancy automation
(the chart only has to make them *possible*) — see K8S-2/3 in the PRD.

## Why this shape

Arigami is a **stateful singleton**, not a 12-factor service (`docs/DOCKER.md`
"Handing it to DevOps"): the listeners scheduler (`server/state.ts`) and the
session registry live in one process, sessions write git worktrees straight
onto disk, and the desktop/Chrome need a real `/dev/shm`. Two pods on one
volume corrupts state; a rolling update that briefly runs two pods does too.
So:

- **`StatefulSet`, `replicas: 1`.** `updateStrategy.type: RollingUpdate` (the
  default, and the only one that doesn't need a human to delete the pod by
  hand) — this is fine here specifically because a StatefulSet already
  maintains "at most one pod per ordinal" at all times, unlike a Deployment's
  RollingUpdate which by default runs old+new together (`maxSurge`). With one
  replica there is never a moment with two pods against the same PVC.
- **One PVC, `ReadWriteOnce`**, mounted at `/data` — the same path
  `docs/DOCKER.md` documents for Docker; `volumeClaimTemplates` on the
  StatefulSet so it survives pod recreate automatically.
- **`/dev/shm` as `emptyDir{medium: Memory}`** — Chrome dies on the default
  64MB container `/dev/shm`; `docker-compose.yml` gives it `shm_size: 1gb`,
  this is the K8s equivalent (and it counts against the pod's memory limit,
  same trade-off).
- **Tenant = namespace.** `ResourceQuota` + `LimitRange` cap what the
  namespace can consume; a `NetworkPolicy` denies ingress from every other
  namespace except the ingress controller's. Deleting a tenant is
  `kubectl delete namespace u-<id>` — proven below to take the StatefulSet,
  Service(s), PVC *and its backing volume* with it.

## Probes: which endpoint

The PRD's own §4.1 draft said `/__api/health` — that's wrong once you read
`server/auth.ts`: everything under `/__api/` requires a session
(`isPublicPath` doesn't list it), so a probe with no cookie gets 401 there.
The endpoint that's actually public is **`/__health`**
(`server/index.ts:136`, `{ok:true}`, listed in `auth.ts` `isPublicPath`). The
chart's `probes.path` defaults to it.

First boot may run `ARIGAMI_BUNDLE` (a git clone plus skills/memory/cron
application, see below) **before** `server.listen()` — so a plain
liveness/readiness probe with a short `initialDelaySeconds` could kill the pod
mid-clone. The chart uses a `startupProbe` (default: every 5s, 60 attempts =
5 minutes) to absorb that; liveness/readiness only start once it succeeds.

## Graceful shutdown, honestly

The PRD asks for "SIGTERM → finish the in-flight turn". Tracing
`server/index.ts` end to end: `process.on('SIGTERM', shutdown)` where
`shutdown()` calls `flushState()` (sync), `flushTriggers()` (sync),
`killAll()` (sends `SIGTERM` to every child `claude` process via
`server/lib/children.ts` `killTree` — non-blocking, `unref()`'d 1.5s
escalation timer to `SIGKILL`), `releaseHost()`, `server.close()`, then
**`process.exit(0)` immediately** — no `await`, nothing waits for a turn to
actually finish. The real drain-and-wait (`cfg.host.drainTimeoutMs`, default
20s) lives in `server/host-control.ts`'s `RestartController`, and it runs
**before** SIGTERM is sent, only on a cockpit-initiated restart
(`host-control.ts:20`: "Draining gives in-flight turns a bounded grace period
… their processes are killed by the normal shutdown path … afterwards").

So today, a raw external SIGTERM (a pod eviction, a rollout, `kubectl delete
pod`, a node drain) does **not** wait for an in-flight turn — it kills it
within about a second, same as it always has under systemd/launchd/pm2/Docker.
The chart still sets `terminationGracePeriodSeconds: 30` (some headroom past
`drainTimeoutMs` for slower network-attached PVC I/O), but that number buys
almost nothing today — it is not a substitute for wiring the cockpit's drain
path into the OS signal handler, which is real, scoped work for a later wave
and out of scope here (K8S-1 is chart mechanics; changing production shutdown
semantics is not "the smallest change" this wave asked for). Documenting this
honestly beats a number that implies a guarantee the code doesn't keep.

## `ARIGAMI_BUNDLE`

`server/profiles.ts` already had a full Profile Bundle apply pipeline
(`applyBundle`/`applySource`) driven by the wizard or `host profile apply`,
but nothing read an env var — verified by grepping the tree for
`ARIGAMI_BUNDLE` before writing any code (zero hits on master). Added
`applyBundleEnv()`: reads `process.env.ARIGAMI_BUNDLE`, no-ops if unset or if
`$ARIGAMI_DIR/profile.json` already exists (i.e. *some* bundle — this one, a
different one via `host profile apply`, or the wizard — already landed), else
calls the same `applySource()` the CLI/wizard use. Wired into
`server/index.ts` before the trigger scheduler starts (so the bundle's own
cron jobs are registered from tick one) and before `server.listen()` (so the
startup probe, not a readiness flap, is what covers the clone). Test:
`test/profiles.test.ts` "ARIGAMI_BUNDLE" section — first boot applies, a
"restart" (profile.json already present) is a no-op with no duplicate history
entry.

**Known gap, documented not fixed**: the PRD also mentions "`+ optional
ref`" — `resolveSource`'s `gitClone` always does `git clone --depth 1` of the
default branch, no `--branch`/ref pinning. Out of scope for the "smallest
change that makes `ARIGAMI_BUNDLE` work" this wave asked for; a later wave
adding `ARIGAMI_BUNDLE_REF` would need one line in `gitClone`.

## The chart

```
deploy/helm/arigami-tenant/
  Chart.yaml
  values.yaml          # shipped defaults — PRD-measured sizing, real image
  values-real.yaml      # worked example: real tag, ingress domain, secrets
  ci/stub-values.yaml   # what THIS doc's k3d run actually used
  templates/
    statefulset.yaml    # the StatefulSet + volumeClaimTemplates (the PVC)
    service.yaml         # ClusterIP, Ingress backend
    service-headless.yaml # StatefulSet's governing Service (clusterIP: None)
    ingress.yaml
    serviceaccount.yaml
    resourcequota.yaml
    limitrange.yaml
    networkpolicy.yaml
    secret.yaml          # only rendered when values.secretEnv is set
    NOTES.txt
```

See `deploy/helm/README.md` for the value-by-value reference.

## Proof on k3d (2026-09-01)

Ran on the box that also runs the live Arigami host (`PRD-ARIGAMI-K8S.md`
§6: ~1.2GB free RAM / ~4.9GB free disk at the time the PRD was written; this
run started at 614MB free / 1.66GB available RAM, 4.7GB free disk — see
"Resource envelope" below for the full trace). k3d/kubectl/helm installed as
user binaries under `~/.local/bin` (no `apt`, no sudo beyond nothing —
static-binary installers needed none here); **no k3s on the host itself**, no
iptables changes outside the `k3d-arigami-k8s1` Docker network, the live
`arigami` process/container was never touched.

```
k3d cluster create arigami-k8s1 --servers 1 --agents 0 --no-lb \
  --k3s-arg "--disable=metrics-server@server:0" \
  --k3s-arg "--disable=servicelb@server:0" \
  --wait --timeout 180s
```

`--no-lb` skips k3d's extra load-balancer container (one fewer container to
pay RAM for); Traefik (k3s's bundled ingress controller) and CoreDNS stay on
since the ingress-routing proof needs them. A 3-line busybox-httpd image
(`ci/stub-values.yaml`'s `arigami-stub:k8s1`, ~7MB, built locally and
`k3d image import`ed — never pushed anywhere) stood in for the real 2.89GB
`ghcr.io/maor700/arigami` image, per §6.

### 1. Namespace create/delete

```
$ kubectl create namespace u-demo
namespace/u-demo created
$ helm install u-demo deploy/helm/arigami-tenant -n u-demo \
    -f deploy/helm/arigami-tenant/ci/stub-values.yaml --set tenant.id=demo --wait --timeout 120s
NAME: u-demo
LAST DEPLOYED: Tue Sep  1 18:35:20 2026
NAMESPACE: u-demo
STATUS: deployed
```
… full delete proof is §6 below (it depends on the PVC/pod tests running
first so there's state worth losing).

### 2. Every chart object landed, quota tracked usage

```
$ kubectl -n u-demo get all,pvc,resourcequota,limitrange,networkpolicy,ingress
NAME                 READY   STATUS    RESTARTS   AGE
pod/arigami-demo-0   1/1     Running   0          11s

NAME                            TYPE        CLUSTER-IP     EXTERNAL-IP   PORT(S)    AGE
service/arigami-demo            ClusterIP   <cluster-ip>   <none>        3099/TCP   11s
service/arigami-demo-headless   ClusterIP   None           <none>        3099/TCP   11s

NAME                            READY   AGE
statefulset.apps/arigami-demo   1/1     11s

NAME                                        STATUS   VOLUME                                     CAPACITY   ACCESS MODES   STORAGECLASS   AGE
persistentvolumeclaim/data-arigami-demo-0   Bound    pvc-83e916af-eb19-40ad-be2b-d7a055f10540   200Mi      RWO            local-path     11s

NAME                               AGE   REQUEST                                                                    LIMIT
resourcequota/arigami-demo-quota   11s   requests.cpu: 50m/200m, requests.memory: 32Mi/128Mi, requests.storage: 200Mi/1Gi, pods: 1/6, services: 2/2, secrets: 1/10, configmaps: 1/10, persistentvolumeclaims: 1/2   limits.cpu: 250m/1, limits.memory: 64Mi/256Mi

NAME                             CREATED AT
limitrange/arigami-demo-limits   2026-09-01T15:35:21Z

NAME                                                             POD-SELECTOR
networkpolicy.networking.k8s.io/arigami-demo-deny-cross-tenant   <none>

NAME                                     CLASS     HOSTS                  PORTS
ingress.networking.k8s.io/arigami-demo   traefik   u-demo.localtest.me   80
```

### 3. ResourceQuota enforcement

A pod requesting more than the namespace's remaining quota is rejected
server-side, not just capped:

```
$ kubectl -n u-demo run quota-buster --image=arigami-stub:k8s1 --restart=Never \
    --overrides='{"spec":{"containers":[{"name":"quota-buster", ...,
      "resources":{"requests":{"memory":"200Mi","cpu":"50m"},"limits":{"memory":"200Mi","cpu":"50m"}}}]}}'
Error from server (Forbidden): pods "quota-buster" is forbidden: exceeded quota: arigami-demo-quota,
  requested: limits.memory=200Mi,requests.memory=200Mi,
  used: limits.memory=64Mi,requests.memory=32Mi,
  limited: limits.memory=256Mi,requests.memory=128Mi
```

Bonus (unplanned) evidence for `LimitRange`: a pod created with **no**
resources at all in the same namespace got the LimitRange defaults
(`1 CPU / 512Mi limit`) filled in automatically, which *then* tripped the same
ResourceQuota — proving both objects are live, not just present:

```
$ kubectl -n u-demo run prober-local --image=arigami-stub:k8s1 --restart=Never --command -- sleep 3600
Error from server (Forbidden): pods "prober-local" is forbidden: exceeded quota: arigami-demo-quota,
  requested: limits.cpu=1,limits.memory=512Mi,requests.cpu=250m,requests.memory=256Mi, ...
```

### 4. PVC survives a pod delete

```
$ kubectl -n u-demo exec arigami-demo-0 -- sh -c 'echo "k8s1-proof-1788276948" > /data/marker.txt && cat /data/marker.txt'
k8s1-proof-1788276948
$ kubectl -n u-demo delete pod arigami-demo-0
pod "arigami-demo-0" deleted
$ kubectl -n u-demo wait --for=condition=Ready pod/arigami-demo-0 --timeout=60s
pod/arigami-demo-0 condition met
$ kubectl -n u-demo exec arigami-demo-0 -- cat /data/marker.txt
k8s1-proof-1788276948
```
Same `pvc-83e916af-…` volume before and after (`kubectl get pvc` unchanged).

### 5. Ingress routes by host; a wrong host doesn't reach the tenant

Reached Traefik directly on the k3d server node's container IP (`--no-lb`
means no separate load-balancer container/port on the host):

```
$ curl -H "Host: u-demo.localtest.me" http://<k3d-node-ip>:32009/__health
{"ok":true}                                                    # HTTP_STATUS:200
$ curl -H "Host: u-demo.localtest.me" http://<k3d-node-ip>:32009/
<html><body>arigami-stub k8s1 ok</body></html>                 # HTTP_STATUS:200
$ curl -H "Host: nonexistent.localtest.me" http://<k3d-node-ip>:32009/__health
404 page not found                                              # HTTP_STATUS:404
```
(`localtest.me` and its subdomains always resolve to 127.0.0.1 — the real
chart's `ingress.host` default of `u-<id>.<domain>` needs real DNS + a
LoadBalancer/NodePort reachable from outside the cluster; not re-proved here,
same mechanism as any other K8s Ingress.)

### 6. NetworkPolicy denies cross-namespace, allows same-namespace and the ingress controller's namespace

A-B-C test, one variable at a time: k3s enforces `NetworkPolicy` out of the
box (a built-in kube-router-based controller — no Calico/Cilium install
needed), confirmed by the difference below rather than assumed.

```
# A) same namespace (u-demo → u-demo): ALLOWED
$ kubectl -n u-demo exec prober-local -- wget -qO- http://<pod-ip>:3099/__health
{"ok":true}

# B) the ingress controller's namespace (kube-system, matching
#    networkPolicy.ingressNamespace) → u-demo: ALLOWED
$ kubectl -n kube-system exec prober-ingress -- wget -qO- http://<pod-ip>:3099/__health
{"ok":true}

# C) a DIFFERENT tenant namespace (u-other) → u-demo: BLOCKED
$ kubectl -n u-other exec prober -- timeout 5 wget -qO- http://<pod-ip>:3099/__health
wget: can't connect to remote host (<pod-ip>): Connection refused
command terminated with exit code 1
```
(For the shipped chart default, `networkPolicy.ingressNamespace: ingress-nginx`
— `kube-system` above is a k3d/Traefik-specific override in
`ci/stub-values.yaml`, since k3d's bundled ingress controller lives there.)

### 7. Scale-to-zero and back, data intact (dormancy mechanics for K8S-3)

```
$ kubectl -n u-demo scale statefulset/arigami-demo --replicas=0
statefulset.apps/arigami-demo scaled
$ kubectl -n u-demo wait --for=delete pod/arigami-demo-0 --timeout=60s
pod/arigami-demo-0 condition met
$ kubectl -n u-demo get pvc
NAME                  STATUS   VOLUME                    CAPACITY   ACCESS MODES
data-arigami-demo-0   Bound    pvc-83e916af-…             200Mi      RWO
$ kubectl -n u-demo scale statefulset/arigami-demo --replicas=1
statefulset.apps/arigami-demo scaled
$ kubectl -n u-demo wait --for=condition=Ready pod/arigami-demo-0 --timeout=60s
pod/arigami-demo-0 condition met
$ kubectl -n u-demo exec arigami-demo-0 -- cat /data/marker.txt
k8s1-proof-1788276948
```

### 8. Namespace delete tears down everything, including the volume

```
$ kubectl delete namespace u-demo --wait=true --timeout=90s
namespace "u-demo" deleted
$ kubectl delete namespace u-other --wait=true --timeout=90s
namespace "u-other" deleted
$ kubectl get pv
No resources found
```
`local-path`'s default reclaim policy is `Delete`, so the PVC's deletion (via
namespace cascade) took the backing `PersistentVolume` — and the data on it —
with it. That's the intended "delete a user = delete the namespace" model
(PRD-ARIGAMI-K8S.md §2); a real cluster's storage class should be checked for
the same reclaim policy if that's the desired behaviour, or set to `Retain`
if tenant data should survive a mistaken `kubectl delete namespace` (K8S-3
territory — dormancy/archival, not this wave).

### 9. Teardown, verified clean

```
$ k3d cluster delete arigami-k8s1
INFO Successfully deleted cluster arigami-k8s1!
$ docker ps -a
CONTAINER ID   IMAGE     COMMAND   CREATED   STATUS    PORTS     NAMES
$ docker images
IMAGE   ID   DISK USAGE   CONTENT SIZE   EXTRA
```
(Both empty — the k3d containers/network/volume, the `arigami-stub:k8s1`
image, and the pulled `rancher/k3s`/`k3d-tools` images were all removed by
name, never a blanket `docker system prune`.)

### Resource envelope

`free -m` / `df -h /` at each step (production VPS also running the live
Arigami host and its sessions — including this one):

| step | free MB | available MB | disk free |
|---|---|---|---|
| before anything | 614 | 1663 | 4.7G |
| after installing kubectl/helm/k3d | 514 | 1638 | 4.7G |
| `k3d cluster create` (node Ready) | 358 | 1650 | 4.5G |
| system pods settled (coredns/traefik/local-path) | 161 | 1580 | 3.6G |
| stub image built + imported | 137 | 1554 | 3.6G |
| chart installed, all objects proven | 224 | 1583 | 3.6G |
| cluster deleted | 1182 | 2058 | 4.2G |
| stub/k3s/tools images removed | 1361 | 2050 | 4.5G |

Never dropped below the ~400MB free / ~2GB disk floor from
`PRD-ARIGAMI-K8S.md` §6 (tracking `available`, the number that actually
predicts whether a new allocation OOMs, since Linux's `free` column is
dominated by reclaimable page cache — `available` never went below 1.5GB).
Nothing here touched the live `arigami` process, host iptables, or ran
`docker system/volume prune`.

## §5 smoke test — run for real, on the real image (2026-09-01, follow-up)

The first pass of this doc left this section "documented, not run" because
the box only had 3.6-4.7GB free disk against the PRD's >10GB-before-pulling
rule. Two things changed before re-running it:

1. **Disk headroom.** `/tmp` had accumulated ~9.7GB of scratch worktrees from
   already-completed, already-merged tasks (`arigami-<code>-<hash>`, none
   held open by any live process — checked via `/proc/*/fd`, `/proc/*/cwd`
   *and* `ss -xlp` for listening Unix sockets before deleting anything, since
   the last check alone would have missed live IPC sockets like
   `/tmp/cc-socks`), plus 3.4GB of an unrelated root-owned tool cache
   (`/root/.cache`, `/root/.npm` — no root-owned application process was
   running to hold it). Freeing both, with the specific live paths protected
   and verified still alive afterward, took free disk from ~4.2GB to 18GB.
2. **`ghcr.io/maor700/arigami` turned out not to be pullable at all** —
   `docker pull` returned `unauthorized`, and the GitHub API 404s the repo
   unauthenticated. The repo/package isn't public yet (pre-release), not a
   disk problem. Built the same image locally instead, from this
   worktree's own `Dockerfile` at commit `1d5dbb3`
   (`docker build -t ghcr.io/maor700/arigami:k8s1-smoketest .`) — **2.89GB**,
   matching the PRD's number exactly — and `k3d image import`ed it, same as
   the stub. `deploy/helm/arigami-tenant/ci/real-image-k3d-values.yaml` layers
   the k3d-specific bits (no nginx/cert-manager here) onto `values-real.yaml`.

```
$ helm install u-real deploy/helm/arigami-tenant -n u-real \
    -f deploy/helm/arigami-tenant/ci/real-image-k3d-values.yaml \
    --set tenant.id=real --wait --timeout 300s
STATUS: deployed   # took 12.6s, not anywhere near the 5-minute startup budget
```

### Boot log — the real host, in a pod

```
$ kubectl -n u-real logs arigami-real-0
[host] instance /data/.arigami#3099 (isolated: /data/.arigami)
[host] arigami up on http://0.0.0.0:3099 (pid 1, auth: pairing, public: http://u-real.localtest.me)
[auth] no admin yet — pairing code: ZEL8-5ZFA  (also in /data/.arigami/run/pairing-code; or run: bin/host pair)
[triggers] scheduler started
[supervisor] disabled by config — health is still computed on demand
[host] global desktop up on :99 (vnc :5900)
```
Exactly the line `docs/DOCKER.md` shows for the Docker path, plus confirmation
the host really is `pid 1` in the container (relevant to "Graceful shutdown,
honestly" above — there's no init process forwarding the signal, `bun` gets
SIGTERM directly). `/__host/` over `kubectl port-forward` served the real
cockpit HTML (pairing screen), and `/__health` returned `{"ok":true}`.

### Non-root, for real

```
$ kubectl -n u-real exec arigami-real-0 -- ps -eo user,pid,comm
USER         PID COMMAND
node           1 bun
node          58 Xvfb
node          62 openbox
node          64 tint2
node          65 x11vnc
root         109 ps
```
(`ps` itself shows root only because a bare `kubectl exec` — like a bare
`docker compose exec` — drops into the root shell `docker/entrypoint.sh`
leaves around for first-boot chown; every process the host actually spawned
is `node`, matching `docs/DOCKER.md` "Desktop + Chrome".)

### Proofs 4/7/8 repeated against the real image — same results

- **PVC survival**: wrote a marker, `kubectl delete pod`, marker present
  after the real image reboots (first-boot chown skipped the second time —
  `/data/.chowned` already there — and the SAME pairing code came back from
  `/data/.arigami/run/pairing-code`, not just the marker file).
- **Ingress**: `curl -H "Host: u-real.localtest.me" http://<node-ip>:<traefik-nodeport>/__health` → `{"ok":true}`; wrong host → `404`.
- **NetworkPolicy A/B/C**: same-namespace and `kube-system` (the ingress
  namespace) reach `arigami-real-0:3099`; a pod in a different tenant
  namespace (`u-other-real`) gets `wget: ... exit code 4` (network
  failure) — blocked, not merely slow. (The default `ResourceQuota`
  actually left **zero** headroom for a same-namespace prober pod — its
  `requests.cpu`/`requests.memory` cap is sized to fit exactly the one real
  pod's own request, so proving "A" needed a temporary `kubectl patch
  resourcequota` bump. That's a feature, not a bug: it means a compromised
  tenant can't spin up extra pods in its own namespace by default either.)
- **Scale-to-zero → back**: `kubectl scale --replicas=0` then `=1`; pod comes
  back, `/data/marker.txt` and the pairing code both intact.

One new, minor, honest finding: on `kubectl delete namespace`, `kubectl get
pv` immediately afterward showed the PV as `Released`, not gone —
`local-path-provisioner`'s reclaim is an async controller (it runs a cleanup
job that `rm -rf`s the hostpath, then deletes the PV object), not instant.
The stub run's `docs/K8S.md` §8 evidence happened to be captured after that
controller had already finished; this run's teardown (`k3d cluster delete`)
made it moot by removing the whole node before checking again. On a real
cluster with a real CSI driver this is worth confirming rather than assuming
gone-on-return.

Teardown: `k3d cluster delete arigami-k8s1-real`, `docker rmi` on the built
image + the two k3d support images, all removed by name. `docker ps -a` /
`docker images` both empty afterward; disk back to 14GB free.
