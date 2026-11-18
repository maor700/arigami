# Gatekeeper — permissions for restricted sessions

A **bundled** extension: it ships with Arigami and is **off** until an admin turns it on (Settings › Extensions ›
Bundled with Arigami, or `PATCH /__api/extensions/gatekeeper {"enabled":true}`). While it is off it is not loaded at all.
While it is on, a session without a profile (a **Full** session) is spawned and served exactly as before: its tools go
only to restricted sessions (`"audience": "restricted"`), its tab is the only other thing it adds.

It does two things:

1. **The Permissions tab** — define session profiles, choose where they apply (a new session, a project folder, an
   agent, a cron job), connect the bot identities, set the scope and the approvers, and read every decision.
2. **The gatekeeper** — the bot identities live here and nowhere else. A restricted session holds no credentials; it
   asks the gatekeeper's MCP tools, which do only what the session's profile grants, inside the configured scope.

## Who decides what

Every call passes four checks, all in this extension's code (`lib/decide.ts`), none in the model:

| check | where the facts come from |
|---|---|
| the caller is a restricted session | the host's MCP gateway attaches the caller's id, effective profile, host-recorded ancestors and cwd to each call (`_meta`); the arguments never say who is calling |
| its profile grants the action | `profile.grants` — `gatekeeper:<service>.<action>`, narrowed by intersection for children like every other profile field |
| the target is in scope | the one repo (and its branches, never the default or a protected one), the session's own incident thread, the Linear team (/project), the Sentry project, the listed alert rules |
| a sensitive action is approved | **merge, revert, alert-rule change**: an operator's message in the session's own incident thread — the message's **author user id** must be a configured operator, it must say the verb (`merge` / `revert` / `apply`), not be quoted, not be a bot's, be fresh, name no other PR, and it is used once. For a merge, the **auto-rule** may approve instead: CI green on the head commit + an approving review on that same commit (not by the author, optionally only from listed reviewers). Display names, quotes and the session's word never count. |

Every decision is one JSON line in `$ARIGAMI_DIR/gatekeeper/audit.log`:
`{ts, session, profile, tool, action, target, decision: allowed|refused|failed|config, reason?, approval?, result?}`.
A refusal reaches the model as `denied by the gatekeeper: <reason>`.

## Grants and tools

| grant | tools | needs approval |
|---|---|---|
| `gatekeeper:slack.read` | `slack_read_thread`, `slack_read_channel`, `slack_bind_thread` | |
| `gatekeeper:slack.post` | `slack_thread_say` (own thread only; no @channel/@here) , `slack_bind_thread` | |
| `gatekeeper:github.read` | `github_get_pr`, `github_list_prs`, `github_run_logs` | |
| `gatekeeper:github.push` | `github_push` | |
| `gatekeeper:github.pr` | `github_open_pr`, `github_pr_note` | |
| `gatekeeper:github.review` | `github_request_review` | |
| `gatekeeper:github.merge` | `github_merge` | operator or auto-rule |
| `gatekeeper:github.revert` | `github_revert` (opens the revert PR) | operator |
| `gatekeeper:linear.read` | `linear_get_issue` | |
| `gatekeeper:linear.write` | `linear_update_issue`, `linear_add_note`, `linear_create_issue` | |
| `gatekeeper:sentry.read` | `sentry_get_issue`, `sentry_list_issues`, `sentry_get_alert_rule` | |
| `gatekeeper:sentry.note` | `sentry_add_note` | |
| `gatekeeper:sentry.resolve` | `sentry_set_status` (resolved / unresolved) | |
| `gatekeeper:sentry.alerts` | `sentry_update_alert_rule` | operator |

`gatekeeper_status` (no grant) tells a session what it may do and where. Tool names match on both engines: claude
calls them `mcp__ext-gatekeeper__*`, codex `mcp__ext_gatekeeper__*`; the host's policy folds the server segment
(`agent-policy.ts mcpCanonical`), so one profile entry covers both. A profile that grants anything here also
needs `ext:gatekeeper` in its tools (the tab adds it).

No tool name reads as "send / post / reply / comment": the host would turn those into owner Send cards. A restricted
session's writes are already confined here (its own thread, its own repo, its team, its project), and running them
autonomously inside those limits is the point.

### The incident thread

A session writes and reads approvals only in its **bound** thread. A binding never changes; children inherit their
parent's. It is made, in this order:

1. **by an admin** (Activity tab), or **from the session's origin**: whoever creates the session records where it was
   started — `POST /__api/sessions {metadata: {origin: {kind: "slack", channel, thread_ts}}}`. `origin` is a
   host-protected key (a restricted session can neither set it for a child nor change its own), and a child inherits
   its parent's. The first gatekeeper call binds it automatically.
2. **from a Slack listener** the session or an ancestor armed on a thread of the incident channel (host-recorded, but
   chosen by the session), or **from a `thread_ts` a Slack/approval tool names** (`slack_thread_say`,
   `slack_read_thread`, `github_merge`…), or `slack_bind_thread`. These are the session's own claims, so they bind
   only to a thread in the incident channel whose root an allowed alert source or an operator posted (`threadOpeners`;
   off with `bindOnFirstUse:false`), and in such a thread an operator approval counts only if it is **newer than the
   session** — a session cannot pick an old thread where an operator once said "merge" for something else.

