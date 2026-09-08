#!/usr/bin/env bash
# Shared helper for the connect-* playbooks (S3 / JIT setup).
#
# Every connect-* skill drives THIS session's own Chrome through the same few
# primitives, so the security rules live in one place:
#   - navigation only inside the playbook's DOMAIN ALLOWLIST (CONNECT_ALLOW),
#   - the agent NEVER types passwords / 2FA / OTP codes — a login form is the
#     take-over boundary (request_screen); `type` refuses secret-looking input
#     only heuristically, the rule is enforced by the playbook, not here,
#   - one evidence screenshot at the end, published as an artifact,
#   - the result reported to the host with report_setup (MCP) or the REST twin.
#
# screen-agnostic (server/lib/screen-driver.ts): `open`/`nav`/`type`/`click`/
# `shot` all go through the host's CDP-backed browser REST
# (server/lib/browser-actions.ts, the same code behind the browser_* MCP
# tools) instead of typing into the X11 root window or scrot-ing the desktop.
# That works whether this session's desktop is Xvfb+VNC (server today) or a
# real native window later (a mac/Windows app) — CDP talks to the Chrome
# TAB, not the screen. Only `key` (a raw key combo with no page-level CDP
# equivalent, e.g. alt+Tab) still falls back to xinput.py/XTEST, and only
# when this session actually has a desktop (`$DISPLAY` set) — it fails with
# a clear message otherwise, it does not silently no-op.
#
# Usage:
#   connect.sh open  <url>                 allowlist-check, then POST /browser/open: ensures the
#                                          session's Chrome exists and is showing <url> — a fresh
#                                          Chrome starts on it, an already-running one is navigated
#                                          there (never "already running, URL ignored" (F6))
#   connect.sh nav   <url>                 allowlist-check, then POST /browser/navigate (CDP Page.navigate)
#   connect.sh url                         print the current tab URL (from the profile's History db)
#   connect.sh wait-url <regex> [secs]     poll until the current URL matches (default 60s); prints it; exit 1 on timeout
#   connect.sh allowed <url>               exit 0 if the host of <url> is in CONNECT_ALLOW, else 1
#   connect.sh shot  [name]                CDP screenshot of the front TAB (not the desktop) → prints the PNG path (view it with Read)
#   connect.sh click <x> <y>               POST /browser/click (CDP, viewport coordinates)
#   connect.sh type  <text>                POST /browser/type (CDP Input.insertText; refuses password/OTP/CAPTCHA fields)
#   connect.sh key   <combo>               xinput.py/XTEST fallback for a raw key combo — needs $DISPLAY, no CDP equivalent
#   connect.sh api   <METHOD> <path> [json]   authenticated call to the host REST (prints body)
#   connect.sh report <capability> <ok|fail> [evidence-path] [detail]
#                                          POST /__api/setup/<capability>/report — the REST twin of report_setup
#
# Env: CONNECT_ALLOW — space-separated domain allowlist (a domain matches itself and
#      its subdomains); every playbook exports its own before calling open/nav.
#      ARIGAMI_URL / ARIGAMI_TOKEN / ARIGAMI_SESSION_ID / ARIGAMI_DIR — set by the host.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST="${ARIGAMI_URL:-http://127.0.0.1:3099}"
AUTH=(-H "Authorization: Bearer ${ARIGAMI_TOKEN:-}" -H "X-Arigami-Session: ${ARIGAMI_SESSION_ID:-}")
SID="${ARIGAMI_SESSION_ID:?ARIGAMI_SESSION_ID not set — run inside a host session}"
ADIR="${ARIGAMI_DIR:-$HOME/.arigami}"
PROFILE="$ADIR/chrome-sessions/$SID"
XI="$HERE/xinput.py"
# Screenshots go to /tmp, NOT $ARIGAMI_DIR — publish_artifact refuses the state dir.
SHOTS="${TMPDIR:-/tmp}/connect-$SID"

die() { echo "connect: $*" >&2; exit 1; }

esc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

# One authenticated call to the host REST; prints the raw response body (no
# trailing newline — callers that echo it add their own).
api_call() {
  local m="$1" p="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -sS "${AUTH[@]}" -X "$m" "$HOST$p" -H 'content-type: application/json' -d "$body"
  else
    curl -sS "${AUTH[@]}" -X "$m" "$HOST$p"
  fi
}

# POST {url} or {text} or {x,y} to a browser/<action> route and die with the
# response body when it doesn't come back {"ok":true} — every nav/type/click
# call below shares this so a policy 403 or a needsHuman refusal fails loudly
# instead of the playbook sailing on as if it had worked.
browser_call() {
  local action="$1" body="$2" resp
  resp="$(api_call POST "/__api/sessions/$SID/browser/$action" "$body")"
  printf '%s' "$resp" | grep -q '"ok":true' || die "$action failed: $resp"
  printf '%s\n' "$resp"
}

host_of() { printf '%s' "$1" | sed -E 's#^[a-zA-Z]+://##; s#[/?\#].*$##; s#^[^@]*@##; s#:[0-9]+$##' | tr 'A-Z' 'a-z'; }

