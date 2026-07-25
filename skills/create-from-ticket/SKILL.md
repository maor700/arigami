---
description: Arigami default workflow — provision a Linear ticket session (worktree, ports, dev server), drive the cockpit via the Host MCP (title/color/status/progress/tabs), work the ticket, then request human review. Invoked by the Host launcher as the first prompt of a new session.
argument-hint: <issue-id>
---

# Create From Ticket (Arigami session workflow)

You are running INSIDE a Arigami session (env `ARIGAMI_SESSION_ID` is set and
the `arigami` MCP server is connected). The human created this session from the
launcher with a Linear ticket id in `$ARGUMENTS`. Your job: **claim the ticket
only if it's actually free (§1.5)**, provision the environment, keep the cockpit
informed at every step, work the ticket, and gate the result behind human review.

**The cockpit is your status surface.** Anything the human should see at a glance
goes through the `arigami` MCP tools — not just chat text.

## 0. Announce

Immediately (before any heavy work):

1. `mcp__arigami__set_title({ title: "<issue-id> · <short title once known>" })`
   (use just the issue id until you've fetched the ticket).
2. `mcp__arigami__set_status({ status: "Booting" })`
3. `mcp__arigami__set_progress({ steps: [
     { label: "Worktree", state: "active" },
     { label: "bun install", state: "pending" },
     { label: "Dev server", state: "pending" },
     { label: "Open tabs", state: "pending" } ] })`

## 1. Fetch the ticket

`mcp__linear-server__get_issue(id: <issue-id>)` — title, description, labels,
priority, url, suggested branch name. Then:

- `set_title({ title: "<issue-id> · <ticket title, truncated ~40 chars>" })`
- `set_metadata({ patch: { ticket: "<issue-id>", ticketUrl: "<url>" } })`
- Open the ticket tab right away so the human can read along:
  `open_tab({ type: "url", title: "Linear", url: "/__ticket/<issue-id>" })`
  (host-internal page — pass the path as-is, do not wrap it in ?__target=).
  If the page reports no cached data and no LINEAR_API_KEY, cache it first:
  write the issue JSON from get_issue to `~/.arigami-tickets/<issue-id>.json`.

## 1.5. Claim the ticket — GATE before you provision anything

Run this the moment §1's `get_issue` returns, and BEFORE §2 — no worktree, no
`bun install`, no dev server until it passes. This is what stops two people
working the same ticket (the exact failure mode where someone already has a
branch/PR out and you find out only at push time).

Identify yourself once: `mcp__linear-server__get_user(query: "me")` → `{ id, name }`.

Read these signals off the issue you already fetched, plus two cheap lookups:

- **State** — `statusType`: `started` (In Progress / In Review) or `completed`
  (Done / Canceled) means it's already being / been worked.
- **Assignee** — `assignee` / `assigneeId`: anyone other than you = not yours.
- **Existing work** — an open branch or PR already exists for it:
  - a `github.com/.../pull/` link in `issue.attachments[]`,
  - `git ls-remote --heads origin "<gitBranchName>"` (non-empty ⇒ branch exists),
  - `gh pr list --search "<issue-id>" --state open --json number,url,author`.
- **Relevance doubt** — `mcp__linear-server__list_comments(issueId)`: a comment
  that suggests it's stale/handled — "duplicate", "won't fix", "already fixed",
  "not relevant", "on hold", "revert". Judge in context, don't pattern-match.

### STOP — do NOT provision, ask the human — if ANY of these hold:

state is `started`/`completed`, OR assigned to someone who isn't you, OR an open
branch/PR already exists, OR a comment casts real doubt on relevance.

```
set_status({ status: "Blocked" })
set_progress({ steps: null })          // nothing has been provisioned
request_action({
  prompt: "<issue-id> looks already in-flight: <what you found — e.g. 'In Progress, assigned to Reviewer, PR #3395 open'>. What do you want me to do?",
  buttons: [
    { label: "Work it anyway", value: "claim-force", style: "danger" },
    { label: "Stop",           value: "claim-stop",  style: "primary" }
  ]
})
```

Then **WAIT**. `claim-stop` → end the turn, nothing provisioned. `claim-force` →
continue to §2, but do NOT self-assign / restatus — respect whoever holds it.

### PROCEED — claim it, then provision — only if ALL of these hold:

state is NOT started/completed (Backlog / Todo / Triage), AND unassigned or
already yours, AND no open branch/PR, AND no relevance-doubt comment.

Claim it **before** §2 so the rest of the team sees it's taken — one call sets
both assignee and state:

```
mcp__linear-server__save_issue({ id: "<issue-id>", assignee: "me", state: "In Progress" })
set_metadata({ patch: { assignee: "<me.name>" } })
```

Only now continue to §2.

## 2. Provision the worktree

Source the config and run the bundled setup (this directory is self-contained;
`$SKILL_DIR` below = the absolute directory of this SKILL.md):

```bash
source "$SKILL_DIR/../_lib/config.sh"   # exports APP_REPO, WORKTREES_DIR, port pools
cd "$APP_REPO"
git fetch origin main --quiet
git worktree list --porcelain | grep -q "app-worktrees/<issue-id-lower>" || \
  git worktree add "$WORKTREES_DIR/<issue-id-lower>" -b <branch> origin/main
cd "$WORKTREES_DIR/<issue-id-lower>"
printf '{"cwd":"%s"}' "$PWD" | bash "$SKILL_DIR/setup.sh"   # ports + vercel env pull + bun install
. ./.env.development.local
echo "DEV_PORT=$DEV_PORT STORYBOOK_PORT=$STORYBOOK_PORT"
```

Progress choreography while that runs:
- worktree created → `set_progress` Worktree=done, bun install=active
- install finished → bun install=done, Dev server=active

Then register everything the host needs for lifecycle/cleanup:

```
set_metadata({ patch: {
  worktree: "<worktreePath>", branch: "<branch>",
  port: <DEV_PORT>, storybookPort: <STORYBOOK_PORT>,   // `port` shows in the rail row
  cleanup: [
    "lsof -ti :<DEV_PORT> -sTCP:LISTEN | xargs kill 2>/dev/null || true",
    "lsof -ti :<STORYBOOK_PORT> -sTCP:LISTEN | xargs kill 2>/dev/null || true",
    "git -C <APP_REPO> worktree remove --force <worktreePath>",
    "git -C <APP_REPO> branch -D <branch>"
  ] } })
```

(The host shows these verbatim in its archive/delete dialogs — they must be real,
runnable commands.)

## 3. Dev server + tabs

```bash
cd <worktreePath> && bun run dev   # run_in_background
# poll: curl -sI http://localhost:$DEV_PORT/ | head -1  → expect 200 (≤30s)
```

When it answers:
- `set_progress` Dev server=done, Open tabs=active
- `open_tab({ type: "url", title: "App", url: "http://localhost:<DEV_PORT>/",
    compare_url: "<prod url for the same route, default https://app.example.com/>" })`
- `set_progress({ steps: null })` (clear the strip)
- `set_status({ status: "In Progress" })`

Open further tabs **when they become relevant, not up front**: a `Changes` content
tab (markdown of `git diff --stat` + per-file diffs) once you've edited files; a
`GitHub` url tab (`/__pr/<owner>/<repo>/<number>` shows the PR inline via the
local gh auth) once a PR exists; `Storybook` (`http://localhost:<STORYBOOK_PORT>/`,
launch with `STORYBOOK_NO_OPEN=1 bun run storybook`) when you touch a story.

## 4. Work the ticket

Standard engineering flow in `<worktreePath>` — classify (bug/feature/refactor/
chore), locate, fix, verify with the project's gates (`bun run test`, typecheck;
remember: `bun run test`, never bare `bun test`).

