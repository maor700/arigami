# Agents (Team) — A1 + A2 + A3 + A4 + A5 + M1 + UX1 + UX2

> A note on UI text in this document: every button/tab/section name below is given in English for
> readability. The actual on-screen label is i18n'd and renders in whichever language the user has
> selected (Settings → Appearance → Language) — Hebrew, English, or auto — it is never hardcoded to
> one language. Don't read an English name here as "the UI is in English"; it's just this doc's
> convention.

An **agent is who**; a **session is what/when**. An agent is a persistent identity — persona,
referenced (shared) skills, its own memory namespace, default model, tool/domain allowlists and
a daily budget — that sessions can be *born from*. Sessions stay the unit of work: a session
created with `agent` inherits the agent's model, persona and skills and carries
`metadata.agent = <slug>`; a session created without one behaves exactly as before. One agent
can have many sessions; each agent also has a **home chat** — one long-lived, worktree-less
session for DMs (get-or-create).

Decisions (PRD-ARIGAMI-AGENTS, approved 2026-08-30): agents are a layer **on top of** sessions;
the Rail's Team section sits **below** the sessions/folders section; **no per-agent private
skills** — agents reference shared skills by name. (UX1 later made the home chat the **home** tab of
the agent surface instead of a rail row — see the last section.)

## Storage — `$ARIGAMI_DIR/agents/<slug>/`

```
agent.json   { slug, name, emoji, color, engine?, model?, skills: [names], tools?, domains?,
               budget?: {tokensPerDay}, homeSessionId?, createdAt, updatedAt }
             engine: 'claude' | 'codex' (absent = claude); `model` belongs to that engine's catalog
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
  validation (slug, `#rrggbb`, engine ∈ {claude, codex, null}, model, persona ≤ 4000 chars,
  skills must exist in the shipped pack or `$ARIGAMI_DIR/skills`), `personaBlock(slug)`,
  `agents-updated` WS broadcast, `engineForSpawn(explicit, agent)`.
- `server/claude.js` — `spawnProc` records `p.agent`; the first turn gets
  `URL_GUIDANCE + identity + personaBlock + memory snapshot (USER.md + agent MEMORY.md)`;
  env gets `ARIGAMI_AGENT`.
- `POST /__api/sessions {agent}` — 404 on an unknown slug; `engine` and `model` default to the
  agent's (an explicit `engine` / `model` wins); the session takes the agent's rail color; `title`
  defaults to the agent name; `metadata.agent` is stamped. The slim sessions list already carries
  `metadata`, so the Rail can badge rows.

### Engine

