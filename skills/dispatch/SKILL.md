---
description: Arigami master/worker orchestration — decompose a large task into a tree of worker sessions, spawn them (read-only or mutating-with-worktree), read thin results, decide what's next, and integrate. One skill, role-branched: you act master-side toward children and worker-side toward your parent, possibly both at once. Loaded by any session that needs to farm work out, or that was spawned as a worker.
argument-hint: [task description, if you are the root master]
slash: plan
---

# Dispatch (Arigami master/worker orchestration)

You are running inside a Arigami session (`ARIGAMI_SESSION_ID` is set and the
`arigami` MCP is connected). This skill lets you **farm parts of a task out to
child sessions ("workers")**, manage them, and decide what to do as results land.

**There is no "master" role you invoke.** Dispatching a worker *automatically
makes you its master* — the host stamps you as the parent at spawn time. This is
recursive: a worker that farms out part of *its* job becomes a master too. The
result is a **tree of any depth**. You may be both a worker (to your parent) and a
master (to your children) at once.

If `$ARGUMENTS` contains a task, you are the **root master** — start at *Master
protocol*. If your `metadata.subtask` is set (check `list_sessions`), you were
spawned as a **worker** — start at *Worker protocol*.

---

## The contract (shared by both roles — read in full)

### Metadata keys (the host sets these automatically; never set them yourself)

| key        | set by | meaning |
|------------|--------|---------|
| `master`   | host   | your parent session id (the spawner) |
| `role`     | host   | `'worker'` |
| `subtask`  | spawner | the `ORCHESTRATION.json` node id this worker owns |
| `kind`     | spawner | `'mutating'` \| `'readonly'` |
| `worktree` | host   | absolute worktree path (mutating only) |
| `branch`   | host   | `dispatch/<subtask>` (mutating only) |
| `cleanup`  | host   | teardown cmds (worktree remove, etc.) |
| `result`   | you    | capped struct written by `report_to_master` |

### The one hard rule

> **A master NEVER reads a worker's chat transcript.** (`GET /sessions/:id/chat`
> is forbidden to you.)

The transcript is the only unbounded thing you could fetch. The worker — which has
the full context — compresses its work into a **bounded handoff** (`report_to_master`);
the master reads only that. For code, the master reads the **diff**
(`GET /sessions/:id/changes` / `/changes/diff`) or specific files — never the chat.
This is what keeps a master's context cheap and long-lived.

### The result struct (capped)

`report_to_master({ state, note, summary?, artifacts? })`:
- `state`: `done` | `blocked` | `error` | `milestone`
- `note`: one-line pointer (the thin wake the master sees)
- `summary`: ≤~2 KB of what you did (the server truncates)
- `artifacts`: pointers the master opens on demand, e.g.
  `[{kind:"branch",ref:"dispatch/add-flag"},{kind:"file",path:"REPORT.md"},{kind:"diff",ref:"HEAD~1"}]`

`state:"blocked"` is the escalation signal — the master decides or escalates to the
human; **it never silently retries a block**.

### `ORCHESTRATION.json` — the master's durable plan

The master's **source of truth**, written to its own cwd. The master treats its own
chat as scratch: after any wake or compaction it rebuilds working state from **this
file + one `list_sessions` poll filtered to `metadata.master == me`**.

```jsonc
{
  "task": "one-line description of the whole job",
  "base": "main",                 // integration base ref
  "nodes": [
    {
      "id": "find-callsites",     // unique; names the worker's branch/worktree
      "desc": "locate every call site of foo()",
      "kind": "readonly",         // readonly | mutating
      "deps": [],                 // node ids that must be terminal (done) first
      "needsServer": false,
      "state": "pending",         // pending|ready|running|blocked|done|error|cancelled
      "worker": null,             // assigned session id, or null
      "attempts": 0,
      "maxAttempts": 2,
      "resultRef": "metadata"     // "metadata" | path to an artifact file
    }
  ]
}
```