allowed() {
  local h; h="$(host_of "$1")"
  [ -n "$h" ] || return 1
  local d
  for d in ${CONNECT_ALLOW:-}; do
    d="$(printf '%s' "$d" | tr 'A-Z' 'a-z')"
    [ "$h" = "$d" ] && return 0
    case "$h" in *."$d") return 0 ;; esac
  done
  return 1
}

require_allowed() {
  [ -n "${CONNECT_ALLOW:-}" ] || die "CONNECT_ALLOW is empty — export the playbook's domain allowlist first"
  allowed "$1" || die "refusing to open $(host_of "$1") — not in allowlist [${CONNECT_ALLOW}]"
}

current_url() {
  # Chrome commits every navigation to Default/History right away (the SNSS
  # session file, by contrast, is flushed lazily and can lag by minutes). The
  # DB is locked while Chrome runs, so read a copy with python's sqlite3; fall
  # back to the newest URL string in the session file if that fails. The
  # playbook still confirms visually with `shot`.
  local h="$PROFILE/Default/History" u=""
  if [ -f "$h" ]; then
    u="$(python3 - "$h" 2>/dev/null <<'PY' || true
import shutil, sqlite3, sys, tempfile, os
src = sys.argv[1]
d = tempfile.mkdtemp()
try:
    dst = os.path.join(d, 'h.db'); shutil.copyfile(src, dst)
    c = sqlite3.connect(dst)
    r = c.execute('select url from urls order by last_visit_time desc limit 1').fetchone()
    print(r[0] if r else '')
finally:
    shutil.rmtree(d, ignore_errors=True)
PY
)"
  fi
  if [ -z "$u" ]; then
    local f
    f="$(ls -t "$PROFILE"/Default/Sessions/Session_* 2>/dev/null | head -1 || true)"
    [ -n "$f" ] && u="$(strings "$f" | grep -E '^https?://' | tail -1 || true)"
  fi
  printf '%s\n' "$u"
}

cmd="${1:-}"; shift || true
case "$cmd" in
  allowed) allowed "${1:?url}" ;;
  open)
    url="${1:?url}"
    require_allowed "$url"
    # open = "ensure Chrome + navigate": browser/open (browserActions.open)
    # does both server-side now — a fresh Chrome starts on $url, an already-
    # running one is CDP-navigated there. No client-side "was it already
    # running?" branch or keyboard fallback needed any more (F6 still holds:
    # never "already running, URL ignored").
    browser_call open "{\"url\":\"$(esc "$url")\"}" ;;
  nav)
    url="${1:?url}"
    require_allowed "$url"
    browser_call navigate "{\"url\":\"$(esc "$url")\"}" >/dev/null ;;
  url) current_url ;;
  wait-url)
    re="${1:?regex}"; secs="${2:-60}"; t=0
    while [ "$t" -lt "$secs" ]; do
      u="$(current_url)"
      if printf '%s' "$u" | grep -Eq "$re"; then echo "$u"; exit 0; fi
      sleep 2; t=$((t+2))
    done
    echo "$(current_url)"; die "wait-url: no match for /$re/ after ${secs}s" ;;
  shot)
    mkdir -p "$SHOTS"
    out="$SHOTS/${1:-shot}-$(date +%s).png"
    resp="$(api_call POST "/__api/sessions/$SID/browser/screenshot" "")"
    b64="$(printf '%s' "$resp" | python3 -c '
import json, sys
try:
    print(json.load(sys.stdin).get("base64") or "")
except Exception:
    print("")')"
    [ -n "$b64" ] || die "shot failed: $resp"
    printf '%s' "$b64" | base64 -d > "$out" || die "shot: could not decode/write $out"
    echo "$out" ;;
  click)
    x="${1:?x}"; y="${2:?y}"
    browser_call click "{\"x\":$x,\"y\":$y}" >/dev/null ;;
  key)
    # No CDP equivalent for a raw key combo (alt+Tab, ctrl+w on the desktop
    # itself, not a page) — this is the one primitive still tied to a real
    # X11 desktop. Fail clearly instead of silently doing nothing when this
    # session has none.
    [ -n "${DISPLAY:-}" ] || die "key: no CDP equivalent for a raw key combo, and DISPLAY is not set — this session has no desktop"
    python3 "$XI" key "${1:?combo}" ;;
  type)
    browser_call type "{\"text\":\"$(esc "${1:?text}")\"}" >/dev/null ;;
  api)
    m="${1:?METHOD}"; p="${2:?path}"; body="${3:-}"
    api_call "$m" "$p" "$body"; echo ;;
  report)
    cap="${1:?capability}"; ok="${2:?ok|fail}"; ev="${3:-}"; detail="${4:-}"
    okj=false; [ "$ok" = "ok" ] && okj=true
    api_call POST "/__api/setup/$(printf '%s' "$cap" | sed 's#/#%2F#g')/report" \
      "{\"ok\":$okj,\"sessionId\":\"$SID\",\"evidence\":\"$(esc "$ev")\",\"detail\":\"$(esc "$detail")\"}"; echo ;;
  *) sed -n '2,30p' "$0"; exit 2 ;;
esac
