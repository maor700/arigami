# Agents ("צוות") — A1 + A2 + A3

An **agent is who**; a **session is what/when**. An agent is a persistent identity — persona,
referenced (shared) skills, its own memory namespace, default model, tool/domain allowlists and
a daily budget — that sessions can be *born from*. Sessions stay the unit of work: a session
created with `agent` inherits the agent's model, persona and skills and carries
`metadata.agent = <slug>`; a session created without one behaves exactly as before. One agent
can have many sessions; each agent also has a **home chat** — one long-lived, worktree-less
session for DMs (get-or-create).

Decisions (PRD-ARIGAMI-AGENTS, approved 2026-08-30): agents are a layer **on top of** sessions;
the Rail "צוות" section sits **below** the sessions/folders section; **no per-agent private
skills** — agents reference shared skills by name.

## Storage — `$ARIGAMI_DIR/agents/<slug>/`

```
agent.json   { slug, name, emoji, color, model?, skills: [names], tools?, domains?,
               budget?: {tokensPerDay}, homeSessionId?, createdAt, updatedAt }
persona.md   ≤ ~20 lines "who you are + limits" — injected into the first turn of every
             session born from the agent (a <system-reminder> block, like the memory snapshot)
memory/      MEMORY.md + journal/ — the agent's memory namespace (FTS scope agent:<slug>)
assets/      brand/style references — their paths are listed to the session
browser/     the agent's persistent Chrome profile (A2)
identity.json the agent's own Google identity (A2, no secrets)
```

`slug` matches `^[a-z0-9][a-z0-9-]{0,39}$` (same shape as bundle/skill names). It is derived
from the name when possible; Hebrew/other-script names need an explicit slug. Never store
secrets in an agent — `agent.json` is plain JSON that export/import will carry.

## Memory namespace

`memory_write` / `memory_search` (and `POST /__api/memory/write`, `GET /__api/memory/search`,
`GET /__api/memory?agent=`) accept `agent`. The host injects `ARIGAMI_AGENT=<slug>` into a
session born from an agent, and `mcp/host-mcp.js` defaults the namespace from it, so:

| call from an agent session          | lands in / searches                                   |
|-------------------------------------|-------------------------------------------------------|
| `memory_write({target:'memory'})`   | `agents/<slug>/MEMORY.md` (cap ~900 tokens)           |
| `memory_write({target:'journal'})`  | `agents/<slug>/journal/<day>.md`                      |
| `memory_write({target:'user'})`     | the shared `USER.md` — facts about the human are one file |
| `memory_search({query})`            | `USER.md` + episodes + `agent:<slug>` — **not** the shared MEMORY.md/journal |
| `memory_search({query, agent:""})`  | the shared view                                        |
| `memory_search({query, scope:'agent:<other>'})` | another agent's namespace (explicit)       |

The shared default view (no agent) never returns `agent:*` rows. A session born from an agent
boots with `USER.md` + the **agent's** `MEMORY.md` instead of the shared one. Every write is
still sanitized, deduped, capped and logged (undo works across namespaces — the log stores the
virtual path `agents/<slug>/…`).

## Server

- `server/agents.ts` — CRUD (`listAgents/getAgent/createAgent/updateAgent/deleteAgent`),
  validation (slug, `#rrggbb`, model, persona ≤ 4000 chars, skills must exist in the shipped
  pack or `$ARIGAMI_DIR/skills`), `personaBlock(slug)`, `agents-updated` WS broadcast.
- `server/claude.js` — `spawnProc` records `p.agent`; the first turn gets
  `URL_GUIDANCE + identity + personaBlock + memory snapshot (USER.md + agent MEMORY.md)`;
  env gets `ARIGAMI_AGENT`.
- `POST /__api/sessions {agent}` — 404 on an unknown slug; `model` defaults to the agent's
  (an explicit `model` wins); the session takes the agent's rail color; `title` defaults to the
  agent name; `metadata.agent` is stamped. The slim sessions list already carries `metadata`,
  so the Rail can badge rows.

