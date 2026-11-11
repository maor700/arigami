#!/usr/bin/env bash
# A stand-in for `kubectl -n <ns> exec [-i] <pod> -- gosu node:node <cmd…>`, the
# only kubectl shape the profile rollout uses (src/provisioner.ts
# execInTenant). "The pod" is a real Arigami host on this machine:
# $FAKE_KUBECTL_MAP has one `<ns>=<port>` line per tenant, and the in-pod
# loopback URL 127.0.0.1:$CP_TENANT_PORT is rewritten to that host's port.
set -euo pipefail
[ -n "${FAKE_KUBECTL_LOG:-}" ] && printf '%s\n' "$*" >> "$FAKE_KUBECTL_LOG" # argv only — what `ps` would show
[ "$1" = "-n" ] || { echo "fake kubectl: expected -n <ns>, got: $*" >&2; exit 2; }
ns="$2"; shift 2
[ "$1" = "exec" ] || { echo "fake kubectl: only exec is faked, got: $*" >&2; exit 2; }
shift
[ "$1" = "-i" ] && shift
shift # pod name
[ "$1" = "--" ] && shift
[ "$1" = "gosu" ] && shift 2
port="$(grep -E "^${ns}=" "$FAKE_KUBECTL_MAP" | cut -d= -f2 || true)"
[ -n "$port" ] || { echo "Error from server (NotFound): pods not found in ${ns}" >&2; exit 1; }
args=()
for a in "$@"; do args+=("${a//127.0.0.1:${CP_TENANT_PORT}/127.0.0.1:${port}}"); done
exec "${args[@]}"
