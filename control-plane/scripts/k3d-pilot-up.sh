#!/usr/bin/env bash
# K8S-3 §1 — "one command to seed the org config": bring up the whole pilot on
# a DISPOSABLE k3d cluster — cluster, org bundle repo (fixture), bundle file
# server, mock OIDC IdP, and the control-plane itself. The mirror command is
# k3d-pilot-down.sh. For a REAL org there is no script: the "seed" is env
# (docs/CONTROL-PLANE.md "Running it") + the org's actual bundle repo + a real
# IdP client — this script swaps those three for local fixtures, nothing else.
#
# Prereqs: docker, k3d, kubectl, helm on PATH; the arigami image already
# present locally as $IMAGE (built from this repo's Dockerfile — it is not
# publicly pullable yet, docs/K8S.md §5).
#
#   IMAGE=ghcr.io/maor700/arigami:k8s3-a ./k3d-pilot-up.sh
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(cd .. && pwd)"

CLUSTER="${CLUSTER:-arigami-k8s3}"
IMAGE="${IMAGE:-ghcr.io/maor700/arigami:k8s3-a}"
RUN_DIR="${RUN_DIR:-$PWD/data/pilot}"
CP_PORT="${CP_PORT:-18090}"
IDP_PORT="${IDP_PORT:-18091}"
BUNDLE_PORT="${BUNDLE_PORT:-18092}"

mkdir -p "$RUN_DIR"

if ! k3d cluster get "$CLUSTER" >/dev/null 2>&1; then
  k3d cluster create "$CLUSTER" --servers 1 --agents 0 --no-lb \
    --k3s-arg "--disable=metrics-server@server:0" \
    --k3s-arg "--disable=servicelb@server:0" \
    --wait --timeout 180s
fi
k3d image import -c "$CLUSTER" "$IMAGE"

./test/fixtures/make-org-bundle.sh "$RUN_DIR/bundle" "http://host.k3d.internal:$BUNDLE_PORT/fake-org-bundle.git"

start_bg() { # name, cmd...
  local name="$1"; shift
  if [ -f "$RUN_DIR/$name.pid" ] && kill -0 "$(cat "$RUN_DIR/$name.pid")" 2>/dev/null; then
    echo "[$name] already running (pid $(cat "$RUN_DIR/$name.pid"))"; return
  fi
  nohup "$@" > "$RUN_DIR/$name.log" 2>&1 &
  echo $! > "$RUN_DIR/$name.pid"
  echo "[$name] pid $! (log: $RUN_DIR/$name.log)"
}

start_bg bundle-server bun test/fixtures/serve-dir.ts "$RUN_DIR/bundle" "$BUNDLE_PORT"
start_bg mock-idp bun test/fixtures/mock-idp.ts "$IDP_PORT"

CP_ENV=(
  "CP_PORT=$CP_PORT"
  "CP_PUBLIC_URL=http://127.0.0.1:$CP_PORT"
  "CP_DB_PATH=$RUN_DIR/control-plane.db"
  "CP_OIDC_ISSUER=http://127.0.0.1:$IDP_PORT"
  "CP_OIDC_CLIENT_ID=arigami-pilot"
  "CP_OIDC_CLIENT_SECRET=pilot-secret"
  "ALLOWED_EMAIL_DOMAINS=fake-org.test"
  "CP_ORG_DOMAIN=localtest.me"
  "CP_URL_SCHEME=http"
  "CP_IMAGE_REPOSITORY=${IMAGE%:*}"
  "CP_IMAGE_TAG=${IMAGE##*:}"
  "CP_ARIGAMI_BUNDLE=http://host.k3d.internal:$BUNDLE_PORT/fake-org-bundle.git"
  "CP_HELM_CHART_PATH=$ROOT/deploy/helm/arigami-tenant"
  "CP_HELM_EXTRA_VALUES=$ROOT/deploy/helm/arigami-tenant/ci/k8s3-pilot-values.yaml"
  "CP_HELM_TIMEOUT_SEC=300"
  "CP_RECONCILE_SEC=${CP_RECONCILE_SEC:-20}"
  "CP_BACKUP_DIR=$RUN_DIR/backups"
  "CP_BACKUP_INTERVAL_SEC=${CP_BACKUP_INTERVAL_SEC:-0}"
)
start_bg control-plane env "${CP_ENV[@]}" bun src/index.ts
printf '%s\n' "${CP_ENV[@]}" > "$RUN_DIR/cp.env"

echo
echo "pilot up:"
echo "  control-plane  http://127.0.0.1:$CP_PORT   (sign in via the mock IdP; &email=<who>@fake-org.test picks the user)"
echo "  mock IdP       http://127.0.0.1:$IDP_PORT"
echo "  bundle repo    http://host.k3d.internal:$BUNDLE_PORT/fake-org-bundle.git (from inside the cluster)"
echo "  CLI            env \$(cat $RUN_DIR/cp.env) bun src/cli.ts tenants"
