# Dispatcher — master/worker orchestration for arigami

A design spec for letting any host session farm out parts of a larger task to
child sessions ("workers"), manage them, and decide what to do next as results
arrive. Produced from a full design grill; every section below traces to a
decision recorded in **§ Decisions**.

---

## 1. The model

**There is no "master" role you invoke.** Any ordinary session that dispatches a
worker *automatically becomes* that worker's master — the host stamps the parent
on the child at spawn time. "Master" is just "the session that spawned you."

This is **recursive**: a worker that farms out part of *its* subtask becomes a
master of its own children. The result is a **tree of arbitrary depth**, not one
master over a flat pool. One skill (`dispatch`) is loaded by whoever orchestrates;
a session acts master-side toward its children and worker-side toward its parent,
and can be both at once.

The master is a **pure orchestrator**: it decomposes, spawns, reads *thin*
results, decides, and escalates. **It never writes code or resolves conflicts** —
all heavy lifting, including integration, is just another worker. This keeps the
orchestrator's context cheap and long-lived (and is exactly why per-session
auto-compact matters: the master is the session most at risk of filling up).

```
root session (master)
├── worker A  (read-only:  "find all call sites of X")
├── worker B  (mutating:   own worktree+branch)        ┐
├── worker C  (mutating:   own worktree+branch)        � run in parallel
│   └── worker C1 (mutating)  ← C dispatched, so C is now a master too
└── integration worker (merges B, C branches; runs gate)  ← spawned when ready
```

---

## 2. Communication

**Hybrid (decision 1).** Two directions:

- **Workers push events up** to their master — *thin pointers only* (decision 2):
  `"worker abc → done"` / `"blocked"` / `"milestone N"`. Delivered via the
  existing **queue-until-idle + coalesce** path (`server/listeners.ts`), so the
  master is never interrupted mid-turn and wakes **once per burst**, then pulls
  detail itself.
- **Masters pull status on demand** — `list_sessions` (returns `metadata` +
  `claude_state`) and `GET /sessions/:id` (session object, no chat).

### The one hard rule

> **The master must never read a worker's chat transcript (`/sessions/:id/chat`).**

The transcript is the *only* unbounded thing the master could fetch; everything
else it can poll is already bounded. Forbidding that one endpoint makes context
blow-up structurally impossible. The worker — which has the full context — is
responsible for compressing its work into a bounded handoff; the master reads
only that. (Same contract this agent harness uses for its own subagents: the
final return value is a small struct, not the scratchpad.)

---

## 3. The contract (single source of truth)

Lives once, in the `dispatch` skill, shared by master and worker so they cannot
drift (decision 13, as amended by the emergent-master correction).

### 3.1 Metadata keys (on every worker session)

| key                | set by   | meaning                                              |
|--------------------|----------|-----------------------------------------------------|
| `master`           | **host** (auto, decision 15) | parent session id (the spawner)        |
| `role`             | **host** (auto) | `'worker'`                                      |
| `subtask`          | spawner  | the `ORCHESTRATION.json` node id this worker owns    |
| `kind`             | spawner  | `'mutating'` \| `'readonly'`                          |
| `worktree`         | **host** (auto, mutating) | absolute worktree path                  |
| `branch`           | **host** (auto, mutating) | `dispatch/<subtask>`                    |
| `port`             | **host** (auto, if `needsServer`) | allocated dev-server port       |
| `cleanup`          | **host** (auto) | teardown cmds (`git worktree remove …`, kill server)|
| `result`           | worker   | capped struct — see 3.3                              |

### 3.2 `ORCHESTRATION.json` (the durable plan — decision 4)

The master's **source of truth**, written to its own cwd. The master treats its
own chat as scratch; after any wake or compaction it rebuilds working state from
**this file + one `list_sessions` poll filtered to `metadata.master == me`**.

```jsonc
{
  "task": "one-line description of the whole job",
  "base": "main",                 // integration base ref
  "nodes": [
    {
      "id": "find-callsites",
      "desc": "locate every call site of foo()",
      "kind": "readonly",         // readonly | mutating
      "deps": [],                 // node ids that must be terminal first
      "needsServer": false,
      "state": "done",            // pending|ready|running|blocked|done|error|cancelled
      "worker": "sess_AbC",       // assigned session id, or null
      "attempts": 1,
      "maxAttempts": 2,
      "resultRef": "metadata"     // "metadata" | path to an artifact file
    }
  ]
}
```