**Ready-set is computed mechanically, never eyeballed:**
```
ready = { n in nodes
          | n.state in {pending, ready}
          | every d in n.deps has nodes[d].state == done
          | no running node shares n's worktree target }
```
**Done** = every node terminal (`done | cancelled`, or `error`/`blocked` that's
been escalated).

---

## Master protocol

**You are a pure orchestrator. You NEVER write code or resolve conflicts** — all
heavy lifting, *including integration*, is just another worker. Keeping your own
context thin is the whole point.

1. **Decompose.** Break the task into nodes with explicit `deps`. Mark each
   `readonly` (search/analysis, no edits) or `mutating` (edits in its own
   worktree). Write `ORCHESTRATION.json` to your cwd. Announce via `set_title` /
   `set_status` / `set_progress` so the cockpit reflects the plan.

2. **Loop — on each wake (or right after writing the plan):**
   - **Reconcile.** Re-read `ORCHESTRATION.json`. `list_sessions`, filter to
     `metadata.master == <me>`. Update each node's `state`/`worker` from its
     worker's `metadata.result` and `claude_state`. (Read results, branches,
     diffs — never chat.)
   - **Compute the ready-set** (formula above).
   - **Launch** ready nodes via `create_session({ kind, subtask: <node.id>,
     prompt: <node instructions>, base? })`. The host auto-wires
     parent/role/worktree/branch/cleanup.
     - On `{deferred:true}` (at capacity): leave the node `ready`, retry next wake.
     - On spawn: set the node `state:"running"`, `worker:<id>`, `attempts++`.
   - **Handle terminal results:**
     - `done` → mark the node `done`.
     - `error`/dead → if `attempts < maxAttempts`, kill-with-cleanup
       (`delete_session({run_cleanup:true})`) and relaunch; else mark `blocked`
       and escalate.
     - `blocked` → **decide or escalate** (`request_action` to the human). Never
       auto-retry a block.
   - **Integrate.** A worker never merges its own branch. When a wave's
     mutating branches are all `done`, either (a) — the default when a human
     is in the loop — wait for the human's approval on each branch
     (`metadata.review.state === "approved"`, set by their ✓ Verified /
     review-approve) and then merge it with **one call, `merge_session({
     session_id, strategy?, delete_branch? })`** — the HOST runs the git merge
     into your checkout, refuses dirty/unapproved bases, and returns
     `{conflict:true, files}` (already aborted) on a conflict → task the worker
     to rebase and try again; after success run the gate (tsc/tests/build)
     yourself, then push; or (b) for unattended runs, spawn a **delegated
     integration worker** (`kind:"mutating"`) whose job is to merge those
     branches onto `base`, run the gate, and report. In both cases you never
     merge by hand in your own checkout.
   - **Finish.** When every node is terminal, integrate the final result and
     signal the human (`request_review` / `request_action`).

3. Persist every node-state change back to `ORCHESTRATION.json` immediately — it is
   your memory across compaction.

---

## Worker protocol

1. Read your `subtask` node (the master put your instructions in your first
   prompt; the node id is `metadata.subtask`). If you need plan context, you may
   read your master's `ORCHESTRATION.json`.
2. Do the work. **Never merge your branch into `base` yourself** — commit on
   your branch; merging is your master's call (`merge_session`) after the
   human approved, or the integration worker's. If `mutating`, all edits go in **your worktree** (`metadata.worktree`,
   already your cwd) on **your branch** (`metadata.branch`). If `readonly`, do not
   edit — search/analyze and write findings.
3. Write any large output to an **artifact file** (e.g. `REPORT.md` in your cwd)
   rather than stuffing it all into the result.
4. **`report_to_master`** with a capped result — `state`, a one-line `note`, a
   `summary`, and `artifacts` pointers. For code, point at your `branch`/`diff`.
5. **On error or block, STILL report** (`state:"error"` / `"blocked"`). Never hang
   on a permission prompt — escalate up by reporting; the master is the sole human
   interface.
6. If you farmed out part of your work (you became a master too), aggregate your
   children into **one** result before reporting up (results bubble).

---

## Retro (before you finish, either role)

