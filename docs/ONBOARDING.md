# Arigami — Onboarding & Workspace Provisioning

Design spec for turning a **fresh** arigami (a clean container / K8s pod, or a
new dev machine) into a working cockpit with **minimal manual steps** — the
foundation for autonomous, trigger-driven task runs.

Derived from a full design review (2026-07-01). This is the contract the build
follows; deviations should update this doc.

---

## 1. Goals & framing

- **Unopinionated platform, Acme as a profile.** The host core works against
  **any repo the user chooses** — clone, detect toolchain, install, run. Acme
  specifics (repos, registry tokens, ports, Linear) are a *profile* layered on
  top, never baked into the core. (Matches the platform's original design: the
  core is generic; workflows live in `skills/`.)
- **The heavy work is a *fresh-environment* problem.** On a dev Mac the user
  already has repos, `gh` auth, env files, and Claude auth — onboarding there is
  nearly a no-op (a health check). In a fresh container/pod it does the real
  provisioning. One adaptive surface, not two products.
- **Image stays lean; reproducibility comes from onboarding, not from baking.**
  Repos, `node_modules`, secrets, and env are **state** (volume / Secret), never
  image layers. A fresh pod becomes "like local" by *running onboarding*, not by
  shipping a fat image. See `docs/DOCKER.md` for the image/volume split.

Key insight that shaped every decision: **almost all friction is OAuth bound to
the user's browser+account, plus per-environment differences.** Everything else
is deterministically automatable.

---

## 2. Run modes (decision 1)

| Mode | When | Notes |
|------|------|-------|
| **Native** (`bin/host`) | **default for local developers** | Simple, already mature (launchd, `bin/host launch`). No daemon, no port collision, no in-container OAuth callback pain. |
| **Docker / container** | deployment: server / VPS / K8s / always-on triggers | Stateful singleton; see `docs/DOCKER.md`. |

The onboarding system is **run-mode-agnostic** — the same engine, endpoints, and
UI serve both. Only the *auto-fix strategy* branches (§3).

---

## 3. Environment detection (decision 2) — automatic

Detection is **per-item probes**, not a hardcoded "mode". `/__api/onboarding/status`
probes each requirement independently; the "environment" is emergent.

One runtime hint selects the **auto-fix strategy**:

- **Native (not in a container)** → **borrow** from the host machine: read
  `gh auth token`, copy local `.env.local`, read MCP tokens from the Keychain, or
  register an existing local repo path without cloning.
- **Container** (detected via `/.dockerenv` / cgroup) → **provide**: secrets from
  env / K8s Secret, repos via `git clone`, env via the repo's `envSource`.

Single adaptive surface: green-everywhere on a dev Mac (quiet health check),
full wizard on a fresh pod. Never gated/hidden by mode — status drives it.

---

## 4. Status model (decision 7)

Single source of truth consumed by the server engine, the Setup UI, the skill,
and trigger-readiness.

### Step schema

```jsonc
{
  "id": "repo:app.deps",
  "title": "Install app dependencies",
  "scope": "global" | "repo:<name>",
  "status": "ok" | "missing" | "error" | "blocked",  // blocked = prereq not green
  "autoFixable": true,
  "dependsOn": ["git-auth", "repo:app.env"],
  "action": "onboarding.installDeps",                // server action id
  "detail": "1980 pkgs expected; node_modules absent"
}
```

### Taxonomy — a tree, not a flat list

- **Global (credentials):** `claude-cli`/`claude-auth` or `codex-cli`/`codex-auth` → `git-auth` (GH_TOKEN / gh). Gates; the engine not connected carries `required:false` once the other one is.
- **Per-repo group** (one per `repos.json` entry): `repo:<n>.cloned` → `repo:<n>.env` → `repo:<n>.deps`.
- **Profile-specific:** `linear-connector` (only if `profile.issueSource == "linear"`), `voice` (Groq), `playwright` (Chromium/ffmpeg binary presence).

### Readiness (decision 7b) — **per repo**

`ready(repo)` = all required global steps **and** that repo's steps are `ok`.
This is exactly what an autonomous trigger checks before firing — no human, no
tokens. A trigger bound to repo X will not run until `ready(X)`.

---

## 5. Repos model (decision 4) — the generic core

No repo registry exists today; sessions just receive a `cwd`. This adds one.

