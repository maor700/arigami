# Operating Arigami tenants on Kubernetes (K8S-3 §4)

What an operator actually does, for the tenant fleet `deploy/helm/arigami-tenant`
(K8S-1) + `control-plane/` (K8S-2/3) run. Companion docs: `docs/K8S.md` (the
chart and its live proofs), `docs/CONTROL-PLANE.md` (the control-plane,
upgrades, backups — with this wave's k3d evidence).

## Logs — where they go, and what to do

There are three log surfaces per tenant, because "`kubectl logs` is not
enough" cuts both ways — some things only exist there, some things never
appear there:

1. **Container stdout/stderr** — the host's boot lines (`[host] arigami up`,
   `[host] ARIGAMI_BUNDLE applied: …`, `[auth] pairing code`), trigger
   scheduler, supervisor, and anything a child process prints. This is what
   `kubectl -n u-<id> logs arigami-<id>-0` shows, and `--previous` shows the
   crashed container's tail after an OOM/restart — the FIRST thing to read on
   a crash loop. It does not survive pod deletion (as opposed to restart), and
   k3s rotates it.
2. **The PVC, `/data/.arigami/logs/`** — logs the host writes itself (e.g.
   `upgrade.log`), plus per-concern files some subsystems keep
   (`*-logs.txt`). These SURVIVE pod recreation and travel with backups'
   excluded set rules (they are excluded from backups — they're logs).
   Read with `kubectl -n u-<id> exec arigami-<id>-0 -- tail -50 /data/.arigami/logs/<file>`.
3. **Chat/session records, `/data/.arigami/chat/*.jsonl`** — what actually
   happened inside a session (turn errors like `Not logged in`, setup cards).
   Support questions ("my session died") are answered here, not in kubectl
   logs.

Operator practice per fleet size:

- **Pilot / single node**: the three commands above are genuinely enough.
  `kubectl logs --previous` for crashes, exec-tail for host logs, exec-tail
  chat for session complaints.
- **A real multi-tenant box**: ship container logs off-node — k3s/containerd
  writes every container's stream to `/var/log/pods/<ns>_<pod>_…/`; run one
  node-level shipper (Vector/Promtail DaemonSet → Loki or any log store) and
  you get per-namespace (= per-tenant) history that survives pod AND node
  loss, with zero app changes. The PVC logs stay tenant-private on the
  volume; they are diagnostic, not audit.

## Reaching a tenant's cockpit for support — without stealing the session

Never ask the user for their cookie, and don't lift `users.json`. The
supported path (proved live in the K8S-3 pilot run):

```
kubectl -n u-<id> exec arigami-<id>-0 -- gosu node:node sh -c 'cd /app && bin/host pair'
#   pairing code: XXXX-XXXX  (one-time)
kubectl -n u-<id> port-forward arigami-<id>-0 8080:3099
# browse http://127.0.0.1:8080/__host/ → enter the code → you are a NEW admin user
```

`bin/host pair` mints a fresh one-time pairing code (`server/auth.ts`:
possession of the code == possession of the filesystem, so it always yields
an admin — a NEW user with your email, not the tenant user's session). The
tenant user's own cookie/session is untouched; your access is visible to
them in the users list. When done: remove yourself —
`kubectl … exec … -- gosu node:node sh -c 'cd /app && bin/host user remove support@<org>'`.

Port-forward (not the ingress) keeps support access off the public URL and
inside kubectl's audited auth. The same exec/pair path works when the
ingress is broken — it only needs the pod to be running.

## What the probes actually assert (and don't)

All three probes hit `GET /__health` (`server/index.ts`), which answers
`{ok:true}` as soon as the HTTP server is listening. Precisely:

- **startupProbe** (5s × 60 = 5 min budget): covers first boot doing the
  `ARIGAMI_BUNDLE` clone + apply BEFORE `server.listen()` (docs/K8S.md
  "ARIGAMI_BUNDLE"). A slow bundle repo eats into this budget; a bundle
  failure does NOT fail the probe — the host logs
  `ARIGAMI_BUNDLE apply failed: …` and starts anyway (retrying on next boot,
  since nothing wrote `profile.json`). Check the boot log line after every
  first provision.
- **livenessProbe**: "the bun process accepts HTTP and its event loop can
  serve a trivial route." A hung/deadlocked host gets restarted. It does NOT
  assert Claude auth, session health, desktop/Chrome, or trigger delivery —
  a tenant can be "live" and still broken for its user (see runbook).
- **readinessProbe**: same endpoint; gates the Service/ingress. With one pod
  there is no "other replica" to shift traffic to — unready = the user sees
  502 from the ingress.

To an unauthenticated/public caller `/__health` is `{ok:true}` and nothing
else, on purpose. From LOOPBACK (a `kubectl exec` curl — how the
control-plane asks) it additionally reports `busySessions` — the count of
sessions with a claude turn in flight (`server/host-control.ts healthBody`),
which is the upgrade/restore idle gate. Tenant activity is never visible
through the ingress.

## Runbook — the three failures we already know happen

### 1. Pod OOM under Chrome

**Symptoms**: pod restarts; `kubectl -n u-<id> describe pod arigami-<id>-0`
shows `Last State: Terminated, Reason: OOMKilled`; the user reports their
browser session/desktop died mid-task.

**Why**: browsing sessions run real Chrome; `/dev/shm` is a memory-backed
emptyDir that COUNTS AGAINST the pod's memory limit (values.yaml `shm`), and
a heavy session is measured at 2.5–3.5GB (values.yaml sizing note).

**Do**:
1. Confirm it's OOM, not liveness: `describe pod` → OOMKilled (liveness
   failures say "Unhealthy … Liveness probe failed" in events instead).
2. `kubectl logs --previous` for what was running at the kill.
3. Raise the tenant's limit — through the control-plane values, not by hand:
   bump `resources.limits.memory` (and the namespace `resourceQuota.limits`
   with it — the quota is sized to exactly this pod) in the org's extra
   values file, then let the reconcile/`helm upgrade` roll it. A hand-patched
   StatefulSet is overwritten by the next upgrade.
4. If the org won't pay for bigger tenants: lower `shm.sizeLimit` (Chrome
   degrades before the host dies) and tell the user fewer parallel
   browser-heavy sessions.