- `engine?: 'claude' | 'codex'` on the record (REST, `create_agent`/`update_agent`, the agent page's
  Advanced settings and the AgentCard draft — the model picker there lists that engine's catalog).
- Resolution (`agents.engineForSpawn`, inside `applyAgentToSession`, used by every spawn-from-agent
  path): explicit caller value → agent's engine → parent's (children) → `cfg.defaultEngine`; `''` counts as not given.
- A3 on Codex: the same PreToolUse hook, written to `$CODEX_HOME/hooks.json` and run with
  `--dangerously-bypass-hook-trust`; codex built-ins are aliased onto claude names (`view_image` → Read). See `docs/ENGINES.md` §3.

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
  until the human clicks **Create agent** (→ `POST /__api/agents`, the card flips to `created` and the
  session gets a `[host] …` message with the slug) or **Cancel**. `confirm:false` creates at once.
- `list_agents()` — the team.
- `update_agent({slug, …fields})` — applied immediately; an `updated` card shows which fields changed.
- `create_session({agent, …})` — see above. `task_session` is unchanged.

## Web

- **Rail → Team** (`TeamSection` in `Rail.jsx`): collapsible, rendered below folders/free
  sessions and above archived (hidden while searching). Row = emoji avatar in the agent color,
  name, status (`working` when any live session of the agent is mid-turn, else its **work**-session
  count / `idle`), skills line, ⋯ → home / runs / persona. Click → the **agent surface**
  (`#/agents/<slug>`, UX1 — it used to open the home chat as a session).
  **+ New agent** starts a normal session with a prefilled
  "set up an agent…" prompt (the agent then calls `create_agent` with `confirm:true`).
  Sessions born from an agent show the agent's emoji instead of the color dot, plus a
  "· <agent>" chip (UX1); the agent's own home chat is not listed here at all.
- **AgentCard** (`AgentCard.jsx`, `{kind:'agent-card'}`): name, slug, emoji, model select
  (from `/models`), budget, tool checkboxes, skills multi-select (from `GET /__api/skills`),
  persona textarea, [Create agent] [Cancel]. `agent-card-update` events patch the card in place (live
  via the store, on reload via `foldSetupUpdates`).
- **Agent surface** `#/agents/<slug>[/<tab>]` (`AgentView.jsx`): its own header treatment +
  tabs home · persona · memory · connections · routine · activity · runs — see **UX1** below.
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
A4 experience — shipped, see below (slash-commands, @mentions, bundles ship `agents/`, `marketing-team`).

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
(persisted in `setup-pending.json`, shown as a chip "for <agent>" in the chat). Every path that
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

Settings → **Connections** gets a **"Belongs to:"** select (General / each agent). With an agent selected the
hub shows the agent's view (`settings/AgentConnections.jsx`): the ownable capabilities with
**its own / shared (host) / not connected**, the host-level list, the browser-profile line and the
agent's audit; the global audit shows an owner column. The same panel is the Agent page tab
**Connections**. "Connect to agent" opens `ConnectDialog` with the owner — AUTO spawns a session **born from
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
  the one helper (engine / model / color / title / `metadata.agent`), used by `POST /__api/sessions` and
  by `startEmptySession({agent})` that `fireCron` calls — so a cron run gets the persona, the
  agent memory, the agent's connections and browser profile.
- `Listener.agent` — stamped by `state.addListener` from the arming session's `metadata.agent`.
- `GET /__api/agents/:slug/routine` → `{cron: [ …, nextRunAt ], listeners}`; `GET /__api/triggers`
  rows carry `agent`.
- Web: Agent page tab **Routine** (`RoutineList.jsx`): cron jobs with enable/disable (`PATCH
  /triggers/:id`), run now, delete, next/last run; listeners with cancel. Adding: the **"Add routine"**
  form (A5 — schedule kind + expression + prompt → `POST /__api/triggers`), or "Add via chat",
  which opens the agent's **existing home chat** — since UX1, the surface's home tab — with the ask
  prefilled. The Rail team
  row of an **idle** agent with an enabled job shows its next run ("⏰ in 3h") instead of
  **"Free/idle"** (`nextCronFor(slug, triggers)`).

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

Entries may be a **family** (the A1 checkboxes: `desktop`, `browser`, `whatsapp`, `gmail`, `calendar`,
`drive`, `git`, `sessions`, `triggers`, `web`, `publish` — expanded by `FAMILIES`), a host tool name
(`open_tab` / `mcp__arigami__open_tab`), an external MCP pattern (`mcp__composio-mcp__GMAIL_*`,
`mcp__whatsapp`), or a Claude Code built-in (`Bash`, `Edit`, `WebFetch`). No `tools` = unrestricted.
With a list, `CORE_TOOLS` (set_title/progress/status, request_action/review/setup, memory_*,
list_agents…) and the read-only built-ins (Read, Glob, Grep, …) stay available;
`RESTRICTED_BUILTINS` (Bash, Edit, Write, MultiEdit, NotebookEdit, WebFetch, WebSearch, Agent, Task,
CronCreate, CronDelete, CronList) need an entry. Publishing (`publish`) and scheduling (`triggers`,
which covers the CLI's own cron built-ins) are families, not core — see **A5** below.

Four layers, outer to inner:

1. **`--disallowedTools`** at spawn (`claude.js policyArgs`): restricted built-ins the agent may
   not use + whole external servers (`mcp__<server>`) no entry touches (names from the last init
   report + the live MCP health map). The CLI never offers them. A5: when the allowlist reaches
   into **no** external server the spawn also gets `--strict-mcp-config`, so the user's global
   servers are never loaded at all (their schemas used to leak into restricted agents).
2. **PreToolUse hook** — `--settings {hooks:{PreToolUse:[…mcp/policy-hook.js]}}`. Before EVERY tool
   call the hook POSTs `/__api/sessions/:id/policy/check {tool_name, input}`; `allow:false` → exit 2
   with the reason on stderr (the model sees it). Fail-**closed**: an unreachable host blocks the
   call. Only sessions born from an agent with a restrictive policy get the hook. This is what makes
   partial external allowlists (`GMAIL_*` but not `GOOGLEDRIVE_*`) and the domain allowlist real.
3. **Host MCP filtering** — `mcp/host-mcp.js` asks `GET /__api/sessions/:id/policy?names=…` on
   `tools/list` and hides the arigami tools that are not allowed; a call to a hidden one is refused.
4. **REST guards** — `POST /__api/sessions/:id/tabs {type:'url'}` (open_tab) and
   `POST /__api/sessions/:id/browser/{open,navigate}` (BROWSE1) refuse a URL outside `domains` (403).

Every denial is a `policy` line in the agent's ledger (below) and shows in the Activity tab.

## Domain allowlist — `domains`

`example.com` matches itself and subdomains, `*.example.com` only subdomains, `*` everything;
loopback and relative paths (dev servers, `/__pr/…`) always pass. Enforced on **`open_tab`**,
**`browser_open`/`browser_navigate`** (BROWSE1, REST) and **`WebFetch`** (hook, `tool_input.url`).

**Not enforceable by the host, documented only:** a page the agent reaches by `browser_click`ing a
link or `browser_type`ing a URL into the address bar (once the tab is already open, nothing stops
it navigating itself further — same limit xdotool always had), `curl`/`wget` inside `Bash`, and
requests external MCP servers make on their own. Keep `desktop`/`browser`/`git` (Bash) out of
`tools` when the domain list must be airtight.

## Daily token budget — `budget.tokensPerDay` (`server/agent-ledger.ts`)

- Tokens are counted from the stream: every `assistant` message's `usage` (input + output +
  cache_creation + cache_read) is summed per turn; the `result` event closes the turn with the
  per-turn delta of the CLI's cumulative `total_cost_usd`.
- `usedToday(slug)` = today's `turn` lines, **host-local calendar day** — resets at local midnight
  (`nextLocalMidnight`).
- Exceeded → `applyAgentToSession` throws a 429 (`budgetRefusal`): `POST /__api/sessions {agent}`,
  `create_session({agent})`, cron fires and a **new** home chat are refused with a clear line
  ("no new sessions or turns until local midnight (00:00); raise the cap in Settings → Host →
  Budgets"). The running session gets **one final warning** per day (`[host] FINAL WARNING …` as a
  user message + a `budget` ledger line + a chat error line) and may finish that turn; after it
  **every further turn is refused too** (A5 #5 — see below).
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

## request_action — agent card + "automatically approve actions of this kind from now on"

`request_action({prompt, buttons, kind?})` — `kind` is a short machine tag
(`^[a-z0-9][a-z0-9:._-]{0,39}$`: `send-email`, `merge`, `post:facebook`). From a session born from
an agent the action carries `agent:{slug,name,emoji,color}`; the card (transcript `ActionCard` and
the sticky `ActionBar`, both in `web/src/components/ActionCard.jsx`) shows the avatar/name/kind and,
when a kind is present, the toggle. Answering with it ticked stores the kind; the next action of
that kind from any of the agent's sessions is answered **by the host at once** with the primary
button (else the first), logged as `action {auto:true}`, and shown as an `action-auto` receipt line
in the chat. The Agent page → Persona → advanced lists the auto-approved kinds (untick to revoke).

## Web

- **Agent page → Activity** (`AgentView.jsx ActivityTab`): range chips today / 7d / 30d, a totals
  strip (tokens, cost, turns, runs, actions, artifacts, denied) + the budget line, the ledger rows
  (time · kind · what · tokens/cost, session id opens the session), the agent's sessions, and the
  A1 episodes collapsed below.
- **Settings → Host → Budgets** (`settings/Budgets.jsx`): agent × model × daily cap (inline, Save on
  change) × used today (tokens / cap · % · $, **"Used up"** pill when exhausted).
- Agent page → Persona → advanced: `web` tool family, a **domains** field, the auto-approved kinds.

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

---

# A4 — Experience

The team becomes reachable **from the composer**: slash-commands with autocomplete, `@mentions`
that hand a message to an agent, and profile bundles that ship agents (with a six-agent showcase).

## Slash-commands in the composer (`web/src/lib/composer.js`, `SlashCommands.jsx`, `SessionView.jsx ChatFooter`)

Typing `/` opens the existing palette; it now merges three sources (host first, then prefix
matches):

| command | what happens | where |
|---|---|---|
| `/team` | a panel with every agent + status (working / n sessions / idle), **@** (insert a mention), home chat, agent page | host, runs at once |
| `/as <agent> <text>` | a **one-off session born from the agent** that runs `<text>` — a full child in your project folder when you are its controller, else a free session in your cwd | host → `POST /__api/sessions/:id/delegate {mode:'as'}` |
| `/agent new [name]` | **UX2**: opens the **create-agent SURFACE** (`AgentView`, create mode) with `name` prefilled — no session, no chat card. See the UX2 section below | host → `openAgent('__new__', 'persona', name)` (a `host:open-agent` event; `App.jsx` owns the surface) |
| `/adopt <agent>` | **UX2**: this session **adopts** an existing agent from its next turn on — no new session | host → `POST /__api/sessions/:id/adopt-agent` |
| `/plan <text>`, `/review [text]`, … | **data-driven**: every skill whose `SKILL.md` frontmatter has `slash: <word>` is offered as `/<word>` and rewritten to its plugin command (`/arigami:<skill> …`, `/arigami-user:<skill> …` for a user skill) before it is sent. Shipped: `dispatch` (`slash: plan`), `explain-changes` (`slash: review`). `GET /__api/skills` carries `slash` (`SLASH_RE = ^[a-z][a-z0-9-]{0,23}$`; user skills win by name) | skill |
| anything else `/…` | pass-through to the claude CLI, as before | CLI |

Resolution order for a submission (`resolveSubmission`): host command → skill slash → `@mention`
→ plain. The palette is the same bottom sheet on phones (`max-w-[92vw]`); `/agent new` and `/adopt`
are the multi-word / argument-taking commands the palette regex admits.

> The `POST /__api/sessions/:id/agent-card` route itself is unchanged and still live — it is what
> the MCP `create_agent` tool and its `{kind:'agent-card'}` chat card use (an *agent* proposing an
> agent from inside a session). Only the *composer's* `/agent new` stopped calling it — see UX2.

## @mentions

Typing `@` (at the start, or after whitespace/punctuation) at the end of the text opens the
**mention palette** (agents from the store: avatar, `@slug`, name, skills; ↑↓ ↵ esc, tap on
mobile). `@slug` and `@Name` both resolve; `sam@example.com` and `@2pm` stay text.

Sending a message that mentions agents (and has text left after the tokens are stripped) does
**not** send it to the current session — the host routes it, one `delegate` call per agent:

| the caller is | what the host does | receipt `how` |
|---|---|---|
| the **controller of a project folder** (PM) | `wireFullChild` + `applyAgentToSession`: a **full child born from the agent**, placed in the folder, tasked with `[Task from your project controller (…)]\n\n<text>` — the same wrapper `task_session` uses | `child` |
| any other session | the agent's **home chat** (get-or-create, `ensureHomeSession`) gets `[Forwarded from the chat "…" — the human addressed you with @slug]\n\n<text>` — now if idle, else queued with auto-play (`deliverToSession`) | `home` |
| `/as` | a new session born from the agent (child when a PM, else free), `metadata.delegatedFrom` | `session` |

Either way the **caller's** chat gets a `{kind:'delegated', agent:{slug,name,emoji,color}, target,
targetTitle, how, delivered, mode, text}` line — rendered by `DelegatedLine.jsx`. UX1 reworded it to
name the destination in a sentence: **"Opened in <agent>'s home"** + **Open home** (the agent surface's
home tab) vs **"Created work session «title» with <agent>"** + **Open session** (open session). Budget (A3) is
honoured: a spent agent gets no new child/home/session (429); an unknown agent is 404, empty text 400.

### REST

| method | path | |
|---|---|---|
| POST | `/__api/sessions/:id/delegate` `{agent, text, mode?: 'mention'\|'as'}` | `{ok, target, how, delivered, url}` (201) — `agent` is a **slug** (the composer resolves display names) |
| POST | `/__api/sessions/:id/agent-card` `{name?, draft?}` | posts a pending `agent-card` → `{cardId, slug, state:'pending'}` (201); 409 when the slug exists |
| GET | `/__api/skills` | `skills[].slash` |
| POST | `/__api/profiles/apply` `{source, force?}` | `report.agents[]` (below) |

## Bundles ship agents — `agents/<slug>/{agent.json, persona.md, assets/}`

`server/profiles.ts` (see `docs/INSTALL.md` §3 for the whole format):

- **load**: every `agents/<slug>/` dir (`profile.json.agents` is an optional allow-list, like
  `skills`); `agent.json` must be valid JSON.
- **validate**: slug (`^[a-z0-9][a-z0-9-]{0,39}$`, same as `agents.ts`), `name` required, `slug`
  in the file must equal the dir, `emoji`/`color`/`model`/array fields/`budget` shapes,
  persona ≤ 4000 chars, asset names safe and ≤ 2 MB, **no secret-looking keys** (`token`, `secret`,
  `password`, `apiKey`); warnings for `homeSessionId` (instance-local, ignored) and for a
  referenced skill that is neither in the bundle nor shipped. `cron.json[].agent` (the slug the
  runs are born from — A2's `cronjob({agent})`) must be a slug; a warning when the bundle does not
  ship it.
- **apply** (after the skills step, so the bundle's own skills already exist on the host):
  an **absent** agent is created (`createAgent`) with the record + persona; an **existing** agent is
  the user's → `unchanged`, nothing touched; with **`force`** (`--force` on the CLI,
  `{force:true}` over REST) it is `updated` to the bundle's record/persona. Skills the host does
  not have (e.g. an external bundle's skills are still pending proposals) are **dropped and
  reported** (`skippedSkills`), never a failure. Assets are copied when missing (all of them under
  force). The bundle's cron is born from its agent when the host has it. `ApplyReport.agents[]`:
  `{slug, status: created|updated|unchanged|error, assets?, skippedSkills?, error?}`.
- **export** (`backup.ts exportBundle`, `bin/host export --bundle`): `agents/<slug>/` with
  `agent.json` minus `homeSessionId`, `persona.md`, `assets/` — never `memory/`, `browser/`,
  `identity.json`; `cron.json[].agent` travels too. Re-importing is idempotent.

### Showcase — `profiles/bundles/marketing-team/`

Six agents (English personas ≤ 20 lines, a placeholder product `<your-product>`, no accounts or
brands): **awesome** 🧭 manager (`sessions`, `triggers`; `campaign-brief`, `project-manager`),
**Mila** ✍️ copywriter (`web`), **Jord** 🎨 image maker (`desktop`, `web`; domains
`unsplash.com`, `pexels.com`; one placeholder asset), **Reachard** 🔍 researcher (`web`, `*`),
**Richi** 📨 outreach (`gmail`, `web`), **Fibi** 📅 social manager (`web`). Three generic skills the
bundle ships and the agents reference — `campaign-brief`, `content-calendar`, `outreach-sequence`
(all approval-gated: nothing is sent or posted without `request_action`) — a memory seed with the
placeholder facts, and a disabled Monday "weekly-plan" cron born from awesome. Every agent has a
modest daily token budget that A3 enforces.

## Tests

`test/agents-a4-web.test.js` (composer parsing: slash / `agent new` / skill slashes / mentions /
mention query & completion / `resolveSubmission`; palette merge; `SlashPalette` skill chip,
`MentionPalette`, `DelegatedLine`, `teamRows` + `TeamPanel`), `test/agents-a4.test.ts` (the
showcase bundle loads + validates, agent validation errors/warnings, apply → created / unchanged /
force-updated, skipped skills on an external bundle, cron born from the agent, `exportBundle`
round-trip), `test/agents-a4-host.test.ts` (isolated host: `skills[].slash`, mention → home,
mention from a PM → child in the folder, `/as` → session, 404/400/429, agent-card 201/409 + cancel,
profiles REST apply with agents + force). `test/profile-bundles.test.ts` now covers
`marketing-team` too.

## Known limits (A4)

- `/plan` and `/review` map to the closest shipped skills (`dispatch`, `explain-changes`); a user
  skill with the same `slash:` shadows them (user skills win by name in `GET /__api/skills`, and the
  composer picks the first item per slash word).
- A mention's text goes to **each** mentioned agent in full (no splitting); attachments stay in the
  draft — the delegate channel is text-only, like `task_session`.
- The receipt line is written by the host into the caller's chat; the caller's own claude turn
  does not see the delegated text (by design — the human addressed the agent, not this session).
- Bundle agents reference **shared** skills only (the A1 decision): a bundle cannot ship a
  per-agent private skill; put it under the bundle's `skills/` and reference it by name.

---

# A5 — Hardening (what the live E2E run found)

A5 fixes the bugs of the first end-to-end run of the whole stack on a live host
(`TEST-REPORT-AGENTS-E2E.md`). Nothing new is added: every item below is a hole in an
A1–A4 promise.

## #1 — scheduling built-ins are part of `triggers`

Claude Code ships its own `CronCreate` / `CronDelete` / `CronList`. They were outside the
allowlist, so an agent asked for a routine used them and reported success — while the job was
**session-only**: invisible in the Routine tab, unattributed, dead on the next restart. They are
now in `FAMILIES.triggers` **and** in `RESTRICTED_BUILTINS`, so an agent without `triggers` never
sees them (layer 1). If one still reaches the hook, `denialHint()` makes the refusal loud and
actionable: *a session-only schedule is not a routine — ask the human to add it in the Routine tab
(or to tick `triggers`), and never report a routine as created.* The same hint covers `cronjob`
and `register_listener`. The persona block repeats it for agents without `triggers`.

## #2 — `publish` is a revocable family; a PUBLIC link asks the human

`publish_artifact` / `share_artifact` / `unshare_artifact` left `CORE_TOOLS` for
`FAMILIES.publish`. An agent whose allowlist omits it gets them **hidden** from its toolset
(host-MCP filter), refused by the hook, and refused by the REST guard (`POST
/__api/sessions/:id/artifacts` → 403) — the fourth layer, like `open_tab`'s domain check.

`share:true` (and `share_artifact`) from a session **born from an agent** never mints a link on the
agent's word:

| agent state | what happens |
|---|---|
| no `publish` in the allowlist | refused (403 / a warning on the publish result) |
| `publish`, `share` **not** in `autoApprove` | the host opens a `request_action` card of kind `share`; publish returns `share_url: null, share_pending: true`. Approving mints the token and sends the link into the session; refusing mints nothing and says so |
| `publish` + `autoApprove: ['share']` | minted at once (the human pre-approved the kind) |
| a **logged-in human** clicking the artifact card's own share button | minted — the click *is* the approval |

**Defaults:** agent records written before A5 (`toolsV` < 2) are migrated once — `publish` is added
to their allowlist, so an existing agent keeps exactly the publishing it had, and unticking the new
checkbox afterwards sticks. A **new** agent with an allowlist must ask for `publish` explicitly (the
bundled `marketing-team` agents do). `share` always needs the human unless it is auto-approved.

## #3 — the injected policy line

The old line named only the allowlist, so agents refused legal calls ("I'm blocked from
publishing" — they were not) and, in the other direction, published without ever considering it
might be forbidden. `personaBlock` now says three things: what you **MAY** use (allowlist **plus**
the always-on core tools and read-only built-ins, listed), what is **DENIED** (including the
restricted built-ins this agent lacks), and that **a denied call is reported by the host** — so
trying is safe and guessing is not. Publishing and share get their own line, in both directions.

## #5 — the daily cap stops spend, not just new sessions

`budgetState.exceeded` only gated session creation, so messages kept landing in an existing agent
chat (the run ended at 167% of the cap). Now: crossing the cap still delivers **one** final warning
(`budget` ledger line + chat error line + a `[host] FINAL WARNING` turn), and after it
`ledger.turnBlocked(slug)` refuses **every** further turn — `POST /__api/sessions/:id/message`,
queued-prompt play, delegate-to-home — with the same 429 line, until local midnight. The block is
read from `activity.jsonl`, so it survives a respawn or a host restart. 429 responses carry a
structured `budget` object (`{slug, name, cap, usedTokens, exceeded, resetsAt}`) for the UI.

## #7 — restricted agents no longer load external MCP servers

`--disallowedTools mcp__<server>` only denies *calls*; the schemas were still listed (a leaked
capability map, tokens and latency on tools that can never run). When an allowlist reaches into no
external server (`strictMcpFor`), the spawn adds `--strict-mcp-config` — only what the host itself
passes in `--mcp-config` is loaded. That includes the agent's **own M1 grants** (`mcpConfigFor`
injects them), so strict never takes an agent's own connection away; a grant its allowlist does not
name is denied by name in `--disallowedTools`, as before. An agent that *does* need an external
server (e.g. `gmail`) keeps the old per-call filtering.

## #8 / trip-up #2 — the Routine tab

"Add via chat" spawned a brand-new session on every click; it now opens the agent's **existing**
home chat (`GET /__api/agents/:slug/home`) with the ask prefilled in its composer draft. And chat is
no longer the only path: **"Add routine"** opens an inline form (schedule kind `cron` / `interval` /
`at` + expression + prompt + optional name) that posts to `POST /__api/triggers {type:'cron',
agent}` — `routinePayload()` is the pure builder, unit-tested.

## #10 / #11 — the composer and the 429

- A failed slash command is **not** restored into the composer. It used to be, so the next thing the
  human typed was appended to it and Enter silently re-ran the same failing line. The error is
  toasted with a "Restore text" action instead. A refused plain message also says why (it used to
  bounce back with no explanation at all).
- `web/src/lib/errors.js` (`errText` / `budgetText`) turns an `api.js` error into a sentence:
  `toast()` runs everything non-string through it, so nothing shows as `Error: HTTP 429 — …`. A 429
  with a `budget` body renders from the locale, in the cockpit's own current language — the server
  line itself is a plain English fallback string, never a language the locale doesn't cover.

## Tests

`test/agents-a5.test.ts` (cron family + denial hint, publish family + the one-time migration + a
sticky untick, the reworded policy line, `turnBlocked` before/after the warning, `strictMcpFor`),
`test/agents-a5-host.test.ts` (isolated host: spawn flags, the routine hint while the tab's own form
still creates a real trigger, publish 403 + hidden toolset, the share card → approve / refuse /
auto-approve, a turn refused with 429 after the warning and never reaching the model),
`test/agents-a5-web.test.js` (both add paths in the Routine tab, `routinePayload`, `errText` /
`toastText`).

## Known limits (A5) — and the followups left open

- **Not fixed here (recorded, needs its own change):** `#4` question cards time out after ~4–5
  minutes and swallow late clicks — wrong default for a phone-first cockpit; `#6` a multi-question
  card seems to submit on the first click (needs one clean human repro); `#9` pairing an already
  configured host lands mid-wizard on "Profile bundle" with Apply buttons; and `@agent` still means
  two different things (home chat from a normal session, a child from a folder controller) — only
  the receipt line says which.
- The share gate keys off the caller being a logged-in **user**; on a host with `ARIGAMI_AUTH=off`
  the human's own click on an agent session's artifact goes through the approval card too.
- `turnBlocked` refuses the turn at the host boundary — a turn already in flight when the cap is
  crossed finishes (that is the "one final warning" by design).
- `--strict-mcp-config` is all-or-nothing per session: an agent that needs one external server still
  loads all of them and relies on the hook.
- Merged after M1: the two features meet in `policyArgs` / `mcpConfigFor` — see the `--strict-mcp-config`
  bullet under **M1** below for what strict does and does not hide.

---

# M1 — native remote-MCP connections per agent

Full picture (provider per service, the spike results, export rules):
[INTEGRATIONS.md](INTEGRATIONS.md). What matters for an agent:

- An agent's connection to a vendor-hosted MCP server is its **own OAuth grant**,
  named `<service>--<slug>` (the server name is what identifies a grant — the same
  URL under another name is a different grant with a different vendor identity).
  `sales` connecting Linear gets `linear--sales`, not the host's `linear`.
- It is recorded in `$ARIGAMI_DIR/agents/<slug>/connections.json`
  (`[{cap, slug, name, url, auth, at, byIdentity}]` — names and URLs, never a
  token) and shown in the Connections hub under **Belongs to**.
- Registration uses `local` scope with the agent's directory as `cwd`, so no other
  agent's session sees the server; the host injects it into the owner's sessions
  with `--mcp-config`, under the grant name.
- Resolution is agent-first, then the host's shared grant — the same rule A2 uses
  for `identity` and `composio:*`. A capability status says which one answered
  (`resolvedFrom`), and the card says "(shared)" when it fell back.
- Its tools are `mcp__<service>--<slug>__*`. When the agent has a **tools
  allowlist**, connecting a service adds that pattern to it (and the response says
  `toolsAdded`): A3 denies whole MCP servers no pattern reaches, so a connection
  the agent could not then call would be a trap. Disconnecting does **not** remove
  the pattern — that would be editing the agent behind the human's back.
- `--strict-mcp-config` is used only where it takes nothing away (A5 #7): a session
  whose allowlist reaches into **no** external MCP server. The agent's own grants ride
  in the host's `--mcp-config` (`mcpConfigFor`), so strict never hides them — what it
  drops is the user's global servers (WhatsApp bridge, Composio gateway), which that
  allowlist could not call anyway. An agent that *does* name an external server keeps
  the old behaviour: everything loads and the allowlist takes tools away.
  Isolation between agents is still the local scope; taking tools away is the allowlist.

Composio connections keep working exactly as in A2 — the connected account is
keyed by `user_id = agent:<slug>` — so an agent can own a native Linear grant and
a brokered Gmail account at the same time.

---

# UX1 — Home vs Work

The complaint the spec starts from: clicking a Team row and being handed work by
an agent both ended in *a session that looks like every other session*. Nothing
said what each surface was for. UX1 splits them in the UI (no new concepts, no
routing changes):

- **Agent (home)** — a *place*: who the agent is, what it remembers, what it is
  connected to, what it runs on a schedule, what it costs. Talking to it is a DM.
- **Work session** — a *job*: a transcript, changes, review/merge. It may be born
  from an agent, and then it wears the agent's face.

## The home chat stops being a rail row

`metadata.agentHome` sessions are filtered out of the Rail's Sessions section
(folders, search, drag, archived all read the filtered list). They stay in
`GET /__api/sessions`, stay resumable and stay in the agent's ledger — they are
simply reached through the agent surface. Any route that lands on one (a deep
link, the quick switcher, a push notification, an old bookmark) is bounced to
`#/agents/<slug>` by `App.jsx`.

**One home per agent, enforced** (`ensureHomeSession`): a home the record lost
track of — an export/import round-trip strips `homeSessionId`, a restored backup,
an older build — is **adopted** (oldest first), not re-created; any extra home is
**demoted** to an ordinary work session, keeping its id, transcript and
`metadata.agent`. `agentHome` is a host-only stamp: `applyAgentToSession`,
`POST /__api/sessions` and `PATCH /__api/sessions/:id` all strip it from
caller-supplied metadata, so nothing but the home route can hide a session.

## The agent surface — `#/agents/<slug>[/<tab>]`

`AgentView.jsx` is a full view with its own header treatment (this is what keeps
it from reading as a work session): a 40px avatar, the name + `@slug`, the
persona's first real line, live status (working / next scheduled run / idle —
`SurfaceStatus`, the home chat counts as "working" but never as a run), the daily
budget as a bar (`BudgetBar`, `GET /__api/agents/budgets`), the agent's color
washed over the chrome, and the one-liner *home = talking to the agent. session = the work it's
doing.* Tabs (horizontal, scrollable on a phone; each deep-linkable):

| tab | |
|---|---|
| **Home** | the DM chat, embedded (`AgentHomeChat` in `SessionView.jsx`: transcript + composer, no tab bar, no `claude-code` header). Opening the tab is what get-or-creates the home session |
| Persona / Memory / Connections / Routine / Activity | A1–A3, unchanged (Activity lost its sessions list to Runs) |
| **Runs** | every session born from the agent with its state and cost — `sessions[]` of `GET /agents/:slug/activity` now carries `tokens`/`costUsd`/`turns` per session, summed over the WHOLE ledger so an old run still shows what it cost |

The Home composer carries a hint chip — *want it to do a task? Type /as or
drag into a folder* — that turns the human's last message (`lastHumanText`) into a real work
session through the existing `POST /__api/sessions/:id/delegate {mode:'as'}`.

## A work session says whose job it is

It stays in the Sessions section, wearing the agent avatar plus a "· <agent>"
chip in the rail row and **"Work session · born from <agent>"** (`BornFromChip`) in the
session header — both link back to the agent surface.

The delegate receipt (`DelegatedLine`) now says which of the two happened, in a
sentence instead of a suffix: **"Opened in <agent>'s home"** with **[Open home]** (→ the
surface's home tab) vs **"Created work session «title» with <agent>"** with **[Open session]**
(a child adds "in this project"). The `@mention` routing rules themselves are
unchanged — only the wording is.

## Tests

`test/agents-ux1-host.test.ts` (isolated host with a SEEDED `state.json`: the
adopt/demote migration, `agentHome` refused from POST + PATCH, per-session cost),
`test/agents-ux1-web.test.js` (the surface header/status/budget/tabs, `RunsList`,
`personaLine`, `lastHumanText`, `BornFromChip`, `teamRows`). `agents-web` covers
the rail (no home row, the "· <agent>" chip) and `agents-a4-web` the receipt.

## Known limits (UX1)

- Memory stays a tab of the surface even though the spec's list omits it —
  dropping it would have deleted an A1 feature.
- The Home tab creates the home session on open, exactly like the old rail row
  did; a spent daily budget refuses it with the same 429 (shown inline).
- The hint chip acts on the last **human** message; `[host]` lines and forwarded
  mentions are skipped. There is no multi-message selection.
- A home chat is still a session everywhere below the UI (API, exports, cron,
  the ledger) — UX1 is a framing change, not a new object.

# UX2 — creating an agent is a surface, not a session

The complaint: clicking "+ New agent" spawned a session whose only job was to
*interview* the human and eventually call `create_agent` — a work session for
work that was never work. UX2 removes that detour: creating an agent opens the
same surface an existing agent already has (`AgentView.jsx`), just in **create
mode**, with an empty draft.

## The rail button — create mode, not an interview session

`Rail.jsx`'s "+ New agent" now calls `openAgent('__new__', 'persona')` — the same
`host:open-agent` event `/team`, mentions and receipts already use to jump to
the agent surface (`App.jsx` owns `agentOpen`/`agentTab`/`agentDraftName` and
renders `AgentView`). `'__new__'` is a sentinel slug that can never collide with
a real one (`SLUG_RE` bars underscores) — `AgentView` treats it as `isNew` and
skips its `GET /agents/:slug` + `/agents/budgets` fetches entirely, building a
local draft object instead (`{name: draftName, emoji:'🤖', color, persona:'', …}`).

**The surface reads the same in both modes.** All seven tabs render; only
Persona is enabled before the agent exists — the rest (`Home` / `Memory` /
`Connections` / `Routine` / `Activity` / `Runs`) are visibly present but `disabled`,
with a `title` hint ("will be available after creation") so the surface doesn't look
broken, just not-yet-applicable. The header drops the `@slug` line and the
status/budget row (there is no session or ledger yet); the persona form gains
one extra field only in create mode — an explicit **slug** input (Hebrew names
don't survive `slugify`, so `createAgent` needs one explicitly, exactly like
the `{kind:'agent-card'}` chat card already does).

`PersonaTab`'s save button becomes **"Create agent"** and calls `POST /__api/agents`
(instead of `PATCH /__api/agents/:slug`); the delete button becomes **"Cancel"**
and just closes the surface (`onClose`) — nothing was written, there is nothing
to undo. On success, `AgentView`'s `onCreated(agent)` callback (wired in
`App.jsx`) flips the surface into normal existing-agent mode for the real slug,
still on the Persona tab. **The home chat is not created at this point** — it
stays exactly as lazy as UX1 left it (`ensureHomeSession`, minted on first
`GET /agents/:slug/home`, i.e. only when the human clicks the newly-available
**"Open home chat"** button or the agent is first delegated to).

## `/agent new [name]` — same surface, from a session

The composer's `/agent new [name]` (`resolveSubmission` → `{type:'agent-new',
name}`, unchanged parsing) now resolves in `SessionView.jsx`'s `runHostCommand`
to `openAgent('__new__', 'persona', name)` instead of `POST
/sessions/:id/agent-card` — same create-mode surface as the rail button, with
`name` prefilled. Leaving the draft (✕ or "Cancel") behaves exactly like leaving
any other agent surface reached this way (`/team`, a mention receipt, …) — back
to the rail, nothing session-specific to restore.

## What still creates an agent from inside a session — unchanged

Two paths are explicitly **not** touched by UX2, because they are a different
thing: an *agent* proposing a new agent, not a human clicking a button.

- **MCP `create_agent`** (`mcp/host-mcp.js`) → `POST /__mcp/agent-card` →
  `openPendingAgentCard` → a `{kind:'agent-card', state:'pending'}` chat card
  the human edits and confirms (`AgentCard.jsx`) → `POST /__api/agents
  {…, cardId, sessionId}`. Entirely separate code path from the rail
  button/`/agent new` (different draft, different confirm step) — see the A1
  section above.
- The underlying `POST /__api/sessions/:id/agent-card` REST route is likewise
  unchanged and still tested (`agents-a4-host.test.ts`) — only the composer
  stopped calling it.

Neither path spawns a session either; they always operated on the
*already-open* session's chat.

## Adopt agent — a session adopts an existing agent, no new session

`/adopt <agent>` (composer, autocompletes like `/as`) calls `POST
/__api/sessions/:id/adopt-agent {agent}`. `adoptAgentIntoSession` (`server/api.ts`):

1. 404s on an unknown session/agent; **429s** (with `.budget`) if the agent's
   daily cap is already spent — same shape as `applyAgentToSession`/
   `ensureHomeSession` — and leaves the session **untouched** on failure.
2. Sets `metadata.agent = slug` and remembers what ran before it
   (`metadata.adoptedFrom`, `null` if the session had no agent at all).
3. Appends a `{kind:'agent-adopt', agent:{slug,name,emoji,color}, prevAgent}`
   chat card (`AgentAdoptLine.jsx`) — a plain-language receipt: *"{name} was
   adopted into this session"* + a note that earlier turns ran without it, and a **"Revert
   to normal"** button.
4. Queues a `[host]` line carrying the agent's persona block
   (`agents.personaBlock`) via `deliverToSession` (sent now if idle, queued
   with auto-play if busy) — so the model itself learns what it just became,
   not only the human watching the chat.

**Why setting `metadata.agent` is enough for A3 from the very next turn**:
`policyArgs`/`mcpConfigFor` (tool/domain allowlist + MCP server grants) and
`budgetRefusalFor` (the daily-cap 429) all read `session.metadata?.agent` fresh
on *every* spawn/`sendMessage` call — there is no cached policy object tied to
session creation time. The one thing that is **not** automatic: persona
injection normally only happens on a session's true first spawn
(`!resume && !sent.length`) — an adopted session is already resumed, so step 4
above is what actually tells the model, not a side-effect of setting metadata.

**Reversible**: `POST /__api/sessions/:id/adopt-agent/revert` restores
`metadata.agent` to whatever `adoptedFrom` remembered (or clears it, via an
explicit `agent: undefined` — `patchSession`'s metadata merge is additive and
can't delete a key by omission) and appends a `{kind:'agent-adopt', agent:null,
reverted:true}` receipt. Adopting a second agent without reverting first
remembers the *immediately preceding* one — revert is one step back, not
"forget every adoption ever."

## Tests

`test/agents-ux2-host.test.ts` (isolated host: adopt sets `metadata.agent` +
color, receipt card, `[host]` persona line reaches the chat/queue, 404s, 429 on
a spent budget with the session left untouched, revert restores the prior
agent, a second adoption without reverting remembers the first one).
`test/agents-ux2-web.test.js` (`AgentView` create mode: disabled tabs + hint,
"Create agent"/no delete/no open-home, the slug field, draftName prefill, the
sentinel never leaking into the header; existing-agent mode unaffected;
`resolveSubmission('/adopt …')`; the `{kind:'agent-adopt'}` receipt in both
states; source assertions that the rail button and `/agent new` no longer POST
a session or an agent-card).

## Known limits (UX2)

- The create-mode draft is pure client state — refreshing the page mid-draft
  loses it (same as any unsaved form; there was never a server-side "draft"
  object, by design — nothing is written until "Create agent").
- `/adopt` has no autocomplete UI of its own yet (unlike `/as`'s `@mention`
  picker) — it resolves the same way `/as <agent>` does (`findAgent` by slug or
  name), so a typo just 404s/`unknown-agent`s like any other host command.
- Adoption is a single-slot "what ran before" — adopting three agents in a row
  without reverting only remembers the last swap, not the whole chain.

---

# BROWSE1 — an agent must be able to actually drive a browser

Two gaps, found together: (1) `desktop`'s tools (`open_tab`/`capture_screen`/`request_screen`) let
an agent **show** a page, none of them **drive** the session's own Chrome — the only documented way
was `Bash` + `skills/_lib/chrome.sh`, and `Bash` lives in `git`, which a non-coding agent (`desktop`
+ `web`, no `git`) has no business holding; (2) the machine side panel could silently render the
*shared* :99 desktop for a session that had no display of its own yet — the same failure mode T8 was
built to prevent for `capture_screen`/`request_screen`, just missed in the panel's own WebSocket path.

## 1 — the `browser` family

`browser_open/navigate/snapshot/click/type/scroll/close` (`mcp/host-mcp.js`, REST under
`/__api/sessions/:id/browser/*`, logic in `server/lib/browser-actions.ts`) drive the session's
**own** Chrome (own desktop, own profile — A2 agent-seeded) over the **existing** CDP/xdotool
plumbing — `server/lib/chrome.ts` (launch/profile), `server/lib/chrome-cdp.ts` (now exports
`cdpCall`/`frontPage`/`pageNavigate`/`pageEvaluate`/`pageClick`/`pageScroll` alongside the F8
take-over helpers it already had) and `screenshots.ts` (capture). No playwright, no new runtime
dependency — the point of BROWSE1 was to replace the removed playwright MCP with something that
reuses what the host already runs.

- `browser_open({url?})` — `ensureDesktop` + `openChrome` (same as `skills/_lib/chrome.sh`), then
  navigates and screenshots. Reuses the SAME running Chrome across calls, same as the shell helper.
- `browser_navigate({url})` waits for `document.readyState === 'complete'` (best-effort, 15s) and
  does **not** screenshot — machine-work's "required moments only" rule; call `browser_snapshot`
  when you actually need to look.
- `browser_snapshot()` — screenshot + `{url, title, text}` (`document.body.innerText`, 8000 chars)
  + `{needsHuman, reason, hint}` (see below).
- `browser_click({x,y}|{text})` — CDP `Input.dispatchMouseEvent` at **viewport** coordinates (not
  xdotool screen coordinates); `{text}` finds the smallest matching clickable element via
  `getBoundingClientRect` after `scrollIntoView`.
- `browser_type({text, submit?})` — CDP `Input.insertText` (falls back to `xinput.py` XTEST when no
  page target — same helper `typeIntoDesktop` already used for the take-over "type into the desktop"
  field), then optionally `Enter`.
- `browser_scroll({dx?,dy?,x?,y?})` — `Input.dispatchMouseEvent` `mouseWheel`.
- `browser_close()` — `chrome.closeChrome`, this session's pid only (never `pkill`).

**FAMILIES**: `browser` is its own checkbox AND folded into `desktop` (an agent that already ticked
`desktop` gets browsing for free; `browser` alone grants driving without the rest of `desktop`).

**Domains (A3)**: `browser_open`/`browser_navigate` are in `agent-policy.ts`'s `URL_TOOLS`, checked
in the REST handler before any Chrome call (`policy.checkToolCall(…, 'browser_open'/'browser_navigate', {url})`)
— same 403 shape as `open_tab`. What that check **cannot** see: navigation the agent causes by
`browser_click`ing a link or `browser_type`ing into the address bar once a tab is open — same
inherent gap `xdotool` always had (see the Domain allowlist section above).

**Human-in-the-loop**: `humanGate()` (`browser-actions.ts`) runs a small `Runtime.evaluate` snippet
that checks the focused element (`type==="password"`, `autocomplete` of `current-password` /
`one-time-code`, or a name/id matching `otp|2fa|mfa|verification code`) and the page (a
`recaptcha`/`hcaptcha`/`captcha`-named iframe or element). `browser_type` **refuses** to type when
the gate fires — returns `{ok:false, needsHuman:true, reason, hint}` instead — and `browser_snapshot`
always reports it so the agent notices *before* it tries. The hint is always "call `request_screen`",
same rule the machine-work skill already states for `request_screen` itself.

**F8 / Google sign-in rule, unaffected**: `openChrome()` already starts every session's Chrome with
`--remote-debugging-port=0` (Chrome picks its own loopback port, writes it to `DevToolsActivePort`) —
see [[session-chrome-cdp-google-block]] / [[facebook-browser-driving]]. `browser_*` reuses that SAME
port through `chrome-cdp.ts`; there is no fixed/predictable port and no relaunch trick needed, because
one was never needed for reading (only the OLD memory note's *pre-F8* recollection needed a relaunch).

## 2 — the machine panel shows the SESSION's display, never the shared one silently

- `GET /__api/screen/status?session=<id>` now returns `own` (`true` when
  `session.metadata.screen.vncPort` is set) alongside `available`/`display` — the field
  `ScreenSidePanel.jsx` uses to tell "this session's own machine" from "the shared-desktop values
  `screenTarget()` falls back to when there's nothing allocated yet."
- `POST /__api/sessions/:id/screen/allocate` — explicit `ensureDesktop(id)`, for the panel's empty
  state's button (the same allocation `capture_screen`/`request_screen`/`browser_open` already do
  lazily, now human-triggerable too).
- `server/vnc.ts`'s `/__vnc` WebSocket bridge — the actual video path — now `ensureDesktop(sessionId)`
  before connecting whenever `?session=` is given, instead of going straight to `screenTarget()`
  (which silently returns the global `:99` target when nothing was allocated). Chosen over "refuse":
  an explicit session id means the caller wants THAT session's machine, so give it one. Only a real
  allocation failure (screen sharing off, port range exhausted) still falls through to the global
  fallback — the pre-existing behaviour for that edge case.
- `ScreenSidePanel.jsx` — no `ScreenView` (and therefore no `/__vnc?session=…` connection) is
  rendered until `own` is known to be true; `own === false` renders `ScreenEmptyState` instead: "This
  session doesn't have a machine yet" + a button that calls `screen/allocate` + a clearly separate "The
  shared machine →" link that opens the existing global modal (`setScreenModal(true)`, no `sessionId` — always was a
  distinct code path, just not distinctly *labelled*: the rail icon's title changed from "Screen"
  to "Shared machine").

## Tests

`test/browse1-policy.test.ts` (family expansion incl. the `desktop` compatibility fold, domain
allowlist on `browser_open`/`browser_navigate`, web `TOOL_FAMILIES` sync), `test/browse1-host.test.ts`
(isolated host: `/policy` hides `browser_*` without the family and shows exactly them with it, 403
outside `domains` before touching Chrome, clean 4xx from `/browser/*` with no browser open yet,
`browser_close` always safe, `/screen/status` `own` before/after `metadata.screen` is set),
`test/browse1-web.test.js` (`ScreenEmptyState` markup: the empty message, the allocate button, the
distinctly-labelled shared-machine link). Real Chrome/Xvfb are not exercised in `bun test` (same
boundary `chrome.ts`/`vnc.ts` already had zero coverage of) — verified live instead on an isolated
instance (`allocate_port`), screenshotted, then torn down.
