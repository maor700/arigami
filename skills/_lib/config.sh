#!/usr/bin/env bash
# shellcheck disable=SC2034  # vars here are consumed by the scripts that source this file
# Shared workspace config for the Acme frontend skill suite.
#
# Single source of truth for every environment-specific value the skills use:
# repo locations, port pools, the shared-Chrome CDP port, the default reviewer,
# and the per-user helper directories. Skills source this instead of hardcoding
# paths/ports, so the suite is portable across machines and teammates.
#
# Usage (prepend to any bash block that needs these vars — Bash tool shells are
# ephemeral, so each block must source it). The finder is DUAL-MODE so the exact
# same skills work whether they run from this repo or from an installed plugin:
#   1. Plugin mode  → $CLAUDE_PLUGIN_ROOT/skills/_lib/config.sh (Claude Code sets
#                     CLAUDE_PLUGIN_ROOT for plugin-bundled skills/hooks/commands).
#   2. In-repo mode → walk up from $PWD to .claude/skills/_lib/config.sh.
# It's shell-agnostic (no BASH_SOURCE, which zsh leaves empty) and cwd-independent.
#
#   source "$([ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -f "$CLAUDE_PLUGIN_ROOT/skills/_lib/config.sh" ] && echo "$CLAUDE_PLUGIN_ROOT/skills/_lib/config.sh" || { d="$PWD"; while [ "$d" != / ] && [ ! -f "$d/.claude/skills/_lib/config.sh" ]; do d="$(dirname "$d")"; done; echo "$d/.claude/skills/_lib/config.sh"; })"
#
# Override the workspace location (where app/ and login/ live) without editing:
#   export ACME_WORKSPACE_ROOT=~/code/acme     # parent dir containing app/ and login/

# --- Workspace layout --------------------------------------------------------
# WORKSPACE_ROOT is the dir that holds the `app` and `login` clones side by side.
# It is INDEPENDENT of where this config file lives (the plugin install dir is a
# different place entirely). Resolution order:
#   1. ACME_WORKSPACE_ROOT env (explicit override / shell profile).
#   2. Walk up from $PWD to the nearest dir that has an `app/` child — works from
#      the app repo, any worktree, or the workspace root.
#   3. Fall back to $PWD.
if [ -z "${ACME_WORKSPACE_ROOT:-}" ]; then
  _d="$PWD"
  while [ "$_d" != / ] && [ ! -d "$_d/app" ]; do _d="$(dirname "$_d")"; done
  if [ -d "$_d/app" ]; then ACME_WORKSPACE_ROOT="$_d"; else ACME_WORKSPACE_ROOT="$PWD"; fi
  unset _d
fi
WORKSPACE_ROOT="$ACME_WORKSPACE_ROOT"
APP_REPO="$WORKSPACE_ROOT/app"
LOGIN_REPO="$WORKSPACE_ROOT/login"
WORKTREES_DIR="$WORKSPACE_ROOT/app-worktrees"
# Playwright MCP screenshot root — the only dir browser_take_screenshot may
# write to (must live under WORKSPACE_ROOT so the MCP server can reach it).
PW_FRAMES_ROOT="$WORKSPACE_ROOT/.playwright-mcp"
# visual-diff helper scripts (diff.ts etc.)
VISUAL_DIFF_DIR="$WORKSPACE_ROOT/visual-diff"
# Directory holding the suite's _lib helper scripts (frames-to-gif.sh).
# Arigami sessions get ARIGAMI_SKILLS injected by the host's process
# manager; plugin root when running as a plugin; in-repo skills/_lib last.
if [ -n "${ARIGAMI_SKILLS:-}" ] && [ -d "$ARIGAMI_SKILLS/_lib" ]; then
  SKILLS_LIB="$ARIGAMI_SKILLS/_lib"
elif [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -d "$CLAUDE_PLUGIN_ROOT/skills/_lib" ]; then
  SKILLS_LIB="$CLAUDE_PLUGIN_ROOT/skills/_lib"
else
  SKILLS_LIB="$WORKSPACE_ROOT/.claude/skills/_lib"
fi

# --- Ports -------------------------------------------------------------------
# Small, stable pools so Chrome cookies (keyed by scheme+host+port) survive
# across worktrees that reuse a port — lets `login` skip auth on warm runs.
DEV_PORT_POOL="3020-3070"        # `bun run dev` per worktree
STORYBOOK_PORT_POOL="6020-6070"  # `bun run storybook` per worktree
STORYBOOK_DEFAULT_PORT=6006      # Storybook's own default (non-worktree runs)
CHROME_CDP_PORT=9333             # the one shared Chrome all MCP servers attach to

# --- Workflow knobs ----------------------------------------------------------
DEFAULT_REVIEWER="${ACME_DEFAULT_REVIEWER:-}"   # empty => skills require an explicit reviewer arg
LOGIN_METHOD="${ACME_LOGIN_METHOD:-google-sso}" # google-sso | e2e

# --- Per-user helper locations (under $HOME, so already per-user) ------------
# Three DISTINCT dirs — don't conflate the names:
PW_PROFILE_DIR="${ACME_PW_PROFILE_DIR:-$HOME/.playwright-acme}"        # persistent Chromium PROFILE (logged-in session)
PW_HELPER_DIR="${ACME_PW_HELPER_DIR:-$HOME/.acme-playwright}"          # helper SCRIPTS (ensure-browser.sh)
TICKET_COLOR_DIR="${ACME_TICKET_COLOR_DIR:-$HOME/.acme-ticket-color}"  # ticket color allocator (allocator.py, marker.js, tickets/)
PW_MCP_CONFIG="${ACME_PW_MCP_CONFIG:-$HOME/.playwright-mcp-config.json}" # Playwright MCP config (browser.cdpEndpoint)