### REST

| method | path | |
|---|---|---|
| GET | `/__api/agents` | `{agents:[AgentView]}` (record + `persona` + `assets`) |
| POST | `/__api/agents` | create; `{cardId, sessionId}` extra fields close a pending chat card |
| GET / PATCH / DELETE | `/__api/agents/:slug` | PATCH accepts any field incl. `persona`; DELETE removes the dir, sessions stay |
| GET | `/__api/agents/:slug/home` | get-or-create the home session → `{session, created}` (201 when created; an archived home is restored) |
| GET | `/__api/agents/:slug/activity` | `{sessions:[…, home:boolean], episodes:[…]}` — episodes of the agent's sessions |
| POST | `/__api/agents/cards/:cardId/cancel` | the human said no to a pending card |
| POST | `/__mcp/agent-card` | the MCP tools' backend (below) |

### MCP tools (`mcp/host-mcp.js`)

- `create_agent({name, slug?, emoji?, color?, model?, persona?, skills?, tools?, domains?, budget?, confirm?})`
  — `confirm` defaults to **true**: the host posts an editable `{kind:'agent-card'}` in the
  calling session's chat and returns `{card:true, cardId, state:'pending'}`; nothing is written
  until the human clicks **צור סוכן** (→ `POST /__api/agents`, the card flips to `created` and the
  session gets a `[host] …` message with the slug) or **בטל**. `confirm:false` creates at once.
- `list_agents()` — the team.
- `update_agent({slug, …fields})` — applied immediately; an `updated` card shows which fields changed.
- `create_session({agent, …})` — see above. `task_session` is unchanged.

## Web

- **Rail → "צוות"** (`TeamSection` in `Rail.jsx`): collapsible, rendered below folders/free
  sessions and above archived (hidden while searching). Row = emoji avatar in the agent color,
  name, status (`working` when any live session of the agent is mid-turn, else its active
  session count / `idle`), skills line, ⋯ → home chat / agent page. Click → the home chat
  (`GET /agents/:slug/home`). **+ סוכן חדש** starts a normal session with a prefilled
  "תקים סוכן…" prompt (the agent then calls `create_agent` with `confirm:true`).
  Sessions born from an agent show the agent's emoji instead of the color dot.
- **AgentCard** (`AgentCard.jsx`, `{kind:'agent-card'}`): name, slug, emoji, model select
  (from `/models`), budget, tool checkboxes, skills multi-select (from `GET /__api/skills`),
  persona textarea, [צור סוכן] [בטל]. `agent-card-update` events patch the card in place (live
  via the store, on reload via `foldSetupUpdates`).
