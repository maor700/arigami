#!/usr/bin/env bash
# Bring the whole multi-tenant stack up on a plain local cluster (k3s, k3d or kind), idempotently:
#   ingress-nginx (NodePort) -> mock OIDC IdP -> in-cluster DNS for the local names -> the control plane (Helm chart,
#   cluster-scoped RBAC included). Tenants are NOT installed here — the control plane installs one per user at
#   first sign-in, exactly as in the cloud.
#
#   KUBECONFIG=~/.kube/my-local-cluster ./up.sh
#
# Re-running converges (helm upgrade --install / kubectl apply). Mirror: ./down.sh.
# Prereqs: kubectl, helm (3.x), network access to ghcr.io, docker.io, registry.k8s.io and the ingress-nginx chart repo.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

: "${KUBECONFIG:?set KUBECONFIG to the local cluster — this script never guesses a context}"
export KUBECONFIG
CONTEXT="${KUBE_CONTEXT:-$(kubectl config current-context)}"
K="kubectl --context $CONTEXT"
H="helm --kube-context $CONTEXT"

INGRESS_NGINX_VERSION="${INGRESS_NGINX_VERSION:-4.15.1}" # controller 1.15.1
CP_NS=arigami
CP_RELEASE=control-plane

log() { printf '\n== %s\n' "$*"; }

log "cluster: context=$CONTEXT"
$K get nodes -o wide

# --- 1. ingress controller --------------------------------------------------------------------------------------
log "ingress-nginx $INGRESS_NGINX_VERSION (NodePort 30080/30443)"
$H upgrade --install ingress-nginx ingress-nginx \
  --repo https://kubernetes.github.io/ingress-nginx --version "$INGRESS_NGINX_VERSION" \
  --namespace ingress-nginx --create-namespace \
  -f "$HERE/values/ingress-nginx.yaml" --wait --timeout 5m

# --- 2. in-cluster DNS for *.arigami.localtest.me and idp.localtest.me ------------------------------------------
log "CoreDNS rewrite -> ingress-nginx-controller.ingress-nginx.svc"
COREFILE="$($K -n kube-system get configmap coredns -o jsonpath='{.data.Corefile}')"
if grep -q 'import /etc/coredns/custom/\*\.override' <<<"$COREFILE"; then
  # k3s / k3d: CoreDNS imports every *.override key of this ConfigMap. Restarted only when the rules changed — the
  # import is read at start (`reload` watches the Corefile, and the mounted file can take a minute to appear).
  WANT="$($K create --dry-run=client -o jsonpath='{.data.arigami-local\.override}' -f "$HERE/manifests/coredns-custom.yaml")"
  HAVE="$($K -n kube-system get configmap coredns-custom -o jsonpath='{.data.arigami-local\.override}' 2>/dev/null || true)"
  if [ "$WANT" != "$HAVE" ]; then
    $K apply -f "$HERE/manifests/coredns-custom.yaml"
    $K -n kube-system rollout restart deployment/coredns >/dev/null
  fi
elif ! grep -q 'arigami-local:begin' <<<"$COREFILE"; then
  # kind and everything else: splice the same rewrite lines into the main server block, between markers so down.sh
  # can take them out again. (Not exercised on this repo's reference run — that was k3s.)
  RULES="$($K create --dry-run=client -o jsonpath='{.data.arigami-local\.override}' -f "$HERE/manifests/coredns-custom.yaml")"
  NEW="$(awk -v rules="$RULES" '
    !done && /^[[:space:]]*kubernetes / { print "    # arigami-local:begin"; n=split(rules, r, "\n"); for (i=1;i<=n;i++) if (r[i]!="") print "    " r[i]; print "    # arigami-local:end"; done=1 }
    { print }' <<<"$COREFILE")"
  $K -n kube-system create configmap coredns --from-literal=Corefile="$NEW" --dry-run=client -o yaml | $K apply -f -
  $K -n kube-system rollout restart deployment/coredns >/dev/null
fi
$K -n kube-system rollout status deployment/coredns --timeout=120s