**Data**: nothing is lost — the PVC survives OOM kills; sessions resume
(`--resume`) after restart, same as any host restart. An in-flight turn IS
lost (docs/K8S.md "Graceful shutdown, honestly").

### 2. PVC full

**Symptoms**: sessions fail to start or write (`ENOSPC` in chat errors /
host log); exports fail; the pod itself usually stays Ready (the probe
doesn't write).

**Do**:
1. Measure: `kubectl -n u-<id> exec arigami-<id>-0 -- df -h /data` and find
   the eater: `… exec … -- gosu node:node du -sh /data/.arigami/* /data/repos/* | sort -h | tail`.
2. Usual suspects, safe to delete in-pod: `/data/.arigami/tmp/*` (export
   scratch), stale `.bak-*` dirs from old restores (each restore leaves one
   — `server/backup.ts` importFull), `/data/.arigami/backups/*` (old local
   archives; control-plane backups live OFF the volume). Worktree buildup
   under session workdirs is the same disease the host box gets (memory:
   `/tmp` buildup) — prune merged/dead worktrees.
3. Expand: only if the storage class has `allowVolumeExpansion: true` —
   `kubectl -n u-<id> patch pvc data-arigami-<id>-0 -p '{"spec":{"resources":{"requests":{"storage":"<bigger>"}}}}'`.
   Note `volumeClaimTemplates` on the StatefulSet do NOT propagate size
   changes to existing PVCs — patch the PVC directly, and update the chart
   value so future tenants get the new size. k3d's `local-path` does NOT
   support expansion (pilot limitation, §6 in docs/K8S.md's values notes).
4. Worst case: control-plane backup → delete tenant → re-provision →
   restore (docs/CONTROL-PLANE.md K8S-3 §3 — the proven round-trip).

### 3. Claude auth expired inside a tenant

**Symptoms**: every turn errors immediately; the chat shows
`Not logged in · Please run /login` followed by a `setup` card for the
`claude` capability (observed verbatim in the pilot run). Pod healthy,
probes green — this failure is INVISIBLE to Kubernetes.

**Do**:
1. This is user-fixable by design: the JIT-setup card in their cockpit
   (connect-claude flow) re-authenticates without any operator involvement.
   First response is "open the card and reconnect".
2. If the org injects credentials centrally (`secretEnv` /
   `existingSecret` → `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY`):
   rotate the Secret, then restart the pod to re-read env:
   `kubectl -n u-<id> rollout restart statefulset/arigami-<id>` (safe for
   data; kills in-flight turns — check the busy signal first like the
   control-plane does).
3. Fleet-wide (org token expired everywhere): fix the Secret once per
   namespace (script it), restart tenants idle-first using the same
   `/__health` busySessions gate the upgrade path uses.

**Monitoring gap, stated honestly**: nothing today alerts an operator that a
tenant's Claude auth died — Kubernetes can't see it and the control-plane
doesn't poll for it. The signal exists in-pod (the setup card / chat error);
wiring it to the control-plane is future work, not this wave.

## Running the same thing on a dedicated box

The pilot ran on a 3.8GB VPS next to the live host — fine for a disposable
proof, not for real tenants (one REAL tenant wants 2Gi requests / 8Gi
limits, values.yaml). Moving the pilot to a dedicated machine (the €46/mo
6c/64GB class box from PRD-ARIGAMI-K8S.md — comfortably ~10 real tenants at
2Gi request + system overhead):

1. **OS + k3s** (not k3d — no Docker indirection on a real box):
   `curl -sfL https://get.k3s.io | sh -s - --disable=servicelb` (keep
   Traefik, or `--disable=traefik` + install ingress-nginx and set the
   chart's `networkPolicy.ingressNamespace`/`ingress.className` to match).
2. **Storage**: k3s ships `local-path` — node-local, fine on ONE box
   (everything is on that node anyway), no expansion support; size PVCs
   generously up front. Set `persistence.storageClassName` explicitly and
   read the warning in values.yaml before ever adding a second node.
3. **Image**: push the built image to a registry the box can pull
   (`ghcr.io/maor700/arigami` once it's published, or a private registry +
   `imagePullSecrets`) — no `k3d image import` on a real cluster.
4. **DNS + TLS**: wildcard `*.tenants.<org>` A-record → the box;
   cert-manager + a wildcard cert (or Traefik's ACME); set `ingress.domain`,
   `ingress.tls.enabled=true`, `CP_URL_SCHEME=https`.
5. **Control-plane**: run it on the same box under systemd (it's one bun
   process + sqlite + kubectl/helm on PATH), env per
   docs/CONTROL-PLANE.md "Running it" — a real `CP_OIDC_ISSUER` (the org's
   IdP), `ALLOWED_EMAIL_DOMAINS`, `CP_ARIGAMI_BUNDLE` = the org's real
   bundle repo URL, `CP_BACKUP_DIR` on a disk that is NOT the tenants' disk
   (or rsync'd off-box — backups that live on the box they protect die with
   it).
6. **Sizing sanity**: requests×tenants ≤ node allocatable; the shipped
   defaults mean ~10 tenants on 64GB with room for k3s + the control-plane.
   The quota keeps each tenant at exactly one pod, so fleet arithmetic stays
   linear.

Everything above is a deployment of already-proven pieces; nothing in this
section was newly proven on such a box this wave (no such box exists yet —
and no cloud resources were provisioned for this task, per its constraints).
