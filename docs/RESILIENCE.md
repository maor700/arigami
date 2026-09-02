# Resilience — the host supervisor (RES1)

> The business keeps running unless a human answer is genuinely required.

A session used to stop for reasons no human needed to hear about: the `claude`
process died, its OAuth token expired, every pooled account hit its weekly
limit, an MCP server stopped answering, a worker finished and forgot to report,
a controller waited forever on a child that never got the ask.

The supervisor closes those. It computes a health state for every session once
per tick, walks a recovery ladder for the ones it can fix, and puts everything
it genuinely cannot fix into one queue the human reads: **"ממתין לך"**.

Two files, split the same way as `watchdog.ts` / `listeners.ts`:

| file | what it is |
|---|---|
| `server/supervisor.ts` | the whole decision, **pure** — no IO, no state singleton, unit-tested in `test/supervisor.test.ts` |
| `server/supervisor-loop.ts` | the IO around it: read the sessions, run the action, write the receipts, expose the health map |

It never restarts the host, never touches anything outside a session, and never
prunes or deletes anything.

---

## 1. One health model

Every live session gets a computed state, not a guess.

| state | meaning | rail dot |
|---|---|---|
| `RUNNING` | a turn is in flight, or the prompt queue is non-empty | blue |
| `IDLE_OK` | finished and reported; nothing owed | grey |
| `WAITING_HUMAN` | genuinely blocked on a person. **The only state where stopping is correct.** | amber |
| `BLOCKED_SYSTEM` | auth revoked, accounts+models exhausted, proc dead, MCP down | red |
| `STALLED` | no progress for N minutes with nothing owed to a human | red |

Sources, all live: `claude_state` and whether the child process is actually
alive, the transcript tail, the pending-prompt queue, the review/merge state,
open action / screen / setup cards, the error family of the last turn (the
`LIMIT_RE` / `AUTH_RE` families already in `claude.js`), the account pool, and
the A3/A5 agent ledger.

Two rules in `classify()` are worth stating out loud, because they are what keep
the thing from being annoying:

- **`WAITING_HUMAN` is evaluated first and beats every system signal.** A
  session can be both blocked on a person *and* broken. The person wins, so
  nothing below can auto-recover it out from under them.
- **`STALLED` only applies when something is actually owed** — a worker that
  never reported, or a queue that auto-play promised to run. A plain human chat
  that is simply idle is `IDLE_OK` forever; nudging the user's own session
  would be noise. A queue the human parked with auto-play **off** is theirs to
  release, not ours to nudge.
- **A controller mid-orchestration is `IDLE_OK`, not `STALLED` — even if it
  also owes a report of its own** (SUP1). At least one live (non-archived,
  non-terminal) child (discovered via `metadata.master`), or an un-cleared
  `waitingOn` pointer, means the work it owns right now belongs to someone
  else; being quiet while they work is its correct resting state, not a stall.
  A controller with **no** live children and **no** `waitingOn` that goes quiet
  past the threshold is still genuinely `STALLED`. The moment the last live
  child clears, the loop floors the controller's activity clock at that
  instant (`floorActivity`), so it gets a full fresh stall window instead of
  being judged against however stale its own transcript happens to be — a
  child reporting must never itself trigger a nudge on the next tick.

---

## 2. The recovery ladder

One tick (default 30s) per session. Every rung writes **both** a chat receipt in
the affected session and a line in `$ARIGAMI_DIR/incidents.jsonl`.

