# Agent Engines (engines)

**Engine** is the CLI that actually runs the session's turn. Until now there was only one — `claude`.
Today there are two: `claude` and `codex` (OpenAI's CLI). The choice is made once,
at session creation, and is stored in `session.engine`.

- The seam: `server/lib/engine-driver.ts` (`EngineDriver`, `registerEngine`, `pickEngine`)
- The implementations: `server/claude.js`, `server/codex-app.ts` (codex over `codex app-server`, default) and `server/codex.ts` (codex over `codex exec`, fallback)
- Cockpit side: `web/src/lib/engines.js`
- Tests: `test/codex-app.test.ts`, `test/codex-engine.test.ts`, `test/engine-ui-wiring.test.js`, `test/engine-ui-web.test.js`

## How it's chosen

In the launcher, the engine picker is the first select of four, because it determines the content of two
of the others: the model list and the effort levels are per-engine, not a shared vocabulary.

- **claude** — the model list is pulled from the CLI (`server/models.js`), and the effort scale
  is uniform across every model (`--effort`, low…max).
- **codex** — the list comes from the engine at runtime (`codex app-server` `model/list` under the active
  login, 5-min cache; its `models_cache.json` only while that call is in flight; no hardcoded rows). Effort isn't a flag but a config
  key, `model_reasoning_effort`, and the scale is a property of the **model**:
  gpt-5.6-terra adds `ultra` above `max`, and gpt-5.5 stops at `xhigh`.

Resolution (`agents.engineForSpawn` + `state.createSession`): explicit `engine` → the agent's engine →
the parent's engine (children spawned with a master) → `cfg.defaultEngine` (Settings › Host, `POST
/__api/config/default-engine`) → `claude`. An unknown `defaultEngine` reads as claude. Cron, the Brain,
the PM controller and agent homes without an engine all land on the default; the launcher's toggle starts on it.

An engine with no registered driver fails loudly at spawn, and does not silently fall back to claude.

## What works on Codex

Verified live: the session comes up in the cockpit, receives a message, calls Arigami's home tools via MCP, and resumes previous turns. Skills pass through via a symlink — `$CODEX_HOME/skills/arigami` → `SKILLS_DIR` — as `arigami:<name>`. The chat log, bus, personas, memory, Simple mode, worktrees and the cockpit are engine-agnostic.

### Transport: app-server (default) or exec

`cfg.codexTransport` (`ARIGAMI_CODEX_TRANSPORT`), read at boot: `server/index.ts` imports `codex-app.ts`, which registers the `codex` driver for the transport.

- **`app-server`** — one long-lived `codex app-server` per session, newline-delimited JSON-RPC over stdio. Handshake: `initialize` → `initialized` → `thread/start`, or `thread/resume` when a thread id is stored (a thread with no turn has no rollout and starts over silently). A message is `turn/start` when idle and `turn/steer` into the running turn otherwise (no carry-over); Stop is `turn/interrupt`; `/compact` is `thread/compact/start`. The process lives across turns; the session goes idle on `turn/completed` and is marked dead only when the process exits (the next message respawns it). Verified live 2026-09-15 (codex-cli 0.153.4): turn + tools, steer merged into the running turn, approval card deny → declined, interrupt, compaction, image input, thinking; fixtures `test/fixtures/codex-app/`.
- **`exec`** — `server/codex.ts`, unchanged: `codex exec` per turn, `codex exec resume <thread>` for the next one, stdin at EOF during the turn, a mid-turn message carried over to the next turn. No approvals, compaction or thinking (limits 2, 5, 6 below still hold there).

The thread id is observed, not assigned, on both transports.

## Limitations — what doesn't work, explicitly

This list is the reason this document exists. Do not soften it.

Closed on master (2026-09): A3 policy hooks (§3), per-provider accounts and real quota (Accounts section), quota recovery + model ladder (§5, §6b), remote MCP grants per engine (§4), Composio (§4b).
Closed with app-server: approval cards (§2), compaction (§5), thinking (§6), live quota signal (§6b).
Still open: no sandbox on this VPS (§1), claude.ai connectors claude-only (§4b), no codex in the Docker image (docs/DOCKER.md); on `exec`, §2/§5/§6 remain as written.

### 1. No local sandbox

Codex's built-in bubblewrap **does not come up on this machine** —
`bwrap: loopback: Failed RTM_NEWADDR`. So exec always runs with `--dangerously-bypass-approvals-and-sandbox`, and app-server threads with `sandbox: danger-full-access` / `sandboxPolicy: dangerFullAccess`.
The only isolation that remains is the session's worktree.

Boot probe (`server/lib/codex-sandbox.ts`): `codex sandbox -- /bin/true`, cached in `$ARIGAMI_DIR/codex-sandbox.json`,
shown under Settings › Host › Codex CLI ("available" / "unavailable on this machine (bwrap: …)"). The spawn flags do not
follow it on either transport — a pass only logs that a sandboxed mode is possible.

Claude has separation that doesn't exist here: permission modes, the PreToolUse hook, `--disallowedTools`.
On exec a codex session is always the equivalent of `bypassPermissions`; on app-server only approvals (§2) can stop it.

### 2. Approvals — closed with app-server

`permissions.kind === 'rpc-request'`. `item/commandExecution/requestApproval`, `item/fileChange/requestApproval` and `item/permissions/requestApproval` become the chat permission card (`openPermission` in `server/api.ts`, the same one `permission_prompt` feeds); allow → `accept`, deny → `decline`, no answer within 30 minutes → `cancel`. `item/tool/requestUserInput` becomes the "Question for you" card (answers keyed by question id). `serverRequest/resolved` (e.g. after an interrupt) closes a card nobody answered. MCP elicitations are declined.

approvalPolicy per turn: `bypassPermissions` → `cfg.codexApprovals` (`ARIGAMI_CODEX_APPROVALS`, `never` default | `on-request` | `untrusted`); the picker's ask mode (`default`) → `untrusted`. Measured: `on-request` under danger-full-access never asks, so "ask" cannot be `on-request`. A mode change applies to the next turn with no respawn. On exec: `permissions.kind === 'none'`, no cards. `permission_prompt` stays hidden from codex tools/list (`ARIGAMI_ENGINE=codex`).

### 3. Agents with an allowlist run — the policy hook is enforced

Codex reads Claude Code's hooks format from `$CODEX_HOME/hooks.json` (same stdin shape; `tool_name`
is `Bash` for its shell, `mcp__<server>__<tool>` for MCP; exit 2 blocks). `codexPrepare()` writes the
`mcp/policy-hook.js` hook there for a restrictive agent. exec: `codexBuildSpawn()` adds
`--dangerously-bypass-hook-trust` — without it codex skips hooks silently. app-server: that flag does not reach its threads (measured, `hooks/list` → `untrusted`), so the handshake trusts this home's `hooks.json` in-process (`hooks/list` → `config/batchWrite` `hooks.state.<key>.trusted_hash`) before `thread/start`; verified live, the hook blocked a Bash call. No `--disallowedTools`:
restricted built-ins are hook-denied, not hidden; extension servers the allowlist never touches are
left out of `config.toml`. Codex's snake_case built-ins are aliased onto claude names in `agent-policy.ts`.

### 4. Remote MCP grants are per engine

Claude's grants (`claude mcp login`) can't be used by codex. A codex session loads a `url` server only when codex holds its own grant: `codex mcp login <name>` under one host-wide `$ARIGAMI_DIR/codex-mcp` home (`mcp_oauth_credentials_store="file"`, server url passed as `-c`), written to `.credentials.json` keyed `<name>|<hash>` like Claude's, and linked into every session's `$CODEX_HOME`. Ownership stays in the same `connections.json` records (`agent:<slug>` / global). Verified on this VPS 2026-09-15 (codex-cli 0.153.4): the login prints the authorize URL headless, Linear consent on the session Chrome landed on the loopback, and a codex turn called `linear.list_teams` through the linked file.
Claude-only grants get one chat note per session. Bearer rows (GitHub) are not wired for codex. A token refresh that replaces the linked file is copied back to the shared file on the next spawn.

### 4b. External MCP servers: composio-mcp yes, claude.ai connectors no

Host-managed stdio servers (`composio-mcp`) live in `$ARIGAMI_DIR/mcp-servers.json` (`server/lib/mcp-servers.ts`), seeded once from `~/.claude.json`; codex gets them as `[mcp_servers.<name>]`, claude keeps reading `~/.claude.json`, and a Composio key change updates both.
Codex's `enabled_tools` takes exact names, so A3 drops an untouched server whole and the policy hook gates partial families (`gmail` → `GMAIL_*`).
claude.ai connectors (`mcp__claude_ai_*`) are claude.ai-account features with no codex equivalent — a codex session never has them.

### 5. The model ladder runs (P2-6); compaction closed with app-server

The RES1 supervisor ticks codex sessions too, with claude-only actions gated per engine (P0-1). Quota recovery runs on codex (`server/codex-recovery.ts`, pure half `server/lib/codex-quota.ts`): rotate the codex pool, then one rung of `cfg.codexModelChain` (`ARIGAMI_CODEX_MODEL_CHAIN`, default terra → luna → 5.5, filtered to the active account's catalog), same badge/restore/incidents as RES1. The Claude auth refresh is skipped; a codex 401 gets a chat line pointing at Settings › Connections › Accounts.

app-server: `thread/compact/start` returns `{}` at once and runs as its own turn with a `contextCompaction` item (no `thread/compacted` notification observed). Arigami uses it for "compact now" / `/compact`, for auto-compact (`setAutoCompact` stores the threshold without a respawn; crossing it on `thread/tokenUsage/updated` compacts once the turn ends), and for LADDER1: `downgradeCodexModel` plans the replay against the target rung's window and, when it does not fit, compacts the thread on the new rung before replaying the message (incident `context-compact`, digest `codex`). The history is compacted in place — no original thread is parked for the climb back.

exec: compaction was tested and does not happen (`model_auto_compact_token_limit=3000`, both scopes, `--enable context_management`: a thread grew to 41,474 tokens with no compaction); the context modal hides it and `POST /autocompact` returns 400.

### 6. Thinking — closed with app-server

app-server: a completed `reasoning` item's `summary`/`content` (else its streamed `item/reasoning/*Delta` text) → a `thinking` event on completion; seen live on gpt-5.5 medium (empty on low). exec never emits reasoning, even at high effort with `model_reasoning_summary="detailed"` (`test/fixtures/codex-stream/reasoning-test-*.jsonl`).

Also on app-server: agent message deltas stream as partial assistant text; a `fileChange` shows as an `Edit` card carrying the patch and +/- counts; `turn/diff/updated` stamps `session.claude.turnDiff` and an open Changes tab reloads; image attachments go as `{type:'localImage', path}` input.

### 6b. Quota (rate limit) detection — regex, then confirmed by the account

app-server: `account/rateLimits/updated` arrives with every request and lands in the account's usage cache (`usage.js noteLiveUsage`, broadcast like a poll); recovery uses that snapshot when under 2 minutes old instead of spawning a probe, and a failed turn's `codexErrorInfo` `usageLimitExceeded`/`rateLimitExceeded` counts as a limit. The turn's own error text is otherwise still a regex guess (`CODEX_LIMIT_RE` in `server/lib/codex-quota.ts`; only the `unexpected status <code>` wrapper is verified live, on a 401). A match triggers `account/rateLimits/read` on the session's codex account:
`limitReached` or a window at ≥ 100% = confirmed (note says so, account quarantined until that window's `resetsAt`, rotate / ladder); not exhausted = a note, nothing else; unreadable (api-key, probe failed) = "unverified" note, and it acts only on the specific patterns (429, the `RateLimitReachedType` names, "usage limit"). No real quota wall has been reproduced here.

### 7. The session inherits the host's env in full

The codex process receives the host's entire `process.env` (except for
`CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY`, which are explicitly stripped), including
`ARIGAMI_TOKEN` — a live token that talks to the real host.

**This is parity with claude, not a regression.** A claude session works exactly the same way. It's spelled out
here explicitly because, with no sandbox (limitation 1) and approvals off by default (limitation 2), this is what a
codex session can reach without anyone stopping it.

### 8. `~/.codex/skills/.system/` is wiped on every upgrade

This is Codex's own bundle — it's deleted and rewritten on every CLI upgrade. **Nothing of
ours ever sits there, ever.** We also don't symlink it in: Arigami sessions have no use
for imagegen/skill-creator, and leaving it out saves room in skills' context budget.

### 9. `tool_timeout_sec = 1800`

Codex gives up on an MCP tool call after `tool_timeout_sec` and reports it as a failure.
Arigami's blocking home tools (`request_screen`, `permission_prompt`) wait
on a **human**, for minutes. Measured: with 15 seconds, a screen request died at exactly 15.1 seconds; with 180
seconds a real human answered in 38.35 seconds and the call went through.

So the value is pinned to the host's `SCREEN_REQUEST_TIMEOUT_MS` — 30 minutes. The
`ARIGAMI_CODEX_TOOL_TIMEOUT_SEC` knob exists mainly so the give-up path can be exercised
in seconds instead of half an hour. Lowering it in production sells a human's response time for
nothing.

### 10. Other small things worth knowing

- **An unrecognized model name is silently swallowed.** Codex falls back to its default model with no error
  and no warning, so `codexModelArgs()` filters it itself against `CODEX_MODEL_RE` and writes a
  warning to the log. Same for an unrecognized effort level.
- **`EFFORTS` in `server/codex.ts` must remain a superset** of every level the cockpit
  picker offers (`CODEX_MODELS[].efforts` in `web/src/lib/engines.js`). A level
  that reaches the server and isn't in the set gets dropped, and the turn runs at the model's default while
  the UI keeps showing the level the human chose.
- **Context window + model come from codex itself.** The rollout's last `turn_context` (model) and
  `token_count` (last request usage, `model_context_window`) under `$CODEX_HOME/sessions`, else the
  catalog row (`context_window × effective_context_window_percent`).
- **Effort is validated per model** (`effortLevels()` on the driver); `minimal` is accepted when the model has no catalog row.
- **Cost is `null`, not 0.** Codex reports none; the ledger and agent page show "tokens only".
- **The `/usage` tab doesn't exist in a codex session.** It measures a Claude subscription and **account**;
  a codex session has neither.
- **The permission-mode picker for codex:** app-server offers ask vs bypass (`permissionModesFor()` in `web/src/lib/engines.js`, transport from `cfg.codexTransport` in `GET /__api/config`); exec shows a static `bypassPermissions` line instead — a picker there would be a lie.
- **The "refresh model list" button and the CLI-update badge are not shown in a codex session** — both
  talk about claude's CLI.
- **Deleting a session cleans up its `$CODEX_HOME`** (`config/codex/<sessionId>`) — that's where
  the conversation history lives.

## Host utilities (one-shots)

`runOneShot(prompt, {engine})` in `server/lib/oneshot.ts`: claude = `claude -p`, codex = `codex exec --ephemeral -o` in a scratch `$ARIGAMI_DIR/oneshot-codex/` home.
Explain/review/summary run on the session's engine; memory episodes, LEARN1, skills analyze, the wizard health ping and the voice fallback run on `hostEngine()`: the default engine (`defaultEngine()`, claude unless set) when it has a connected account, else the engine that has one — by design, so a codex-only host with no default set runs them on codex. The LADDER1 digest and token verify stay claude-only.

## Accounts are per provider

An account (`server/accounts.js`) carries a `provider` — `claude` or `codex` (`server/lib/providers.ts`,
client mirror `web/src/lib/providers.js`). A provider is bound to the engine that consumes its
credential, and nothing crosses the line: `pickSessionAccount(provider)` pins a new session to an
account of its engine's provider, `nextAvailable()` never rotates a claude session onto a codex login
(or back), `tokenForSession()` ignores codex accounts, and `setActive()` is per provider
(`activeIds`; the file's `activeId` stays the claude one for anything that reads the old shape).
Records written before the field existed load as `claude`.

Codex account types, next to claude's `keychain` / `oauth-token`:

- **`codex-home`** — the machine's own `codex login` (`~/.codex/auth.json`, or `ARIGAMI_CODEX_HOME`),
  seeded on first run exactly like the keychain account: a live pointer, never copied, not removable
  from the cockpit, marked `codex-home-stale` in a backup because it cannot travel.
- **`chatgpt`** — minted by the standard `codex login` (`server/codex-account.ts`), run under the pty
  bridge because codex block-buffers its output on a pipe: codex prints the authorize URL and serves
  the OAuth callback on `127.0.0.1:1455` (a loopback on the HOST). If the human's browser is on the
  host machine the redirect lands by itself; otherwise the browser is sent to
  `http://localhost:1455/auth/callback?code=…&state=…`, which cannot load there — the cockpit asks for
  that address and the host forwards it to the loopback (`POST /__api/accounts/login/code`), so codex
  still owns the exchange and the file format. Then codex writes `auth.json` and exits; the cockpit
  polls `GET /__api/accounts/login/status` until it's done. One login at a time (the port is fixed).
  `codex login --device-auth` (URL + one-time code, no paste-back) exists but ChatGPT workspaces can
  have it disabled ("contact your workspace admin to enable device code authentication") — it did
  on the first real try, so it is not used.
- **`api-key`** — an OpenAI API key. `codex login --with-api-key` accepts anything (a bogus key is
  "Successfully logged in" — measured), so the host validates it against `GET /v1/models` first.
  Billed per request, no plan windows.

Codex credentials are **not** stored in `accounts.json`: codex refreshes its own `auth.json` in place,
so the file has to stay a real file the CLI can write. Each `chatgpt` / `api-key` account owns
`$ARIGAMI_DIR/codex-accounts/<id>/auth.json` (0600), and a session's `$CODEX_HOME/auth.json` is a
symlink to the login of the account the session is pinned to (`codexAuthPathFor`). Removing the
account removes the directory. The directory travels in a full backup like the rest of the state dir.

Identity and quota come from `codex app-server` (`account/read`, `account/rateLimits/read`) run for a
few seconds under the account's own home — no turn is spent. The numbers land in the same
`{session, week}` shape the cockpit already draws, with each window's length attached
(`windowMins`), because codex's windows are a property of the plan: a free account has one 30-day
window, a paid one 5 hours + a week. The rate-limit regex in `codex.ts` (limit 6b) is no longer the
only quota signal, but it is still what the *turn* reports.

REST (generic, provider in the body): `GET /__api/accounts/providers`, `POST /__api/accounts
{provider, label, token}` (the paste path), `POST /__api/accounts/login/start {provider, label}`,
`GET …/login/status?id=`, `POST …/login/code`, `POST …/login/cancel`. The flow id prefix says which
module owns it (`oauth_` claude PKCE, `cdx_` codex device-auth, `auth_` the legacy setup-token
scrape); the older `/__api/accounts/oauth/*` routes are unchanged for the `connect-claude` playbook.

## The rule for text in the UI

A string that describes the **engine** (who's working right now, who's requesting the screen, whose
capabilities these are) must follow `session.engine` — that's why the locales hold a placeholder
`{engine}` and not the word "Claude". A string that describes **Arigami**, or that genuinely describes
the Claude Code CLI itself (its installation, its keychain item, its subscription
usage), keeps saying Claude. The two helpers for this:
`engineLabel()` and `engineTermName()` in `web/src/lib/engines.js`.
