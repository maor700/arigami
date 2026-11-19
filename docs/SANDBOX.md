# Sandbox: restricted sessions in a container (standalone installs)

A **restricted** session (one with a profile, see [SECURITY.md § Restricted sessions](SECURITY.md#restricted-sessions-opt-in))
is limited by the host: its tools, whom it talks to, which host routes its token reaches. Without a sandbox it still
runs as the host's OS user, so its shell can read that user's files, use the network and run `sudo`. The sandbox
removes that for standalone installs (Linux, macOS, Windows with Docker):

- **No secrets.** The engine runs in its own container. It gets the restricted env allowlist and a fresh per-session
  `HOME`. The only host paths it sees are its working tree (plus the repo's git dir), its scratch dir, its codex home
  and the read-only Arigami code its engine loads (skills, docs, the policy hook). `$ARIGAMI_DIR`, the owner's home,
  token files, the gatekeeper store and the checkout's `.env` are never mounted.
- **No root.** It runs as a non-root uid with every capability dropped and `no-new-privileges`, from an image without
  `sudo` and with no setuid binaries.
- **No network but the egress proxy.** The container sits on an `--internal` Docker network. Its only peer there is the
  egress container, which does two jobs:
  - a forward proxy that lets through the model API plus the profile's `egress`, and logs every decision;
  - a relay to the host's **sandbox listener**, which accepts a sandboxed session's own token and nothing else.

**Full sessions and the host are not touched.** `wrapSpawn` returns the very spawn the engine driver built when a
session has no profile or the sandbox is off. There is no proxy in a Full session's path. (Bench check R01: Full spawns
are identical.)

It is engine-agnostic. It wraps whatever `buildSpawn` produced (claude, codex app-server, codex exec), and the
session's `ARIGAMI_URL` stays byte-identical. Inside the container a loopback forwarder on the host's port leads to
the relay, so the engine's MCP client, the PreToolUse hook and `curl` in a skill all work unchanged.

## Turn it on

```bash
# 1. the image (engines + bun, no sudo) — from the checkout
docker build -t arigami-sandbox:latest -f docker/sandbox/Dockerfile docker/sandbox
# 2. config.json → "sandbox": { "mode": "docker" }    (or env ARIGAMI_SANDBOX=docker), restart the host
```

The host log then says
`[sandbox] restricted sessions run in containers (…); host relay <addr>, egress <name>`. `GET /__api/sandbox` shows the
same thing: whether the sandbox is ready, the error if it is not, and its names. If the sandbox is on but not ready
(no Docker, no image), restricted sessions **refuse to start** with the reason in their chat. They never fall back to
running on the host.

| config `sandbox.*` | env | default |
|---|---|---|
| `mode` | `ARIGAMI_SANDBOX` | `off` (`docker` = on) |
| `image` | `ARIGAMI_SANDBOX_IMAGE` | `arigami-sandbox:latest` |
| `docker` | `ARIGAMI_SANDBOX_DOCKER` | `docker` (the CLI; `DOCKER_HOST` in the host env picks the daemon) |
| `hostListen` | `ARIGAMI_SANDBOX_HOST_LISTEN` | Linux: the gateway of `<prefix>-out` with any free port. Docker Desktop: `127.0.0.1` |
| `hostTarget` | `ARIGAMI_SANDBOX_HOST_TARGET` | Linux: the same address. Docker Desktop: `host.docker.internal:<port>` |
| `outsideNetwork` | `ARIGAMI_SANDBOX_OUTSIDE_NETWORK` | none: the host creates `<prefix>-out` |
| `subnet` | `ARIGAMI_SANDBOX_SUBNET` | Docker picks |
| `pathMap` | `ARIGAMI_SANDBOX_PATH_MAP` (`from=to,…`) | none (host in a container: see below) |
| `egressBase` / `egressGroups` | | the model APIs / built-in groups |
| `engines` | | `{claude: "claude", codex: "codex"}` on the image's PATH |
| `memory` / `cpus` / `pids` | | `4g` / `2` / `1024` per container |
| `dns` | `ARIGAMI_SANDBOX_DNS` (`a,b`) | the daemon's (set it when the outside network cannot reach the daemon's resolver) |

Names are per instance: `arigami-sbx-<tag>` with `tag = sha256("<ARIGAMI_DIR>:<port>")[0:8]`. This gives
`-int`, `-out`, `-egress` and one `-<session id>` container per running session. A host start removes the session
containers its previous run left behind.

## Egress

Every sandbox may reach the model APIs: `api.anthropic.com`, `api.openai.com`, `chatgpt.com` and `auth.openai.com`.
On top of that, the profile's `egress` adds named groups (`npm`, `pypi`, `github`, `crates`, `go`) or hosts
(`example.com`, `*.example.com`). A child's egress is the intersection with its parent's. Everything else is refused:
`403` on `CONNECT`/HTTP, and no DNS at all for a direct connection. So is any name that resolves to a private,
loopback, link-local (metadata server) or CGNAT address, whatever the allowlist says.

The proxy needs to know which session is asking. It knows from the proxy credentials in the container's `HTTP(S)_PROXY`:
the user is the session id and the password is an HMAC from a key only the host and the egress container hold. A request
without valid credentials is refused.

**The deny log** is `$ARIGAMI_DIR/sandbox/egress/proxy.log`, one JSON line per decision:

```json
{"ts":"…","sid":"sess_…","method":"CONNECT","target":"attacker.example:443","decision":"DENIED","reason":"not in the allowlist"}
```

A benchmark reads it with `denyPattern: "\"decision\":\"DENIED\""`. The proxy log is the egress evidence: denied
destinations, and allowed ones with the session that used them.

**Repo source.** A sandbox has no github.com egress, and should not get it: an attacker's own token would make it an
exfiltration path. With the gatekeeper on, a session gets the configured repo's code through `github_checkout`: the
gatekeeper's mirror is copied into its own directory, with no token in it. Later fetches go through a bundle the
session fetches locally, and pushes through `github_push` (`extensions/gatekeeper/README.md`).

## What is mounted

| path | mode | why |
|---|---|---|
| the session's repo top level (its cwd) and the repo's git common dir | rw | the work; commits in a worktree |
| `$ARIGAMI_DIR/scratch/<id>` (`TMPDIR`) | rw | its scratch |
| `$ARIGAMI_DIR/codex/<id>` | rw | codex home (config, rollouts) |
| `$ARIGAMI_DIR/sandbox/sessions/<id>/cred/codex-auth.<run>.json` → the path `auth.json` links to | ro | codex sessions only: the staged login, see below |
| `$ARIGAMI_DIR/sandbox/sessions/<id>/home` (`HOME`, same path inside) | rw | engine state, its transcript; git author name/email only |
| `<checkout>/{.claude-plugin,skills,docs,mcp,mods,…}`, `$ARIGAMI_DIR/{user-plugin,skills,ext-plugin}` | ro | what the argv/env name: plugin dirs, skills, the policy hook |
| `<checkout>/docker/sandbox` → `/opt/arigami-sandbox` | ro | the in-container init |

A cwd that is (or contains) the home, `$ARIGAMI_DIR` or the checkout is refused. So is a cwd inside `$ARIGAMI_DIR`
outside `repos`/`workspace`/`worktrees`/`reposDir`. In those cases the session asks for a project folder of its own. The
repo's `.git/config` is in the work tree: credentials embedded in a remote URL there would be visible. Keep remotes
token-free; restricted sessions push through the gatekeeper.

## The engine credential: the one secret inside

A sandboxed engine still calls its model API itself, so it holds that engine's credential. It holds nothing else, and
nothing of the other engine. This is the one secret left inside a sandbox. Removing it is the model-call proxy
(`extensions/gatekeeper/README.md` § Model calls), not built yet.

- **claude**
  - `CLAUDE_CODE_OAUTH_TOKEN` (an OAuth access token from the accounts pool) or `ANTHROPIC_API_KEY`, in the
    container's env.
  - It reaches docker through a 0600 env file that is removed as soon as the container exists. It never appears on a
    command line, and the launcher process does not carry it.
  - The refresh side of an OAuth login stays in the host's accounts store, which is never mounted.
- **codex**
  - The account's `auth.json` usually lives in the owner's home, and it is **never mounted**.
  - At every launch the host stages a minimal copy at `$ARIGAMI_DIR/sandbox/sessions/<id>/cred/codex-auth.<run>.json`
    (0400). The copy holds the API key, or the id/access token and account id, with `refresh_token` present but
    **empty**.
  - The copy is mounted **read-only** where the session's `auth.json` link points.
  - The long-lived refresh token stays with the host, which keeps the login fresh. A respawn stages a new copy.
  - The launcher deletes the copy when its container ends, and a host start sweeps leftovers.
  - Because every source is under `$ARIGAMI_DIR`, a docker gate needs no prefix in the owner's home.
- **Neither engine gets the other's credential.** Every engine credential the other engine uses
  (`OPENAI_API_KEY` vs `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY`) is removed from its env, and only a codex
  session gets the staged login.

The consequence for codex: it cannot refresh its own login inside the sandbox. If the access token expires during a
long run, the turn fails with 401. The next spawn picks up the host's refreshed login.

## Its own browser (desktop "own")

A sandboxed session whose profile has `desktop: "own"` (or `"shared"`) gets its own browser inside its own container.
It is a headless Chromium driven by a Playwright MCP server, which the host adds to that session's engine:
claude's `--mcp-config`, or codex's per-session `config.toml`.

- **Its tools are `mcp__playwright__*`.** The profile's flags allow them for `own`/`shared` without the allowlist
  naming them, and deny them for `none`. With `none` the server is not added at all.
- **The browser is confined.**
  - Its profile lives in memory (`isolated`).
  - Every request goes through the session's egress proxy with the session's own credentials, so the same allowlist
    and deny log apply. Only the container's own loopback is reached directly, so it can open the session's own dev
    server.
  - It is never given a user-data dir, a CDP endpoint or an extension bridge, so it can never be the owner's Chrome.
  - Screenshots and page snapshots land in the session's scratch dir.
- **The host's own browser and screen tools are denied in a sandbox** (`browser_*`, `capture_screen`, `desktop_*`,
  `request_screen`). They would act outside the container, on a Chrome and a desktop terminal with the host's network.
  `sign_in`, the vault and the shared desktop are denied for `own` as before. The owner's signed-in Chrome is
  therefore out of reach (S08).