### `~/.arigami/repos.json` (separate file, not `config.json`)

```jsonc
[
  {
    "name": "app",
    "source": "github.com/acme/app" | "/abs/local/path",  // clone OR register-in-place (native)
    "branch": "main",
    "installCmd": "...",     // auto-detected, overridable
    "devCmd": "...",
    "testCmd": "...",
    "envSource": { "kind": "none" | "file" | "command", "value": "vercel env pull .env.local" }
  }
]
```

- **Auto-detect prefills** on add: package manager from lockfile
  (`bun.lock`→bun, `package-lock`→npm, `pnpm-lock`→pnpm, `yarn.lock`→yarn, …),
  dev/test from `package.json` scripts. All fields overridable.
- **`envSource`** is the irreducible per-repo secret bit: `none`, `file`
  (paste/upload a `.env`), or `command` (e.g. `vercel env pull`). This is where a
  repo's private registries / env plug in.
- **In-repo `.arigami.json` manifest** (supported in MVP): a repo may
  self-describe (install/dev/test/envSource). Opt-in.

### Precedence (low → high)

`auto-detect (prefill)` < `.arigami.json` (repo self-description) < **user edit
in the UI (always wins, stored in `repos.json` as the resolved truth)**.

---

## 6. Profiles (decision 5) — "Acme" (a fictional company) as one profile

A **profile is a declarative manifest that seeds the generic core** — *not* a
skill. Workflows stay as skills; the profile only *references/enables* them.

- **Lives in:** `profiles/*.json` shipped in the host repo (`profiles/acme.json`
  is the first) **+** user profiles in `~/.arigami/profiles/`.
- **Apply = seed-then-auto-fix** (decision 5b): applying merges the profile's
  repo entries into `repos.json`, sets `envSource` strategy, enables plugins, and
  configures the issue source. Then the normal per-step auto-fix runs — visible,
  stoppable, one step at a time. It does **not** one-shot everything.

### Profile schema

```jsonc
{
  "name": "acme",
  "repos": [ { "name": "app", "source": "github.com/acme/app" } ],  // app ONLY — see below
  "toolchain": { "pm": "bun", "install": "set -a && . ./.env.local && set +a && bun install" },
  "envSource": { "native": "copy-local", "container": "vercel env pull" },
  "ports": { "dev": [3020, 3030], "storybook": [6021, 6030] },
  "issueSource": "linear",            // pulls in the session-level connector + relay (profile only)
  "plugins": ["your-plugin", "playwright"],
  "workflows": ["create-from-ticket", "ship-it"]
}
```

### Acme profile = `app` only (decision: drop `login`)

`login` is **not** provisioned. Verified from `app/.env.local`: the app already
points at **remote** auth/api — `AUTH_APP_URL=https://login.example.com`,
`VITE_APP_AUTH_URL=https://app.example.com`, `VITE_API_BASE_URL=https://api.example.com`.
The local `login` repo is never referenced; the app authenticates against the
deployed login (the login skill drives Google SSO through a pre-authed browser
profile). Dropping it removes one clone + one `bun install`.

---

## 7. Credentials & OAuth (decision 3)

Two classes of OAuth, handled differently:

- **Class A — Host-brokered** (host initiates, callback on the cockpit's own
  mapped origin, e.g. `/__api/linear/oauth/callback`). **Already works** — no
  relay. Generalize this pattern for host-level integrations.
- **Class B — Claude-Code-brokered** (the `claude` CLI spins up its *own*
  ephemeral `localhost:<random>/callback`). Breaks in a container (port
  unreachable from the host browser).

### Strategy

| Need | Mechanism |
|------|-----------|
| **Claude auth** | **env token** `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`, ~1yr) — no callback. Or a paste-once in the UI. Core. |
| **Git auth** | `GH_TOKEN` (env / Secret) or borrowed `gh auth token` (native). Entrypoint writes git credential helper. Core. |
| **Host integrations** | Class A, cockpit origin. Core. |
| **Session-level connectors** (linear-server, Slack, Figma) | Class B → **profile, not core.** Native: borrow the token from Keychain. Container: **paste-back relay** (user authorizes → pastes the dead redirect URL → host `curl`s the in-container callback to complete). Built with the Acme profile (P3). |

The fragile relay is thus a small, profile-scoped component for **class B in a
container only** — not the backbone.