The host skill pack lives at `$ARIGAMI_SKILLS` (env, injected by the host) —
read and follow the sibling SKILL.md when its step comes up:

- `$ARIGAMI_SKILLS/login/SKILL.md` — verify the dev URL is authenticated before
  browser work (port-pool cookies usually short-circuit it to `pre-existing`).
- `$ARIGAMI_SKILLS/feedback-loop/SKILL.md` — REQUIRED for visual fixes: the
  edit → reload → verify loop that produces `/tmp/<issue>/before.gif` + `after.gif`.
- `$ARIGAMI_SKILLS/local-env/SKILL.md` — env/tooling reference for the worktree.

Keep chat narration terse; keep the cockpit truthful:

- Long operation (>30s)? Show it: `set_progress` with the real steps.
- Blocked on something only the human can do? `set_status({ status: "Blocked" })`
  plus `request_action` with the choices, then wait.
- Update the `Changes` tab body after each meaningful edit batch.

## 5. Request review (the human gate)

When the work is verified locally:

1. Refresh the `Changes` tab with the final diff summary.
2. `set_status({ status: "In Review" })`
3. `mcp__arigami__request_review({ summary: "<1-2 line root-cause + what changed,
   with file:line references>" })`
4. **Stop and wait.** The footer's buttons answer as a user message:
   - `verified` → read and follow `$ARIGAMI_SKILLS/ship-it/SKILL.md` (gates →
     commit → push → PR → reviewer notify → cockpit teardown hand-off).
   - `request-changes` → the human's follow-up message has the notes; loop back
     to §4 with them, then request review again.

You cannot approve yourself; only the footer click can.

## Rules

- Never provision (worktree, install, dev server) for a ticket that's already
  in-flight — pass the §1.5 claim gate first, or stop and ask. Only self-assign +
  move to In Progress when the ticket is genuinely free.
- Never write host/cockpit files into the worktree (no `.ticket-color.json` etc.).
- Never edit the main `app/` checkout; all work happens in `<worktreePath>`.
- Ports come ONLY from setup.sh's pools (dev 3020-3070, storybook 6020-6070) —
  cookies are keyed to them.
- Every status you set must be currently true — the rail is a trust surface.
