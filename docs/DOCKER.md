# Running arigami in Docker

arigami ships as one image — `ghcr.io/maor700/arigami` (amd64 + arm64) — with
everything a session needs: the Bun host serving the cockpit/proxy/control
plane, the `claude` CLI, `git`/`gh`, a VNC desktop (Xvfb + openbox + x11vnc),
Chrome, Playwright, and the WhatsApp bridge. **All writable state is redirected
onto one mounted volume (`/data`)** via env vars — the image layer itself is
read-only, so upgrading is `pull` + `up`.

## Run

Prereq: Docker (Desktop, colima, or the engine on a VPS). Then:

```bash
cp docker/.env.example .env      # optional: Claude auth, GH_TOKEN (see below)
docker compose up -d             # pulls ghcr.io/maor700/arigami:latest
docker compose logs -f arigami   # prints the one-time pairing code
open http://localhost:3199/__host/
```

The first page asks for the **pairing code** from the logs
(`docker compose logs arigami`, or mint a new one with
`docker compose exec arigami bin/host pair`); that creates the admin and a
session cookie. Then the minimal setup asks for exactly one thing — Claude
auth (see below) — and **Start** opens the first session in the empty
`/data/repos` workspace. Git, WhatsApp, Gmail… connect from the chat when the
agent needs them.

**Settings → Host in a container** shows the image ref (`ARIGAMI_IMAGE`,
stamped by the compose build) and the commit it was built from
(`ARIGAMI_COMMIT` / `ARIGAMI_BRANCH` build args — set them in `.env` when you
build locally), supervisor `docker (restart: unless-stopped)`, and replaces
the git-based *Upgrade* with the two commands that do it here:
`docker compose pull && docker compose up -d`. *Restart* works: the host exits
0 and the restart policy brings the container back.

Pin a version with `ARIGAMI_TAG=0.1.0` (or `sha-<7>`) in `.env`. Tags follow
the release workflow: every push to `master` → `latest` + `sha-…`, every
`vX.Y.Z` tag → `X.Y.Z` + `X.Y`.

Access it as **`http://localhost:3199`** — a natively installed host
(`bin/host install` / systemd) owns `:3099`, so the container listens on and is
mapped to **3199** to avoid the collision. Still `localhost`, so it's a secure
context: voice (mic) and proxied app tabs both work. The port is published on
loopback only; to reach it from other machines use `tailscale serve` or the
HTTPS edge: `docker compose --profile tls up -d` — see [TLS.md](TLS.md).

### Build it yourself

```bash
docker compose --profile build build   # tags ghcr.io/maor700/arigami:latest locally
docker compose up -d
```

Or plain `docker build -t ghcr.io/maor700/arigami:latest .`. Build args:
`WHATSAPP_MCP_REF` (pinned whatsapp-mcp commit), `WHATSAPP_MCP_REPO`.

## Claude auth inside the container

The container has no browser of *yours* and no TTY, so the normal `claude`
login (which opens a localhost callback) can't run there. Three ways, easiest
first — all end up on the `/data` volume:

1. **`CLAUDE_CODE_OAUTH_TOKEN`** in `.env` — run `claude setup-token` once on
   your laptop (Max/Pro subscription), paste the long-lived token. Anthropic's
   documented headless path; no interaction in the container at all.
2. **Cockpit PKCE flow** — open Setup → Claude → *Connect*. The host shows an
   authorize link, you approve it in your own browser, paste the code back;
   the host stores the refresh token in `accounts.json` on the volume and
   refreshes it itself. Works with no TTY and no localhost callback. When the
   approval happens in the **session's own Chrome** (the `connect-claude`
   playbook or a take-over) the host reads the code straight from the
   `…/oauth/code/callback?code=…` tab over the browser's loopback DevTools
   port and finishes the exchange by itself — nothing to paste through VNC.
   "Can't paste? Read the code from the browser" on the card does the same on
   demand, and the take-over modal has a *Type into the desktop* field for any
   other text your clipboard can't carry across.
3. **Interactive fallback** —
   `docker compose exec -it -u node arigami claude setup-token` and follow the
   prompts (the terminal gives it the TTY it needs).

Or skip subscriptions entirely with `ANTHROPIC_API_KEY` (usage-billed). If it
is set it *overrides* the subscription token, so leave it commented otherwise.

## Codex inside the container

Not yet: the image ships no `codex` binary, so the Codex engine and *Connect Codex* do not work in
Docker today. Also not wired: an `OPENAI_API_KEY` in `.env` (the host never reads it; API keys go
through Settings › Connections › Accounts) and a mounted `$CODEX_HOME` (seeded as the `codex-home`
account, but useless without the binary). Untested workaround: a codex release binary on `/data`
plus `ARIGAMI_CODEX_BIN` in `.env`.

## What's in the image

