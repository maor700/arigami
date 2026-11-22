# Agent Engines (engines)

**Engine** is the CLI that actually runs the session's turn. Until now there was only one — `claude`.
Today there are three: `claude`, `codex` (OpenAI's CLI) and `gemini` (Google's Antigravity CLI, `agy`). The choice is made once,
at session creation, and is stored in `session.engine`.

- The seam: `server/lib/engine-driver.ts` (`EngineDriver`, `registerEngine`, `pickEngine`)
- The implementations: `server/claude.js`, `server/codex-app.ts` (codex over `codex app-server`, default), `server/codex.ts` (codex over `codex exec`, fallback) and `server/gemini-acp.ts` (gemini over `agy acp`; pure helpers in `server/lib/gemini-cli.ts`)
- Cockpit side: `web/src/lib/engines.js`
- Tests: `test/codex-app.test.ts`, `test/codex-engine.test.ts`, `test/gemini-acp.test.ts`, `test/gemini-parity.test.ts`, `test/engine-ui-wiring.test.js`, `test/engine-ui-web.test.js`

## How it's chosen

In the launcher, the engine picker is the first select of four, because it determines the content of two
of the others: the model list and the effort levels are per-engine, not a shared vocabulary.

- **claude** — the model list is pulled from the CLI (`server/models.js`), and the effort scale
  is uniform across every model (`--effort`, low…max).
- **codex** — the list comes from the engine at runtime (`codex app-server` `model/list` under the active
  login, 5-min cache; its `models_cache.json` only while that call is in flight; no hardcoded rows). Effort isn't a flag but a config
  key, `model_reasoning_effort`, and the scale is a property of the **model**:
  gpt-5.6-terra adds `ultra` above `max`, and gpt-5.5 stops at `xhigh`.
- **gemini** — the list is what Antigravity offers the signed-in account (`session/new` → `availableModels`,
  cached in `$ARIGAMI_DIR/gemini-models.json`; `GET /__api/models` → `gemini`, same row shape as codex). Effort is the
  tail of the model id (`gemini-4-neon-high`), so the model is a family (`gemini-4-neon`) and the levels are the
  family's own.

