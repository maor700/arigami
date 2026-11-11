#!/usr/bin/env bash
# End-to-end proof of the local stack (run on a FRESH ./up.sh — the first sign-in must be the first ever):
#
#   1. first sign-in becomes org-admin
#   2. two more users each get a tenant that reaches Ready
#   3. the tenant is reachable through the ingress: org-SSO gate + handoff, websocket, refusals
#   4. the tenant NetworkPolicy is ENFORCED: tenant A cannot reach tenant B (Service or pod IP) nor the control
#      plane; DNS and the internet still work; a pod outside any policy reaches the control plane but not tenant B
#   5. restarting the control plane keeps its state (users, tenants, sessions)
#   6. `helm upgrade` of a tenant recreates its pod and keeps its PVC data
#   7. an on-demand backup from the admin page
#   8. what it all costs (kubectl top, image sizes, disk)
#
# Every check prints PASS/FAIL with the raw evidence; the exit code is the number of failed checks.
#   KUBECONFIG=… ./e2e.sh            # evidence also goes to $E2E_OUT (default: a new temp dir)
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
: "${KUBECONFIG:?set KUBECONFIG to the local cluster}"
export KUBECONFIG
K="kubectl --context ${KUBE_CONTEXT:-$(kubectl config current-context)}"
PF_PORT="${PF_PORT:-18080}"
PROXY="http://127.0.0.1:$PF_PORT"
CP="http://arigami.localtest.me"
OUT="${E2E_OUT:-$(mktemp -d -t arigami-e2e.XXXXXX)}"
mkdir -p "$OUT"
exec > >(tee "$OUT/e2e.log") 2>&1