| condition | action | escalation |
|---|---|---|
| proc dead | respawn with `--resume`, replay the last user message | 2 failures → hand to the human + push |
| auth revoked/expired | refresh the token, respawn | 2 failures → hand to the human + push |
| account hit its limit | switch to the next pooled account and replay *(pre-existing, `claude.js`)* | none left → **model ladder** |
| **model ladder** | drop one rung of the session's `modelChain`, announce it, keep working; climb back after the reset | bottom rung, still limited → hand to the human |
| MCP server down | disable that server for the session, tell the model, continue | the session genuinely needs it → hand to the human |
| `STALLED`, nothing owed to a human | nudge: *"continue; if blocked, report why"* | still stalled → respawn → hand to the human |
| a controller with a live child, or an un-cleared `waitingOn` | none — `IDLE_OK`, not `STALLED` (SUP1) | — |
| child terminal, master unaware | synthesize the report from the child's state and wake the master — skipped while the master itself owns a live child or an un-cleared `waitingOn` (SUP1) | — |
| master waiting on a child that never got the ask | re-deliver the ask to the child | — |
| a block only a human can clear | re-notify (push), at most hourly, deduped | — |
| agent over its daily budget | `WAITING_HUMAN` by design (A3/A5) — surfaced with "raise the cap" | — |

### The hard rule

A `WAITING_HUMAN` session is **never** nudged, respawned, downgraded or
otherwise touched. This is not a convention — it is the first branch of
`decide()`, which returns `none` or `notify-human` and nothing else, so no rule
below it can fire. `test/supervisor.test.ts` crosses every blocker with every
ladder-triggering failure at once, on maxed-out counters, and asserts it.

### Escalation is terminal until something moves

Once the host hands a session to a human it stops walking the ladder — that is
what turns a one-off failure into a nudge loop. The flag lives on the session
(`metadata.supervisor`), not only in memory, so it survives a host restart and
so the escalations `claude.js` performs on its own (the bottom rung of the model
ladder) land in the same place.

"Something moved" means a **turn** finished with no error left behind — read
from the transcript, not from `session.updatedAt`: the supervisor's own receipts
and metadata writes bump `updatedAt`, so an escalated session would otherwise
look recovered on the very next tick.

---

## 3. The model ladder

> *"Fable ran out but the weaker models still have quota — keep going."*

Every session has a chain whose **top rung is the model the human actually
picked**. Most specific source wins:

```
session.claude.modelChain  →  agent.modelChain  →  cfg.modelChain  →  ['fable','sonnet','haiku']
```

When the account switch in `claude.js` runs out of pooled accounts, the session
drops **one** rung instead of stopping: `setModel` + `--resume`, so the
conversation survives, then the failed turn is replayed on the weaker model. A
model the CLI reports as *unavailable* or *overloaded* takes the same path — no
account switch can fix that one.

- **The climb back** is armed at the reset time the CLI itself reported
  (`resets 3am`). When nothing told us — an unavailable model says nothing about
  quota — it falls back to `cfg.supervisor.modelBackoffMin` (default 60 min).
- **It is refused while every pooled account is still quarantined**: the top rung
  would just be downgraded again on the next turn and the session would flap.
- **A manual model pick resets the ladder**, so the supervisor never climbs back
  over the human's choice.
- A 30s per-session cooldown stops a replay that fails the same way from walking
  the whole chain in one second.
- `POST /__api/sessions/:id/model/restore` takes the top rung back by hand
  (Settings → מארח → בריאות has the button) without waiting for the reset.

### Fit or compact before the replay (LADDER1)

A rung is a `--resume` of the same conversation — but the rungs do not share a
window: fable/sonnet-5 run 1M tokens, haiku 200k (`server/lib/ctx-window.ts`).
A conversation that grew to 600k on fable is over haiku's limit before its first
turn, which the human saw as "the context dies in a second" (2026-09-02, three
sessions escalated within seconds of reaching the bottom rung). So before every
downgrade `claude.js` judges the live conversation (the measured
`claude.usage.ctxTokens`, else a chars/4 estimate) against the **target** rung's
window with 70% headroom (`cfg.supervisor.ladderHeadroom`,
`ARIGAMI_LADDER_HEADROOM`):