When your part of the tree reaches a terminal state (root master: whole job
done; worker: right before `report_to_master`), pause for one question: did
you learn something a *future* dispatch run should know — a decomposition
that turned out wrong, a node that needed a dependency you didn't see
upfront, an integration step this skill's instructions don't cover? If yes,
call `skill_propose({name: "dispatch", rationale, evidence?})` describing the
concrete change. Not every run produces one — most won't. Never a background
habit, never speculative. If you're a worker and filed a proposal, pass its
id as `report_to_master`'s `skill_proposal_id` so your master sees it.

## Showing things to the human (links)

The human may be on a phone, another machine or a tailnet — a
`http://localhost:…` link only works on the host box. So:

- **Static output** (report, HTML, screenshots dir, built site) →
  `publish_artifact` and pass on the `/__artifacts/<id>/` path it returns.
- **Live server** (dev server, Storybook) → bind it to `$PORT` (or the port from
  `allocate_port`) and `open_tab({type:"url", url:"http://localhost:$PORT"})`;
  the host proxies it into a cockpit tab.
- **Never print `http://localhost:…` URLs** in replies, reports, pushes or
  messages. The host returns host-**relative** paths (`/__host/?session=…`,
  `/__artifacts/…`) — forward them as-is. `$ARIGAMI_URL` is an internal base for
  your own API calls, not a link for people.

## Notes

- Caps are global across the whole tree (`config.json` → `dispatcher.maxMutating` /
  `maxReadOnly`). Depth never lets the fleet exceed them.
- **Watchdog (auto-armed).** When you spawn a worker the host arms a watchdog that
  wakes *you* if that worker **crashes** (claude dies) or **stalls** (no state
  change or report past `dispatcher.stallTimeoutSec`). Treat its wake like any
  terminal signal: bounded auto-retry (kill-with-cleanup + respawn, within
  `maxAttempts`) then escalate. The watchdog retires itself once the worker reports
  a terminal result or is deleted.
- **needsServer.** Pass `needsServer:true` (a worker that runs a dev server) and the
  host allocates a free port from the pool into `metadata.port` and exposes it to
  the worker as `$PORT`; it's released when the worker session is deleted. A
  session that didn't ask up front can call `allocate_port` later.
- `create_session` returns a host-**relative** `url` (`/__host/?session=<id>`);
  show it as-is (`url_internal` is the loopback form, host-box only).
- Teardown: `delete_session({ run_cleanup:true })` runs the worker's `metadata.cleanup`
  (removes its worktree, deletes its branch).
- The cockpit shows the tree (Rail "Tree" mode) and a per-master **Orchestration
  tab** (`GET /sessions/:id/orchestration`) — both render from `metadata` + the
  plan, never from chat.

## Missing capability → `needs_setup` → `request_setup` (JIT setup)

Tools on this host do not fail when a capability is not configured — they *ask*:
a tool result (MCP or REST) of the form
`{ "needs_setup": "composio:gmail", "why": "read your inbox", "hint": "call request_setup" }`
means the capability (`identity`, `claude`, `git`, `repo:<name>`, `whatsapp`,
`composio:<toolkit>`, `desktop`, `push`, `remote`, `telemetry`) is missing.

When you see one:

1. Call `request_setup({capability, why})` — the host shows a Setup card in the
   chat (and a push) where the human chooses **automatic** or **manual**. It blocks.
2. `{state:"auto"}` → the human asked *you* to connect it: run the matching
   playbook — `skills/connect-<provider>/SKILL.md` (`connect-identity`,
   `connect-composio`, `connect-claude`, `connect-tailscale`, `connect-github`) —
   and finish with `report_setup({capability, ok, evidence?})`. Then call the
   original tool again.
3. `{state:"done"}` → the human connected it manually: call the tool again.
4. `{state:"skipped"|"timeout"}` → offer an alternative for the task; do not nag.

**Never work around a missing capability** — no scraping instead of the API, no
asking for tokens/passwords in chat, no reading another session's profile. The
card is the only path. Details: `docs/CONNECT.md`.
