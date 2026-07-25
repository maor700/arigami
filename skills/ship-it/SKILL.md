---
description: Arigami edition of ship-it — quality gates, conventional commit, push, PR, reviewer notify on Linear/Slack, arm a deterministic review listener so PR feedback wakes the session, then hand the teardown decision to the Host action bar instead of Slack polling. Run inside a Host session after the human clicked ✓ Verified.
argument-hint: [reviewer-displayname] [--no-visual]
---

# Ship It (Arigami session edition)

Run this inside a Arigami session when the human has **already approved via the
Verified gate** — that click was the review confirmation, so there is NO separate
operator-confirm DM in this flow. Differences from the legacy skill are marked 🏠.

## Inputs

- `$ARGUMENTS`: optional reviewer Slack/Linear display name. If empty, ask via
  🏠 `mcp__arigami__request_action({ prompt: "Who should review?", buttons: [...] })`
  with the likely candidates, or ask in chat.
- `--no-visual`: skip §1.5 ONLY for changes with zero visual impact.

## 1. Quality gates

Run in order — stop on any failure:

```bash
bun run format        # oxfmt — formats files
bun run lint          # oxlint + eslint + tsgo typecheck
bun run test          # vitest — ALWAYS `bun run test`, never bare `bun test`
                      # (bare invokes Bun's native runner → "document is not
                      # defined" fake failures)
```

Chromatic visual diffs run on CI via the PR — don't run locally unless asked.
Storybook stories changed? Confirm the affected `play()` stories still pass in
the running Storybook.

🏠 While gates run, keep the cockpit honest. Use a **five-step** strip that tracks
the whole lifecycle through merge — do NOT clear it when ship-it returns; the
`merge` step stays `pending` until the PR actually merges (advanced in §10):
`set_progress({ steps: [{label:"format",…},{label:"lint",…},{label:"test",…},{label:"PR",…},{label:"merge",state:"pending"}] })`,
advancing each as it completes.

## 1.5. Visual evidence required

Any branch touching user-visible files MUST have `before.gif` + `after.gif` from
**feedback-loop** (`$ARIGAMI_SKILLS/feedback-loop/SKILL.md`).

```bash
ISSUE=$(git symbolic-ref --short HEAD | sed -n 's/^\(dem-[0-9]*\).*/\1/p')
ISSUE_LOWER=$(echo "$ISSUE" | tr '[:upper:]' '[:lower:]')

VISUAL_FILES=$(git diff --name-only origin/main -- \
  '*.tsx' '*.jsx' '*.css' '*.scss' '*.html' '*.svg' \
  '*.png' '*.jpg' '*.jpeg' '*.webp' '*.gif' 2>/dev/null)

if [[ -n "$VISUAL_FILES" ]]; then
  MISSING=()
  [[ ! -f "/tmp/${ISSUE_LOWER}/before.gif" ]] && MISSING+=("before.gif")
  [[ ! -f "/tmp/${ISSUE_LOWER}/after.gif"  ]] && MISSING+=("after.gif")
  if (( ${#MISSING[@]} > 0 )); then
    echo "Visual gate: missing ${MISSING[*]} — run feedback-loop first." >&2
    exit 1
  fi
fi
```

## 2. Rebase

```bash
git fetch origin main && git rebase origin/main
```

Conflict → **stop**: 🏠 `set_status({ status: "Blocked" })` + explain in chat.

## 3. Commit

- Conventional commit (`feat|fix|chore|refactor|docs|test|style`), optional scope,
  subject <50 chars imperative, body wraps at 72 and explains the **why**.
