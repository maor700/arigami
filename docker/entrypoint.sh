#!/bin/sh
# arigami container entrypoint. Two-pass when it starts as root:
#   pass 1 (root)  — system dbus, own the mounted /data volume, re-exec as `node`
#   pass 2 (node)  — wire git auth from env, exec the host
# Running as non-root is mandatory: Claude Code refuses bypassPermissions (the
# host's default session mode) when uid=0.
#
# It is also valid — and, on a cluster that enforces the `restricted` Pod
# Security Standard, REQUIRED — to start this container as uid 1000 directly,
# with no root pass at all. Then only the prelude below runs and the volume
# must already be writable by that uid: Kubernetes does that with
# `securityContext.fsGroup: 1000` (deploy/helm/arigami-tenant sets it), Docker
# with `--user 1000:1000` on an already-owned volume.
#
# The desktop (Xvfb :99 + openbox + tint2 + x11vnc on 127.0.0.1:5900) is NOT
# started here: the host's global-desktop autostart (server/lib/desktops.ts,
# spec §7.3) spawns and supervises it once the server is up, exactly as it does
# under systemd/launchd. ARIGAMI_GLOBAL_DESKTOP=0 or ARIGAMI_SCREEN_ENABLED=0
# turns that off.
set -e

WA_DIR="${ARIGAMI_WA_MCP_DIR:-/opt/whatsapp-mcp}"
WA_STATE="$ARIGAMI_DIR/whatsapp"

# --- prelude: runs in BOTH passes, and is the only setup a non-root start
#     gets. Everything here must be doable without root and be idempotent.
#     Failures are tolerated: as root they cannot happen, and as an unprivileged
#     user a missing X11 dir only costs the desktop, not the host. ---
mkdir -p "$HOME" "$ARIGAMI_REPOS_DIR" "$ARIGAMI_DIR/chat" "$ARIGAMI_DIR/logs" \
         "$WA_STATE/auth_info" "$WA_STATE/data" 2>/dev/null || true
# X11 socket dir for Xvfb/Chrome. 1777 is what a root pass sets; a non-root
# start creates it owned by itself, which is enough for a single-user container.
mkdir -p /tmp/.X11-unix 2>/dev/null || true
chmod 1777 /tmp/.X11-unix 2>/dev/null || true
# whatsapp-mcp hardcodes its Baileys auth state at <checkout>/auth_info; point
# that at the volume so the WhatsApp login survives image upgrades. The
# checkout is chowned to `node` at build time, so uid 1000 can do this too.
if [ -d "$WA_DIR" ] && [ ! -L "$WA_DIR/auth_info" ]; then
  rm -rf "$WA_DIR/auth_info" 2>/dev/null || true
  ln -s "$WA_STATE/auth_info" "$WA_DIR/auth_info" 2>/dev/null || true
fi

if [ "$(id -u)" = "0" ]; then
  # A system dbus so Chrome/openbox don't log bus errors. Root-only, and
  # purely cosmetic — a non-root start just skips it.
  mkdir -p /run/dbus
  if command -v dbus-daemon >/dev/null 2>&1 && [ ! -e /run/dbus/pid ]; then
    dbus-daemon --system --fork >/dev/null 2>&1 || true
  fi
  # Own the volume once (first boot). Recursive chown is skipped thereafter so
  # large repo trees don't slow every restart; files created by `node` stay owned.
  # Under Kubernetes fsGroup this has already happened at mount time.
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

# --- now running unprivileged (either after the gosu drop, or because the
#     container was started as uid 1000 in the first place) ---
# Hard guard (F3 #3): never run the host as root, whatever went wrong above —
# Claude Code refuses bypassPermissions at uid 0 and every session would fail.
if [ "$(id -u)" = "0" ]; then
  echo "entrypoint: refusing to run the host as root (gosu drop failed)" >&2
  exit 1
fi

# A non-root start cannot chown, so fail loudly and early if the volume is not
# already writable, instead of dying later with a confusing sqlite/git error.
if [ ! -w "$ARIGAMI_DIR" ]; then
  echo "entrypoint: $ARIGAMI_DIR is not writable by uid $(id -u)." >&2
  echo "  Kubernetes: set securityContext.fsGroup to this uid's group." >&2
  echo "  Docker:     start as root once, or chown the volume before mounting." >&2
  exit 1
fi
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