FAILED=0
pass() { printf '  PASS  %s\n' "$*"; }
fail() { printf '  FAIL  %s\n' "$*"; FAILED=$((FAILED + 1)); }
check() { local what="$1"; shift; if "$@"; then pass "$what"; else fail "$what"; fi; }
step() { printf '\n== %s\n' "$*"; }
c() { curl -sS -x "$PROXY" --max-time 20 "$@"; } # every request goes through the ingress, by its real name
json() { bun -e "const o=JSON.parse(require('fs').readFileSync('$1','utf8')); console.log(o$2 ?? '')"; }
db() { # the control plane's own sqlite, read in its pod
  $K -n arigami exec arigami-control-plane-0 -- bun -e "
    const { Database } = require('bun:sqlite'); const d = new Database('/data/control-plane.db', { readonly: true });
    console.log(JSON.stringify(d.query(\"$1\").all()));"
}
not_ok() { ! grep -qE '^200|"ok":true' <<<"$1"; } # a probe that did NOT get an answer
inpod() { local ns="$1"; shift; $K -n "$ns" exec "arigami-${ns#u-}-0" -c arigami -- "$@"; }

# --- the browser's way in: a port-forward on 127.0.0.1, used as an HTTP proxy --------------------------------------
$K -n ingress-nginx port-forward --address 127.0.0.1 svc/ingress-nginx-controller "$PF_PORT:80" >"$OUT/port-forward.log" 2>&1 &
PF_PID=$!
cleanup() { kill "$PF_PID" 2>/dev/null; $K delete namespace e2e-probe --ignore-not-found --wait=false >/dev/null 2>&1; }
trap cleanup EXIT
for _ in $(seq 30); do c -o /dev/null "$CP/__health" 2>/dev/null && break; sleep 1; done
echo "evidence: $OUT   proxy: $PROXY (port-forward pid $PF_PID)"
echo "images: $($K -n arigami get sts arigami-control-plane -o jsonpath='{.spec.template.spec.containers[0].image}')"

pilot() { # control-plane/test/fixtures/live-pilot.ts, unchanged flow: a real OIDC round-trip against the mock IdP
  (cd "$ROOT/control-plane" && HTTP_PROXY="$PROXY" LIVE_PILOT_COOKIE=1 bun test/fixtures/live-pilot.ts "$CP" "$1" "${2:-900}")
}

# --- 1 ---------------------------------------------------------------------------------------------------------------
step "1. first sign-in becomes org-admin"
pilot admin@example.com 60 >"$OUT/admin.json" 2>"$OUT/admin.err"; cat "$OUT/admin.json"
check "admin@example.com landed on /admin (200)" test "$(json "$OUT/admin.json" .landed)/$(json "$OUT/admin.json" .adminStatus)" = admin/200
db "select email, role from users"

# --- 2 ---------------------------------------------------------------------------------------------------------------
step "2. two users sign in; each gets a tenant that reaches Ready"
T0=$(date +%s)
pilot alice@example.com >"$OUT/alice.json" 2>"$OUT/alice.err" & PA=$!
pilot bob@example.com >"$OUT/bob.json" 2>"$OUT/bob.err" & PB=$!
wait $PA; wait $PB
echo "both landed after $(( $(date +%s) - T0 ))s"; cat "$OUT/alice.json" "$OUT/bob.json"
A_NS=$(db "select ns from tenants where email='alice@example.com'" | bun -e 'console.log(JSON.parse(await Bun.stdin.text())[0]?.ns ?? "")')
B_NS=$(db "select ns from tenants where email='bob@example.com'" | bun -e 'console.log(JSON.parse(await Bun.stdin.text())[0]?.ns ?? "")')
A_HOST="${A_NS}.arigami.localtest.me"; B_HOST="${B_NS}.arigami.localtest.me"
A_CP=$(json "$OUT/alice.json" .cookie); B_CP=$(json "$OUT/bob.json" .cookie); ADMIN_CP=$(json "$OUT/admin.json" .cookie)
db "select email, ns, state, desired_digest from tenants"
$K -n "$A_NS" get pods; $K -n "$B_NS" get pods
check "alice landed on her tenant ($A_NS)" test "$(json "$OUT/alice.json" .landed)" = tenant
check "bob landed on his tenant ($B_NS)" test "$(json "$OUT/bob.json" .landed)" = tenant
check "both tenant pods Ready" $K -n "$A_NS" wait pod "arigami-${A_NS#u-}-0" --for=condition=Ready --timeout=10s
check "  (bob)" $K -n "$B_NS" wait pod "arigami-${B_NS#u-}-0" --for=condition=Ready --timeout=10s

# --- 3 ---------------------------------------------------------------------------------------------------------------
step "3. the tenant through the ingress: gate + handoff"
HANDOFF=$(json "$OUT/alice.json" .tenantUrl)
c -i -b "$A_CP" "$HANDOFF" -o "$OUT/handoff.txt"; grep -iE '^(HTTP|location|set-cookie)' "$OUT/handoff.txt" | sed 's/=[^;]*;/=<redacted>;/'
A_SID=$(grep -i '^set-cookie: arigami_sid=' "$OUT/handoff.txt" | sed 's/^[^:]*: //; s/;.*//' | tr -d '\r')
check "handoff (alice's control-plane cookie) -> 302 /__host/" grep -qi '^location: /__host/' "$OUT/handoff.txt"
check "  …and the tenant sets its own session cookie (arigami_sid)" test -n "$A_SID"
code() { c -o /dev/null -w '%{http_code}' "$@"; }
S=$(code -b "$A_CP; $A_SID" "http://$A_HOST/__api/health"); echo "alice, both cookies, /__api/health -> $S"
check "alice reaches her cockpit API through the gate (200)" test "$S" = 200
S=$(code -b "$A_CP; $A_SID" "http://$A_HOST/__host/"); check "alice gets the cockpit page /__host/ (200, got $S)" test "$S" = 200
WS=$(c -i -N --max-time 4 -b "$A_CP; $A_SID" -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
  -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' "http://$A_HOST/__ws" 2>/dev/null | head -1 | tr -d '\r')
echo "websocket /__ws -> $WS"; check "websocket upgrade passes the gate (101)" grep -q ' 101 ' <<<"$WS"
c -i "http://$A_HOST/__host/" -o "$OUT/nosession.txt"; head -1 "$OUT/nosession.txt"; grep -i '^location' "$OUT/nosession.txt"
check "no session -> 302 to $CP/auth/login?rd=<that URL>" grep -qiE "^location: $CP/auth/login\?rd=http(://|%3A%2F%2F)$A_HOST" "$OUT/nosession.txt"
# A fresh browser (no cookies at all) opening alice's workspace URL: the gate sends it to sign in, and it must end up
# INSIDE the cockpit (its own session), not on the cockpit's pairing screen.
JAR="$OUT/fresh-browser.jar"; rm -f "$JAR"
hop() { c -o /dev/null -b "$JAR" -c "$JAR" -w '%{http_code} %{redirect_url}' "$1"; }
L="http://$A_HOST/__host/"; TRACE=""
for i in 1 2 3 4 5 6; do
  R=$(hop "$L"); TRACE+="  $(sed -E 's/([?&](t|code|state|nonce|code_challenge)=)[^& ]*/\1…/g' <<<"$R")"$'\n'
  L="${R#* }"; [ -n "$L" ] || break
  case "$L" in http://idp.localtest.me/authorize*) L="$L&email=alice@example.com&sub=sub-alice@example.com";; esac
done
printf 'fresh browser, %s:\n%s' "http://$A_HOST/__host/" "$TRACE"
S=$(c -o /dev/null -b "$JAR" -w '%{http_code}' "http://$A_HOST/__api/health")
check "…and ends up signed in to the cockpit itself (/__api/health $S)" test "$S" = 200
S=$(code -b "$B_CP" "http://$A_HOST/__host/"); echo "bob's cookie on alice's host -> $S"
check "another user's session -> 403" test "$S" = 403
S=$(code -b "$ADMIN_CP" "http://$A_HOST/__host/"); echo "org-admin's cookie on alice's host -> $S"
check "org-admin on someone else's workspace -> 403" test "$S" = 403
S=$(code -b "$A_CP; $A_SID" "http://u-0123456789.arigami.localtest.me/"); echo "a tenant host that does not exist -> $S"
check "unknown tenant host: no Ingress, nginx's 404, nothing behind it" test "$S" = 404
S=$(code -X POST "http://$A_HOST/__api/webhooks/github"); echo "inbound webhook without a session -> $S"
[ "$S" = 302 ] || [ "$S" = 401 ] || [ "$S" = 500 ] && echo "  NOTE  inbound webhooks are gated too (nginx: one auth-url per Ingress) — README, known gaps"
NGX=$($K -n ingress-nginx exec deploy/ingress-nginx-controller -- cat /etc/nginx/nginx.conf)
check "nginx strips arigami_cp_sid before the tenant (rendered config)" grep -q 'proxy_set_header Cookie $arigami_cookie' <<<"$NGX"

# --- 4 ---------------------------------------------------------------------------------------------------------------
step "4. NetworkPolicy is enforced"
$K -n "$B_NS" get networkpolicy -o yaml | sed -n '/^  spec:/,/^  status/p' | sed -n '1,60p' >"$OUT/netpol-b.yaml"
DNS_IP=$($K -n kube-system get svc kube-dns -o jsonpath='{.spec.clusterIP}')
check "policy allows the kube-dns Service IP (lookup rendered it)" grep -q "cidr: $DNS_IP/32" "$OUT/netpol-b.yaml"
B_SVC_IP=$($K -n "$B_NS" get svc "arigami-${B_NS#u-}" -o jsonpath='{.spec.clusterIP}')
B_POD_IP=$($K -n "$B_NS" get pod "arigami-${B_NS#u-}-0" -o jsonpath='{.status.podIP}')
CP_POD_IP=$($K -n arigami get pod arigami-control-plane-0 -o jsonpath='{.status.podIP}')
probe() { # $1 ns-of-pod $2 url -> prints the curl outcome; exit 0 if it connected
  inpod "$1" curl -sS -o /dev/null -m 4 -w '%{http_code}' "$2" 2>&1 | tr '\n' ' '; echo
}
for target in "http://$B_SVC_IP:3099/__health|bob's Service IP" "http://$B_POD_IP:3099/__health|bob's pod IP" \
              "http://arigami-${B_NS#u-}.$B_NS.svc.cluster.local:3099/__health|bob's Service by name" \
              "http://arigami-control-plane.arigami.svc.cluster.local:8090/__health|the control plane"; do
  url="${target%%|*}"; label="${target##*|}"
  r=$(probe "$A_NS" "$url"); echo "alice -> $label: $r"
  check "alice cannot reach $label" not_ok "$r"
done
r=$(inpod "$A_NS" getent hosts example.com); echo "alice: getent hosts example.com -> ${r:-<nothing>}"
check "DNS works from a tenant (public name)" test -n "$r"
r=$(inpod "$A_NS" getent hosts "arigami-${B_NS#u-}.$B_NS.svc.cluster.local" | awk '{print "resolves"}'); check "DNS works from a tenant (cluster name ${r:-fails})" test "$r" = resolves
r=$(inpod "$A_NS" curl -sS -o /dev/null -m 10 -w '%{http_code}' https://example.com/); echo "alice -> https://example.com/: $r"
check "internet egress works from a tenant" test "$r" = 200
r=$(inpod "$A_NS" curl -sS -m 4 http://127.0.0.1:3099/__health); check "alice's own pod answers on loopback ($r)" grep -q '"ok":true' <<<"$r"
# Contrast, so the refusals above cannot be a dead port: a pod in a namespace with NO policy reaches the control
# plane (no policy) but not bob (his ingress rule admits only his namespace and ingress-nginx). Run as a bare pod
# because a tenant namespace's quota admits exactly one pod.
$K create namespace e2e-probe --dry-run=client -o yaml | $K apply -f - >/dev/null
$K -n e2e-probe run probe --image=oven/bun:1.3-alpine --restart=Never --command -- sleep 600 >/dev/null 2>&1
$K -n e2e-probe wait pod/probe --for=condition=Ready --timeout=120s >/dev/null
r=$($K -n e2e-probe exec probe -- wget -qO- -T 4 "http://$CP_POD_IP:8090/__health" 2>&1); echo "probe (no policy) -> control plane pod IP: $r"
check "an unrestricted pod reaches the control plane (the network itself works)" grep -q '"ok":true' <<<"$r"
r=$($K -n e2e-probe exec probe -- wget -qO- -T 4 "http://$B_POD_IP:3099/__health" 2>&1); echo "probe (no policy) -> bob's pod IP: $r"
check "…but not tenant bob (his NetworkPolicy refuses it)" not_ok "$r"

# --- 5 ---------------------------------------------------------------------------------------------------------------
step "5. restarting the control plane keeps its state"
Q="select u.email, u.role, t.ns, t.state from users u left join tenants t on t.subject = u.subject order by u.email"
BEFORE=$(db "$Q"); echo "before: $BEFORE"; NS_BEFORE=$(db "select count(*) n from sessions")
UID1=$($K -n arigami get pod arigami-control-plane-0 -o jsonpath='{.metadata.uid}')
$K -n arigami delete pod arigami-control-plane-0 --wait=true
$K -n arigami wait pod arigami-control-plane-0 --for=condition=Ready --timeout=180s
UID2=$($K -n arigami get pod arigami-control-plane-0 -o jsonpath='{.metadata.uid}')
AFTER=$(db "$Q"); echo "after:  $AFTER"
check "a new pod (uid changed)" test "$UID1" != "$UID2"
check "users, roles, tenants and states identical" test "$BEFORE" = "$AFTER"
check "sessions survived ($NS_BEFORE)" test "$(db "select count(*) n from sessions")" = "$NS_BEFORE"
for _ in $(seq 20); do [ "$(code "$CP/__health")" = 200 ] && break; sleep 2; done
L=$(c -o /dev/null -w '%{http_code} %{redirect_url}' -b "$A_CP" "$CP/"); echo "alice's old cookie, GET / -> $L" | sed 's/t=[^ ]*/t=<token>/'
check "alice's existing session still lands her in her workspace" grep -q "^302 http://$A_HOST/__api/auth/handoff" <<<"$L"
pilot admin@example.com 60 >"$OUT/admin2.json" 2>/dev/null
check "admin signs in again and is still org-admin" test "$(json "$OUT/admin2.json" .landed)" = admin

# --- 6 ---------------------------------------------------------------------------------------------------------------
step "6. helm upgrade of a tenant keeps its PVC data"
MARK="e2e-$(date +%s)"
inpod "$A_NS" sh -c "echo $MARK > /data/e2e-marker"
PVC_UID1=$($K -n "$A_NS" get pvc "data-arigami-${A_NS#u-}-0" -o jsonpath='{.metadata.uid}')
POD_UID1=$($K -n "$A_NS" get pod "arigami-${A_NS#u-}-0" -o jsonpath='{.metadata.uid}')
REV1=$(helm -n "$A_NS" history "$A_NS" -o json | bun -e 'const h=JSON.parse(await Bun.stdin.text()); console.log(h.at(-1).revision)')
# A spec change that forces a new pod (env), on the release the control plane installed, with the same chart it bakes.
helm upgrade "$A_NS" "$ROOT/deploy/helm/arigami-tenant" -n "$A_NS" --reuse-values --set-string env.TZ=Etc/UTC --wait --timeout 10m | head -6
$K -n "$A_NS" rollout status "statefulset/arigami-${A_NS#u-}" --timeout=600s
POD_UID2=$($K -n "$A_NS" get pod "arigami-${A_NS#u-}-0" -o jsonpath='{.metadata.uid}')
PVC_UID2=$($K -n "$A_NS" get pvc "data-arigami-${A_NS#u-}-0" -o jsonpath='{.metadata.uid}')
REV2=$(helm -n "$A_NS" history "$A_NS" -o json | bun -e 'const h=JSON.parse(await Bun.stdin.text()); console.log(h.at(-1).revision)')
echo "revision $REV1 -> $REV2, pod uid changed: $([ "$POD_UID1" != "$POD_UID2" ] && echo yes || echo no), pvc uid same: $([ "$PVC_UID1" = "$PVC_UID2" ] && echo yes || echo no)"
check "a new revision and a new pod" test "$REV2" -gt "$REV1" -a "$POD_UID1" != "$POD_UID2"
check "same PVC" test "$PVC_UID1" = "$PVC_UID2"
check "marker file survived ($MARK)" test "$(inpod "$A_NS" cat /data/e2e-marker)" = "$MARK"
# Ready is not routed yet: nginx learns the new pod's endpoint a moment later (503 until then).
for _ in $(seq 30); do S=$(code -b "$A_CP; $A_SID" "http://$A_HOST/__api/health"); [ "$S" = 200 ] && break; sleep 2; done
check "alice's cockpit session (stored on the PVC) still valid (got $S)" test "$S" = 200
inpod "$A_NS" rm -f /data/e2e-marker

# --- 7 ---------------------------------------------------------------------------------------------------------------
step "7. on-demand backup (admin page)"
A_SUB=$(db "select subject from tenants where email='alice@example.com'" | bun -e 'console.log(JSON.parse(await Bun.stdin.text())[0].subject)')
R=$(c -o /dev/null -w '%{http_code} %{redirect_url}' -X POST -H "Origin: $CP" -b "$ADMIN_CP" "$CP/admin/tenants/$A_SUB/backup")
echo "POST /admin/tenants/<alice>/backup -> $R"
LS=$($K -n arigami exec arigami-control-plane-0 -- sh -c "ls -l /data/backups/$A_NS/ 2>&1"); echo "$LS"
check "backup archive written on the control plane's volume" grep -q 'arigami-backup-' <<<"$LS"
$K -n arigami logs arigami-control-plane-0 --tail=20 | grep -iE 'backup|error' | tail -5

# --- 8 ---------------------------------------------------------------------------------------------------------------
step "8. measured footprint"
$K top pods -A --no-headers 2>/dev/null | grep -vE '^(kube-system)' || echo "(metrics-server not ready yet)"
$K get node -o json | bun -e '
  const n = JSON.parse(await Bun.stdin.text()).items[0];
  for (const i of n.status.images) { const name = i.names.find((x) => !x.includes("@")) || i.names[0];
    if (/arigami|ingress-nginx|oven\/bun/.test(name)) console.log(`${(i.sizeBytes / 1e6).toFixed(0).padStart(6)} MB  ${name}`); }'
for ns in "$A_NS" "$B_NS"; do echo "$ns /data: $(inpod "$ns" du -sh /data 2>/dev/null | cut -f1)"; done

step "summary"
if [ "$FAILED" = 0 ]; then echo "ALL CHECKS PASSED"; else echo "$FAILED CHECK(S) FAILED"; fi
echo "evidence: $OUT"
exit "$FAILED"