A session started by a listener event is an existing session woken up, so (2) covers it; a session born of a cron
run or a dispatch has no Slack origin unless its creator records one.

### Waking up on the thread (`triggers: "own-thread"`)

A profile's `triggers` is `false`, `"own-thread"` or `true`. `"own-thread"` lets a session arm exactly one kind of
listener: a Slack listener on **its own recorded thread** (`metadata.origin`, its own or its nearest ancestor's), on
itself — it wakes only that session and, like every listener, ends when the session is archived or deleted. Cron (the
host's and the CLI's own), other threads, whole channels and every other listener type are refused with the reason.
The host is the judge (`server/session-profile.ts ownThreadListenerRefusal`); the gatekeeper hands it the thread: when
it binds a session that has no origin yet, its tool result carries `_meta.arigami/origin`, and the MCP gateway — for an
extension with the `session:origin` permission — records it once as `metadata.origin` (never changed afterwards, never
shown to the model).

### Who is a person in Slack

A message is a bot's only when Slack marks it so: a `bot_id`, or subtype `bot_message`. A message whose `user` is an
operator and that carries no `bot_id` is the operator, even when an app sent it (`app_id`): Slack sets `user` from the
token that posted; a bot token always adds a `bot_id`, and display-name/icon overrides need a bot token too. The only
way to post with `user: <operator>` and no `bot_id` is a user token of that operator — the operator, or an app the
operator personally authorised to write as them (their own delegation).

### Pushing without a token

`github_push` reads the commits from a checkout **inside the session's own directory** into a bare mirror the
gatekeeper owns (`$ARIGAMI_DIR/gatekeeper/git/<session>.git`) — with `-c` overrides, so hooks, fsmonitor or pack hooks
in the session's `.git/config` never run — and pushes from there to `https://github.com/<the repo>.git` with the
installation token in a `GIT_CONFIG_*` header of that one git process. The token is minted per hour by the GitHub App
and narrowed to the one repository (`repositories: [name]`).

## Where things live

```
$ARIGAMI_DIR/gatekeeper/   (0700)
  identities.json  0600   GitHub App (appId, installationId, privateKey), Slack bot token, Linear key,
                          Sentry token (+ optional alerts token, used ONLY after an operator approval)
  config.json      0600   scope + approvers (see the tab, Connections)
  state.json       0600   thread bindings, approvals already used
  audit.log        0600   decisions
  git/                    push mirrors
```

Credentials are not in `extensions.json` (whose secrets become a tool server's env), not in any session's env, argv,
files or tool results. The tool server that holds the code runs once, in the host's MCP gateway, never as a child of a
session; it refuses to act when called any other way (`ARIGAMI_MCP_GATEWAY=0`).

**Limit until isolation (phase 4):** a restricted session still runs as the host's OS user, so `Bash` could read
`$ARIGAMI_DIR/gatekeeper/` like any other file of that user. Running restricted sessions in a container / as another
user (or the gatekeeper as a sidecar with the store mounted only there) closes that; nothing in this extension changes.

## Model calls without the Claude token (design, not built)

A restricted session also holds the engine's credential (`CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY`, or codex's
`auth.json`). The same pattern removes it:

- The host serves `/__model/v1/*`, authenticated by the session's own `ARIGAMI_TOKEN` (already per session).
- A restricted session is spawned with `ANTHROPIC_BASE_URL=<host>/__model` and `ANTHROPIC_AUTH_TOKEN=${ARIGAMI_TOKEN}`
  and **without** the real token; codex gets the equivalent `model_providers` entry with `env_key = ARIGAMI_TOKEN`.
- The proxy swaps in the real credential, forwards to the provider, streams back, and on the way enforces a per-session
  token / cost cap (benchmark S15) and logs usage per session.
- Full sessions are spawned exactly as today (no proxy in their path, R01/R03).

Not built here because it belongs in the core spawn (`server/claude.js`, `server/codex.ts`), not in an extension, and
because OAuth subscription tokens need care with the provider's terms; it is a follow-up of its own.

## Bench / test instance

1. Turn it on: `PATCH /__api/extensions/gatekeeper {"enabled":true}` (admin token; the instance must run this code).
2. Identities and scope: either the tab (Connections), or write `$ARIGAMI_DIR/gatekeeper/identities.json` and
   `config.json` (0600) directly on the instance.
3. Profile: add grants and `ext:gatekeeper` to the restricted profile, e.g.

```json
{ "tools": ["git", "ext:gatekeeper"], "hostTools": ["task_session", "send_message", "list_sessions", "delete_session", "restart_session"],
  "desktop": "none", "talkTo": ["parent", "children"], "maySpawn": true, "triggers": "own-thread", "hostRoutes": [],
  "grants": ["gatekeeper:slack.read", "gatekeeper:slack.post", "gatekeeper:github.read", "gatekeeper:github.push",
             "gatekeeper:github.pr", "gatekeeper:github.review", "gatekeeper:github.merge", "gatekeeper:linear.read",
             "gatekeeper:linear.write", "gatekeeper:sentry.read", "gatekeeper:sentry.note", "gatekeeper:sentry.resolve",
             "gatekeeper:sentry.alerts"] }
```

4. The audit log the bench reads as `gatekeeper.log`: `$ARIGAMI_DIR/gatekeeper/audit.log`.