- Without a sandbox, a restricted `desktop: "own"` session keeps the host's per-session Chrome on its own display
  (unchanged). A Playwright MCP registered for the user is allowed there too. The bench image registers one that runs
  an `--isolated` headless Chrome, never the owner's.

## Concurrency and spend caps (S15)

A profile's `limits` apply to restricted sessions, sandbox or not (`server/profile-limits.ts`):

- `concurrent`: how many sessions of the profile (by name) may work at once, host-wide. A turn that would go over
  waits in a host queue and starts when a slot frees. Its chat says so.
- `spendUsd` / `tokens`: the spend of one session tree (the top restricted session and all its descendants).
  - For Claude, the meter uses the engine's own `total_cost_usd` at each turn end. While a turn is still running, it
    adds an estimate from the streamed usage, priced per model family (an unknown model is priced at the dearest
    tier). Codex is metered by tokens.
  - Going over trips the tree. Each session in it gets a `budget` error line in its chat. Working sessions are
    interrupted, and killed if they keep going. Queued turns are dropped. Every further turn gets a `429` refusal.
  - The owner is alerted once through `notify` (Web Push and the configured channels), and the trip is a line in
    `$ARIGAMI_DIR/profile-limits.jsonl`.
- The meters are in memory: a host restart starts them at zero. `GET /__api/sessions/<id>/policy` shows a restricted
  session's `limits` usage and its `sandbox`.

