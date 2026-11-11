#!/usr/bin/env bash
# Keep the reverse tunnel to chisel.yaml's server up: local :18090 (the control plane) -> chisel.edge.svc:18090.
# Needs `chisel` (https://github.com/jpillora/chisel). The machine only ever dials OUT.
#   AUTH_FILE=~/.lab/chisel.auth TUNNEL_URL=https://tunnel.lab.example.com ./tunnel.sh     # file contains  lab:<secret>
# TUNNEL_URL is the edge's `tunnel.<domain>` name (edge.yaml): HTTPS + websocket, nothing to log in to, nothing to expire.
# Without TUNNEL_URL it falls back to `kubectl port-forward` (needs a kubeconfig that reaches the cluster — and a login
# that stays valid, which is the weak point; prefer TUNNEL_URL).
set -euo pipefail
: "${AUTH_FILE:?path to the file holding lab:<secret> (same value as the chisel-auth secret)}"
CP_PORT="${CP_PORT:-18090}"
if [ -n "${TUNNEL_URL:-}" ]; then
  exec chisel client --auth "$(cat "$AUTH_FILE")" --keepalive 10s "$TUNNEL_URL" "R:0.0.0.0:${CP_PORT}:127.0.0.1:${CP_PORT}"
fi
(while true; do kubectl -n edge port-forward svc/chisel 18080:8080 >/dev/null 2>&1 || true; sleep 2; done) &
sleep 3
exec chisel client --auth "$(cat "$AUTH_FILE")" --keepalive 10s http://127.0.0.1:18080 "R:0.0.0.0:${CP_PORT}:127.0.0.1:${CP_PORT}"