| Layer | Why |
|-------|-----|
| `node:22-bookworm-slim` base | `node`/`npm` for the dev servers sessions spawn |
| Bun `1.3` | the host's own runtime (`bun server/index.ts`) |
| `@anthropic-ai/claude-code` | the `claude` binary the host spawns per session |
| `git`, `gh`, `ripgrep`, `python3` | worktrees/diffs, PRs, file search, the pty bridge for logins |
| `xvfb x11vnc openbox tint2 x11-utils fonts-noto(+emoji) dbus-x11` | the desktop the agent drives (`request_screen`, `machine-work`) |
| Google Chrome (amd64) / Chromium (arm64) → `CHROME_BIN` | the agent's browser on that desktop |
| Playwright MCP (driving `CHROME_BIN`) + ffmpeg | screenshot/GIF skills; no second browser in the image |
| whatsapp-mcp at `/opt/whatsapp-mcp` (+ `tsx`) | the Baileys bridge behind the WhatsApp listener/MCP |
| `web/dist` (built in stage 1) | the cockpit UI |

Not in the image: Tailscale. Run it on the Docker host, or add the official
`tailscale/tailscale` sidecar.

### Desktop + Chrome

Nothing to configure. On boot the host (`ARIGAMI_SCREEN_ENABLED=1`,
`ARIGAMI_GLOBAL_DESKTOP=1`, `DISPLAY=:99` — all set in the image) starts `Xvfb :99`, openbox, tint2 and
`x11vnc` on `127.0.0.1:5900`, supervised like any other child process; per-
session desktops are allocated on demand on top. `request_screen` in the cockpit
shows it. The host, the desktop and Chrome run as the unprivileged `node` user
(uid 1000): the entrypoint starts as root only to own the `/data` volume, then
drops via `gosu` — `docker compose exec arigami ps -eo user,comm` shows `node`
for `bun`/`Xvfb`/`x11vnc`. Note that a plain `docker compose exec` shell is
root (the image sets no `USER` so that first-boot chown can run); use
`docker compose exec -u node arigami …` for anything that touches `/data` or
runs `claude`. Because Chrome runs as `node`, the host adds
`--no-sandbox --disable-dev-shm-usage` automatically when `/.dockerenv` exists;
compose gives it `shm_size: 1gb` and no extra capabilities. Turn the shared
desktop off with `ARIGAMI_GLOBAL_DESKTOP=0`.

### WhatsApp

The bridge is cloned at build time (pinned commit, `ARIGAMI_WA_MCP_DIR=/opt/whatsapp-mcp`).
Its login state (`auth_info/`) is symlinked by the entrypoint onto
`/data/.arigami/whatsapp/auth_info`, and the message DB/status file live in
`ARIGAMI_WA_DATA_DIR=/data/.arigami/whatsapp/data` — so scanning the QR once in
Setup → WhatsApp survives restarts and image upgrades.

## State → volume mapping

Everything persists under `/data` (the named volume locally, the PVC in K8s):

| Env var | Path | Holds |
|---------|------|-------|
| `HOME` | `/data/home` | claude config/auth, git config, Chrome profiles, ticket state |
| `ARIGAMI_DIR` | `/data/.arigami` | `config.json`, `accounts.json`, `run/pairing-code`, logs, chrome-base |
| `ARIGAMI_STATE_FILE` | `/data/.arigami/state.json` | session registry, listeners, triggers |
| `ARIGAMI_CHAT_DIR` | `/data/.arigami/chat` | per-session chat transcripts |
| `ARIGAMI_REPOS_DIR` / `ARIGAMI_DEFAULT_CWD` | `/data/repos` | cloned repos + worktrees |
| `ARIGAMI_WA_DATA_DIR` | `/data/.arigami/whatsapp/data` | WhatsApp message DB + bridge status |
| (symlink) | `/data/.arigami/whatsapp/auth_info` | WhatsApp login |

`docker compose down && up` keeps all of it; `docker volume rm arigami_arigami-data`
is the factory reset.

## Handing it to DevOps (Kubernetes)

The image is the same; only the wrapper differs. Three non-negotiables, because
this is a **stateful singleton**, not a 12-factor service:

1. **`StatefulSet`, `replicas: 1`** — the listeners scheduler (`state.ts`) is a
   singleton and sessions write git worktrees. Two pods on one volume = corruption.
2. **`strategy: Recreate`** (not RollingUpdate) — never run two pods at once,
   even briefly during a deploy.
3. **PVC `ReadWriteOnce` mounted at `/data`** — without it every restart
   re-clones every repo.

Plus: generous memory `requests`/`limits` (8–16Gi — OOMKill mid-task is the #1
K8s-only failure mode), an `emptyDir{medium: Memory}` at `/dev/shm` (Chrome),
`.env` → a `Secret` mounted as env. **Ingress/TLS is theirs** — the container
listens on `3099` by default (`ARIGAMI_PORT`) and needs HTTPS in front (secure
context for voice + proxy tabs); set `ARIGAMI_PUBLIC_URL` to the public origin.