- **Agent page** `#/agents/<slug>` (`AgentView.jsx`, Settings visual language): tabs
  פרסונה (identity + persona, save/delete/open home) · זיכרון (the agent's MEMORY.md + journal) ·
  פעילות (sessions + their episodes) · חיבורים / שגרה (A2, below).
- Mobile: the same section inside the rail drawer.

## Tests / gates

`test/agents.test.js` (CRUD, validation, persona block, memory namespace isolation),
`test/agents-host.test.ts` (isolated host: REST, `create_session({agent})` inheritance, home,
card flow, memory REST, activity), `test/agents-web.test.js` (Rail order + rows, AgentCard,
fold). Gates: `bun run typecheck` (2 pre-existing errors), `bun test test/`,
`cd web && bun run build`, `scripts/check-public-readiness.sh`.

## Next waves

A2 connected identity — shipped, see below.
A3 control — shipped, see below.
A4 experience (slash-commands, @mentions, `marketing-team` bundle, bundles ship `agents/`).

---

# A2 — Connected identity

An agent's **connections, browser and routine are its own**. Everything below keys off
`session.metadata.agent` (set by `create_session({agent})`); a session without an agent behaves
exactly as before.

## Owners — `global` / `agent:<slug>`

A connection belongs to the host (`global`) or to one agent (`agent:<slug>`). Only capabilities
that carry real per-identity state are **ownable**:

| capability | agent-owned state | shared fallback |
|---|---|---|
| `identity` | the Google login in the agent's own Chrome profile → `agents/<slug>/identity.json` (no secrets) | `$ARIGAMI_DIR/identity.json` |
| `composio:*` | a Composio connected account with `user_id: agent:<slug>` | the host's account (`user_id: default`) |

`claude`, `git`, `whatsapp`, `desktop`, `push`, `remote`, `telemetry`, `repo:*` are host-level:
they resolve to `global` for every owner (`ownable:false`).

**Resolution is agent-first, then shared.** `capabilitiesStatus(probes, owner)` /
`statusOf(cap, probes, owner)` return `owner` (who was asked) and `resolvedFrom`
(`agent:<slug>` = the agent's own, `global` = inherited from the host — the detail says
`(shared)`, `null` = not connected). `ensure(id, why, probes, owner)` answers the same way for
`check_setup`. The first-turn "Connected now" hint is computed **per owner** (`claude.js
refreshCapabilitiesHint(owner)`), so an agent session sees `identity (shared)` when it is
inheriting. `connections.log` lines carry `owner` (absent = global); `readAudit(limit, owner)`
filters.

### The setup card saves to the agent

`request_setup` from a session born from an agent opens a card with `owner: 'agent:<slug>'`
(persisted in `setup-pending.json`, shown as a chip "עבור <agent>" in the chat). Every path that
closes it writes to the agent:

- `POST /__api/setup/identity {action:'verify', sessionId}` / the take-over resolve → the agent's
  `identity.json`, `chromeProfile: 'agent:<slug>'`;
- `POST /__api/setup/composio:<toolkit> {action:'start'}` → the Composio link uses
  `user_id: agent:<slug>`; the ACTIVE account is then visible only to that agent;
- the **consent click** (`/start`) needs the **agent's own** Google identity — the shared one does
  not drive the agent's Chrome profile;
- `markIdentityProvider`, orphan pruning and `resolveSetupsFor` are per owner.

Owner of an HTTP request: explicit `?owner=` / `body.owner` (400 on garbage) → else the session
principal's agent (or `body.sessionId`'s) → else `global`. Host-level capability ids always
collapse to `global`.

### REST

| method | path | |
|---|---|---|
| GET | `/__api/setup/capabilities?owner=agent:<slug>` | resolved for that owner (+ `sharedIdentity`) |
| GET | `/__api/setup/capabilities/:id?owner=` | `check_setup` twin, `{ok, detail, owner}` |
| GET | `/__api/setup/connections?owner=` | audit filtered to one owner (no owner = everything, with its `owner` column) |
| POST | `/__api/setup/:capability` `{…, owner?}` | manual payload for that owner |
| DELETE | `/__api/setup/:capability?owner=` | disconnect **only** that owner's (an agent's Gmail never removes the host's) |
| GET | `/__api/agents/:slug/connections` | `{owner, identity, sharedIdentity, capabilities, audit, browserProfile}` |

### Web

Settings → **חיבורים** gets a **"שייך ל:"** select (כללי / each agent). With an agent selected the
hub shows the agent's view (`settings/AgentConnections.jsx`): the ownable capabilities with
**משלו / משותף (מארח) / לא מחובר**, the host-level list, the browser-profile line and the
agent's audit; the global audit shows an owner column. The same panel is the Agent page tab
**חיבורים**. "חבר לסוכן" opens `ConnectDialog` with the owner — AUTO spawns a session **born from
the agent** (`connectViaSession(cap, {agent})`), MANUAL steps carry `owner` in their payloads.

## Persistent Chrome profile per agent — `agents/<slug>/browser/`

`server/lib/chrome.ts` keeps the T8 mechanism (one `--user-data-dir` copy per session, seeded on
the first `openChrome`, logins synced back) and only changes **the seed**:

