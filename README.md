# Arigami

**Arigami — the self-hosted cockpit for a team of Claude agents that runs on real
desktops, hands you the wheel when it needs you, and learns your business only
with your approval.**

![Arigami hands you the wheel: a child agent hits 2FA on its own desktop, pushes to your phone, you type the code, it continues](docs/media/hands-you-the-wheel.gif)

## Install in 60s

**One line (Linux / macOS / WSL)** — installs bun, the Claude Code CLI and the
host as a service, then prints the URL and a pairing code:

```bash
curl -fsSL https://raw.githubusercontent.com/maor700/arigami/master/install.sh | bash
```

**Docker:**

```bash
git clone https://github.com/maor700/arigami && cd arigami
cp docker/.env.example .env      # Claude auth (see the file)
docker compose up --build        # → http://localhost:3199/__host/
```

**Manual:**

```bash
bun install && (cd web && bun install && bun run build)
bin/host start                   # → http://localhost:3099/__host/
bin/host pair                    # prints the pairing code for the first sign-in
```

Then open the cockpit, enter the pairing code, pick a profile
(`solo-dev`, `agency-client`, `ops`) and let Setup walk you through Claude auth,
git and your first repo. `install.sh --profile <bundle>` pre-selects one.
Details: [docs/INSTALL.md](docs/INSTALL.md) · [docs/DOCKER.md](docs/DOCKER.md)
· [docs/DEPLOY.md](docs/DEPLOY.md).

Prerequisites the installer handles for you: [bun](https://bun.sh) ≥ 1.2, git +
`gh`, and the Claude Code CLI signed in with **your own subscription** — no API
keys, no OpenRouter. (`ANTHROPIC_API_KEY` works too if you prefer metered
billing.)

## What it is

- **A team of Claude Code sessions, not one chat.** A project-manager session
  decomposes work, spawns children in their own git worktrees, tasks them, reads
  back thin results, and integrates. Cron and listeners (mail, webhooks, Linear,
  Slack) wake sessions on their own. One origin, one Bun server, one UI on your
  phone or laptop.
- **Real desktops, and it hands you the wheel.** Every session can drive a browser
  on its own Xvfb+VNC desktop. At login, 2FA, CAPTCHA or payment it pushes to your
  phone, you take over the screen, tap Done, and it continues — the human is in
  the loop exactly where the human is needed.
- **A second brain with a human gate.** Sessions write episodes, propose memory
  facts and skill changes — all of it lands in *Pending* with a diff, undo and
  scan, and nothing is written until you approve. Fold the cockpit to your
  business with **profile bundles** (repos + skills + memory seed + cron).

## Why not …

| | Arigami | OpenClaw | Hermes Agent | Claude Cowork |
|---|---|---|---|---|
| Self-hosted | ✅ | ✅ | ✅ | ❌ |
| Model / billing | your Claude Code subscription | any provider, API keys | any provider, API keys | Claude (Anthropic cloud) |
| Multi-agent orchestration | PM → children, worktrees, cron | YAML graphs | weak | ❌ |
| Real desktop per agent + human takeover | ✅ VNC, push to phone | ❌ | ❌ | built-in browser, cloud only |
| Learns (memory + skills) | ✅ | via skills | ✅ core | ❌ |
| Human gate on learning | pending + diff + quarantine, always | skill staging | opt-in, no diff | — |
| Profile bundles (fold to a business) | ✅ | ❌ | ❌ | ❌ |

## Security posture

Agents here run shell commands, browsers and git with your credentials, so the
cockpit is treated as an admin console, never a public site:

- **Authenticated by default.** Session cookie, first sign-in by pairing code,
  optional OIDC (Google/GitHub/your IdP) — [docs/AUTH.md](docs/AUTH.md).
- **Binds `127.0.0.1` and fails closed.** Reaching it from another device goes
  through a tunnel you control: `tailscale serve` (private to your tailnet, real
  HTTPS) or Caddy/your reverse proxy with TLS. Never `tailscale funnel`.
- **The cockpit is never funnelled.** The only surfaces that open without a
  cookie are signed, expiring share links for artifacts and webhooks.
- **Agents never print absolute URLs.** Everything the host hands you is a
  host-relative path, so links work from `localhost`, a tailnet or a proxy.
- **Skills and memory are never auto-written.** Proposals wait in *Pending*.

Threat model and hardening: [docs/SECURITY.md](docs/SECURITY.md). Report
vulnerabilities: [SECURITY.md](SECURITY.md).

## Docs

- [docs/INSTALL.md](docs/INSTALL.md) — the three doors (installer, Docker, manual)
- [docs/AUTH.md](docs/AUTH.md) — sign-in, pairing, OIDC, migrating a live host
- [docs/DEPLOY.md](docs/DEPLOY.md) — systemd units, restart/upgrade from the cockpit
- [docs/DOCKER.md](docs/DOCKER.md) — image, volumes, Kubernetes notes
- [docs/SPEC.md](docs/SPEC.md) — data model, REST/WS API, host MCP tools, UI
- [docs/ONBOARDING.md](docs/ONBOARDING.md) — repos, profiles, readiness gates
- [docs/TRIGGERS.md](docs/TRIGGERS.md) · [docs/DISPATCHER.md](docs/DISPATCHER.md) — listeners, cron, PM → children
- [docs/SECURITY.md](docs/SECURITY.md) · [SECURITY.md](SECURITY.md) · [CONTRIBUTING.md](CONTRIBUTING.md) · [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)

Windows: `bin\host.ps1` mirrors `bin/host` (start/launch/doctor/install as a
Scheduled Task); `server/lib/platform.ts` normalizes the POSIX assumptions.
macOS: `bin/host install` registers a launchd agent and `bin/install-app` builds
a one-click `Arigami.app`.

## License

Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE). Contributions are
accepted under the DCO ([CONTRIBUTING.md](CONTRIBUTING.md)).
