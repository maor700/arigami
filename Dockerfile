# syntax=docker/dockerfile:1

#############################################
# Stage 1 — build the web cockpit (Vite → web/dist)
#############################################
FROM oven/bun:1-debian AS web
WORKDIR /app/web
COPY web/package.json web/bun.lock ./
RUN bun install --frozen-lockfile
COPY web/ ./
RUN bun run build      # → /app/web/dist

#############################################
# Stage 2 — runtime
#############################################
FROM node:22-bookworm-slim AS runtime

# --- OS deps the host + the agent need at runtime ---
#   git      : worktrees / diffs the sessions create
#   ripgrep  : claude's file search
#   curl/ca  : installers + outbound HTTPS
#   procps   : ps/kill used by the watchdog
#   lsof     : background-shell liveness/kill (server/claude.js writerPids)
#   python3  : server/lib/pty-bridge.py, which backs the Accounts "add account"
#              (`claude setup-token`) and MCP-login flows. Without it those
#              buttons fail with a spawn ENOENT — `claude setup-token` run by
#              hand under `docker compose exec -it` still works, since that has
#              a real TTY and needs no bridge.
#   gh        comes from the apt repo below
RUN apt-get update && apt-get install -y --no-install-recommends \
      git curl ca-certificates ripgrep procps lsof python3-minimal less openssh-client gnupg gosu \
    && rm -rf /var/lib/apt/lists/*

# --- GitHub CLI (optional; sessions use it for PRs) ---
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# --- Bun (the host's own runtime) ---
RUN npm install -g bun@1.3 && bun --version

# --- Claude Code CLI (pinned to match local; bin → /usr/local/bin/claude) ---
RUN npm install -g @anthropic-ai/claude-code@2.1.196 && claude --version

# --- Playwright + Chromium + ffmpeg (visual ticket skills: screenshots/GIFs).
#     Additive on the node base (not a base-image swap). `--with-deps` apt-installs
#     Chromium's shared libs. Big layer (~400MB) but cached. Sessions get the
#     Playwright MCP registered at user scope by the entrypoint. ---
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
# Shared browser path so the non-root `node` user (sessions) finds the Chromium
# installed here at build time as root. Persists as runtime ENV too.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npm install -g playwright @playwright/mcp \
    && playwright install --with-deps chromium \
    && chmod -R a+rX /ms-playwright \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# --- host server deps (public registry only — no @buf/@fortawesome needed).
#     NOTE: not --frozen-lockfile — the committed bun.lock drifts from
#     package.json (e.g. @types/node), so frozen aborts both here and locally.
#     Plain install uses the lockfile as a resolution hint and succeeds. ---
COPY package.json bun.lock ./
RUN bun install

# --- app source + built web cockpit ---
COPY server/ ./server/
COPY mcp/ ./mcp/
COPY skills/ ./skills/
COPY profiles/ ./profiles/
COPY bin/ ./bin/
COPY .claude-plugin/ ./.claude-plugin/
COPY tsconfig.json ./
COPY --from=web /app/web/dist ./web/dist

# --- all writable state lives on the mounted volume; nothing in the image layer.
#     Every path below is read from env by server/lib/config.ts + state.ts. ---
ENV HOME=/data/home \
    ARIGAMI_PORT=3099 \
    ARIGAMI_DIR=/data/.arigami \
    ARIGAMI_STATE_FILE=/data/.arigami/state.json \
    ARIGAMI_CHAT_DIR=/data/.arigami/chat \
    ARIGAMI_REPOS_DIR=/data/repos \
    ARIGAMI_DEFAULT_CWD=/data/repos

# --- non-root user. Claude Code REFUSES bypassPermissions/--dangerously-skip-
#     permissions when uid=0, and that's arigami's default session mode — so
#     the host (and every claude it spawns) must run as a normal user. The
#     `node` base image already ships a uid-1000 `node` user; reuse it. The
#     entrypoint stays root only long enough to chown the mounted volume, then
#     drops to `node` via gosu. ---

COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 3099
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["bun", "server/index.ts"]
