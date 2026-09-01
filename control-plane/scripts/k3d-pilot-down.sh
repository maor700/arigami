#!/usr/bin/env bash
# K8S-3 §1 — "one command to tear it down": the mirror of k3d-pilot-up.sh.
# Deletes ONLY this pilot's cluster (by name — never a blanket docker prune)
# and the fixture processes it started. The imported image is left in the
# local docker store (delete it yourself with `docker rmi` if you're done with
# it); tenant data dies with the cluster, which is the point of a disposable
# proof.
set -euo pipefail
cd "$(dirname "$0")/.."

CLUSTER="${CLUSTER:-arigami-k8s3}"
RUN_DIR="${RUN_DIR:-$PWD/data/pilot}"

for name in control-plane mock-idp bundle-server; do
  if [ -f "$RUN_DIR/$name.pid" ]; then
    pid="$(cat "$RUN_DIR/$name.pid")"
    kill "$pid" 2>/dev/null && echo "[$name] stopped (pid $pid)" || echo "[$name] not running"
    rm -f "$RUN_DIR/$name.pid"
  fi
done

if k3d cluster get "$CLUSTER" >/dev/null 2>&1; then
  k3d cluster delete "$CLUSTER"
fi

echo "remaining docker containers (should not include $CLUSTER):"
docker ps -a --format '{{.Names}}' | sed 's/^/  /' || true
