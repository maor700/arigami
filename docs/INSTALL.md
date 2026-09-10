# Installing Arigami

Three doors. All of them end with a host answering on `http://127.0.0.1:3099`
(bound to loopback, fail-closed — see [AUTH.md](AUTH.md)) and a one-time
**pairing code** that creates the admin.

| door | when | doc |
|---|---|---|
| **`install.sh`** — one-liner on a VPS / laptop | Debian/Ubuntu, Fedora, macOS, WSL | this page |
| **Docker** | you already run containers | [DOCKER.md](DOCKER.md) |
| **manual** | you want to see every step | [DEPLOY.md](DEPLOY.md) |

## 1. One-liner

```sh
curl -fsSL https://raw.githubusercontent.com/maor700/arigami/master/install.sh | bash
```

or, with options:

```sh
curl -fsSL https://raw.githubusercontent.com/maor700/arigami/master/install.sh -o install.sh
bash install.sh --server --profile solo-dev
```

What it does, in order (every step is skipped when already satisfied, so
re-running is a no-op):

1. **Detects the OS** — Debian/Ubuntu (`apt`), Fedora/RHEL (`dnf`), macOS
   (`brew`), WSL (Linux path, no desktop by default).
2. **Base packages** — `git gh ripgrep python3 ffmpeg curl` (+ `unzip`).
3. **node 22** (the `claude` CLI and whatsapp-mcp need it) — NodeSource on
   Debian, `nodejs22` on Fedora, `node@22` on brew.
4. **bun** — `bun.sh/install`, into the service user's `~/.bun`.
5. **claude** — the native installer (`claude.ai/install.sh`, self-updating;
   not npm).
6. **Desktop stack** (`--desktop`, default on a Linux workstation) —
   `xvfb x11vnc openbox tint2 x11-utils fonts-noto` + Google Chrome on amd64 /
   Chromium on arm64. The host starts `:99` itself on boot.
7. **Clone or `git pull --ff-only`** into `--dir` (default `/opt/arigami` as
   root, `~/.local/share/arigami` otherwise). Running `bash install.sh` from an
   existing checkout uses that checkout.
8. `bun install --frozen-lockfile` + web build.
9. **Data dir** `$ARIGAMI_DIR` (default `~/.arigami` of the service user) and,
   with `--unattended`, the `env` file (see below).
10. **Service** — renders `deploy/systemd/arigami.service` through
    `bin/host render-unit`, `systemctl enable --now arigami`. macOS → launchd
    via `bin/host install`. `--no-service` skips this.
11. **Waits for `/__api/config`** and prints the cockpit URL + the pairing code
    (`$ARIGAMI_DIR/run/pairing-code`).