# --- 3. mock OIDC IdP -------------------------------------------------------------------------------------------
log "mock IdP (control-plane/test/fixtures/mock-idp.ts) at http://idp.localtest.me"
$K apply -f - <<<"$($K create namespace idp --dry-run=client -o yaml)"
$K -n idp create configmap mock-idp --from-file=mock-idp.ts="$ROOT/control-plane/test/fixtures/mock-idp.ts" \
  --dry-run=client -o yaml | $K apply -f -
$K apply -f "$HERE/manifests/mock-idp.yaml"
# A changed mock-idp.ts must reach the running pod: roll it when the ConfigMap content differs from what it runs.
SUM="$(sha256sum "$ROOT/control-plane/test/fixtures/mock-idp.ts" | cut -c1-16)"
$K -n idp patch deployment mock-idp --type merge \
  -p "{\"spec\":{\"template\":{\"metadata\":{\"annotations\":{\"arigami.dev/code-sha\":\"$SUM\"}}}}}" >/dev/null
$K -n idp rollout status deployment/mock-idp --timeout=180s

# --- 4. control plane -------------------------------------------------------------------------------------------
log "control plane (deploy/helm/arigami-control-plane) in namespace $CP_NS"
$K apply -f - <<<"$($K create namespace $CP_NS --dry-run=client -o yaml)"
# The OIDC client secret, created out of band (existingSecret). The mock IdP ignores it; a real IdP will not.
if ! $K -n $CP_NS get secret arigami-control-plane-oidc >/dev/null 2>&1; then
  $K -n $CP_NS create secret generic arigami-control-plane-oidc \
    --from-literal=CP_OIDC_CLIENT_SECRET="${CP_OIDC_CLIENT_SECRET:-local-mock-idp-ignores-this}"
fi
OVERLAY_ARGS=()
if [ "${CP_SRC_OVERLAY:-0}" = 1 ]; then
  log "CP_SRC_OVERLAY=1: control-plane/src from this checkout, mounted over the image's /app/src"
  $K -n $CP_NS create configmap control-plane-src-overlay --from-file="$ROOT/control-plane/src" \
    --dry-run=client -o yaml | $K apply -f -
  OVERLAY_ARGS=(-f "$HERE/values/cp-src-overlay.yaml")
fi
$H upgrade --install $CP_RELEASE "$ROOT/deploy/helm/arigami-control-plane" \
  --namespace $CP_NS -f "$HERE/values/control-plane.yaml" "${OVERLAY_ARGS[@]}" ${CP_HELM_ARGS:-} --wait --timeout 10m
if [ "${CP_SRC_OVERLAY:-0}" = 1 ]; then
  $K -n $CP_NS rollout restart statefulset/arigami-control-plane >/dev/null # the ConfigMap content is not in the pod spec
else
  $K -n $CP_NS delete configmap control-plane-src-overlay --ignore-not-found >/dev/null
fi
$K -n $CP_NS rollout status statefulset/arigami-control-plane --timeout=300s

# --- 5. smoke: the same URLs the browser uses, from inside the cluster -------------------------------------------
log "in-cluster check: the control plane resolves and reaches the IdP through the ingress"
# Retried: a just-created Ingress takes nginx a few seconds to pick up (404 from the default backend until then).
$K -n $CP_NS exec arigami-control-plane-0 -- bun -e '
  const get = async (u) => { for (let i = 0; ; i++) { const r = await fetch(u).catch(() => null);
    if (r?.ok) return r.json(); if (i > 30) throw new Error(`${u}: ${r?.status}`); await Bun.sleep(2000); } };
  const d = await get("http://idp.localtest.me/.well-known/openid-configuration");
  const h = await get("http://arigami.localtest.me/__health");
  console.log(JSON.stringify({ issuer: d.issuer, cpHealthViaIngress: h }));'

cat <<EOF

Up. From this machine (nothing is exposed beyond 127.0.0.1):

  kubectl port-forward -n ingress-nginx --address 127.0.0.1 svc/ingress-nginx-controller 8080:80

then use 127.0.0.1:8080 as an HTTP proxy, so every URL keeps its real name and port 80:

  curl -x http://127.0.0.1:8080 http://arigami.localtest.me/
  google-chrome --proxy-server=http://127.0.0.1:8080 --user-data-dir=\$(mktemp -d) http://arigami.localtest.me/

The first account to sign in becomes org-admin. Proof run: ./e2e.sh
EOF
