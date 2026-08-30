#!/bin/sh
# arigami container entrypoint. Two-pass:
#   pass 1 (root)  — prepare + own the mounted /data volume, X11/dbus runtime
#                    dirs, then re-exec as `node`
#   pass 2 (node)  — wire git auth from env, exec the host
# Running as non-root is mandatory: Claude Code refuses bypassPermissions (the
# host's default session mode) when uid=0.
#
# The desktop (Xvfb :99 + openbox + tint2 + x11vnc on 127.0.0.1:5900) is NOT
# started here: the host's global-desktop autostart (server/lib/desktops.ts,
# spec §7.3) spawns and supervises it once the server is up, exactly as it does
# under systemd/launchd. ARIGAMI_GLOBAL_DESKTOP=0 or ARIGAMI_SCREEN_ENABLED=0
# turns that off.
set -e

WA_DIR="${ARIGAMI_WA_MCP_DIR:-/opt/whatsapp-mcp}"
WA_STATE="$ARIGAMI_DIR/whatsapp"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$HOME" "$ARIGAMI_REPOS_DIR" "$ARIGAMI_DIR/chat" "$ARIGAMI_DIR/logs" \
           "$WA_STATE/auth_info" "$WA_STATE/data"
  # X11 socket dir + a system dbus so Chrome/openbox don't log bus errors.
  mkdir -p /tmp/.X11-unix /run/dbus && chmod 1777 /tmp/.X11-unix
  if command -v dbus-daemon >/dev/null 2>&1 && [ ! -e /run/dbus/pid ]; then
    dbus-daemon --system --fork >/dev/null 2>&1 || true
  fi
  # whatsapp-mcp hardcodes its Baileys auth state at <checkout>/auth_info; point
  # that at the volume so the WhatsApp login survives image upgrades.
  if [ -d "$WA_DIR" ] && [ ! -L "$WA_DIR/auth_info" ]; then
    rm -rf "$WA_DIR/auth_info"
    ln -s "$WA_STATE/auth_info" "$WA_DIR/auth_info"
  fi
  # Own the volume once (first boot). Recursive chown is skipped thereafter so
  # large repo trees don't slow every restart; files created by `node` stay owned.
  if [ ! -e /data/.chowned ]; then
    chown -R node:node /data
    touch /data/.chowned
  fi
  chown node:node "$WA_STATE" "$WA_STATE/auth_info" "$WA_STATE/data" 2>/dev/null || true
  # gosu resets HOME to the target user's passwd home (/home/node); force the
  # intended HOME (/data/home, on the volume) so git creds, claude config, and
  # the Playwright MCP registration persist across recreates instead of landing
  # in the ephemeral container layer.
  exec gosu node:node env HOME="$HOME" "$0" "$@"
fi

# --- now running as `node` ---

# Trust the worktrees the agent creates.
git config --global --add safe.directory '*' || true

# Optional: authenticate git/gh to private repos via a token from the env.
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
# container, driving the image's Chrome/Chromium via CHROME_BIN — the image
# ships no separate Playwright browser) — once, at user scope so every session
# inherits it. The `playwright-mcp` bin comes from the global
# @playwright/mcp install, so no network is needed on first use.
if ! grep -q '"playwright"' "$HOME/.claude.json" 2>/dev/null; then
  claude mcp add --scope user playwright -- \
    playwright-mcp --headless --no-sandbox --isolated \
      --executable-path "${CHROME_BIN:-/usr/local/bin/arigami-chrome}" >/dev/null 2>&1 || true
fi

exec "$@"
