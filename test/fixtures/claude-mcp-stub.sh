#!/usr/bin/env bash
# A stand-in for the `claude` CLI's `mcp` subcommands. It prints exactly what the
# real 2.1.251 printed in the M1 spike AND writes the same two files the real one
# owns, so both halves of the host's contract can be tested without a vendor, a
# browser or a network:
#
#   $CLAUDE_CONFIG_DIR/.credentials.json  mcpOAuth["<name>|<url hash>"] — the grant
#   $CLAUDE_CONFIG_DIR/.claude.json       mcpServers["<name>"]          — the registration
#
# The url "hash" here is a fixed string: the host only ever matches on the name
# part of the key (and on `serverName`), which is what the spike established.
set -u
CFG="${CLAUDE_CONFIG_DIR:?CLAUDE_CONFIG_DIR not set}"
mkdir -p "$CFG"

edit() { python3 - "$CFG" "$@"; }

sub="${2:-}"
name="${3:-}"

grant_live() {
  edit "$1" <<'PY'
import json, os, sys
cfg, name = sys.argv[1], sys.argv[2]
def load(p):
    try: return json.load(open(os.path.join(cfg, p)))
    except Exception: return {}
creds = load('.credentials.json').get('mcpOAuth', {})
live = any(v.get('serverName') == name and v.get('accessToken') for v in creds.values())
# An http server with no grant is "needs auth"; one carrying an Authorization
# header (the bearer path) is connected without any OAuth at all.
entry = load('.claude.json').get('mcpServers', {}).get(name) or {}
sys.exit(0 if (live or entry.get('headers')) else 1)
PY
}

case "$sub" in
  add)
    # mcp add --transport http <name> <url> -s <scope>
    n="${5:-?}"; url="${6:-?}"
    edit "$n" "$url" <<'PY'
import json, os, sys
cfg, name, url = sys.argv[1], sys.argv[2], sys.argv[3]
p = os.path.join(cfg, '.claude.json')
try: d = json.load(open(p))
except Exception: d = {}
d.setdefault('mcpServers', {})[name] = {'type': 'http', 'url': url}
json.dump(d, open(p, 'w'))
PY
    echo "Added HTTP MCP server $n with URL: $url to ${8:-user} config"
    ;;
  add-json)
    edit "$name" "${4:-{\}}" <<'PY'
import json, os, sys
cfg, name, spec = sys.argv[1], sys.argv[2], sys.argv[3]
p = os.path.join(cfg, '.claude.json')
try: d = json.load(open(p))
except Exception: d = {}
try: entry = json.loads(spec)
except Exception: entry = {'type': 'http'}
d.setdefault('mcpServers', {})[name] = entry
json.dump(d, open(p, 'w'))
PY
    echo "Added HTTP MCP server $name to user config"
    ;;
  remove)
    edit "$name" <<'PY'
import json, os, sys
cfg, name = sys.argv[1], sys.argv[2]
for p, key in ((os.path.join(cfg, '.claude.json'), 'mcpServers'), (os.path.join(cfg, '.credentials.json'), 'mcpOAuth')):
    try: d = json.load(open(p))
    except Exception: continue
    if key == 'mcpServers':
        d.get(key, {}).pop(name, None)
    else:
        for k in [k for k, v in d.get(key, {}).items() if v.get('serverName') == name]: d[key].pop(k)
    json.dump(d, open(p, 'w'))
PY
    echo "Removed MCP server \"$name\""
    ;;
  logout)
    edit "$name" <<'PY'
import json, os, sys
cfg, name = sys.argv[1], sys.argv[2]
p = os.path.join(cfg, '.credentials.json')
try: d = json.load(open(p))
except Exception: d = {'mcpOAuth': {}}
for v in d.get('mcpOAuth', {}).values():
    if v.get('serverName') == name: v['accessToken'] = ''
json.dump(d, open(p, 'w'))
PY
    echo "Signed out of \"$name\". Run \`claude mcp login $name\` to authenticate again."
    ;;
  get)
    if grant_live "$name"; then st="✔ Connected"; else st="! Needs authentication"; fi
    printf '%s:\n  Scope: User config (available in all your projects)\n  Status: %s\n  Type: http\n  URL: https://vendor.example/mcp\n' "$name" "$st"
    ;;
  login)
    if [ "${4:-}" != "--no-browser" ]; then echo "error: this stub only implements --no-browser" >&2; exit 2; fi
    printf 'Starting authentication for "%s"…\n' "$name"
    printf 'Visit this URL to authorize:\n  https://vendor.example/authorize?client_id=stub&state=xyz&redirect_uri=http%%3A%%2F%%2Flocalhost%%3A3118%%2Fcallback\n\n'
    printf 'Waiting for authorization… (^C to cancel)\n'
    printf 'Or paste the redirect URL here: '
    IFS= read -r pasted || exit 1
    case "$pasted" in
      *code=bad*) printf '\nAuthentication failed: the authorization code was rejected\n'; exit 1 ;;
      *code=?*)
        edit "$name" <<'PY'
import json, os, sys
cfg, name = sys.argv[1], sys.argv[2]
p = os.path.join(cfg, '.credentials.json')
try: d = json.load(open(p))
except Exception: d = {}
d.setdefault('mcpOAuth', {})[name + '|fe1382f86795a9ab'] = {
    'serverName': name, 'serverUrl': 'https://vendor.example/mcp',
    'accessToken': 'stub-access', 'refreshToken': 'stub-refresh',
}
json.dump(d, open(p, 'w'))
PY
        printf '\nAuthenticated with "%s". Its tools are now available in Claude Code.\n' "$name" ;;
      *) printf '\nAuthentication failed: that is not a valid redirect URL\n'; exit 1 ;;
    esac
    ;;
  list)
    echo "Checking MCP server health…"
    echo
    edit <<'PY'
import json, os, sys
cfg = sys.argv[1]
try: d = json.load(open(os.path.join(cfg, '.claude.json')))
except Exception: d = {}
try: creds = json.load(open(os.path.join(cfg, '.credentials.json'))).get('mcpOAuth', {})
except Exception: creds = {}
live = {v.get('serverName') for v in creds.values() if v.get('accessToken')}
for n, sv in sorted(d.get('mcpServers', {}).items()):
    st = '✔ Connected' if (n in live or 'headers' in sv) else '! Needs authentication'
    print(f"{n}: {sv.get('url','?')} (HTTP) - {st}")
PY
    ;;
  *) echo "unknown command '$sub'" >&2; exit 1 ;;
esac