12. `--profile <src>` — stages a [Profile Bundle](#3-profile-bundles).

### Flags

| flag | meaning |
|---|---|
| `--server` | VPS mode: no desktop stack; as root, creates the `arigami` user |
| `--desktop` / `--no-desktop` | force the Xvfb/VNC/Chrome stack on or off |
| `--unattended` | no prompts; persist secrets from the environment to `$ARIGAMI_DIR/env` (0600) |
| `--dir DIR` | checkout location |
| `--user USER` | service user (created on Linux when missing) |
| `--profile <name\|dir\|git-url>` | profile bundle to apply after first start |
| `--no-service` | install everything, start nothing |
| `--dry-run` | print the plan, change nothing |
| `--repo URL` / `--branch B` | where to clone from (defaults: GitHub `master`) |
| `update` | the upgrade path: `git pull --ff-only` → `bun install` → web build → restart. The cockpit's **Update** button (Settings → Host → Version, `POST /__api/host/upgrade?when=confirm`) does the same pull/install/build and then waits for your restart click. Versions are normally minted **automatically**: a green CI run on master triggers `.github/workflows/version-bump.yml`, which bumps by conventional commits, tags `vX.Y.Z` and publishes. By hand it is still `bun run release <patch\|minor\|major>` + `git push --follow-tags`. `bin/host upgrade [--check]` is the CLI update path on a live host. See docs/RELEASING.md |

### Environment (`--unattended`)

| var | effect |
|---|---|
| `ARIGAMI_DIR` | data dir (everything the host owns lives here) |
| `ARIGAMI_PORT` | port (default 3099) |
| `ARIGAMI_PUBLIC_URL` | external origin (behind Caddy / `tailscale serve`) |
| `ARIGAMI_ADMIN_EMAIL` | admin email the pairing step should use |
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude subscription token from `claude setup-token` (headless) |
| `ANTHROPIC_API_KEY` | API-key billing instead of a subscription |
| `COMPOSIO_API_KEY`, `GH_TOKEN` | integrations |
| `ARIGAMI_PROFILE` | same as `--profile` |

They are written as `KEY=VALUE` lines to `$ARIGAMI_DIR/env`, which the systemd
unit loads with `EnvironmentFile=-`. The installer never prints their values.

### After install

```
  Arigami is running.
  cockpit:      http://127.0.0.1:3099/__host/
  pairing code: 4F7K-2Q9M   (enter it once in the cockpit → creates the admin)
  manage:       /opt/arigami/bin/host status|logs -f|doctor|restart
```

Open the cockpit, paste the code. From a phone/another machine, put the host
behind `tailscale serve` or Caddy (`ARIGAMI_PUBLIC_URL`) — the host itself
stays on loopback. `bin/host doctor` is the health screen; `bin/host pair`
mints a new code.

What follows the code is the **minimal setup** (F8): one screen — *Connect
Claude* (authorize link + paste the code, or a token) → **Start**, which opens
the first session in the empty `$ARIGAMI_DIR/workspace`. `onboarding.json`
records `mode:"minimal"`; nothing else is asked up front — GitHub, WhatsApp,
Gmail, remote access connect from the chat the moment the agent needs them
(see CONNECT.md). "Run full setup" (small link) switches to `mode:"full"` and
opens the 8-step wizard. The first screen of the cockpit is a single question
("What would you like me to do?") with three suggestions — screenshot a site,
connect WhatsApp, clone a repo; ticket/trigger launchers live behind *Advanced*
and the Linear tab only appears once Linear is connected.

### Update

```sh
bash /opt/arigami/install.sh update     # or: Settings → Host → Upgrade in the cockpit
```

Refuses to run on a dirty checkout (same guard as the cockpit).

## 2. Verifying on a clean VM

```sh
# Ubuntu 24.04, fresh, as root
apt-get update && apt-get install -y curl
curl -fsSL https://raw.githubusercontent.com/maor700/arigami/master/install.sh | bash -s -- --server --profile solo-dev
systemctl status arigami           # active (running)
/opt/arigami/bin/host doctor       # manager: systemd, pairing code pending, profile pending: solo-dev
bash /opt/arigami/install.sh       # second run: every step "(already)"
bash /opt/arigami/install.sh update
```

`--desktop` on the same VM: `DISPLAY=:99 xdpyinfo` works after the host boots.

Without root (e.g. a shared box) the installer still works for everything it
can do as the user — it lists the packages you must install yourself and
prints the `render-unit | sudo tee` commands for the service:

```sh
bash install.sh --dir ~/arigami --no-service
ARIGAMI_DIR=~/.arigami ~/arigami/bin/host start
```

## 3. Profile bundles

A **Profile Bundle** is the unit of install / showcase / export (spec K3): a
directory or git repo that "folds" a fresh host to a purpose.

```
my-bundle/
├── profile.json          # {name, version, title, description, repos[], plugins[], workflows[], issueSource}
├── README.md
├── skills/<name>/SKILL.md
├── memory-seed/USER.md   # optional
├── memory-seed/MEMORY.md # optional
├── cron.json             # [{name, prompt, schedule:{kind:"cron|interval|at", value}, enabled?, agent?}]
└── agents/<slug>/        # A4, optional — agents ("צוות") the bundle ships
    ├── agent.json        #   {name, emoji?, color?, model?, skills?[], tools?[], domains?[], budget?, autoApprove?[]} — no secrets
    ├── persona.md        #   ≤ ~20 lines "who you are + limits"
    └── assets/           #   brand/style references (optional)
```

`profiles/bundles/solo-dev/` in the repo is the reference bundle; `agency-client`, `ops`, `il-whatsapp-business` and `marketing-team` (six agents) are the showcase bundles (see `profiles/README.md`).

### What "apply" does (idempotent, additive)

| part | effect |
|---|---|
| `repos[]` | upserted into `repos.json` — Setup then provisions them per step |
| `skills/` | staged through the skill-proposal pipeline (M3). **Shipped bundle + new skill ⇒ applied.** External bundle, or any change to an existing skill ⇒ **pending proposal** in Brain (§7.12) |
| `memory-seed/` | lines **appended** to `USER.md` / `MEMORY.md` only when missing — never overwrites |
| `cron.json` | cron triggers registered **disabled** unless `enabled:true` on a shipped bundle; named `[<bundle>] <name>` so re-apply finds them; `agent` = the slug the runs are born from (used when the host has it) |
| `agents/` | **created** under `$ARIGAMI_DIR/agents/<slug>` when absent (record + persona + assets, skills the host lacks are dropped and reported); an **existing** agent is yours — left alone unless `--force` / `{"force":true}` (A4, `docs/AGENTS.md`) |
| provenance | `$ARIGAMI_DIR/profile.json` — what was applied, when, from where (with history) |

### Ways to apply

```sh
install.sh --profile solo-dev                 # staged as $ARIGAMI_DIR/pending-profile; Setup finishes it
bin/host profile list | current | validate <src>
bin/host profile apply <name|dir|git-url> [--force]   # host down → applied now; host up → staged (or via ARIGAMI_TOKEN=<admin API token> → REST); --force overwrites agents you edited
```

REST (admin):

```
GET  /__api/profiles              → {bundles:[…], pending}
GET  /__api/profiles/current      → {current: <provenance>, pending}
POST /__api/profiles/validate     {source}  → summary + {ok, errors, warnings}
POST /__api/profiles/apply        {source, force?}  → {ok, report}      # source may be "pending"; force overwrites existing agents
```

`source` is a shipped name (`solo-dev`), an installed name
(`$ARIGAMI_DIR/profiles/<name>`), a directory, or a git URL (shallow-cloned
into `$ARIGAMI_DIR/profiles/<name>` and `git pull --ff-only`ed on re-apply).

### Writing your own

Copy `profiles/bundles/solo-dev/`, change `profile.json.name`, add skills
(each needs YAML frontmatter with a `description`), keep memory seeds short
(they share the ~600/900-token caps of `USER.md`/`MEMORY.md`), and validate:

```sh
bin/host profile validate ./my-bundle
```

## 4. Extensions

A **Profile Bundle** ships a starting configuration; an **extension** adds
capability — tools, docs, listener types, merge gates, notification channels and
cockpit tabs — to a running host, at runtime, from a git repo you own. Nothing is
added to `/opt/arigami`, so `git pull --ff-only` (and therefore every future
upgrade) keeps working.

```sh
bin/host ext validate examples/extensions/hello
bin/host ext add      examples/extensions/hello    # or a git URL
bin/host ext list
```

Extension code runs with the host's privileges — `ext add` prints the
permissions the manifest asks for before you enable it. Full picture:
[docs/EXTENSIONS.md](EXTENSIONS.md); the contract for writing one:
[sdk/README.md](../sdk/README.md). You can also just ask a session to build one
for you — `/extend`, the [build-extension](../skills/build-extension/SKILL.md)
skill: it scaffolds into your own repo, validates, loads it and opens it in the
same chat.

## 5. Backup, restore, migration

See [docs/BACKUP.md](BACKUP.md): `bin/host export --full|--bundle`, `bin/host import`, Settings → Host → Export / Import, and the laptop → VPS → Docker recipes.
