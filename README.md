# Arigami

> **Fold AI into your workflow.**
> A customizable cockpit for running teams of AI agents — folded to how your
> business actually works.

A self-hostable web-shell cockpit for running many parallel Claude Code
sessions, with a customizable skill/workflow layer you shape to your own
process.

One Bun server on **`localhost:3099`** serves three things:

1. **The shell UI** (`/__host/`) — session rail, per-session view tabs, a Claude
   Code chat terminal per session, launcher.
2. **The proxy** — the PoC's fixed-origin reverse proxy (one login shared across
   every localhost port / Vercel preview), plus host pages (`/__ticket/<id>`,
   `/__compare`).
3. **The control plane** — REST (`/__api/*`) + WebSocket (`/__ws`) over a
   server-owned session registry, and a **Host MCP** (`mcp/host-mcp.js`) so the
   Claude running inside each session drives its own cockpit: title, color,
   status, progress, tabs, and the human-gated review footer.

The host is an **unopinionated platform** — workflows (tickets, worktrees, dev
servers, review) live in `skills/`, which talk to the host through the MCP.
`skills/create-from-ticket` is the bundled default the launcher uses.

## Prerequisites (fresh machine)

- **[bun](https://bun.sh)** ≥ 1.2 — runs the server and installs everything.
- **git** + **[gh](https://cli.github.com)**, logged in (`gh auth login`) with
  SSO authorized for **your-org** — cloning this repo and the `app` repo
  during onboarding both need it (the git-auth onboarding gate checks it).
  On Windows, use **Git for Windows** — the host runs every shell job (cleanup,
  onboarding clone/install, the skills) under the `bash` it ships.
- **Claude Code CLI** (`npm i -g @anthropic-ai/claude-code`), logged in with
  your own subscription (`claude` once, or `claude setup-token`). The
  claude-cli / claude-auth onboarding gates check this.

> The web UI uses the **free** FontAwesome packages from public npm — **no token
> needed**. `web/.npmrc` pins the `@fortawesome` scope to the public registry so
> a global/ambient `.npmrc` pointing it at the FontAwesome *Pro* registry (common
> on Acme machines, inherited from the `app` repo) can't hijack the install. If
> `bun install` in `web/` ever 401s on `@fortawesome/*`, that override is what
> prevents it — make sure `web/.npmrc` is present.

Optional integrations (voice, Linear ticket pages, a pinned Claude account) are
env-driven — copy the template and fill in what you need:

```bash
cp .env.example .env    # optional; bun auto-loads it on server start
```

## Run

```bash
bun install && (cd web && bun install && bun run build)   # web deps: free FontAwesome from public npm, no token
bin/host start        # or: bun server/index.js
open http://localhost:3099/__host/
```

On **Windows**, same thing through the PowerShell CLI (`bin\host.ps1`, the
counterpart of `bin/host` — same subcommands; `bin\host.cmd` wraps it for
cmd.exe):

```powershell
bun install; cd web; bun install; bun run build; cd ..
bin\host.ps1 start       # or: bun server/index.ts
bin\host.ps1 launch      # start + open the cockpit in a Chrome app window
bin\host.ps1 doctor      # checks bun/claude/git/gh + Git Bash + build artifacts
bin\host.ps1 install     # autostart at logon (a Scheduled Task, in place of launchd)
```

First run on a clean machine: the cockpit's launcher gates on workspace
readiness and routes you to **Setup** (or the chat onboarding skill). Apply the
**Acme profile** there — it registers `github.com/your-org/your-app`, then
drives clone → env → deps per repo. The env step expects the repo's
`.env.local`, which is never in git: bring your own (copy from an existing
checkout or `vercel env pull`) when the gate asks for it — that's expected
onboarding flow, not a failure.

## Desktop launcher (one click)

`bin/host launch` starts the host + local login and opens the cockpit in a
**Chrome app-mode window** (a clean standalone window — no tabs/omnibox — on a
dedicated profile, so it has its own persistent Acme login, isolated from your
everyday Chrome). Because it's real Chrome (Chromium), everything works: Google
SSO, iframes, the compare slider.

One-time setup (run from a terminal — the repo lives under `~/Desktop`, which
macOS TCC shields from Finder-launched apps, so services are managed by launchd,
not the app):

```bash
bin/host install       # launchd agents: host (:3099) + local login (:3001) autostart at login
bin/install-app        # build Arigami.app into ~/Applications (re-run if the repo moves)
```

Then it's one click: **double-click `Arigami.app`** (or `open "$HOME/Applications/Arigami.app"`).
It opens the cockpit in a Chrome app-mode window; the launchd agents keep the
services up. First launch, log into the App tab once (the dedicated Chrome
profile persists it). `bin/host launch` does the same from a terminal (and will
start the services itself there, since the terminal has `~/Desktop` access).

On Windows there's no TCC to work around, so there's no `.app` step —
`bin\host.ps1 launch` is the one-click path (it opens the same dedicated-profile
Chrome app window, falling back to Edge if Chrome isn't installed), and
`bin\host.ps1 install` registers the Scheduled Task that keeps the host up
across logons. To pin it, make a shortcut to
`powershell -NoProfile -ExecutionPolicy Bypass -File <repo>\bin\host.ps1 launch`.

## Platform notes (Windows)

The host targets macOS first; `server/lib/platform.ts` is the single place the
POSIX assumptions get normalized. What differs:

| | macOS/Linux | Windows |
|---|---|---|
| `~` expansion | `$HOME` | `%USERPROFILE%` (platform.ts defines `HOME` at boot) |
| shell jobs | `bash -lc` | Git Bash (`ARIGAMI_BASH` overrides) |
| `claude` lookup | PATH | PATH + PATHEXT (`claude.exe`/`.cmd`) |
| Claude credentials | login keychain | `~/.claude/.credentials.json` |
| bg-shell liveness | `lsof` on the output file | output mtime, then a WMI command-line match |
| bg-shell kill | SIGTERM → SIGKILL | `taskkill /T /F` |
| interactive logins | `lib/pty-bridge.py` | `winpty` (ships with Git for Windows) |
| lifecycle / autostart | `bin/host`, launchd | `bin\host.ps1`, Scheduled Task |

Two things stay macOS-only by design: `bin/install-app` (builds the `.app`
bundle) and the local login service (`bin/host login`), which is a Acme-internal
Next.js repo.

## Use from your phone (local & private, no public URL)

The cockpit is responsive — on a phone the session rail becomes a slide-in
drawer (☰) and the chat goes full-width. To reach it without exposing anything
publicly, use **Tailscale** (a private mesh between *your* devices only):

One-time: install Tailscale on the Mac + phone, sign into the same account. Then
**toggle it from the cockpit**: Settings → *Remote access* → flip on, and copy the
shown `https://<your-mac>.<tailnet>.ts.net/__host/` URL to open on your phone (with
Tailscale running). The toggle just runs `tailscale serve` for you; the equivalent
by hand is:

```bash
tailscale serve --bg 3099        # serves the host over HTTPS, tailnet-only
```
This is `serve` (private to your devices, encrypted, real HTTPS cert) — **not**
`funnel` (which is public). The valid cert means it's a secure context, so the
Service-Worker proxy tabs work too, not just chat.

Same-Wi-Fi alternative (simplest, no install): `http://<mac-lan-ip>:3099/__host/`
— chat works, but the proxied app/preview tabs need HTTPS so they won't load.

> The host has no auth and can run commands via the agent — keep it on your
> tailnet / a trusted LAN, never on `tailscale funnel` or an untrusted network.
> Embedded **your-app** tabs still call `api.example.com`, whose CORS allowlist is
> `localhost` only, so those API calls fail from a non-localhost origin — chat,
> review, and the host's own pages are unaffected.

See `docs/SPEC.md` for the full v1 contract (data model, API, MCP tools, UI).
