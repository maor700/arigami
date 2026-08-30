# Agents ("צוות") — A1

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
browser/     reserved (A2: persistent Chrome profile)
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
  פעילות (sessions + their episodes). חיבורים / שגרה are A2 placeholders.
- Mobile: the same section inside the rail drawer.

## Tests / gates

`test/agents.test.js` (CRUD, validation, persona block, memory namespace isolation),
`test/agents-host.test.ts` (isolated host: REST, `create_session({agent})` inheritance, home,
card flow, memory REST, activity), `test/agents-web.test.js` (Rail order + rows, AgentCard,
fold). Gates: `bun run typecheck` (2 pre-existing errors), `bun test test/`,
`cd web && bun run build`, `scripts/check-public-readiness.sh`.

## Next waves

A2 connected identity (per-agent connections + Chrome profile, `cronjob({agent})`, listeners),
A3 control (host-enforced tool/domain allowlists, budgets, cost per agent),
A4 experience (slash-commands, @mentions, `marketing-team` bundle, bundles ship `agents/`).
