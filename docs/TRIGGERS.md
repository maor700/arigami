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
- Global **`maxConcurrent` (default 3)** next to the toggle. Counts **live,
  non-archived sessions started from the queue** (auto or manual Play). Autoplay
  holds when live count = `maxConcurrent`; resumes as slots free.
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

## Touch list

New:
- `server/triggers.ts` — registry (load/save/CRUD) + poll runner.
- `web/src/components/Triggers.jsx` (or a section in `Launcher.jsx`) — the third
  tab: trigger list + new-trigger form reusing `FilterBar`.
- Pending-queue state + `Rail.jsx` "Pending tasks" section + `/__ticket` preview
  pane mode in `App.jsx`.

Changed:
- `server/state.ts` — pending queue + autoplay/`maxConcurrent` settings +
  `sortOrder` on sessions; persistence.
- `server/api.ts` — `/__api/triggers*`, `/__api/pending*`, autoplay settings,
  `labels[]`+`labelOp` on `/__api/linear/tickets`.
- `server/linear-mcp.ts` — `listIssuesByFacets` (multi-label fan-out/merge).
- `web/src/components/Launcher.jsx` — third tab + multi-select `FilterBar`.
- `web/src/lib/prefs.js` — `sanitizeFilters`/`EMPTY_TICKET_FILTERS` + preset
  migration for `labels[]`/`labelOp`.

Reused as-is: `POST /sessions`, create-from-ticket, the `/__ticket/<id>` page,
the Linear OAuth client.
```