---

## 8. Engine vs skill seam (decision 6)

- **`server/onboarding.ts` — deterministic engine.** Owns *all* mechanical,
  idempotent provisioning: detect, clone, install, env-fetch, register MCPs, seed
  profile. Exposed via `/__api/onboarding/*`. Driven by Setup auto-fix buttons
  **and** callable headless for trigger-readiness — no tokens, testable, CI-safe.
- **Onboarding skill — thin conversational wrapper** for humans: first-run
  "walk me through", explains failures, handles ambiguity. It **calls the same
  server actions** via the Host MCP; it does **not** reimplement provisioning.

Rationale: autonomous triggers must verify/fix readiness without a human and
without burning tokens. Putting the engine in a skill would make every fresh-pod
trigger spawn a full Claude session just to clone+install.

---

## 9. Setup surface & entry (decision 8)

- **One "Setup" surface**, three status-driven sections (not separate pages):
  **Connections** (global creds + profile connectors) · **Repos** (per-repo
  groups + "Add repo") · **Profile** (apply / switch).
- **Status-driven entry:** if any *required* step is missing, the cockpit shows a
  first-run banner/modal ("Setup needed — N steps") that opens Setup. All green →
  collapses to a quiet Settings entry. Native-local: usually all green, no modal.
- **Launcher gating:** starting a session / running a ticket against a repo that
  isn't `ready` **routes to Setup** instead of failing cryptically. This is the
  direct fix for the "I'm blocked — paste ticket details / set
  ACME_WORKSPACE_ROOT" dead-end.

---

## 10. Build phases

### P1 — Generic core (delivers value + fixes the blocked-session dead-end)
- `server/onboarding.ts` engine + `/__api/onboarding/status`.
- `repos.json` model: add repo (git URL / local path), auto-detect, clone,
  install, `envSource`, `.arigami.json` parsing.
- Setup surface: **Connections** (Claude env-token + Git) + **Repos**.
- Automatic environment detection (container/native → provide/borrow).
- **Launcher gating**.
- Fix the entrypoint git-credentials bug (GH_TOKEN → creds reliably; see
  `docs/DOCKER.md`).

### P2 — Profiles + skill + trigger-readiness
- Profile manifest model + `profiles/acme.json` (**app only**) + apply=seed + UI
  Profile section.
- Acme envSource strategies (native `copy-local` / container `vercel env pull`),
  ports, toolchain.
- Thin onboarding skill (conversational wrapper over server actions).
- Trigger-readiness: listeners/triggers check `ready(repo)` before firing.

### P3 — Profile connectors + tooling
- Session-level connectors (linear-server) + **paste-back relay** (class B) as a
  Acme-profile feature → ticket auto-fetch in a container.
- Playwright / Chromium / ffmpeg image layer.
- Voice (Groq).

---

## 11. Non-goals / explicit drops

- **No `login` repo** (app points at remote auth) — §6.
- **No repos / node_modules / secrets baked into the image** — they're volume/Secret state.
- **No hardcoded Acme assumptions in the core** — Acme is a profile.
- **No relay in the core** — class-B OAuth is profile-scoped, container-only.

## 12. First-run wizard (B3) — one state machine, three consumers (K5)

`server/onboarding.ts` → `wizard()` is the **single** source of truth for
"how far is this host set up". Three things read it and nothing else measures
setup: the cockpit **Wizard** (`web/src/components/Wizard.jsx`), **`bin/host
doctor`** (runs `bun server/onboarding.ts doctor` in-process, no host needed)
and the **funnel** (`server/funnel.ts`, shipped by D3 when the user opts in).

### Steps (linear, in this order)

