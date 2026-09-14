# Agent Engines (engines)

**Engine** is the CLI that actually runs the session's turn. Until now there was only one — `claude`.
Today there are two: `claude` and `codex` (OpenAI's CLI). The choice is made once,
at session creation, and is stored in `session.engine`.

- The seam: `server/lib/engine-driver.ts` (`EngineDriver`, `registerEngine`, `pickEngine`)
- The implementations: `server/claude.js` and `server/codex.ts`
- Cockpit side: `web/src/lib/engines.js`
- Tests: `test/codex-engine.test.ts`, `test/engine-ui-wiring.test.js`, `test/engine-ui-web.test.js`

## How it's chosen

In the launcher, the engine picker is the first select of four, because it determines the content of two
of the others: the model list and the effort levels are per-engine, not a shared vocabulary.

- **claude** — the model list is pulled from the CLI (`server/models.js`), and the effort scale
  is uniform across every model (`--effort`, low…max).
- **codex** — the list is static in `web/src/lib/engines.js` (copied from
  `$CODEX_HOME/models_cache.json`, codex-cli 0.153.4). Effort isn't a flag but a config
  key, `model_reasoning_effort`, and the scale is a property of the **model**:
  gpt-5.6-terra adds `ultra` above `max`, and gpt-5.5 stops at `xhigh`.

Resolution (`agents.engineForSpawn` + `state.createSession`): explicit `engine` → the agent's engine →
the parent's engine (children spawned with a master) → `cfg.defaultEngine` (Settings › Host, `POST
/__api/config/default-engine`) → `claude`. An unknown `defaultEngine` reads as claude. Cron, the Brain,
the PM controller and agent homes without an engine all land on the default; the launcher's toggle starts on it.

An engine with no registered driver fails loudly at spawn, and does not silently fall back to claude.

## What works on Codex

Verified live, not in theory: the session comes up in the cockpit, receives a message, calls
Arigami's home tools via MCP (`set_status`, `publish_artifact` were measured), and `codex exec resume` remembers
previous turns. Skills pass through verbatim via a symlink —
`$CODEX_HOME/skills/arigami` → `SKILLS_DIR` — and the namespace comes out as `arigami:<name>`,
exactly the name the persona already promises. All 13 skills load with no frontmatter warnings.

The chat log, the bus, personas, memory bootstrapping, "simple" mode, worktrees, and the cockpit —
all of it is engine-agnostic and untouched.

Two structural differences worth knowing before debugging:

1. **One process per turn.** `codex exec` is not a long-lived conversation over stdin/stdout.
   It reads a single prompt, runs one turn, and exits 0. The next turn is a fresh
   `codex exec resume <thread_id>` against the same `$CODEX_HOME`. Practical consequence:
   stdin sits at EOF for the entire turn.
2. **The conversation id is observed, not assigned.** codex has no `--session-id`; it invents an id
   and announces it in `thread.started`.

## Limitations — what doesn't work, explicitly

This list is the reason this document exists. Do not soften it.

### 1. No local sandbox

Codex's built-in bubblewrap **does not come up on this machine** —
`bwrap: loopback: Failed RTM_NEWADDR`. So the process always runs with
`--dangerously-bypass-approvals-and-sandbox`, not as an option but forced in code.
The only isolation that remains is the session's worktree.

Claude has separation that doesn't exist here: permission modes, the PreToolUse hook, `--disallowedTools`.
A codex session is, permission-wise, the equivalent of `bypassPermissions` — always.

### 2. No live approval bridge

`codex exec` has no equivalent of `--permission-prompt-tool`. Hence
`permissions.kind === 'none'`: no approval card in the chat, and no action ever stops
to ask. Real approval exists only in Codex's `app-server` track — **which is not implemented here**.

### 3. Agents with an allowlist run — the policy hook is enforced

Codex reads Claude Code's hooks format from `$CODEX_HOME/hooks.json` (same stdin shape; `tool_name`
is `Bash` for its shell, `mcp__<server>__<tool>` for MCP; exit 2 blocks). `codexPrepare()` writes the
`mcp/policy-hook.js` hook there for a restrictive agent and `codexBuildSpawn()` adds
`--dangerously-bypass-hook-trust` — without it codex skips hooks silently. No `--disallowedTools`:
restricted built-ins are hook-denied, not hidden; extension servers the allowlist never touches are
left out of `config.toml`. Codex's snake_case built-ins are aliased onto claude names in `agent-policy.ts`.

### 4. Remote MCP grants are skipped

Codex has its own credential store (OAuth) under `$CODEX_HOME`. A grant Arigami issued for
claude simply isn't usable there, so `url`-type MCP servers **are skipped** when building the config.
A remote server you want in a codex session will need its own, separate OAuth.

### 5. The model ladder doesn't run; compaction **was actually tested and found not viable** from `exec`

RES1 (dropping to a weaker model when the quota runs out, and climbing back) is claude-shaped and
**does not run** on a codex session — unchanged. The supervisor skips the ladder, the account switch and
the Claude auth refresh there; a codex 401 gets a chat line pointing at Settings › Connections › Accounts.
The context modal hides auto-compact and "compact now", and `POST /autocompact` returns 400.

LADDER1 (compacting the context before replay) **was tested, not just assumed not to run.** The
binary has two real config keys — `model_auto_compact_token_limit` (a token threshold)
and `model_auto_compact_token_limit_scope` (`total` | `body_after_prefix`) —
that look like the built-in implementation missing here. I ran five real turns on the same thread with
`-c model_auto_compact_token_limit=3000` (both scope values, separately), and also with
`--enable context_management` (the flag that gates these keys — they're listed as "under
development" in `codex features list`) — until the context grew to 41,474 tokens,
**about 14x the configured threshold, and no compaction ever happened**: no `context_compaction` or
`compaction_trigger` event appears in the stream, and `cached_input_tokens` only grew from turn to turn, never
shrinking.

A plausible explanation (not just a guess): the call that actually **triggers** compaction —
`thread/compact/start` — exists only in the app-server protocol (JSON-RPC), not
in `exec` (limitation 2 above). Whoever calls it is probably the interactive client (the TUI), which runs
as a single long-lived process and watches usage between turns. `codex exec` is **one process per
turn**; there is no live process between turns that could "watch" anything, so even if the watcher exists
in the core, the run pattern Arigami uses can't trigger it.

**Conclusion: compaction is not achievable via `exec` without implementing app-server. A codex session
that gets stuck on the context quota stays stuck — no safety net, exactly as written here before.**
Anyone who wants to try again: don't settle for adding the key to config.toml and thinking you're done —
that's exactly what was tried here.

### 6. `item.type === 'reasoning'` was never observed — even at full effort

Handling for it exists in `handleEvent`, but **it did not appear in any real run**, including
a dedicated run with `gpt-5.6-terra`, `model_reasoning_effort="high"` and
`model_reasoning_summary="detailed"` (fixture:
`test/fixtures/codex-stream/reasoning-test-*.jsonl`). The `usage` returned from that same
run did report `reasoning_output_tokens: 73` — the model **does** reason — the item is simply
never emitted on the `exec --json` stream, even with every flag that's supposed to surface it. The handling
in `handleEvent` remains written defensively and unproven. If someone wants to try again: this was tested
and didn't work, so it's worth looking at the app-server surface (which has `item/reasoning/textDelta`
in its protocol) before trying again on `exec`.

### 6b. Quota (rate limit) detection — defensive, **not verified**

Codex has a documented type `RateLimitReachedType` (`rate_limit_reached`,
`workspace_owner_credits_depleted`, `workspace_member_credits_depleted`,
`workspace_owner_usage_limit_reached`, `workspace_member_usage_limit_reached`)
— but it's a field embedded in the `account/rateLimits/updated` notification of the
app-server protocol, not of `exec`. I did not try to reproduce a real quota hit: that would require
actually consuming a live account's entire quota, and there's no justification for that just to
document an error message. **The detection in `handleEvent` (`rateLimitNote()` in `server/codex.ts`)
is a guess, flagged as such in the code** — a regex over the text of `turn.failed`/`error` (the pattern `unexpected
status <code> ...` was verified live on a 401, the `error-noauth` fixture; the hypothesis that code 429
wraps the same way, and that the enum names might be embedded as words in the error body, was not verified).
When an error that looks like a quota hit is received, the human gets an additional system message explaining
this and explicitly noting that the detection is unverified — not just a generic error, but also not a false
show of certainty.

### 7. The session inherits the host's env in full

The codex process receives the host's entire `process.env` (except for
`CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY`, which are explicitly stripped), including
`ARIGAMI_TOKEN` — a live token that talks to the real host.

**This is parity with claude, not a regression.** A claude session works exactly the same way. It's spelled out
here explicitly because, with no sandbox (limitation 1) and no approval bridge (limitation 2), this is what a
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
- **The permission-mode picker isn't shown in a codex session.** In its place sits a line stating
  `bypassPermissions` and explaining why. A picker where "plan" could be chosen while the server runs
  `--dangerously-bypass-approvals-and-sandbox` regardless would be a lie in the UI.
  The predicate: `hasPermissionModes()` in `web/src/lib/engines.js`.
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
