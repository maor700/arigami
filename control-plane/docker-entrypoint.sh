#!/bin/sh
# Control-plane entrypoint. Unlike the arigami host entrypoint there is no root
# pass here at all: the image runs as uid 1000 throughout, so this can only
# create directories on an already-writable /data — it can never chown it.
#
# Who makes /data writable:
#   Kubernetes — securityContext.fsGroup: 1000 (deploy/helm/arigami-control-plane
#                sets it; the kubelet chowns the volume at mount time).
#   Docker     — chown the volume/bind-mount to 1000:1000 before starting, or
#                run with --user 0:0 once to create it (not recommended).
set -e

DATA_DIR="$(dirname "${CP_DB_PATH:-/data/control-plane.db}")"

# sqlite lives directly in $DATA_DIR; the rest are dirs the service and the
# helm CLI write into and neither creates on demand. Probing with `test -w` is
# not reliable across every volume driver (a macOS bind mount happily reports
# writable and then refuses the write), so just attempt the mkdir and turn a
# failure into an actionable message instead of a bare "Permission denied".
if ! mkdir -p "$DATA_DIR" \
              "${CP_BACKUP_DIR:-/data/backups}" \
              "${HOME:-/data/home}" \
              "${HELM_CACHE_HOME:-/data/.helm/cache}" \
              "${HELM_CONFIG_HOME:-/data/.helm/config}" \
              "${HELM_DATA_HOME:-/data/.helm/data}" 2>/dev/null; then
  echo "control-plane: cannot write under $DATA_DIR as uid $(id -u):$(id -g)." >&2
  echo "  Kubernetes: set securityContext.fsGroup to this uid's group." >&2
  echo "  Docker:     chown the mounted volume to $(id -u):$(id -g) first." >&2
  exit 1
fi

exec "$@"
