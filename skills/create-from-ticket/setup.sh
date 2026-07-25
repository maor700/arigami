#!/bin/bash
# Skill-invoked variant of .claude/hooks/worktree-setup.sh with collision-free port assignment.
# Used by the worktree-setup skill. Do NOT replace the upstream hook with this — the upstream
# hook fires on session start automatically; this script is invoked explicitly by the skill so
# it can capture output and run the bump-on-collision logic.
#
# Reads JSON from stdin like the upstream hook (e.g. `{"cwd":"/path/to/wt"}`).
set -e
exec >&2

INPUT=$(cat)
WT_DIR=$(echo "$INPUT" | sed -n 's/.*"cwd":"\([^"]*\)".*/\1/p')
WT_DIR="${WT_DIR:-$CLAUDE_PROJECT_DIR}"

# Shared workspace config (port pools, paths). Dual-mode, same as the skills:
#   - workspace root (app/login): nearest `app/` ancestor of the worktree.
#   - config file: $CLAUDE_PLUGIN_ROOT when running as a plugin, else walk up
#     from the worktree to the in-repo .claude/skills/_lib/config.sh.
if [ -z "${ACME_WORKSPACE_ROOT:-}" ]; then
  _d="$WT_DIR"; while [ "$_d" != / ] && [ ! -d "$_d/app" ]; do _d="$(dirname "$_d")"; done
  [ -d "$_d/app" ] && export ACME_WORKSPACE_ROOT="$_d"
fi
_CFG="${CLAUDE_PLUGIN_ROOT:+$CLAUDE_PLUGIN_ROOT/skills/_lib/config.sh}"
[ -f "$_CFG" ] || _CFG="$(_d="$WT_DIR"; while [ "$_d" != / ] && [ ! -f "$_d/.claude/skills/_lib/config.sh" ]; do _d="$(dirname "$_d")"; done; echo "$_d/.claude/skills/_lib/config.sh")"
# shellcheck source=/dev/null
source "$_CFG"

MAIN_WORKTREE=$(git -C "$WT_DIR" worktree list --porcelain | head -1 | sed 's/^worktree //')
if [ "$WT_DIR" = "$MAIN_WORKTREE" ]; then
  echo "Refusing to run in main worktree ($MAIN_WORKTREE)"
  exit 0
fi

cd "$WT_DIR"

# Reuse existing assignment if everything's already in place
if [ -d "node_modules" ] && [ -f ".env.local" ] && [ -f ".env.development.local" ]; then
  . ./.env.development.local 2>/dev/null
  echo "Dev port: ${DEV_PORT:-3000}, Storybook port: ${STORYBOOK_PORT:-6006}"
  exit 0
fi

# 1. Assign ports from a fixed pool (lowest-free wins). The pool is small and stable so that
#    cookies (which Chrome keys by origin = scheme+host+port) persist across worktrees that
#    happen to reuse the same port — that lets the login skill skip the auth flow on warm-cache
#    runs instead of re-logging-in every worktree.
DEV_POOL_START="${DEV_PORT_POOL%-*}"
DEV_POOL_END="${DEV_PORT_POOL#*-}"
SB_POOL_START="${STORYBOOK_PORT_POOL%-*}"
SB_POOL_END="${STORYBOOK_PORT_POOL#*-}"

# Portable listener probe: lsof on macOS/Linux, netstat on Windows (Git Bash
# has no lsof, but netstat.exe is always there).
is_port_free() {
  if command -v lsof >/dev/null 2>&1; then
    ! lsof -nP -i :"$1" -sTCP:LISTEN >/dev/null 2>&1
  else
    ! netstat -ano -p tcp 2>/dev/null | grep -qE "[:.]$1[[:space:]].*LISTENING"
  fi
}

DEV_PORT=""
for p in $(seq "$DEV_POOL_START" "$DEV_POOL_END"); do
  if is_port_free "$p"; then DEV_PORT=$p; break; fi
done
if [ -z "$DEV_PORT" ]; then
  echo "All dev ports in pool $DEV_POOL_START-$DEV_POOL_END are in use. Tear down an idle worktree (reply 'close' to its ship-summary DM) and retry." >&2
  exit 1
fi

STORYBOOK_PORT=""
for p in $(seq "$SB_POOL_START" "$SB_POOL_END"); do
  if is_port_free "$p"; then STORYBOOK_PORT=$p; break; fi