- **fits** → plain `--resume` as before (`ladderReplay.mode = 'full'`).
- **does not fit** → the conversation is *compacted* onto a **fresh** claude
  conversation: the usual bootstrap prefix, a `[host]` preamble, an LLM digest of
  the older part, the last 6 turns verbatim (`ladderTailTurns`,
  `ARIGAMI_LADDER_TAIL_TURNS`), then the replayed message. Base64 image blocks
  (screenshots, `Read` of a .png) become one-line placeholders — they are the
  heaviest items and never needed for continuity. The digest is written by the
  shared one-shot runner (`server/lib/oneshot.ts`) **on the target rung** — the
  exhausted one has no quota to summarize with; if even that fails, a mechanical
  digest (the human's messages in order) stands in. The original conversation id
  is kept in `claude.ladderReplay.originalSessionId`; an incident
  `context-compact` is logged.
- **the climb back** resumes the *original full history* when it fits the top
  rung's window (`context-restore` incident), with a short interim note of what
  happened on the weaker rung — the digest was a stop-gap, never the history.
- **the cockpit** shows a quiet badge on the rail row and the chat header while a
  session runs below its model — "רץ על הייקו · מכסת Fable מתאפסת ב-18:50"
  (`claude.ladder`, derived in `state.toWireSession`; null on the top rung) — plus
  one system line at the switch and one at the climb back. No toasts.

The decision and the transcript shaping are pure (`server/lib/ladder-replay.ts`,
`test/ladder-replay.test.ts`); `claude.js` only does the IO around them.

State lives on `session.claude`: `modelChain`, `modelRung`, `modelRestoreAt`,
`modelDowngradedFrom`. While a session is downgraded the chain is computed from
`modelDowngradedFrom`, not from the current `modelChoice` — otherwise every
downgrade re-roots the chain at the weaker model and "restore to the top" would
restore to the model we just dropped to.

---

## 4. Orchestration liveness

- **A child that reaches a terminal state without `report_to_master`** gets its
  report synthesized by the host from what it *can* see — status, branch,
  worktree, last words — recorded as `metadata.result` with `synthesized:true`,
  and the master woken with the same thin pointer an explicit report produces.
  A child that was spawned but never tasked is left alone: its controller may be
  about to hand it its first job.
- **A master waiting on a child** records
  `metadata.waitingOn = {sessionId, since, what}` when it calls `task_session`.
  The supervisor checks the child actually knows (its pending queue, whether it
  has been busy since, whether it already answered) and re-delivers the ask if
  not. A real report clears the pointer.
- **Everything that needs a human** is aggregated into one queue: what is
  blocked, since when, and the single action that unblocks it.

| row kind | the one action |
|---|---|
| `action` | answer |
| `screen` | take over |
| `setup` | connect |
| `review` | review |
| `merge` | merge |
| `budget` | raise the cap |
| `system` | look at it (the host could not recover it) |

---

## 5. The incident log

`$ARIGAMI_DIR/incidents.jsonl` — append-only, one line per automatic action,
bounded tail read, rotated past 8 MB. Same shape as `agents/<slug>/activity.jsonl`
on purpose: no database, no migration, greppable by hand.

```json
{"ts":"…","sessionId":"sess_…","action":"model-down","health":"BLOCKED_SYSTEM",
 "reason":"all accounts limited","outcome":"ok","detail":{"from":"fable","to":"sonnet"}}
```

`outcome` is `ok` | `failed` | `escalated`. Every line has a twin in the affected
session's chat, so the human can find it from either end.

---

## 6. API

| endpoint | what it answers |
|---|---|
| `GET /__api/health` | the health map, the waiting queue, a 24h incident tally, per-account quota with reset times, and the host's model chain |
| `GET /__api/health/incidents?hours=24` | what the supervisor actually did, newest first |
| `GET /__api/waiting` | the "ממתין לך" queue on its own |
| `POST /__api/sessions/:id/model/restore` | climb back to the top rung now |
| `POST /__api/sessions/:id/model` | `{model, modelChain?}` — set the session's model and/or its ladder |

The `health` bus event carries the map and the queue together, and only fires
when something the cockpit renders actually changed.

> **A note on `/__api/pending`.** The spec asked for the aggregated queue there,
> but that path is the trigger/ticket queue and predates this work. `GET
> /__api/pending` therefore carries an extra `waiting` key — the same rows — so
> the single endpoint still answers, while `/__api/waiting` is the canonical one.

---

## 7. UI

- **Rail**: a health dot on every row. The badges beside it already said
  "working" and "needs you"; what the dot adds is the two states nothing showed
  before — a session the host is failing to recover, and one that has gone quiet
  with work still owed. A waiting item shows quietly, in place, and nowhere
  else: a small static badge (no pulse) on the row it actually blocks — the
  agent's row when the session was born from one, otherwise the session's own
  row; the badge's title names what is blocked and the one action that
  unblocks it, and shows a count once more than one thing is waiting on that
  row. There is no separate aggregated queue view in the rail — a session
  hidden behind a collapsed folder or a collapsed Team section would otherwise
  show nothing, so its waiting count rolls up (hollow, count-only, same idiom
  the folder's existing "needs your input" rollup uses) onto the folder's
  count chip or the Team header while collapsed; opening either reveals the
  real per-row badges instead.
- **Settings → מארח → בריאות**: the computed state of every live session, the
  account/model quota picture (who is quarantined and until when, which sessions
  are a rung below their model, with a "back on `<model>`" button), and the last
  24h of incidents with what the host did and how it turned out.

---

## 8. Configuration

`config.json` (every knob is also env-overridable, which is how the
isolated-host tests run the 30s loop at 1s):

```jsonc
{
  "modelChain": ["fable", "sonnet", "haiku"],   // ARIGAMI_MODEL_CHAIN
  "supervisor": {
    "enabled": true,          // ARIGAMI_SUPERVISOR=0 turns the ladder off;
                              //   health is still computed on demand
    "tickSec": 30,            // ARIGAMI_SUPERVISOR_TICK_SEC
    "stallMin": 10,           // ARIGAMI_SUPERVISOR_STALL_MIN
    "reportGraceMin": 2,      // ARIGAMI_SUPERVISOR_REPORT_GRACE_MIN
    "notifyEveryMin": 60,     // ARIGAMI_SUPERVISOR_NOTIFY_MIN
    "maxRespawns": 2,
    "modelBackoffMin": 60     // ARIGAMI_MODEL_BACKOFF_MIN
  }
}
```

An agent may carry its own `modelChain` (`PATCH /__api/agents/<slug>`), and a
session may override both (`POST /__api/sessions/:id/model`).

---

## 9. Tests

- `test/supervisor.test.ts` — table-driven over the pure module: the five health
  states, one case per ladder row, the model-ladder helpers, the queue rows, and
  two dedicated groups for the hard rule and for escalation being terminal.
- `test/supervisor-host.test.ts` — a real isolated host with a stub `claude`
  that can die on command or fail with a quota / revoked-token / missing-model
  error: proc death → respawn + replay; limit → account switch → model downgrade
  → restore; a child terminal without `report_to_master` → synthesized report;
  a `WAITING_HUMAN` session well past the stall threshold → not one nudge,
  respawn or extra spawn, but a row in the queue.
- `test/supervisor-web.test.js` — the Health panel's markup in both locales, the
  store's health map, and a check that both dictionaries carry every key the UI
  builds at runtime (which the static scan in `i18n-keys.test.js` cannot see).
- `test/rail-waiting-web.test.js` — the rail's markup for a waiting item: the
  badge lands on the agent's row when the session carries one, otherwise on the
  session's own row; the count shows only once more than one thing is waiting
  on that row; a session hidden behind a collapsed folder or a collapsed Team
  section rolls its count up onto the chip/header instead of disappearing
  (and stops rolling up once expanded, when the real per-row badge takes
  over); and no `pulse-yellow` anywhere in any of it.