- `profileSeedFor(sessionId)` → `agents/<slug>/browser` for a session born from an agent, else
  `chrome-base`. The agent's first profile starts **empty** (its own identity — it does not
  inherit the shared logins); later sessions of the agent inherit the agent's.
- `syncProfileToBase(sessionId, {shared})` copies `Default/Cookies`, `Login Data`,
  `Local Storage` back into the seed under a per-target lock. An agent session lands in the
  agent's profile; **`shared:true`** additionally syncs into `chrome-base` — only when asked.
  Same triggers as before (take-over resolve, session delete, `save_browser_logins`).
- `googleAccountEmail(sessionId)` reads the session copy, then the **agent's** profile — never
  `chrome-base` for an agent session (the shared account must not leak in).
- `save_browser_logins({shared?})` / `POST /__api/sessions/:id/browser/sync-logins {shared}`.
- Backups exclude `agents/*/browser` like `chrome-base` (cookies, huge, rebuilt from logins).

## Routine — `cronjob({agent})` + listeners per agent

- `CronTrigger.agent` — the slug the **isolated runs are born from**. `cronjob({action:'create',
  agent?})` / `POST /__api/triggers {type:'cron', agent?}`: explicit slug wins (unknown → 400),
  a job created from an agent's session **defaults to that agent**, `agent: ''` = none. The
  runaway-loop guard is unchanged.
- The fire path now shares the `create_session({agent})` code: `api.applyAgentToSession()` is
  the one helper (model / color / title / `metadata.agent`), used by `POST /__api/sessions` and
  by `startEmptySession({agent})` that `fireCron` calls — so a cron run gets the persona, the
  agent memory, the agent's connections and browser profile.
- `Listener.agent` — stamped by `state.addListener` from the arming session's `metadata.agent`.
- `GET /__api/agents/:slug/routine` → `{cron: [ …, nextRunAt ], listeners}`; `GET /__api/triggers`
  rows carry `agent`.
- Web: Agent page tab **שגרה** (`RoutineList.jsx`): cron jobs with enable/disable (`PATCH
  /triggers/:id`), run now, delete, next/last run; listeners with cancel. Adding is done in chat
  ("הוסף דרך הצ׳אט" opens a session born from the agent with a prefilled prompt). The Rail team
  row of an **idle** agent with an enabled job shows its next run ("⏰ בעוד 3שע") instead of
  "פנוי" (`nextCronFor(slug, triggers)`).

## Tests

`test/agents-a2.test.ts` (owners, identity per owner, audit filter, Chrome seed/sync/email,
listener stamping), `test/agents-a2-host.test.ts` (isolated host: card owner, identity verify →
agent file, connections/routine endpoints, cron born from the agent, sync-logins),
`test/agents-a2-web.test.js` (Rail next cron, AgentConnections, RoutineList, SetupCard owner
chip, hub filter). The S1 contract tests now expect `owner` on `card.identity` / `ensure()`.

## Known limits (A2)

- Per-agent ownership is real for `identity` and `composio:*` only; the MCP servers a session
  sees are still the user's global ones — an agent's Composio account is selected by the
  `user_id` Composio keys the connection with, not by a per-session MCP config.
- Claude accounts (`accounts.json`) stay host-level; A3 attributes tokens/cost per agent from the stream.
- An agent's first browser profile is empty by design — the human logs in once per agent.

---

# A3 — Control

Everything below is enforced **in the host**, never by the prompt. `agent.json` gains
`autoApprove: [kinds]`; `tools`, `domains` and `budget.tokensPerDay` (A1 fields, advisory
until now) become real.

## Tool allowlist — `tools` (`server/agent-policy.ts`)