done
if [ -z "$STORYBOOK_PORT" ]; then
  echo "All storybook ports in pool $SB_POOL_START-$SB_POOL_END are in use. Tear down an idle worktree first." >&2
  exit 1
fi

cat >.env.development.local <<EOF
DEV_PORT=$DEV_PORT
STORYBOOK_PORT=$STORYBOOK_PORT
EOF
echo "Assigned ports — dev: $DEV_PORT, storybook: $STORYBOOK_PORT"

# 2. Pull env vars from Vercel
if [ ! -f ".env.local" ]; then
  echo "Linking Vercel project..."
  bunx vercel link -p acme-app -S example-team --yes

  echo "Pulling env vars from Vercel..."
  bunx vercel env pull
fi

# 3. Install dependencies
if [ ! -d "node_modules" ]; then
  echo "Installing dependencies..."
  bun install
fi

# 4. Pre-populate the Chrome-in-Claude MCP allowlist in
# .claude/settings.local.json so the orchestrator / login / locate-ui /
# feedback-loop skills don't prompt for every browser-tool call. Also
# allowlist the Bash helper that assembles screenshot frames into a .gif.
SETTINGS_LOCAL=".claude/settings.local.json"
BROWSER_TOOLS='[
  "mcp__plugin_playwright_playwright__browser_tabs",
  "mcp__plugin_playwright_playwright__browser_navigate",
  "mcp__plugin_playwright_playwright__browser_navigate_back",
  "mcp__plugin_playwright_playwright__browser_snapshot",
  "mcp__plugin_playwright_playwright__browser_take_screenshot",
  "mcp__plugin_playwright_playwright__browser_click",
  "mcp__plugin_playwright_playwright__browser_type",
  "mcp__plugin_playwright_playwright__browser_fill_form",
  "mcp__plugin_playwright_playwright__browser_press_key",
  "mcp__plugin_playwright_playwright__browser_select_option",
  "mcp__plugin_playwright_playwright__browser_hover",
  "mcp__plugin_playwright_playwright__browser_evaluate",
  "mcp__plugin_playwright_playwright__browser_console_messages",
  "mcp__plugin_playwright_playwright__browser_network_requests",
  "mcp__plugin_playwright_playwright__browser_wait_for",
  "mcp__plugin_playwright_playwright__browser_start_video",
  "mcp__plugin_playwright_playwright__browser_stop_video",
  "mcp__plugin_playwright_playwright__browser_close",
  "Bash(.claude/skills/_lib/frames-to-gif.sh:*)",
  "Bash('"$SKILLS_LIB"'/frames-to-gif.sh:*)"
]'

mkdir -p .claude
if [ -f "$SETTINGS_LOCAL" ]; then
  TMP=$(mktemp)
  # Add the Playwright MCP + helper entries; drop stale claude-in-chrome / agent-browser / move-recording entries from older skill versions.
  jq --argjson tools "$BROWSER_TOOLS" \
    '.permissions.allow = (((.permissions.allow // []) + $tools) | unique)
     | .permissions.allow = (.permissions.allow
         | map(select(test("claude-in-chrome|agent-browser|/ab\\.sh|/record-flow\\.sh|/capture-window\\.sh|/move-recording\\.sh") | not)))' \
    "$SETTINGS_LOCAL" >"$TMP" && mv "$TMP" "$SETTINGS_LOCAL"
else
  jq --argjson tools "$BROWSER_TOOLS" -n \
    '{permissions: {allow: $tools}}' >"$SETTINGS_LOCAL"
fi
echo "Wrote Playwright MCP allowlist to $SETTINGS_LOCAL (and pruned stale claude-in-chrome entries)"

# 5. Rename branch: worktree-xxx → xxx
BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [[ "$BRANCH" == worktree-* ]]; then
  BASE="${BRANCH#worktree-}"
  NEW_BRANCH="$BASE"
  SUFFIX=2
  while git show-ref --verify --quiet "refs/heads/$NEW_BRANCH"; do
    NEW_BRANCH="${BASE}-${SUFFIX}"
    SUFFIX=$((SUFFIX + 1))
  done
  git branch -m "$NEW_BRANCH"
  echo "Renamed branch to $NEW_BRANCH"
fi

echo "Worktree setup complete."
