# Arigami — Triggers & the Pending Queue

Design record (grill-me session 2026-06-30). Adds a third "From trigger" launcher
tab, a server-side trigger producer, and a Pending-tasks queue with autoplay.

The host stays an **unopinionated platform**: a trigger is a pure *producer* (it
finds matching tickets and drops them in the queue). All automation *policy* lives
in one place — the Pending queue.

## Concepts

- **Trigger** — a standing, server-side rule that watches a source and drops
  matching items into the Pending queue. v1 has one kind: `linear-filter`.
- **Pending queue** — the single inbox of not-yet-a-session items (from triggers
  or manual defer). One **autoplay** switch governs whether it self-drains.
- **Session** — unchanged. A pending item "started" becomes an ordinary
  create-from-ticket session, indistinguishable from a hand-launched one.
- **Engine** — a trigger, pending item and cron job each carry `engine` (`claude` | `codex` | '' = the
  agent's engine, else `cfg.defaultEngine`); the session they start runs on it. See docs/ENGINES.md.

## Trigger (producer)

Persisted in `~/.arigami/triggers.json` (debounced writes, mirrors `state.ts`):

```js
trigger = {
  id: 'trig_<nano>',
  type: 'linear-filter',          // only kind in v1
  name: 'My bugs',                // shown as provenance on pending rows
  enabled: true,                  // false = stop polling; queued items stay
  filters: { /* FilterBar facets, incl. labels[]+labelOp — see below */ },
  seen: ['ENG-101', ...],         // high-water mark; dismissed items stay here
  createdSessions: [{ ticket, sessionId, at }],
  lastPolledAt, lastError,
}
```

### Poll runner (one, in `server/index.ts`, next to the watchdog)

- Global interval **60s** (not per-trigger in v1).
- Per enabled trigger: `listIssuesByFacets(filters)` → for each match **not** in
  `seen` and **without** a live session (`metadata.ticket` dedup) → push to the
  Pending queue, add id to `seen`.
- **Prime on arm:** when a trigger is created, run one fetch and mark all current
  matches `seen` *without* queuing — so it fires only on tickets that enter the
  filter *after* arming (new tickets AND old ones newly matching: relabeled,
  reassigned, moved state).
- **Reconcile:** queued items that no longer match their trigger's filter are
  removed from the queue (never became a session → nothing to clean up).

### REST

```
GET    /__api/triggers
POST   /__api/triggers        {type:'linear-filter', name, filters} → arms+primes
PATCH  /__api/triggers/:id    {name?|enabled?|filters?}
DELETE /__api/triggers/:id
```
WS broadcast on change, like sessions.

## Pending queue (policy)

State: an ordered list owned by the server (its own slot in state, broadcast over
WS). Each item:

```js
pending = { id, ticket, title, triggerId, triggerName, addedAt }
```

- New **"Pending tasks"** section at the top of the rail (`Rail.jsx`), above the
  session groups. Order = the array order (see D&D below).
- Row click → main pane shows `/__ticket/<id>` full-pane preview (a new pane mode
  in `App.jsx`, like the launcher takes over the pane). No session tabs — there's
  no session yet.
- Per-item **▶ Play** → `POST /sessions` create-from-ticket payload (same as the
  "From ticket" tab); the row leaves the queue, a root session appears.
- Per-item **Dismiss** → remove the row, **keep** the ticket in its trigger's
  `seen` (won't reappear next poll).
- "Do it later" / a "Later" button in the ticket picker → adds a manual pending
  item (no trigger).

### Autoplay

- Single **▶/⏸ toggle** on the Pending section header — persisted. ▶ = autoplay
  on (queue self-drains top-down), ⏸ = off (items start only via per-item Play).
  *No separate enable checkbox.*
- Global **`maxConcurrent` (default 3)** next to the toggle. Counts **non-archived sessions
  started from the queue (auto or manual Play) that are running a turn** — an idle one (a review
  waiting on its PR, a question waiting on the human, a finished run kept open) is waiting, not
  working, and takes no slot. Autoplay holds when that count = `maxConcurrent`; resumes as slots free.
- **Execution order = the queue's D&D order**, initialized to arrival order, then
  freely reorderable. Autoplay drains top-down in that order.

## Drag-and-drop

- **Pending queue:** D&D reorders; the order *is* the autoplay execution order.
- **Root sessions:** D&D applies in **`flat` mode only** — a stored per-session
  order the server owns (`sortOrder`). `grouped` mode keeps status-derived order
  (no manual order); `tree` mode reorders root rows via the same `sortOrder`,
  **no drag-to-reparent in v1**.

## Linear label filter — multi-select + operator (both tabs)

Shared `FilterBar`, so this lands in the "From ticket" picker *and* the "From
trigger" tab.

- Facet change: `filters.label: string` → `filters.labels: string[]` +
  `filters.labelOp: 'and' | 'or'` (default `'or'`).
- **Backward compat:** an old string `label` reads as `{ labels: [label],
  labelOp: 'or' }` (presets + the built-in preset survive).
- Linear's `list_issues` takes a **single** `label` string — so multi-tag is not
  one call. Fan-out lives server-side in `listIssuesByFacets` (`linear-mcp.ts`),
  shared by the picker route and the poll runner:
  - 0–1 labels → one `listIssues` call.
  - **OR + N** → N calls, union + dedup by id.
  - **AND + N** → 1 call on the first label, then intersection-filter on each
    issue's `labels` (the list payload already carries `labels`).
- UI: the single `<select>` becomes a multi-select (chips/checklist) + an AND/OR
  segmented toggle, matching the existing segmented controls.

## Autonomous (unattended) triggers + injected prompt

For unattended runs (e.g. on EC2), a trigger can carry two extra fields:

- `autonomous: boolean` — sessions it starts run with **no human in the loop**:
  `permissionMode` is forced to `bypassPermissions` (no permission prompts), and an
  **autonomy directive** is appended to the task prompt instructing the agent not to
  ask questions and not to pause for the create-from-ticket review gate — treat it as
  auto-approved and run to completion. Enabling it in the UI is gated behind a
  **warning modal** (consequences + "don't show again", persisted in `prefs.js` as
  `autonomyWarningDismissed`). Autonomous trigger rows show a ⚠️ icon.
- `injectPrompt: string` — free-text appended to the task prompt on start
  (`## Additional instructions`), so a trigger can bias how its tickets are worked.

Both are set in the new-trigger form, stored on the trigger, forwarded by
`startTicketSession`, and back-filled to `false`/`''` for pre-existing records on load.

## Activity log

Each trigger keeps a 200-line in-memory ring buffer (`tlog`): `armed/primed`, a
per-poll `polled · N match · M new` heartbeat, `queued`, `started`, `poll failed`,
and `reconciled` lines. `GET /__api/triggers/:id` returns the trigger + `log`; the
From-trigger tab's **⚡ logs** button opens a service modal that tails it every 1.5s
(mirrors the listener details modal).

## Cron (M2 — durable, agent-callable schedules)

A second trigger kind, `type:'cron'`, sharing the same registry/persistence
(`~/.arigami/triggers.json`) and poll loop (60s) as `linear-filter` — see
`server/triggers.ts`'s `CronTrigger` interface. Unlike Claude Code's own
`CronCreate` (session-local, in-memory, gone when the session closes, expires
after 7 days), a cron trigger is host-owned and durable, and — the actual gap
this closes — **a session can create one itself** via the `cronjob` MCP tool,
not only a human through the UI.

```js
cronTrigger = {
  id: 'trig_<nano>',
  type: 'cron',
  name: 'Nightly summary',
  enabled: true,
  schedule: { kind: 'cron' | 'interval' | 'at', value: '0 22 * * *' },
  prompt: 'Summarize today and write it to the journal.',
  sessionMode: 'isolated' | 'existing:<sessionId>',
  deliver: { push: true, whatsapp: '<jid>' /* or true = config notify.whatsappJid */, master: '<sessionId>' },
  autonomous: true,
  engine: '',                      // 'claude' | 'codex' | '' = the agent's engine, else cfg.defaultEngine
  createdAt, createdBySessionId,
  lastRun: 1735689600000,          // ms epoch, null until first fire
  lastError: null,
  runs: [{ at, sessionId, state, summary }],   // bounded to the last 20
}
```

`engine` is set by `cronjob({engine})`, `POST /__api/triggers {engine}` or the Routine/Cron forms' toggle; an unknown value is ignored on PATCH and stored as `''` on create. Linear triggers use the same rule.

### Schedule (`server/cron-schedule.ts` — pure, unit-tested, no dependency)

- `'cron'` — a standard 5-field expression (`minute hour dom month dow`),
  minute resolution, evaluated in server-local time. Supports `*`, `*/n`,
  `a-b`, `a-b/n`, comma lists, and the standard dom/dow OR-rule (when BOTH are
  restricted, a day matches if either matches); `7` is accepted as a Sunday
  alias for `0`. No external cron library — a small bounded forward search
  (jumps to the next month/day/hour/minute boundary, not a minute-by-minute
  crawl) computes the next run.
- `'interval'` — a duration (`"30s"`/`"5m"`/`"2h"`/`"1d"`, or a plain
  millisecond count). Repeats from `lastRun` (or `createdAt` if it has never
  fired) + the interval — so the first fire is `createdAt + interval`, not
  immediate.
- `'at'` — an ISO timestamp. Fires once; `computeNextRun` returns `null` once
  `lastRun` is set, so the poll loop never refires it.

A bad expression/duration/timestamp throws at **create or patch time**
(`validateSchedule`) — never discovered later as "the poll loop silently never
fires this job."

### Running

- `sessionMode: 'isolated'` — `fireCron` spawns a fresh session
  (`api.startEmptySession`) with `prompt` as its first message, suffixed with
  a directive telling the agent to call `report_to_master` when it finishes
  (that's the only way delivery + auto-archive fire). No explicit memory-
  bootstrap call is needed here: `claude.js`'s `writeUserMessage` already
  prepends the USER.md/MEMORY.md snapshot to any fresh (non-resumed)
  session's first message unconditionally (M1.3) — `startEmptySession` routes
  through the same `claude.sendMessage` as every other new session, so an
  isolated cron run gets it for free. `autonomous: true` also
  appends the same `AUTONOMY_DIRECTIVE` used by autonomous Linear triggers and
  forces `bypassPermissions`. The session is tagged
  `metadata.{fromCronTrigger, cronTriggerId, cronTriggerName, cronDeliver}` —
  `fromCronTrigger` is both the accounting tag (see maxConcurrent below) and
  the create-guard flag (see Guard below). On a terminal
  `report_to_master(state:'done'|'error')`, `server/api.ts`'s `/report`
  handler calls `triggers.onCronReport()` (records the run, delivers the
  result) and archives the session. `state:'blocked'` delivers but does NOT
  archive — a human still needs to look at it (same `pushIntervention`
  'blocked' push as any worker uses).
- `sessionMode: 'existing:<sessionId>'` — delivers `prompt` into that session
  through the exact same idle/busy channel `task_session` uses (idle → now,
  busy → the pending-prompt queue with autoplay). No result-delivery/archive
  step applies here — the target session isn't cron's to close.
- **maxConcurrent**: isolated runs are tagged `metadata.fromQueue = true`, so
  they're counted by the SAME `countQueueSessions()` the Pending queue's
  `maxConcurrent` already gates — no parallel accounting mechanism. A fire
  that would exceed the budget is held (logged, retried next poll); manual
  "run now" (`runCronNow`, UI button / `cronjob action:'run'`) bypasses the
  gate — it's an explicit one-off action.
- **Double-fire lock**: an in-memory `Set` (`cronFiring`) guards each trigger
  id for the duration of its own fire — not persisted (doesn't need to be; a
  restart can't have two pollers running at once).

### Delivery (`deliverCronResult`, `server/triggers.ts`)

Reuses existing channels — no new transport:
- `deliver.push` (default **true** — decision) — a 4th row in the push table,
  `docs/SPEC.md` "Human intervention → push notification". Title = job name
  (+ ` — <state>` on error/blocked); body = the run's `summary`/`note`.
- `deliver.master` — wakes that session id with a thin pointer via
  `listeners.enqueueWake`, same mechanism `report_to_master` uses for a
  dispatch parent — but cron doesn't set `metadata.master` on the spawned
  session (which would piggyback on the dispatch-flavored generic pointer
  wording); it calls `enqueueWake` directly so `[SILENT]` can gate it too.
- `deliver.whatsapp` — **real.** It sends through the host's ONE paired
  WhatsApp process (`server/whatsapp-bridge.ts` owns it; `whatsapp-proxy.ts`
  calls `send_message` on it), so no second Baileys connection is opened and
  the live pairing is never replaced. The value is either a JID
  (`…@s.whatsapp.net` / `…@lid` / `…@g.us`) or `true`, which means "the default
  target", `notify.whatsappJid` in `config.json`. Not paired, or no target
  resolved → the delivery is skipped with a `tlog` warning; a notification is
  never allowed to become an error. Delivery goes through `server/notify.ts`,
  which is also where an extension registers extra channels (Telegram, mail…).
- **`[SILENT]`** — a run's `summary`/`note` starting with `[SILENT]`
  suppresses a SUCCESS delivery only (push + master); the prefix is stripped
  before display. Failures (`error`/`blocked`) always deliver regardless.

### Guard against runaway scheduling loops

A session spawned BY a cron fire (`metadata.fromCronTrigger` set) cannot
create a new cron trigger — `createCronTrigger` throws if
`createdBySessionId` resolves to such a session. Lesson from OpenClaw
issue #21775 / Hermes's `allow_agent_scheduling:false`: nothing else stops a
job whose own prompt says "schedule another job like this one" from spawning
an unbounded tree. Only **create** is guarded — pause/resume/run/remove from
a cron-spawned session are fine (they don't grow the tree).

### `cronjob` MCP tool (`mcp/host-mcp.js`)

`cronjob({action: create|list|pause|resume|run|remove, ...})` — thin fetches
to the REST endpoints below, so a session (a PM, a brain chat — M4) can
schedule itself. `action:'create'` passes the caller's own session id as
`createdBySessionId` for the guard check above.

### REST

```
GET    /__api/triggers            → both kinds; cron entries carry a live-computed `nextRunAt`
POST   /__api/triggers            {type:'cron', name, prompt, schedule, sessionMode, deliver, autonomous, createdBySessionId?}
GET    /__api/triggers/:id        → + `log` (tlog) + `nextRunAt` for cron
PATCH  /__api/triggers/:id        {name?|enabled?|prompt?|schedule?|sessionMode?|deliver?|autonomous?} — schedule re-validates, 400 on a bad expression
DELETE /__api/triggers/:id
POST   /__api/triggers/:id/run    → fire now (bypasses schedule + maxConcurrent)
```

### UI

A sub-tab switch (`TriggerKindSwitch`) inside the existing "From trigger" tab
— "Linear filter" (unchanged) / "Cron" (`CronSubPanel`, `Launcher.jsx`):
new-job form (name, prompt, schedule kind+value, session mode, deliver,
autonomous) + a list (enabled dot, schedule summary, last/next run, Run now,
Logs — **reuses** `TriggerLogModal`'s tlog activity view for run history
rather than a separate `runs[]` UI, Pause/Resume, Delete).

## Touch list

New:
- `server/triggers.ts` — registry (load/save/CRUD) + poll runner. **M2:**
  `CronTrigger` type, `createCronTrigger`/`patchTrigger`/`runCronNow`/
  `onCronReport`/`nextRunFor`, the guard, `deliverCronResult`.
- `server/cron-schedule.ts` (M2) — pure schedule math (cron/interval/at →
  next run), no dependency. Unit-tested in `test/cron-schedule.test.js`.
- `web/src/components/Triggers.jsx` (or a section in `Launcher.jsx`) — the third
  tab: trigger list + new-trigger form reusing `FilterBar`. **M2:** the Cron
  sub-tab (`TriggerKindSwitch`, `CronSubPanel`).
- Pending-queue state + `Rail.jsx` "Pending tasks" section + `/__ticket` preview
  pane mode in `App.jsx`.

Changed:
- `server/state.ts` — pending queue + autoplay/`maxConcurrent` settings +
  `sortOrder` on sessions; persistence.
- `server/api.ts` — `/__api/triggers*`, `/__api/pending*`, autoplay settings,
  `labels[]`+`labelOp` on `/__api/linear/tickets`. **M2:**
  `POST /__api/triggers` dispatches on `type`; `POST /__api/triggers/:id/run`;
  the `/report` handler detects `metadata.cronTriggerId` and delegates to
  `triggers.onCronReport`; `AUTONOMY_DIRECTIVE`/`CRON_REPORT_DIRECTIVE`
  exported; `deliverToSession` helper (shared idle/busy delivery semantics).
- `server/linear-mcp.ts` — `listIssuesByFacets` (multi-label fan-out/merge).
- `server/push.ts` — reused as-is; cron is a 4th row in the push table
  (`docs/SPEC.md`), no code change.
- `mcp/host-mcp.js` — **M2:** the `cronjob` tool.
- `web/src/components/Launcher.jsx` — third tab + multi-select `FilterBar`.
  **M2:** the Cron sub-tab.
- `web/src/lib/prefs.js` — `sanitizeFilters`/`EMPTY_TICKET_FILTERS` + preset
  migration for `labels[]`/`labelOp`.

Reused as-is: `POST /sessions`, create-from-ticket, the `/__ticket/<id>` page,
the Linear OAuth client, `report_to_master` (cron's own completion channel),
`push.ts`, `listeners.enqueueWake`.
```

### Project folders at launch

Session creation, pending items and trigger definitions accept `folderName` (REST)
/ `folder_name` (`create_session` and `cronjob` MCP). Names are trimmed and matched
exactly, case-sensitively; a missing folder is created when the session launches.
Blank names leave sessions at root. Concurrent launches reuse the same folder.
`folderId` / `folder_id` takes precedence, including the existing behavior that an
unknown id leaves the session at root. Dispatch children still inherit their
master's folder. Folder membership does not create a project controller.

The launcher exposes the name in session options (also saved in presets), Linear
trigger options and isolated cron options. Deferred items retain it; tickets
produced by a trigger use its current settings when started. Trigger PATCH accepts
`folderName: null` or `""` to clear the choice. Cron delivery to an existing session
does not move it. Profile-bundle cron entries also accept `folderName`.

Listeners wake their existing session rather than create one. Listener registration
accepts `folderName` / `folderId` in REST (`folder_name` / `folder_id` in MCP) to
place that session in the chosen folder after successful registration; omitting
them keeps its current membership. Extension launcher tabs can pass `folderName`
or `folderId` in `createSession`; a human-entered folder name takes precedence.