**Ready-set is computed, not eyeballed (decision 9):**
```
ready = { n in nodes
          | n.state in {pending, ready}
          | every d in n.deps has nodes[d].state == done
          | no running node shares n's worktree target }
```
The master launches from `ready` up to the global caps each wake. **Done** = every
node terminal (`done | cancelled`, or `error`/`blocked` that's been escalated).

### 3.3 The result struct (capped — decision 3, persisted by decision 12)

Written into the worker's `metadata.result` **atomically with the wake** by
`report_to_master`. Server **truncates** to a hard cap (e.g. `summary` ≤ ~2 KB) so
a runaway worker physically cannot bloat the master.

```jsonc
{
  "state": "done",               // done | blocked | error | milestone
  "summary": "added the flag and 3 tests; all green",
  "artifacts": [                 // pointers for depth — master opens on demand
    { "kind": "branch", "ref": "dispatch/add-flag" },
    { "kind": "file",   "path": "REPORT.md" },
    { "kind": "diff",   "ref": "HEAD~1" }
  ]
}
```
For code, the master reads the **diff** (`/sessions/:id/changes`) or specific
files — never the chat. Results that don't fit the cap go in an **artifact file**
the master opens for one worker on demand (decision 3 = "both").

---

## 4. New server primitives to build

Everything not listed here is **reused as-is**: tagging (metadata),
escalation (`request_action`), kill (`delete_session({run_cleanup:true})`),
diffs (`/sessions/:id/changes`), listener scheduler/queue/TTL.

### 4.1 `create_session` — fully automatic wiring (decision 15 = A)

The dispatcher calls `create_session({ prompt, kind, needsServer?, base? })`.
The host detects the caller via `ARIGAMI_SESSION_ID` and does **all** of:

1. stamp `metadata.master = <caller>`, `metadata.role = 'worker'`;
2. enforce **global** caps (decision 14) — if `kind` is over its cap, return
   `{ deferred: true, reason: 'at-capacity' }` (no server-side queue; the master
   leaves the node in `ready` and retries next wake);
3. if `kind == 'mutating'`: `git worktree add` a new `dispatch/<subtask>` branch
   off `base` (default = parent's current branch) under
   `reposDir/worktreesSubdir`; set `cwd`, `metadata.worktree/branch/cleanup`;
4. if `readonly`: `cwd` = parent's repo (read-only intent; no worktree);
5. if `needsServer`: allocate a free port from the configured pool → `metadata.port`
   + child env; add release to `cleanup`;
6. spawn with `permission_mode = bypassPermissions` (readonly) or `acceptEdits`
   (mutating) — decision 7;
7. **auto-arm the worker-watchdog** listener (4.3) targeting the caller.

> Needs a real `git worktree add/remove` helper in `server/git.ts` (none today —
> only read helpers exist). Caps are **global**, counted across all sessions by
> `role`+`kind`, so the whole tree is bounded regardless of depth.

### 4.2 `report_to_master` — MCP tool (decisions 2, 3, 12 = A)

`report_to_master({ state, note, summary?, artifacts? })`, called by a worker.
**Atomic persist-then-wake:**

1. write the capped `{state, summary, artifacts}` to the worker's own
   `metadata.result`;
2. **then** enqueue a *thin* pointer (`"worker <id> (<subtask>) → <state>: <note>"`)
   to `metadata.master` via the existing queue-until-idle delivery.

Persist-before-wake kills the publish-before-write race: any poll the wake
triggers always sees fresh data. `state: blocked` is the escalation signal — the
master never retries it (decision 11), it decides or escalates to the human.

### 4.3 `worker` watchdog — new listener type (decision 8 = B)

Extend `server/listeners.ts` (today hardcoded to `github-pr`) with a `worker`
type, auto-armed by 4.1. Per tick it inspects the worker and pushes a thin event
to the master on:

- **dead** — `claude_state == 'dead'` (crash);
- **stall** — no state change / no `report_to_master` past `stallTimeoutSec`.

Reuses the scheduler, queue-until-idle, and TTL. This is the backstop for the
cases an explicit push can't cover (crash, hang, silent-done). Master response is
**bounded auto-retry then escalate** (decision 11): on stall, kill the wedged
worker first (`delete_session({run_cleanup:true})`) then respawn; on crash,
respawn; after `maxAttempts`, mark `blocked` + `request_action` to the human.

### 4.4 `GET /sessions/:id/orchestration` — bounded read for the UI

Returns the parsed `ORCHESTRATION.json` **plus** a bounded summary per child
(`id, title, status, claude_state, metadata.result`). The Orchestration tab (6.2)
renders from this; it **never** reads worker chat.

### 4.5 `config.json` additions (decision 10)

```jsonc
{
  "dispatcher": {
    "maxMutating": 3,            // global concurrent mutating workers
    "maxReadOnly": 6,            // global concurrent read-only workers
    "portRange": [3200, 3299],   // pool for needsServer workers
    "stallTimeoutSec": 600       // watchdog stall threshold
  }
}
```

---

## 5. The skill — `dispatch` (one skill, role-branched)

`skills/dispatch/SKILL.md`, available to every session (each spawn gets
`--plugin-dir ROOT`). Sections:

- **Contract** (§3) — shared verbatim by both roles.
- **Master protocol:** decompose → write `ORCHESTRATION.json` → loop:
  `{ on wake: reconcile (read plan + poll my workers); update node states from
  results; compute ready-set; launch up to caps (handle deferred); on blocked →
  decide/escalate via request_action; when a wave's branches are ready → spawn an
  integration worker; when all terminal → integrate + signal the human }`.
  **Never edits code. Never reads worker chat.**
- **Worker protocol:** read my `subtask` node → do it (in my worktree if mutating)
  → write artifacts → `report_to_master` with a capped result → **on error or
  block, still report** (never hang on a permission prompt; escalate up instead).
  If I farm out part of my work, I become a master and aggregate my children into
  **one** result before reporting up (result bubbling, decision 14).

---

## 6. UI

### 6.1 Rail "Tree" mode (decision 17 = A)

A third Rail mode beside Active / Grouped-by-status: workers render **indented,
collapsible, recursively** under their master (walk `metadata.master`), each row
keeping its existing status / color / progress / port / listener indicators. Only
new sectioning logic over the existing row component. Depends only on
`metadata.master` (stable), so it's safe to build immediately.

### 6.2 Orchestration tab (decisions 18 = A, 19 = C)

A **built-in** tab (like Changes) that auto-appears on any session with children.
Renders `GET …/orchestration` as a **state-grouped list** (Running / Ready /
Blocked / Done) with **dep chips**, each node's worker **clickable to jump to that
session**, the ready-set highlighted, escalations called out, and per-node
**kill / retry** controls. List-first; a drawn node-edge graph is a later nicety.

Escalations surface via the existing `request_action` bar (on the worker *and*
mirrored as "needs you" in the parent's Orchestration tab). The worker-watchdog
shows through the existing listener indicators.

---

## 7. Phased build plan (decision 16 = B, with UI pulled to Phase 1 per decision 19 = C)

**Phase 1 — prove the loop + full UI.**
- `create_session` auto-parent + auto-role + global caps (deferred return).
- `report_to_master` (atomic persist-then-wake).
- `GET /sessions/:id/orchestration`.
- `dispatch` skill (contract + both protocols).
- `ORCHESTRATION.json` schema (build this **first** — the Orchestration tab and
  everything else key off it).
- UI: Rail Tree mode **and** Orchestration tab.
- Worktrees: created by the master via shell `git worktree add` (interim).
- Integration: delegated integration worker, manual trigger by the master.
- *Validate on a real 2–3-worker task before Phase 2.*

**Phase 2 — robustness (server hardening).**
- `worker` watchdog listener (crash/stall) — auto-armed by `create_session`;
  lights up the stall/dead indicators the Phase-1 UI already has slots for.
- Port pool + `needsServer` allocation/release.
- Fold worktree creation **into** `create_session` (retire the interim shell path).
- Nesting/bubbling exercised end-to-end (depth > 1).
- Bounded auto-retry wiring on watchdog events.

> Risk flagged: building the Orchestration tab in Phase 1 (decision 19 = C) means
> it's coded against a plan schema still settling in Phase 1 → some rework.
> Mitigation: lock `ORCHESTRATION.json` first.

---

## 8. Decisions (traceability)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Coordination topology | **Hybrid** — master pulls on demand + workers push |
| 2 | Push payload | **Thin** pointer + poll for detail; queue-until-idle, coalesced |
| 3 | Result channel | **Both** — capped struct in metadata + artifact file + diffs; **never chat** |
| 4 | Orchestration state | **Durable `ORCHESTRATION.json`** + `metadata.master/role/subtask` tagging |
| 5 | Isolation | **Type-aware** — worktree+branch for mutating, none for read-only |
| 6 | Integration | **Delegated integration worker**; master never edits |
| 7 | Autonomy | `acceptEdits`+escalate (mutating), `bypassPermissions` (readonly); master = sole human interface |
| 8 | Failure detection | Explicit pushes **+ server-side worker-watchdog** (dead/stall) |
| 9 | Planning | **Coarse plan + adaptive**; ready-set computed mechanically |
| 10 | Concurrency | **Caps + port pool in config**; split `maxMutating:3` / `maxReadOnly:6` |
| 11 | Recovery & kill | Failure/blocked split; **bounded auto-retry (2)** then escalate; kill-with-cleanup |
| 12 | Report tool | **Unified, atomic** persist-then-wake |
| 13 | Packaging | **One skill, role-branched** (single source of contract) |
| —  | Master model | **Emergent & recursive** — dispatching auto-makes you a master (user correction) |
| 14 | Recursion | **Nesting allowed, global server caps**, results bubble, at-capacity → deferred |
| 15 | Auto-wiring | **Fully automatic host-side** (parent, role, watchdog, port, caps, worktree) |
| 16 | Build scope | **MVP-then-harden** |
| 17 | Rail tree | **Third "Tree" mode**, recursive/collapsible |
| 18 | Orchestration view | **Built-in Orchestration tab**, list-first |
| 19 | UI phasing | **Full UI in Phase 1** (accept schema-churn rework) |
