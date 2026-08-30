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
ARG TARGETARCH

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

# --- Desktop stack (B2 / spec §7.3): the host's global-desktop autostart
#     (server/lib/desktops.ts) spawns Xvfb :99 + openbox + tint2 + x11vnc on
#     loopback at boot, and per-session desktops on demand. No supervisord,
#     no systemd — the host process owns them. dbus-x11 gives Chrome a session
#     bus; fonts-noto(+emoji) cover the scripts/emoji the agent screenshots. ---
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb x11vnc openbox tint2 x11-utils xauth dbus-x11 \
      fonts-noto-core fonts-noto-color-emoji fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

# --- Browser (spec §7.4): Google Chrome on amd64 (official deb), Chromium on
#     arm64 (Google ships no arm64 deb). Both land behind one stable path so
#     CHROME_BIN is arch-independent. Chrome runs with --no-sandbox as the
#     non-root user; server/lib/chrome.ts adds that flag when /.dockerenv exists. ---
RUN set -eux; \
    apt-get update; \
    if [ "$TARGETARCH" = "amd64" ]; then \
      curl -fsSLo /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb; \
      apt-get install -y --no-install-recommends /tmp/chrome.deb; \
      rm -f /tmp/chrome.deb; \
      ln -sf /usr/bin/google-chrome-stable /usr/local/bin/arigami-chrome; \
    else \
      apt-get install -y --no-install-recommends chromium; \
      ln -sf /usr/bin/chromium /usr/local/bin/arigami-chrome; \
    fi; \
    rm -rf /var/lib/apt/lists/*; \
    /usr/local/bin/arigami-chrome --version
ENV CHROME_BIN=/usr/local/bin/arigami-chrome

# --- Bun (the host's own runtime) — the static binary from the official image
#     (~95MB; the `bun` npm package weighs 350MB+ once unpacked). ---
COPY --from=oven/bun:1-debian /usr/local/bin/bun /usr/local/bin/bun
RUN ln -s /usr/local/bin/bun /usr/local/bin/bunx && bun --version

# --- Claude Code CLI (pinned to match local; bin → /usr/local/bin/claude) ---
RUN npm install -g @anthropic-ai/claude-code@2.1.196 && claude --version \
    && npm cache clean --force && rm -rf /root/.npm

# --- Playwright MCP + ffmpeg (visual ticket skills: screenshots/GIFs).
#     No bundled Playwright Chromium: the MCP is registered by the entrypoint
#     with `--executable-path $CHROME_BIN`, so it drives the same Chrome/
#     Chromium as the desktop (saves ~700MB vs `playwright install --with-deps`). ---
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g playwright @playwright/mcp \
    && npm cache clean --force && rm -rf /root/.npm

# --- whatsapp-mcp (Baileys bridge the host spawns via `npx tsx`; B2). Cloned
#     at build time at a pinned commit so the image is reproducible; `tsx` is
#     installed globally so the first bridge start needs no network. The
#     checkout's auth_info/ is symlinked onto /data by the entrypoint (upstream
#     hardcodes it next to src/); the message DB goes to ARIGAMI_WA_DATA_DIR. ---
ARG WHATSAPP_MCP_REPO=https://github.com/jlucaso1/whatsapp-mcp-ts
ARG WHATSAPP_MCP_REF=ce9b144a2327d44f4288ee400503e2dc06c7d2d5
RUN set -eux; \
    git init -q /opt/whatsapp-mcp; \
    cd /opt/whatsapp-mcp; \
    git remote add origin "$WHATSAPP_MCP_REPO"; \
    git fetch -q --depth 1 origin "$WHATSAPP_MCP_REF"; \
    git checkout -q FETCH_HEAD; \
    rm -rf .git; \
    npm install --omit=dev --no-audit --no-fund --ignore-scripts=false --engine-strict=false; \
    npm cache clean --force; \
    npm install -g tsx; \
    npm cache clean --force; rm -rf /root/.npm; \
    rm -rf auth_info data; \
    chown -R node:node /opt/whatsapp-mcp

WORKDIR /app

# --- host server deps (public registry only — no private packages needed).
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
#     Every path below is read from env by server/lib/config.ts + state.ts.
#     DISPLAY/ARIGAMI_SCREEN_ENABLED/ARIGAMI_GLOBAL_DESKTOP=1 turn on the global
#     desktop autostart (=1 opts in although /data/.arigami is not ~/.arigami);
#     ARIGAMI_WA_* point the WhatsApp bridge at the build-time checkout and at
#     the volume for its DB. ---
ENV HOME=/data/home \
    ARIGAMI_PORT=3099 \
    ARIGAMI_DIR=/data/.arigami \
    ARIGAMI_STATE_FILE=/data/.arigami/state.json \
    ARIGAMI_CHAT_DIR=/data/.arigami/chat \
    ARIGAMI_REPOS_DIR=/data/repos \
    ARIGAMI_DEFAULT_CWD=/data/repos \
    ARIGAMI_SCREEN_ENABLED=1 \
    ARIGAMI_GLOBAL_DESKTOP=1 \
    DISPLAY=:99 \
    ARIGAMI_WA_MCP_DIR=/opt/whatsapp-mcp \
    ARIGAMI_WA_DATA_DIR=/data/.arigami/whatsapp/data

# --- non-root user. Claude Code REFUSES bypassPermissions/--dangerously-skip-
#     permissions when uid=0, and that's arigami's default session mode — so
#     the host (and every claude it spawns) must run as a normal user. The
#     `node` base image already ships a uid-1000 `node` user; reuse it. The
#     entrypoint stays root only long enough to chown the mounted volume, then
#     drops to `node` via gosu. ---

COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

VOLUME ["/data"]
EXPOSE 3099
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["bun", "server/index.ts"]