Resolution (`agents.engineForSpawn` + `state.createSession`): explicit `engine` → the agent's engine →
the parent's engine (children spawned with a master) → `cfg.defaultEngine` (Settings › Host, `POST
/__api/config/default-engine`) → `claude`. An unknown `defaultEngine` reads as claude. Cron, the Brain,
the PM controller and agent homes without an engine all land on the default; the launcher's toggle starts on it.
When the default engine is not signed in, the first one that is (claude, codex, gemini) is used instead.

An engine with no registered driver fails loudly at spawn, and does not silently fall back to claude.

## What works on Codex

Verified live: the session comes up in the cockpit, receives a message, calls Arigami's home tools via MCP, and resumes previous turns. Skills pass through via a symlink — `$CODEX_HOME/skills/arigami` → `SKILLS_DIR` — as `arigami:<name>`. The chat log, bus, personas, memory, Simple mode, worktrees and the cockpit are engine-agnostic.

### Transport: app-server (default) or exec

`cfg.codexTransport` (`ARIGAMI_CODEX_TRANSPORT`), read at boot: `server/index.ts` imports `codex-app.ts`, which registers the `codex` driver for the transport.

- **`app-server`** — one long-lived `codex app-server` per session, newline-delimited JSON-RPC over stdio. Handshake: `initialize` → `initialized` → `thread/start`, or `thread/resume` when a thread id is stored (a thread with no turn has no rollout and starts over silently). A message is `turn/start` when idle and `turn/steer` into the running turn otherwise (no carry-over); Stop is `turn/interrupt`; `/compact` is `thread/compact/start`. The process lives across turns; the session goes idle on `turn/completed` and is marked dead only when the process exits (the next message respawns it). Verified live 2026-09-15 (codex-cli 0.153.4): turn + tools, steer merged into the running turn, approval card deny → declined, interrupt, compaction, image input, thinking; fixtures `test/fixtures/codex-app/`.
- **`exec`** — `server/codex.ts`, unchanged: `codex exec` per turn, `codex exec resume <thread>` for the next one, stdin at EOF during the turn, a mid-turn message carried over to the next turn. No approvals, compaction or thinking (limits 2, 5, 6 below still hold there).

The thread id is observed, not assigned, on both transports.

## What works on Gemini

The `gemini` engine is Google's Antigravity CLI (`agy`) in ACP mode: one long-lived `agy acp` per session, newline-delimited JSON-RPC over stdio (`server/gemini-acp.ts`, pure helpers in `server/lib/gemini-cli.ts`). It uses agy's own Google login (`~/.gemini/antigravity-cli/`; `ARIGAMI_GEMINI_HOME` — or the older `ARIGAMI_GEMINI_DIR` — points agy at another home via `agy acp --gemini-dir`) — the driver injects no token. Missing CLI or missing login fails the spawn with a sentence that says which.

Verified live 2026-11-22 (agy 1.5.14, gemini-3.8-flash), through the real driver against a real `agy acp`: a turn with a shell command and a file write, an approval card answered deny, kill + resume of the same conversation, interrupt, a restricted agent refused by the pre-tool hook with the reason read back by the model, an edit put on a card in ask mode, a skill run by `/arigami-user:<name>`; and by direct ACP runs: thinking, MCP tools through the gateway, image input, `/compact`, model switching, the question tool, the 3-minute tool timeout. Fixtures: `test/fixtures/gemini-acp/`. **Not yet run inside the cockpit** — that needs a host restart.

- **Handshake.** `initialize` → `session/new` (or `session/resume` with the stored id; the id is observed) → `session/set_model` → `session/set_mode`. A conversation agy no longer has starts over and says so in the chat.
- **MCP.** The same set a claude session gets (arigami, extensions, Composio, host-held grants), sent in `session/new` as http entries with `Authorization: Bearer <session token>` — in memory, on stdin, never in a file or argv. Tool names arrive as `mcp_<server>_<tool>` and are shown and policy-checked as `mcp__<server>__<tool>`.
- **System prompt.** The first-turn blocks, the persona and the memory snapshot go as `_meta.antigravity.systemPrompt.append` instead of a prefix on the first message. agy keeps it with the conversation (measured), so a resume sends none.
- **The session's own dir.** `$ARIGAMI_DIR/gemini/<session>/.agents/`, handed to agy as `--add-dir` (measured: agy reads hooks and skills from an added directory). Rewritten on every spawn, removed with the session. It holds the two things below.
- **Pre-tool hook** (`.agents/hooks.json` → `mcp/policy-hook.js --agy` → `POST /__api/sessions/:id/gemini/tool-check`). Before every tool call the host answers one of agy's four decisions: `deny` + reason when the agent's allowlist (A3) or a mod refuses — the model reads the reason and the turn goes on (measured); `allow` under `bypassPermissions`, for an edit under `acceptEdits`, and for reading Arigami's own skill packs and docs; `force_ask` for an edit in ask mode, because agy never asks about a workspace edit by itself (measured); `ask` (agy's own default) otherwise. An unreachable host means `ask`, or `deny` for a restricted agent. The hook is also what makes file edits visible to the allowlist.
- **Skills.** Every Arigami skill (shipped, user, extension) gets a stub `SKILL.md` in the session dir, so agy lists it as its own skill and slash command; the stub sends the agent to the real file (agy follows no symlinks and ignores `skills.json` there — measured). `/arigami:<skill> …` from the host or the composer is rewritten to "read `<pack>/<skill>/SKILL.md` and follow it". Verified live.
- **Messages.** `session/prompt` per message. A message sent mid-turn waits and becomes the next turn: a second `session/prompt` makes agy end the running one at once and leaves its command without a final status (measured, `second-prompt-flash.jsonl`).
- **Stream.** Text deltas stream as partial assistant text; thinking shows as thinking; `tool_call` / `tool_call_update` become tool cards under Claude's names (`run_command` → Bash, `write_file` → Write, `read_file` → Read, …); a finished edit stamps `turnDiff` so an open Changes tab reloads; Arigami's own tools stay out of the transcript, as on the other engines.
- **Commands.** `available_commands_update` is stored as `session.claude.capabilities.commands` (`{name, description, argumentHint}`) — agy's own commands and the Arigami skill stubs — so the Commands tab and the slash palette fill.
- **Questions.** agy's `ask_question` shows as the "Question for you" card. agy ends the turn on a question and takes the next message as the answer (measured), so the card answers with a message.
- **Context.** `usage_update` gives used tokens and the window (1,048,576) — the context meter is exact.
- **Approvals.** `permissions.kind === 'rpc-request'`. Under `bypassPermissions` every `session/request_permission` is answered allow; in ask mode it is the chat permission card (allow / deny, no answer in 30 minutes → cancelled), for commands, MCP tools and — through the hook — edits. `acceptEdits` and `plan` are agy's own `accept-edits` and `plan` modes. A mode change applies to the next call with no respawn.
- **Stop.** Interrupt is `session/cancel`; open cards are closed; queued messages are dropped.
- **Model and effort.** The session's model is a family (`gemini-4-neon`, `-argon`, `-hydrogen`, `gemini-3.8-flash`; none = Neon) and the effort a level (none = high); the ACP model id is `<family>-<effort>`, checked against `availableModels`. Neon and Hydrogen go low…xhigh, Argon and Flash low…high. A model or level the account is not offered is an error line in the chat and the session keeps running on what it had. A change applies live, with no respawn. The picker's list (`GET /__api/models` → `gemini`) is those families only — the Orchestrator and Claude/GPT-through-Google ids agy also lists are left out.
- **Model ladder and quota** (`server/gemini-recovery.ts`, pure half `server/lib/gemini-quota.ts`). Chain: `cfg.geminiModelChain` (`ARIGAMI_GEMINI_MODEL_CHAIN`, default Neon → Argon → Flash), the picked family on top, filtered to what the account is offered; a session or a gemini agent may override it. A failed turn that looks like a limit is checked against the account's quota: an unavailable / overloaded model steps one rung down, live, and replays the message; the supervisor climbs back at the backoff. A **spent quota does not step down** — every `gemini-*` model draws on one 5-hour bucket (measured: identical `remainingFraction` on all of them) — the chat says when it resets and the account is marked limited until then; only a rung outside the bucket (a Claude/GPT id agy serves, if someone puts one in the chain) is used. The error patterns are guesses: no quota wall or overload was reproduced.
- **`/compact`** is agy's own command, sent as a prompt; the chat shows "compacting" / "compacted". **Auto-compact** (`POST /autocompact`, no respawn): when `usage_update` passes the chosen % of the window agy reports, the same `/compact` runs once the turn ends — once per crossing, so a compaction that does not bring the context back under the line is not repeated. The threshold logic is unit-tested; a real crossing (≥ 50% of 1M tokens) was not reproduced.
- **Tools that wait for a human.** agy abandons an MCP tool call after exactly 3 minutes (measured: "timed out after 3m0s"). `request_screen`, `request_setup`, `sign_in`, `vault_collect` and `vault_fill` therefore answer a gemini session `{still_waiting, wait_key}` after 150 seconds, and the agent calls the tool again with the key — the same card, the same request; the host keeps a landed answer for 5 minutes.
- **Images** go as ACP image blocks; other attachments are listed by path.
- **Sign-in from the cockpit.** Capability `gemini`, its setup card, the wizard step and playbook `connect-gemini` — see "Gemini accounts and quota" below. Measured and not used by that flow yet: `agy acp --login` needs no terminal (it prints the Google link and reads the code, or the landing address, from stdin) and takes `--gemini-dir`, so it could also sign in an overridden gemini home.
- **Deleting a session** removes its dir and the conversations agy kept for it (`conversations/<id>.db`, `brain/<id>/`, `annotations/<id>.pbtxt`, `presence/<id>.lock` — measured: nothing of them remains in `session/list`).
- **One-shots.** `agy -p --output-format json` (`runOneShot`, engine `gemini`); a run that needs MCP servers (explain / review / summary), or any run under an overridden gemini home, goes over ACP like a session. Both verified live. With no gemini model named they run on the flash family at its lowest effort (from the cached list), else agy's default.

### Gemini limitations

1. **No sandbox.** agy runs with the session's env and the host's files. `agy acp --sandbox` was tried: a command still wrote a file outside the workspace (measured), so it is not used.
2. **Steering is not possible.** A mid-turn message is queued, not merged into the running turn (see Messages).
3. **A denial at the approval card ends the turn.** agy stops instead of letting the model answer (measured). A denial by the hook (allowlist, mod) does not: the model gets the reason and goes on.
4. **MCP tool results are not in the stream.** ACP reports that an MCP call finished, not what it returned — the card shows the call with an empty result.
5. **Mods see a tool call before it runs, not its result.** agy's PostToolUse carries no output and accepts no replacement (measured), so a mod can block a call or change an MCP tool's arguments, and nothing more. Changed arguments ride agy's `overwrite`; that path was not run.
6. **Any other MCP tool call longer than 3 minutes fails.** Only the wait-for-a-human tools got the resume key. No setting for the timeout is documented.
7. **A spent quota has no way around it** (one bucket for every Gemini model, one account). One-shots — the automatic status summary included — draw on the same bucket; they default to Flash at low effort.
8. **Compaction is agy's summary, not Arigami's.** What `/compact` keeps is agy's decision; nothing is parked for a climb back.
9. **Remote MCP grants need the gateway.** Host-held grants work; with `ARIGAMI_MCP_GATEWAY=0` a gemini session gets stdio servers only, a remote service's capability says so, and that path was not run. Grants made with `claude mcp login` and claude.ai connectors are Claude's.
10. **agy keeps one host-wide cache of MCP tool schemas per server name** (`~/.gemini/antigravity-cli/mcp/<server>/`). No secrets, but two sessions with different tool visibility write the same files; calls are still refused by the host.
11. **One login for every session.** agy has one Google account per home; there is no account pool and no per-session account.
12. **A command agy moves to the background is lost to the transcript.** Its card closes at the end of the turn with no output, and it is not in the session's background-shell list.
13. **Sub-agent sessions are ignored.** Updates for another ACP session id are dropped, so `/swarm`, `/teamwork` and the like show nothing of their workers.
14. **Cost is `null`**, tokens only.
15. **Not in the Docker image**, no auto-install, no CLI updater.
16. **The hook costs one short process per tool call** (bun start + a loopback request), on every gemini session.

## Limitations — what doesn't work on Codex, explicitly

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

### 4. Remote MCP grants are held by the host

With the MCP gateway on (the default), connecting a remote MCP server (Settings › Connections, a setup card, the connect-mcp playbook, or the /mcp panel's Login for a catalog server) runs the OAuth in the host itself (`server/lib/mcp-grants.ts`: discovery, dynamic client registration, PKCE, refresh via the MCP SDK). The grant lives in `$ARIGAMI_DIR/mcp-grants.json` (0600, machine-local), the vendor redirects to the host's `/__api/mcp-oauth/callback` (public, accepted only with the one-time `state` of a sign-in the host started), and every session of either engine reaches the vendor through `/__mcp/s/<grant>` under the grant's own name. A `--mcp-config` server replaces a CLI-configured one of the same name (measured on Claude Code: the dynamic entry wins and the other is never contacted), so allowlists (`mcp__linear__*`) are unchanged. Tools that send to a person (comments, reviews, messages) file an outbound card.
Grants made earlier with `claude mcp login` keep working as before until the service is connected again through the host (Settings offers "Move to Arigami" for them).

Connecting is one press, and then the host tries on its own: the consent runner (`server/lib/consent-runner.ts`) opens the vendor's consent page in the shared browser (the login vault) — or an agent's own profile for that agent's grant — follows the vendor's login through Google with real mouse clicks, approves only on the vendor's domain and only a page that names this host's callback, catches the redirect inside the browser and exchanges the code itself. It stops at the first page it does not know (a password, 2FA, a second Google account, a foreign domain) and the card asks the person there. Per-vendor steps are data in `mcp-catalog.ts` (`consent`). A grant whose refresh the vendor refuses is re-consented the same way, quietly, at most once an hour; if that needs a person, a notification says so. After a connection lands, every running session that could use it restarts in place when idle (never mid-turn); the one that asked for it is told to continue. `ARIGAMI_CONSENT_AUTO=0` turns the runner off.

With the gateway off (`ARIGAMI_MCP_GATEWAY=0`) the engine-held path below applies.

#### 4a. Engine-held grants (gateway off)

Claude's grants (`claude mcp login`) can't be used by codex. A codex session loads a `url` server only when codex holds its own grant: `codex mcp login <name>` under one host-wide `$ARIGAMI_DIR/codex-mcp` home (`mcp_oauth_credentials_store="file"`, server url passed as `-c`), written to `.credentials.json` keyed `<name>|<hash>` like Claude's, and linked into every session's `$CODEX_HOME`. Ownership stays in the same `connections.json` records (`agent:<slug>` / global). Verified on this VPS 2026-09-15 (codex-cli 0.153.4): the login prints the authorize URL headless, Linear consent on the session Chrome landed on the loopback, and a codex turn called `linear.list_teams` through the linked file.
Claude-only grants get one chat note per session. Bearer rows (GitHub) are not wired for codex. A token refresh that replaces the linked file is copied back to the shared file on the next spawn.

### 4b. External MCP servers: composio-mcp yes, claude.ai connectors no

Composio is served by the host over the MCP gateway (`/__mcp/s/composio-mcp`, `server/lib/composio-mcp.ts`) as soon as the host holds a Composio key: both engines get the same server, with the tools of the toolkits connected for the session's owner (the agent's own connected account first, else the shared one; another agent's account never). Tool names stay `mcp__composio-mcp__<SLUG>`. A tool that sends to a person (`GMAIL_SEND_EMAIL`, a calendar invite, a Drive share) files an outbound card and runs only after the owner's Send.
A hand-installed stdio `composio-mcp` (`$ARIGAMI_DIR/mcp-servers.json`, `server/lib/mcp-servers.ts`) is still honored for codex when the gateway is off (`ARIGAMI_MCP_GATEWAY=0`) or no key is set; with the gateway on, the gateway entry replaces it.
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

`runOneShot(prompt, {engine})` in `server/lib/oneshot.ts`: claude = `claude -p`, codex = `codex exec --ephemeral -o` in a scratch `$ARIGAMI_DIR/oneshot-codex/` home, gemini = `agy -p --output-format json` (ACP when the run needs MCP servers).
Explain/review/summary run on the session's engine; memory episodes, LEARN1, skills analyze, the wizard health ping and the voice fallback run on `hostEngine()`: the default engine (`defaultEngine()`, claude unless set) when it is signed in, else the first engine that is — by design, so a codex-only host with no default set runs them on codex. The LADDER1 digest and token verify stay claude-only.

## Accounts are per provider

An account (`server/accounts.js`) carries a `provider` — `claude`, `codex` or `gemini` (`server/lib/providers.ts`,
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

### Gemini accounts and quota

Provider `gemini` feeds the `gemini` engine (Google's Antigravity CLI, `agy`). One account type:

- **`gemini-home`** — the machine's own `agy` Google login in `~/.gemini` (`ARIGAMI_GEMINI_HOME` overrides; `ARIGAMI_GEMINI_DIR` is an alias), seeded like
  `codex-home`: a live pointer, not removable from the cockpit, `gemini-home-stale` in a backup. A login made after boot is
  adopted on the next `GET /__api/accounts`.

Signing in from the cockpit (`server/gemini-login.ts`, flow ids `agy_…` on the generic `/__api/accounts/login/*` routes): the
host runs `agy` under the pty bridge, presses Enter on its "Google OAuth" menu row, and hands out the authorize link agy
prints (Google redirects to `antigravity.google/oauth-callback`, which shows a code). The pasted code — or the callback
address, the host takes `code=` out of it — is typed into agy, and the flow is done when agy has written its token file;
agy is stopped before its chat opens. Only code characters are ever typed. An agy that is already signed in shows no menu
and the flow ends `done`. The same flow is the `gemini` setup capability (`POST /__api/setup/gemini`, playbook
`connect-gemini`), the third card of the engine step in the wizard / Setup / the chat's setup card, Add account › Gemini,
and "Sign in again" on a card whose login is dead (401 or signed out). Measured up to the link against the real agy in a
scratch home; the code exchange itself only against a scripted stand-in. With `ARIGAMI_GEMINI_HOME` set the sign-in still
writes to agy's default home (only `agy acp` takes `--gemini-dir`).

The token file (`antigravity-cli/antigravity-oauth-token`) is agy's. The host reads the access token from it for the calls
below and nothing else: it is never written, copied into `accounts.json`, logged, or passed to a session.

Quota (`server/gemini-account.ts`, 5-minute cache whatever the 60-second usage poll asks): `POST
https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary` and `:fetchAvailableModels`. Every Gemini
model reports one shared 5-hour bucket (`remainingFraction`, `resetTime`); it becomes the `session` window (`windowMins`
300) of the usual `{session, week}` shape, so the account card and the rail meter draw it unchanged. `week` is null. The
summary's `3p-5h` / `3p-weekly` buckets (Claude and GPT through Google) ride along as `thirdParty` and are not drawn.
The plan tier is `loadCodeAssist` → `paidTier.name` (else `currentTier.name`), cached an hour, shown on the card and in
Settings › Host › Gemini CLI (`GET /__api/host/gemini`); the email is the token file's `id_token_email`.

The access token lives about an hour and only agy renews it. When it has lapsed the last reading stays (with none, the
card says usage shows up after the next run). The host runs `agy models` to let agy renew it only while someone is
looking (Accounts or Settings › Host opened in the last 15 minutes), at most once an hour; the usage poll alone never runs agy.
Measured 2026-11-22 (agy 1.5.14): one `agy models` run on a lapsed token rewrote the file with a fresh hour.
An exhausted bucket is inferred from a missing `remainingFraction` (proto3 drops zeros) — not reproduced here.

Cockpit: the model picker lists the families `GET /__api/models` carries as `gemini` (`GEMINI_MODELS` in
`web/src/lib/engines.js` until it lands) and sends the family as `model` and the rung as `effort` (default Neon, high);
Claude/GPT-through-Google and the Orchestrator ids are not offered. All four permission modes; "compact now" and the
auto-compact threshold both work. `/usage`, the CLI-update badge and "refresh model list" are hidden in a gemini session.

## The rule for text in the UI

A string that describes the **engine** (who's working right now, who's requesting the screen, whose
capabilities these are) must follow `session.engine` — that's why the locales hold a placeholder
`{engine}` and not the word "Claude". A string that describes **Arigami**, or that genuinely describes
the Claude Code CLI itself (its installation, its keychain item, its subscription
usage), keeps saying Claude. The two helpers for this:
`engineLabel()` and `engineTermName()` in `web/src/lib/engines.js`.
