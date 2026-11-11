#!/bin/sh
# Register the Playwright MCP for sessions, once, at user scope so every session
# inherits it: headless + no-sandbox for a non-root container, driving the
# image's Chrome/Chromium via CHROME_BIN (the image ships no separate
# Playwright browser). The `playwright-mcp` bin comes from the image's global
# @playwright/mcp install, so no network is needed.
#
# Runs from the entrypoint on every start (a no-op once registered, or while
# claude isn't installed yet) and as ARIGAMI_CLAUDE_POSTINSTALL right after the
# host installs claude into ~/.local on first boot (server/lib/claude-update.js).
command -v claude >/dev/null 2>&1 || exit 0
grep -q '"playwright"' "$HOME/.claude.json" 2>/dev/null && exit 0
claude mcp add --scope user playwright -- \
  playwright-mcp --headless --no-sandbox --isolated \
    --executable-path "${CHROME_BIN:-/usr/local/bin/arigami-chrome}" >/dev/null 2>&1 || true