Entries may be a **family** (the A1 checkboxes: `desktop`, `whatsapp`, `gmail`, `calendar`,
`drive`, `git`, `sessions`, `triggers`, `web` — expanded by `FAMILIES`), a host tool name
(`open_tab` / `mcp__arigami__open_tab`), an external MCP pattern (`mcp__composio-mcp__GMAIL_*`,
`mcp__whatsapp`), or a Claude Code built-in (`Bash`, `Edit`, `WebFetch`). No `tools` = unrestricted.
With a list, `CORE_TOOLS` (set_title/progress/status, publish_artifact, request_action/review/
setup, memory_*, list_agents…) and the read-only built-ins (Read, Glob, Grep, …) stay available;
`RESTRICTED_BUILTINS` (Bash, Edit, Write, MultiEdit, NotebookEdit, WebFetch, WebSearch, Agent, Task)
need an entry.

Four layers, outer to inner:

1. **`--disallowedTools`** at spawn (`claude.js policyArgs`): restricted built-ins the agent may
   not use + whole external servers (`mcp__<server>`) no entry touches (names from the last init
   report + the live MCP health map). The CLI never offers them.
2. **PreToolUse hook** — `--settings {hooks:{PreToolUse:[…mcp/policy-hook.js]}}`. Before EVERY tool
   call the hook POSTs `/__api/sessions/:id/policy/check {tool_name, input}`; `allow:false` → exit 2
   with the reason on stderr (the model sees it). Fail-**closed**: an unreachable host blocks the
   call. Only sessions born from an agent with a restrictive policy get the hook. This is what makes
   partial external allowlists (`GMAIL_*` but not `GOOGLEDRIVE_*`) and the domain allowlist real.
3. **Host MCP filtering** — `mcp/host-mcp.js` asks `GET /__api/sessions/:id/policy?names=…` on
   `tools/list` and hides the arigami tools that are not allowed; a call to a hidden one is refused.
4. **REST guards** — `POST /__api/sessions/:id/tabs {type:'url'}` (open_tab) refuses a URL outside
   `domains` (403).

Every denial is a `policy` line in the agent's ledger (below) and shows in the Activity tab.

## Domain allowlist — `domains`

`example.com` matches itself and subdomains, `*.example.com` only subdomains, `*` everything;
loopback and relative paths (dev servers, `/__pr/…`) always pass. Enforced on **`open_tab`** (REST)
and **`WebFetch`** (hook, `tool_input.url`).

**Not enforceable by the host, documented only:** pages the agent reaches by driving Chrome on the
desktop (xdotool/typing a URL), `curl`/`wget` inside `Bash`, and requests external MCP servers make on
their own. Keep `desktop`/`git` (Bash) out of `tools` when the domain list must be airtight.

## Daily token budget — `budget.tokensPerDay` (`server/agent-ledger.ts`)

- Tokens are counted from the stream: every `assistant` message's `usage` (input + output +
  cache_creation + cache_read) is summed per turn; the `result` event closes the turn with the
  per-turn delta of the CLI's cumulative `total_cost_usd`.
- `usedToday(slug)` = today's `turn` lines, **host-local calendar day** — resets at local midnight
  (`nextLocalMidnight`).
- Exceeded → `applyAgentToSession` throws a 429 (`budgetRefusal`): `POST /__api/sessions {agent}`,
  `create_session({agent})`, cron fires and a **new** home chat are refused with a clear line
  ("no new sessions until local midnight (00:00); raise the cap in Settings → מארח → תקציבים").
  Running sessions get **one final warning** per day (`[host] FINAL WARNING …` as a user message
  + a `budget` ledger line + a chat error line) and may finish their turn.
- Raising the cap (PATCH `/__api/agents/:slug {budget}`) lifts the refusal at once.

## Activity ledger with cost — `agents/<slug>/activity.jsonl`

One JSON line per event: `session` (first spawn of a session born from the agent), `turn`
(tokens, breakdown, costUsd, model, durationMs), `action` (request_action — `auto:true` when the
host answered, else `by`), `artifact` (publish_artifact), `policy` (a denied tool call, with the
reason), `budget` (the daily warning). `readActivity(slug,{since,kinds})`, `totalsOf`,
`rangeStart('today'|'7d'|'30d')`, `budgetState(slug)`.