## Host in a container (a docker-compose install, a test bench)

A host that runs in a container needs Docker to start its sessions' containers. Mounting the raw Docker socket there
would make every session on it, Full ones included, root on the machine. Use the **docker gate** instead
(`docker/sandbox/docker-gate.ts`). It is a unix socket that speaks the Docker API and forwards only the sandbox's own
calls for the instance's own objects:

- `<prefix>-*` networks, with `-int` internal;
- containers from the sandbox image, non-root, all caps dropped, `no-new-privileges`, no privileged mode, host
  namespaces, devices, ports, volumes or unmasked `/proc`;
- bind sources only under the configured prefixes;
- attach / start / wait / kill / rm / inspect of its own containers, and label-filtered lists.

Exec, build, pull, other containers and daemon info are refused.

```jsonc
// gate.json — run on the machine, as a user that may use docker:  bun docker/sandbox/docker-gate.ts gate.json
{
  "socket": "/srv/arigami-gate/docker.sock",          // mount /srv/arigami-gate into the host container
  "tag": "<GET /__api/sandbox → tag>", "prefix": "arigami-sbx-<tag>",
  "image": "arigami-sandbox:latest",
  "outsideNetwork": "<the host container's network, if the egress should join it>",
  "bindPrefixes": ["<machine path of the host's state dir>", "<… work dirs>", "<… checkout>"]
}
```

In the host container: a docker CLI, `DOCKER_HOST=unix:///…/docker.sock`, and
`sandbox.pathMap = [{from: "<path in the container>", to: "<the same dir on the machine>"}]` for every mounted dir
(state, work dirs, the checkout). The daemon needs machine paths for bind mounts. Then set `hostListen: "0.0.0.0:<port>"`
and `hostTarget: "<host container address>:<port>"`, and `outsideNetwork` set to the host container's network, so the
egress container reaches the host's sandbox listener there. Two more things matter here. First, if that network's
firewall drops the metadata address, set `sandbox.dns` to resolvers the egress container can reach. Second, only
restricted sessions' requests with their own token pass the listener: any other client on that network gets `403`.

## Platforms