- Always include `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Pre-commit hook runs format+lint+typecheck — NEVER `--no-verify`.
- Stage only the files you changed (no blanket `git add -A`).

## 4. Push

```bash
git push -u origin <branch>
```

Remote diverged → **stop and ask**; never force-push.

## 5. Open the PR

- Target `main`; title = commit subject style, <70 chars, no Linear ID.
- Body: 1–2 sentence summary + `Closes [ENG-XXXX](https://linear.app/Acme/issue/ENG-XXXX)`,
  before/after table when both GIF URLs exist (reuse `/tmp/<issue>/before.url`/
  `after.url`, else upload via `gh image` and cache the `.url` files), Figma
  compliance table when all three `visual-diff-*.url` files exist, and the
  `🤖 Generated with [Claude Code](https://claude.com/claude-code)` footer.
  No section headings. Re-shipping after changes → `gh pr edit <n> --body` instead.

Capture the PR URL, then 🏠 surface it in the cockpit:

```
set_metadata({ patch: { pr: "<pr-url>", prNumber: <n> } })
open_tab({ type: "url", title: "GitHub", url: "/__pr/<owner>/<repo>/<n>", badge: "#<n>" })
   // host page renders the PR inline via local gh auth (GitHub can't be iframed)
// advance the strip: PR done, merge still pending (flips to done in §10)
set_progress({ steps: [
  {label:"format",state:"done"},{label:"lint",state:"done"},{label:"test",state:"done"},
  {label:"PR",state:"done"},{label:"merge",state:"pending"}
] })
```

## 6. Notify on Linear

Comment on the issue mentioning the reviewer (reply to the existing thread via
`parentId` if one exists):

```
@<reviewer> ready for review whenever you have time 🙏
<PR URL>
```

## 7. Notify the reviewer on Slack

`slack_search_users(query: "<reviewer name>")` — multiple matches → ask before
sending. Then DM the reviewer (auto-send is opted-in for this flow):

```
Hey <name>! 👋
Could you take a look when you get a chance?
PR: <pr-url> · Linear: <issue-url>
Thanks 🙏
```

## 7.5. 🏠 Arm a review listener (so feedback wakes the session)

The PR is out. Don't keep an expensive session alive polling for the reviewer,
and don't leave the human to re-invoke `pr-respond` by hand — arm a deterministic
listener. It watches the PR server-side (cheap, no model) and wakes **this**
session (resuming it via `--resume` even if its process has exited) the moment a
review, comment, approval, CI failure, or merge conflict lands. It auto-stops on
merge/close, after its TTL, or when the session is archived.

```
register_listener({
  type: "github-pr",
  // omit the target to infer the PR for the current branch in the worktree;
  // or pass url / owner+repo+number explicitly
  fire_on: ["approved", "changes_requested", "new_comment", "ci_failed", "conflicts"]
})
```

A 👀 chip appears on the session card (and a count in the rail). When it fires it
injects a thin signal (e.g. "PR #<n> — requested changes by @<reviewer>", or
"CI failed: UI Tests"); for review feedback follow it straight into the
`/example-fe:pr-respond` skill; for a CI failure check `gh pr checks` /
`gh run view --log-failed` and fix; for conflicts rebase on the base branch.
This is what makes PR feedback auto-resume the session instead of waiting on a
manual `pr-respond` invocation.

## 8. 🏠 Hand off — the session idles, the listener watches

No Slack self-DM, no 270s polling loop. Set status `In Review` and end the turn —
the §7.5 listener wakes the session when the reviewer acts, so you don't keep a
model polling. The progress strip stays visible with `merge` pending.

```
set_status({ status: "In Review" })
```

Optionally offer a dev-server teardown (the watch survives it — see §10's note):

```
request_action({
  prompt: "Shipped <issue-id> — PR #<n> sent to <reviewer>. Keep dev servers up while in review?",
  buttons: [
    { label: "Keep running",      value: "keep",  style: "default" },
    { label: "Close dev servers", value: "close", style: "primary" }
  ]
})
```

`close` → kill by port (never by process name). Git Bash on Windows has no
`lsof`, so fall back to `netstat` + `taskkill` there:
```bash
listener_pids() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -ti :"$1" -sTCP:LISTEN 2>/dev/null
  else
    netstat -ano -p tcp 2>/dev/null | awk -v p=":$1" '$0 ~ p" " && /LISTENING/ {print $NF}' | sort -u
  fi
}
kill_pids() {
  if command -v lsof >/dev/null 2>&1; then kill $1 2>/dev/null
  else for id in $1; do taskkill //PID "$id" //T //F >/dev/null 2>&1; done; fi
}
for PORT in "$DEV_PORT" "$STORYBOOK_PORT"; do
  PIDS=$(listener_pids "$PORT"); [ -n "$PIDS" ] && kill_pids "$PIDS"
done
sleep 2
for PORT in "$DEV_PORT" "$STORYBOOK_PORT"; do
  PIDS=$(listener_pids "$PORT"); [ -n "$PIDS" ] && { command -v lsof >/dev/null 2>&1 && kill -9 $PIDS || kill_pids "$PIDS"; }
done
```
The review listener stays armed either way — keep the session unarchived so the
wake has a target.

## 9. 🏠 When the review listener wakes the session

The listener injects a thin signal ("PR #<n> — <event> by @<reviewer>"). Re-fetch
the live state (`gh pr view <n> --json reviewDecision,mergeable,mergeStateStatus,state`
+ `gh pr checks <n>`), then branch:

- **Changes requested / new comments** → run the `/example-fe:pr-respond` skill to
  address the threads, then push fixup commits. (Each push + reviewer reply will
  wake you again via the listener.)
- **Approved + `MERGEABLE` + CI green** → DON'T merge silently. Merging is an
  irreversible external action, so ask with a **selection UI** and let the human
  click — the click is the confirmation:

```
request_action({
  prompt: "PR #<n> approved by <reviewer>, CI green, MERGEABLE. Merge it?",
  buttons: [
    { label: "Squash & merge", value: "merge-squash", style: "primary" },
    { label: "Rebase & merge", value: "merge-rebase", style: "default" },
    { label: "Merge commit",   value: "merge-commit", style: "default" },
    { label: "Not yet",        value: "merge-wait",   style: "default" }
  ]
})
```

On the button reply, run the matching `gh` merge (squash is the recommended
default — it collapses the review-fix commits into one clean commit):

```bash
gh pr merge <n> --squash  --delete-branch    # merge-squash
gh pr merge <n> --rebase  --delete-branch    # merge-rebase
gh pr merge <n> --merge   --delete-branch    # merge-commit
# merge-wait → do nothing; leave the listener armed and end the turn.
```

The listener fires once more when the merge lands → §10.

## 10. 🏠 After merge — complete + ask what's next

When the PR is merged (the listener fired `merged`, or you just merged it):

```
set_status({ status: "Completed" })
// flip the final progress step to done
set_progress({ steps: [
  {label:"format",state:"done"},{label:"lint",state:"done"},{label:"test",state:"done"},
  {label:"PR",state:"done"},{label:"merge",state:"done"}
] })
```

The listener auto-stops on merge (status `stopped`) — nothing to cancel. Then ask
what to do with the now-finished session, again as a **selection UI**:

```
request_action({
  prompt: "PR #<n> merged 🎉 — <issue-id> is done. What next?",
  buttons: [
    { label: "Delete session",    value: "next-delete", style: "danger" },
    { label: "Close dev servers",  value: "next-close",  style: "default" },
    { label: "Keep it",            value: "next-keep",   style: "primary" }
  ]
})
```

On the button reply:

- `next-delete` → tear down everything and remove the session from the rail. Do
  this **last** (it ends this session): `delete_session({ run_cleanup: true })`
  (kills the claude process, removes the session, and runs `metadata.cleanup` —
  dev servers + worktree).
- `next-close` → kill dev servers by port (the §8 `close` block), leave the
  session as `Completed` in the rail.
- `next-keep` → leave it `Completed`; end the turn.

## Rules

- Never bypass pre-commit hooks; never force-push.
- "Always rebase, never merge" applies to **integrating `main` into your branch**
  (§2) — never `git merge main`. Merging the **PR** itself (§9) is the goal and is
  done via `gh pr merge` only after the human clicks a merge button.
- One ticket → one PR; ask before splitting unrelated changes.
- Quality gate fails → fix the cause, don't relax the gate.
- Every status/progress you set must be currently true.
- The `merge` progress step stays `pending` until the PR truly merges — only §10
  flips it to `done`.