### REST

| method | path | |
|---|---|---|
| GET | `/__api/agents/:slug/activity?range=today\|7d\|30d&limit=` | `{sessions, episodes, range, entries (newest first), totals:{tokens,costUsd,turns,sessions,actions,artifacts,denied}, budget}` |
| GET | `/__api/agents/budgets` | `{budgets:[{slug,name,emoji,color,model,cap,usedTokens,usedCostUsd,exceeded,resetsAt}], day}` |
| GET | `/__api/sessions/:id/policy?names=a,b` | `{agent, restrictive, tools, domains, autoApprove, hidden}` |
| POST | `/__api/sessions/:id/policy/check` `{tool_name, input}` | `{allow, reason?}` (the hook's backend) |
| POST | `/__api/sessions/:id/action` `{prompt, buttons, kind?}` | the action now carries `agent` + `kind`; `{…, autoApproved:true, value}` when the host answered |
| POST | `/__api/sessions/:id/action/answer` `{value, autoApprove?}` | `autoApprove:true` adds the action's kind to `agent.json autoApprove` |

## request_action — agent card + "אשר אוטומטית פעולות מסוג זה מעכשיו"

`request_action({prompt, buttons, kind?})` — `kind` is a short machine tag
(`^[a-z0-9][a-z0-9:._-]{0,39}$`: `send-email`, `merge`, `post:facebook`). From a session born from
an agent the action carries `agent:{slug,name,emoji,color}`; the card (transcript `ActionCard` and
the sticky `ActionBar`, both in `web/src/components/ActionCard.jsx`) shows the avatar/name/kind and,
when a kind is present, the toggle. Answering with it ticked stores the kind; the next action of
that kind from any of the agent's sessions is answered **by the host at once** with the primary
button (else the first), logged as `action {auto:true}`, and shown as an `action-auto` receipt line
in the chat. The Agent page → פרסונה → advanced lists the auto-approved kinds (untick to revoke).

## Web

- **Agent page → פעילות** (`AgentView.jsx ActivityTab`): range chips today / 7d / 30d, a totals
  strip (tokens, cost, turns, runs, actions, artifacts, denied) + the budget line, the ledger rows
  (time · kind · what · tokens/cost, session id opens the session), the agent's sessions, and the
  A1 episodes collapsed below.
- **Settings → מארח → תקציבים** (`settings/Budgets.jsx`): agent × model × daily cap (inline, Save on
  change) × used today (tokens / cap · % · $, "נוצל" pill when exhausted).
- Agent page → פרסונה → advanced: `web` tool family, a **domains** field, the auto-approved kinds.

## Tests

`test/agents-a3.test.ts` (policy matching, families, disallowed list, domains, checkToolCall →
ledger; ledger ranges/totals/budget/local day; autoApprove validation, persona block),
`test/agents-a3-host.test.ts` (isolated host with a stream-json stub claude: spawn flags, policy
REST, the hook script exit codes incl. fail-closed, open_tab 403, request_action agent/kind/
auto-approve flow, turns → ledger, 429 + final warning, budgets/activity REST, artifacts logged),
`test/agents-a3-web.test.js` (ActionCard/ActionBar/receipt, Budgets table, Activity totals/rows,
families parity with the host).

## Known limits (A3)

- Claude accounts stay host-level; cost is attributed per agent from the CLI's `total_cost_usd`
  (subscription plans report $0 for some models — tokens are always counted).
- `--disallowedTools` can only deny whole external servers it knows about at spawn; a server that
  appears later is covered by the hook only.
- The domain allowlist cannot see desktop-driven Chrome navigation or `curl` in Bash (above).
- A session that is already running when the cap is raised/lowered picks up the new policy on its
  next spawn (flags) — the hook and the budget check read the current agent.json on every call.
