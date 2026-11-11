#!/usr/bin/env bash
# Remove everything up.sh (and the control plane, and e2e.sh) put into the cluster — and nothing else. The cluster
# itself stays (k3s/k3d/kind lifecycle is yours). Tenant data goes with the tenant namespaces: local-path deletes the
# volumes asynchronously after the PVCs are gone.
#
#   KUBECONFIG=… ./down.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
: "${KUBECONFIG:?set KUBECONFIG to the local cluster — this script never guesses a context}"
export KUBECONFIG
CONTEXT="${KUBE_CONTEXT:-$(kubectl config current-context)}"
K="kubectl --context $CONTEXT"
H="helm --kube-context $CONTEXT"
log() { printf '\n== %s\n' "$*"; }

log "tenants (the ones THIS control plane installed — its own tenants table, nothing else in the cluster)"
# Another control plane may share the cluster and use the same u-<hex> naming, so the namespace list comes from
# this one's sqlite, never from a name pattern.
TENANTS="$($K -n arigami exec arigami-control-plane-0 -- bun -e '
  const { Database } = require("bun:sqlite");
  for (const t of new Database("/data/control-plane.db", { readonly: true }).query("select ns, release from tenants").all())
    console.log(t.ns, t.release);' 2>/dev/null || true)"
[ -n "$TENANTS" ] || echo "  (none, or the control plane is not running — then remove leftover u-* namespaces by hand)"
while read -r ns name; do
  [ -n "$ns" ] || continue
  echo "  $ns/$name"
  $H uninstall "$name" -n "$ns" --wait --timeout 5m >/dev/null 2>&1 || true
  $K delete namespace "$ns" --ignore-not-found --wait=false
  WAIT_NS="${WAIT_NS:-} $ns"
done <<<"$TENANTS"

log "control plane (release, its namespace with the sqlite PVC, the ClusterRole/Binding)"
$H uninstall control-plane -n arigami --wait --timeout 5m 2>/dev/null || true
$K delete namespace arigami e2e-probe idp --ignore-not-found --wait=false

log "CoreDNS rewrite"
if $K -n kube-system get configmap coredns-custom -o jsonpath='{.data}' 2>/dev/null | grep -q 'arigami-local.override'; then
  $K -n kube-system patch configmap coredns-custom --type json -p '[{"op":"remove","path":"/data/arigami-local.override"}]'
  # Drop the ConfigMap only if that was the only key in it (k3s/k3d create none of their own).
  LEFT="$($K -n kube-system get configmap coredns-custom -o jsonpath='{.data}')"
  if [ -z "$LEFT" ] || [ "$LEFT" = "{}" ]; then $K -n kube-system delete configmap coredns-custom; fi
  $K -n kube-system rollout restart deployment/coredns >/dev/null
fi
COREFILE="$($K -n kube-system get configmap coredns -o jsonpath='{.data.Corefile}')"
if grep -q 'arigami-local:begin' <<<"$COREFILE"; then
  NEW="$(awk '/# arigami-local:begin/{skip=1} !skip{print} /# arigami-local:end/{skip=0}' <<<"$COREFILE")"
  $K -n kube-system create configmap coredns --from-literal=Corefile="$NEW" --dry-run=client -o yaml | $K apply -f -
  $K -n kube-system rollout restart deployment/coredns >/dev/null
fi

log "ingress-nginx"
$H uninstall ingress-nginx -n ingress-nginx --wait --timeout 5m 2>/dev/null || true
$K delete namespace ingress-nginx --ignore-not-found --wait=false

log "waiting for the namespaces to go"
for ns in ${WAIT_NS:-} arigami idp ingress-nginx e2e-probe; do
  $K wait --for=delete "namespace/$ns" --timeout=300s 2>/dev/null || true
done
$K get ns
echo "(PersistentVolumes left behind, if any, are being reclaimed by the provisioner:)"
$K get pv 2>/dev/null || true
