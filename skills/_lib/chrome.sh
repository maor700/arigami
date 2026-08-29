#!/usr/bin/env bash
# Open Chrome on THIS session's own desktop and Chrome profile (T8).
#
# Why not just launch google-chrome yourself: every session gets its own
# Xvfb+VNC desktop, allocated lazily on first use, and its own
# <ARIGAMI_DIR>/chrome-sessions/<id> profile cloned from the shared
# <ARIGAMI_DIR>/chrome-base/ (ARIGAMI_DIR defaults to ~/.arigami) (a shared --user-data-dir can't work — Chrome locks
# the profile, so two sessions running Chrome at once would collide). This
# helper asks the host to do both, then hands back the DISPLAY it ran on.
#
# Usage:
#   skills/_lib/chrome.sh [url]     open (or focus) this session's Chrome
#   skills/_lib/chrome.sh --sync    sync cookies/logins back to chrome-base now
#                                    (also happens automatically after a
#                                    request_screen takeover and at session end)
#
# Never `pkill chrome` / `pkill -f chrome` — that would kill OTHER sessions'
# browsers too. This session's instance is torn down by the host at
# archive/delete; you don't need to (and don't have a clean way to) kill it
# yourself.
set -euo pipefail

HOST="${ARIGAMI_URL:-http://127.0.0.1:3099}"
# C1: per-session bearer token injected by the host (empty = auth off).
AUTH=(-H "Authorization: Bearer ${ARIGAMI_TOKEN:-}")
SID="${ARIGAMI_SESSION_ID:?ARIGAMI_SESSION_ID not set — run inside a host session}"

json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

if [ "${1:-}" = "--sync" ]; then
  curl -sf "${AUTH[@]}" -X POST "$HOST/__api/sessions/$SID/browser/sync-logins" \
    -H 'content-type: application/json' -d '{}'
  exit 0
fi

URL="${1:-}"
if [ -n "$URL" ]; then
  BODY="{\"url\":\"$(json_escape "$URL")\"}"
else
  BODY='{}'
fi
curl -sf "${AUTH[@]}" -X POST "$HOST/__api/sessions/$SID/browser" \
  -H 'content-type: application/json' -d "$BODY"