| id | probe (live, no network) | fixable in the wizard by | skippable |
|---|---|---|---|
| `pair` | an admin exists in `users.json` (C1) | Login.jsx pairing / "Pair another device" | no |
| `claude` | CLI on PATH **and** a credential (account, keychain, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`) | PKCE sign-in (`/__api/accounts/oauth/*`) or paste token (`POST wizard/claude {action:'token'}`) | no (`skipped` by:'auto' while codex is ok) |
| `codex` | `codex` on PATH (or `ARIGAMI_CODEX_BIN`) **and** a codex account / `~/.codex/auth.json` | `codex login` (`POST /__api/setup/codex {action:'start'}`, callback pasted back) or an OpenAI key (`{token}`) | no (`skipped` by:'auto' while claude is ok) |
| `git` | `GH_TOKEN` / `~/.git-credentials` / `gh` hosts.yml | PAT (`{action:'token'}` → `~/.git-credentials`, 0600) or `gh auth login --web` under the pty bridge (`{action:'gh-login'}`, device code + URL surfaced) | yes |
| `profile` | `$ARIGAMI_DIR/profile.json` provenance | `POST /__api/profiles/apply {source}` (B1); `$ARIGAMI_DIR/pending-profile` is preselected | yes ("Start blank") |
| `integrations` | informational (composio key / whatsapp status / tailscale) | Composio key (`{action:'composio-key'}`), WhatsApp QR (`/__api/whatsapp/*`, status file now carries `qr`), Tailscale (`/__api/remote`) | yes (Continue = complete) |
| `repo` | `repos.json` non-empty | existing AddRepo | yes |
| `health` | last `runHealth()` result ok | `POST /__api/onboarding/health` — engine ping on the connected engine — `claude -p` or `codex exec --ephemeral` (required), desktop `xdpyinfo` (required iff screen enabled), Chrome `--version` (required iff desktop), WhatsApp (info) | yes |

Status resolution is **probe-first**: a passing probe is `ok` regardless of
what was recorded; otherwise the record in `$ARIGAMI_DIR/onboarding.json`
(`{status:'complete'|'skipped', at, by:'user'|'auto'|'unattended'}`) decides;
otherwise `todo` (`blocked` when the Claude CLI is missing). `done` = every
step `ok` or `skipped`; `current` = the first step that is neither.

### Codex-only

One engine is enough for the minimal Start gate and the engine step: with a codex login and no Claude CLI, `claude` reads `skipped`,
the wizard is `done` after pairing and the health ping runs `codex exec`. `workspaceReady()` ignores the claude rows but still needs git auth + a ready repo.

### REST

- `GET /__api/onboarding/wizard` → `{steps[], current, done, completedAt?, unattended, ghLogin}`
- `POST /__api/onboarding/wizard/:step {action}` (admin) — `complete` | `skip` | `reset`, plus the step-specific fixers listed above. Secrets are consumed and never echoed.
- `POST /__api/onboarding/wizard/reset` (admin) — forget every decision ("Run setup wizard" in Setup).
- `POST /__api/onboarding/health` (admin) — run the checks, persist the result.

### UI entry

`App.jsx` asks `GET /__api/onboarding/wizard` once after login; `done:false` →
the Wizard replaces the main pane (dismissable per tab; `#/wizard` deep link;
Setup → "Run setup wizard" reopens it after a reset). he/en, RTL-aware, phone-width.

### Unattended (`install.sh --unattended`)

The installer writes `ARIGAMI_UNATTENDED=1` into `$ARIGAMI_DIR/env` next to any
tokens. At boot `unattendedPrecomplete()` marks every still-open *skippable*
step `skipped (by:'unattended')`; tokens in the env satisfy `claude`/`git`
probes by themselves. Pairing is never auto-completed — the wizard is `done`
the moment the first pairing lands, so the UI never shows it.

## 13. Funnel events (`server/funnel.ts`)

Always appended locally to `$ARIGAMI_DIR/funnel.jsonl` (one JSON object per
line, `{name, at, ...props}`); nothing leaves the box unless D3 telemetry is
opted in, and D3 ships **names + timestamps only**.

| event | when | props |
|---|---|---|
| `onboarding.step` | a wizard step's status changed (once per transition; the last emitted status is stored in `onboarding.json`) | `step`, `status` |
| `onboarding.done` | `done` flipped to true | — |
| `session.first` | first session ever created | — |
| `pm.first_tree` | a master got its second child (≥2) | — |
| `screen.first_request` | first `request_screen` | — |
| `skill.first_applied` | first skill proposal applied | — |
| `artifact.first_publish` | first `publish_artifact` | — |

`firstTime(name)` is idempotent across restarts (`$ARIGAMI_DIR/funnel-first.json`).
Every event is also broadcast on the ws bus (`{type:'funnel', event}`; step
transitions additionally as `{type:'onboarding.step', step, status, at}`) so the
Wizard re-reads live. `ARIGAMI_FUNNEL_QUIET=1` (tests, `doctor`) skips the bus.