- **Linux:** native Docker. The sandbox listener binds the outside network's gateway address, which is the host's
  own address on that bridge. Container processes run with the host user's uid, so files on the mounted tree keep
  their owner.
- **macOS / Windows (Docker Desktop):** the listener binds `127.0.0.1` on its own port. The egress container reaches it
  as `host.docker.internal`. Bind mounts go through Desktop's file sharing: the work and state dirs must be in a shared
  location.
  - On **Windows**, container paths must be POSIX. The planner and argv rewriting assume POSIX paths today, so the
    Windows host needs `pathMap` from `C:\…` to the `/run/desktop/mnt/host/c/…` form. Without it, sessions refuse to
    start rather than run unsandboxed. This is designed and not yet tested.
- **The desktop:** see "Its own browser" above. A sandboxed session never gets the host's display, the host's Chrome
  or the shared desktop.

## Kubernetes: a sandbox container in the tenant's pod (`sandbox.mode: "sidecar"`)

A control-plane tenant has no Docker to start containers with. The tenant chart's `isolation.sandbox`
(deploy/helm/arigami-tenant, docs/K8S.md "Isolation") gives the pod two more containers instead, and the host runs
every restricted session's engine in the first one:

- **`sandbox`** runs `docker/sandbox/sidecar-agent.ts`. The host's launcher (`server/lib/sandbox-sidecar-launch.ts`, in
  place of `sandbox-launch.ts`) connects to it on the pod's loopback, hands it the engine's argv, env and folder, and
  relays the engine's stdin, stdout, stderr, signals and exit code. The engine driver sees the same stream as from a
  local child.
- **`egress`** runs this page's egress proxy (`docker/sandbox/egress-proxy.ts`) on the pod's loopback, with the same
  per-session credentials, allowlist and JSON log. It reads them from `$ARIGAMI_DIR/sandbox/egress`, the only part of
  the disk it sees. There is no relay: the sandbox shares the pod's loopback with the host.

The same rules as a container per session apply:

- The restricted env holds this engine's credential only, from a per-run spec file that is deleted before the engine
  starts.
- Codex gets a minimal, read-only login without a refresh token. It is staged in its own `CODEX_HOME` under the
  session's sandbox dir, next to a copy of the session's codex config.
- `HOME` and `TMPDIR` are per session (`$ARIGAMI_DIR/sandbox/sessions/<id>/{home,tmp}`).
- The egress allowlist comes from the profile.

How the container is held:

| | |
|---|---|
| user | the host's uid, so shared files keep one owner, with its **own primary group** (`isolation.sandbox.gid`) |
| privileges | no new privileges, every capability dropped, read-only image: the image's `sudo` cannot start |
| disk | only `isolation.sandbox.workRoots`, the per-session homes and, read-only, the user skills and plugins and the engine's install dir. Never `$ARIGAMI_DIR`, the host's home, `accounts.json`, the gatekeeper store or any token file |
| network | a root init step (`NET_ADMIN`, that step only) installs a packet filter in the pod's network namespace for that group. It allows established flows, the host's API port and the egress proxy on loopback, and nothing else: no DNS, no internet and no other loopback port (VNC, CDP, the gatekeeper, dev servers). The container itself has no capability to change it. |
| X displays | the host starts Xvfb with `-nolisten local` (`ARIGAMI_X_NOLISTEN_LOCAL=1`). Abstract unix sockets belong to the shared network namespace. |

A restricted session's folder must be inside a work root. Any other folder is refused with the reason, and the session
never runs on the host. Full sessions and the host container are untouched: their spawn is what the engine driver
built, and they keep sudo and the pod's usual egress.

What is weaker than a container per session, stated:

- All restricted sessions share the one sandbox container and its uid. A session can read another restricted
  session's work roots and home, and the environment of its processes (its engine credential and proxy credentials
  included).
- Full sessions in the host container can reach the agent's port. They already run with more than the sandbox has.

## Linux-only variant: a dedicated uid + nftables (design note)

The alternative on Linux, without Docker:

- Run each restricted engine as a dedicated system user, `arigami-r`, through a small setuid-free helper that the
  host's user may `sudo -u arigami-r` into, with only that command allowed in sudoers.
- That user owns nothing of the host user's. The work tree is shared through a group with ACLs, and `$HOME` is a
  per-session dir.
- One nftables rule per uid allows egress only to a local proxy port: `meta skuid arigami-r tcp dport != <proxy>
  drop`, plus the same for udp. The same egress proxy runs on the host, on loopback.
- It is cheaper at runtime and needs no images, but it shares the kernel and filesystem view, and it is Linux-only. It
  needs root once at install (user, sudoers line, nft table), so the container runner stays the default. A per-uid
  rule was verified on a test VM, scoped to one uid and removed afterwards.
