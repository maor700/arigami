#!/usr/bin/env bash
# Shared helper for the connect-* playbooks (S3 / JIT setup).
#
# Every connect-* skill drives THIS session's own Chrome (skills/_lib/chrome.sh)
# through the same few primitives, so the security rules live in one place:
#   - navigation only inside the playbook's DOMAIN ALLOWLIST (CONNECT_ALLOW),
#   - the agent NEVER types passwords / 2FA / OTP codes — a login form is the
#     take-over boundary (request_screen); `type` refuses secret-looking input
#     only heuristically, the rule is enforced by the playbook, not here,
#   - one evidence screenshot at the end, published as an artifact,
#   - the result reported to the host with report_setup (MCP) or the REST twin.
#
# Usage:
#   connect.sh open  <url>                 allowlist-check, then open in the session Chrome
#   connect.sh nav   <url>                 allowlist-check, then Ctrl+L / type / Enter in the running Chrome
#   connect.sh url                         print the current tab URL (from the profile's session file)
#   connect.sh wait-url <regex> [secs]     poll until the current URL matches (default 60s); prints it; exit 1 on timeout
#   connect.sh allowed <url>               exit 0 if the host of <url> is in CONNECT_ALLOW, else 1
#   connect.sh shot  [name]                scrot of the session desktop → prints the PNG path (view it with Read)
#   connect.sh click <x> <y> | key <combo> | type <text>    → xinput.py on this desktop
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
AUTH=(-H "Authorization: Bearer ${ARIGAMI_TOKEN:-}")
SID="${ARIGAMI_SESSION_ID:?ARIGAMI_SESSION_ID not set — run inside a host session}"
ADIR="${ARIGAMI_DIR:-$HOME/.arigami}"
PROFILE="$ADIR/chrome-sessions/$SID"
XI="$HERE/xinput.py"
# Screenshots go to /tmp, NOT $ARIGAMI_DIR — publish_artifact refuses the state dir.
SHOTS="${TMPDIR:-/tmp}/connect-$SID"

die() { echo "connect: $*" >&2; exit 1; }

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
    require_allowed "${1:?url}"
    "$HERE/chrome.sh" "$1"; echo ;;
  nav)
    require_allowed "${1:?url}"
    "$HERE/chrome.sh" >/dev/null  # make sure Chrome is up + focused
    sleep 0.5
    python3 "$XI" key ctrl+l && python3 "$XI" type "$1" && python3 "$XI" key Return ;;
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
    [ -n "${DISPLAY:-}" ] || die "DISPLAY not set — this session has no desktop yet"
    mkdir -p "$SHOTS"
    out="$SHOTS/${1:-shot}-$(date +%s).png"
    scrot -o "$out" >/dev/null 2>&1 || import -window root "$out"
    echo "$out" ;;
  click) python3 "$XI" click "${1:?x}" "${2:?y}" "${3:-1}" ;;
  key)   python3 "$XI" key "${1:?combo}" ;;
  type)  python3 "$XI" type "${1:?text}" ;;
  api)
    m="${1:?METHOD}"; p="${2:?path}"; body="${3:-}"
    if [ -n "$body" ]; then
      curl -sS "${AUTH[@]}" -X "$m" "$HOST$p" -H 'content-type: application/json' -d "$body"
    else
      curl -sS "${AUTH[@]}" -X "$m" "$HOST$p"
    fi; echo ;;
  report)
    cap="${1:?capability}"; ok="${2:?ok|fail}"; ev="${3:-}"; detail="${4:-}"
    okj=false; [ "$ok" = "ok" ] && okj=true
    esc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
    curl -sS "${AUTH[@]}" -X POST "$HOST/__api/setup/$(printf '%s' "$cap" | sed 's#/#%2F#g')/report" \
      -H 'content-type: application/json' \
      -d "{\"ok\":$okj,\"sessionId\":\"$SID\",\"evidence\":\"$(esc "$ev")\",\"detail\":\"$(esc "$detail")\"}"; echo ;;
  *) sed -n '2,30p' "$0"; exit 2 ;;
esac
