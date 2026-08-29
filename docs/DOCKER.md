# Running arigami in Docker

arigami packages cleanly into one image: a Bun server that serves the cockpit,
the proxy, and the control plane on `:3099`, plus the `claude` CLI + `git` it
shells out to. **All writable state is redirected onto one mounted volume**
(`/data`) via env vars — the image layer itself is read-only.

## Run locally

> HTTPS in front of the container (Let's Encrypt, rate limits): `docker compose --profile tls up` — [TLS.md](TLS.md).

Prereq: Docker Desktop (or colima). Then:

```bash
cp docker/.env.example .env     # set up Claude auth (see the file)
docker compose up --build
open http://localhost:3199/__host/
```

Access it as **`http://localhost:3199`** — the native launchd host
(`com.example.arigami`) owns `:3099`, so the container is mapped to host port **3199**
to avoid the collision (`localhost:3099` = native, `localhost:3199` = container).
Still `localhost`, so it's a secure context: voice (mic) and the proxied your-app
tabs (CORS allowlist is `localhost`) both work — exactly like running it natively.

To check which is which: `lsof -nP -iTCP:3199 -sTCP:LISTEN` shows `ssh`/colima
(the container's port-forward); `:3099` shows `bun` (the native host).

## What's in the image

| Layer | Why |
|-------|-----|
| `node:22` base | provides `node`/`npm` for the dev servers sessions spawn |
| Bun `1.3` | the host's own runtime (`bun server/index.ts`) |
| `@anthropic-ai/claude-code` | the `claude` binary the host spawns per session |
| `git`, `gh`, `ripgrep` | worktrees/diffs, PRs, the agent's file search |
| `web/dist` (built in stage 1) | the cockpit UI |

The host's own deps are all public — the build needs **no** `@buf`/`@fortawesome`
tokens. Those are runtime-only, for when a *session* runs `bun install` inside a
cloned Acme repo; pass them through `.env`.

## State → volume mapping

Everything persists under `/data` (the named volume locally, the PVC in K8s):

| Env var | Path | Holds |
|---------|------|-------|
| `HOME` | `/data/home` | claude config/auth, git config, `~/.arigami-tickets`, ticket colors |
| `ARIGAMI_DIR` | `/data/.arigami` | `config.json`, logs |
| `ARIGAMI_STATE_FILE` | `/data/.arigami/state.json` | session registry, listeners, triggers |
| `ARIGAMI_CHAT_DIR` | `/data/.arigami/chat` | per-session chat transcripts |
| `ARIGAMI_REPOS_DIR` / `ARIGAMI_DEFAULT_CWD` | `/data/repos` | cloned repos + worktrees |

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
K8s-only failure mode), `.env` → a `Secret` mounted as env, and the
Linear/`~/.arigami/linear-oauth.json` seeded into the volume or a Secret after
doing the OAuth flow once. **Ingress/TLS is theirs** — just tell them the
container listens on `3099` and needs HTTPS in front (secure context for voice +
proxy tabs).

## Not yet in the base image: Chrome/Playwright

Visual ticket skills (feedback-loop, screenshots, GIFs) drive a headless Chrome.
That's a heavy layer left out of the base so it builds fast. To add it: switch
the runtime stage to `mcr.microsoft.com/playwright`, and set `shm_size: 1gb`
(compose) / an `emptyDir{medium: Memory}` at `/dev/shm` (K8s) — Chrome crashes on
the default 64MB `/dev/shm`.
