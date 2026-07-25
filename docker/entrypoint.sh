#!/bin/sh
# arigami container entrypoint. Two-pass:
#   pass 1 (root)  — prepare + own the mounted /data volume, then re-exec as `node`
#   pass 2 (node)  — wire git auth from env, exec the host
# Running as non-root is mandatory: Claude Code refuses bypassPermissions (the
# host's default session mode) when uid=0.
set -e

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$HOME" "$ARIGAMI_REPOS_DIR" "$ARIGAMI_DIR/chat" "$ARIGAMI_DIR/logs"
  # Own the volume once (first boot). Recursive chown is skipped thereafter so
  # large repo trees don't slow every restart; files created by `node` stay owned.
  if [ ! -e /data/.chowned ]; then
    chown -R node:node /data
    touch /data/.chowned
  fi
  # gosu resets HOME to the target user's passwd home (/home/node); force the
  # intended HOME (/data/home, on the volume) so git creds, claude config, and
  # the Playwright MCP registration persist across recreates instead of landing
  # in the ephemeral container layer.
  exec gosu node:node env HOME="$HOME" "$0" "$@"
fi

# --- now running as `node` ---

# Trust the worktrees the agent creates.
git config --global --add safe.directory '*' || true

# Optional: authenticate git/gh to private Acme repos via a token from the env.
if [ -n "$GH_TOKEN" ]; then
  git config --global credential.helper store
  printf 'https://x-access-token:%s@github.com\n' "$GH_TOKEN" > "$HOME/.git-credentials"
  chmod 600 "$HOME/.git-credentials"
fi

# Identity for commits the agent makes (override via GIT_NAME / GIT_EMAIL).
if [ -z "$(git config --global user.email || true)" ]; then
  git config --global user.email "${GIT_EMAIL:-arigami@example.com}"
fi
if [ -z "$(git config --global user.name || true)" ]; then
  git config --global user.name "${GIT_NAME:-Arigami}"
fi

# Register the Playwright MCP for sessions (headless + no-sandbox for a non-root
# container) — once, at user scope so every session inherits it.
if ! grep -q '"playwright"' "$HOME/.claude.json" 2>/dev/null; then
  claude mcp add --scope user playwright -- \
    npx -y @playwright/mcp@latest --headless --no-sandbox --isolated >/dev/null 2>&1 || true
fi

exec "$@"
