#!/usr/bin/env bash
# Keep the reverse tunnel to chisel.yaml's server up: local :18090 (the control plane) -> chisel.edge.svc:18090.
# Needs `chisel` (https://github.com/jpillora/chisel) and a kubeconfig that reaches the lab cluster.
#   AUTH_FILE=~/.lab/chisel.auth ./tunnel.sh        # file contains  lab:<secret>
set -euo pipefail
: "${AUTH_FILE:?path to the file holding lab:<secret> (same value as the chisel-auth secret)}"
CP_PORT="${CP_PORT:-18090}"
(while true; do kubectl -n edge port-forward svc/chisel 18080:8080 >/dev/null 2>&1 || true; sleep 2; done) &
sleep 3
exec chisel client --auth "$(cat "$AUTH_FILE")" --keepalive 10s http://127.0.0.1:18080 "R:0.0.0.0:${CP_PORT}:127.0.0.1:${CP_PORT}"
