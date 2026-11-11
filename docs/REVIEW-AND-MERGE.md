# Review and merge

Approving and merging are two separate steps. Each step has one control.

## Approve: one action

The chat's review card (raised by `request_review`) and the Changes tab's
review bar have the same **Approve** button. Before this change they were two
actions: "✓ Verified" on the card and "Approve" / "Approve PR" in the tab.
Each surface reached the host by its own path and left a different state
behind. Now both surfaces call `approveSession` in `server/api.ts`:

| Surface | Request |
|---|---|
| Review card | `POST /sessions/:id/action/answer` with `value: "approve"` (cards raised before the rename send `"verified"`, which is treated the same) |
| Changes tab | `POST /sessions/:id/review/submit` with `verdict: "approve"` |
| An agent submitting a review | `review/submit` with `verdict: "approve"` |

Clicking Approve doesn't open a confirmation step. The surface shows in
advance what Approve will do: the card prints it in a line under the button,
and the Changes tab shows it in the button's hint.

### What Approve does depends on the session

The session decides, not the surface that was clicked
(`server/lib/review-approval.ts`):

| Session | Mode | Approve does | Stamp in `metadata.review` |
|---|---|---|---|
| No pull request (a worktree child, a ticket session, a plain session) | `local` | Sends the agent a "✅ Approved" review message (pending comments included) and sets the status to `Approved` | `{state:"approved", at, by, sha, repo, branch}`. A session with no branch gets `{state:"approved", at, by, target:"local"}` with no SHA |
| Has a pull request the viewer authored | `pr-own` | Same as `local`. GitHub doesn't accept approvals of your own PR, so nothing is posted | Same as `local` |
| Has a pull request someone else authored | `pr-review` | Sends the agent a "Publish this as a GitHub PR review (event `APPROVE`)" message. The agent posts the review with `gh` | `{state:"approved", target:"github", pr, sha:<PR head>, at, by}` |
| Has a pull request, but GitHub couldn't be reached | `unknown` | Refuses with HTTP 502. Nothing is posted and nothing is stamped | none |

A session "has a pull request" when `metadata.pr` holds a PR URL, or when it
has both `metadata.repo` and `metadata.prNumber`. The author and the viewer
come from `gh`: the PR's author, and the login of the host's `gh` token.

In every mode, Approve also:

- clears the pending review comments (they are part of the message);
- closes the open review card;
- sets the status to `Approved`.

### Already approved

An approval is **current** while its SHA still matches the code under review.
In `local` and `pr-own` mode that's the tip of the branch; in `pr-review` mode
it's the PR head. A session with no SHA keeps its approval current until a
newer review card is raised.

A current approval affects all three places:

- the review card shows **Approved** with the button disabled;
- the Changes tab button shows **Approved**, disabled;
- the host treats a repeat approve as a no-op: it returns `{ok:true, already:true}` and sends nothing.

A new commit on the branch, or a new push to the PR, makes Approve available
again.

**Request changes** withdraws an approval on either surface. The stamp becomes
`changes-requested`, and merging is refused until the next Approve.

### The card doesn't jump

The chat doesn't render live action cards or merge cards while the transcript
is loading. A card appears once, in its final place. Before this change, a cold
open showed the card first and then moved it down about 240px when history
loaded on top of it.

## Merge: shown only when the viewer can merge

`GET /sessions/:id/merge/status` answers for the requesting viewer. Its
`offer: {show, reason}` field gates the Merge control in the chat, the Changes
tab, and the Orchestration tab:

| Session | Merge shown when | Merged by |
|---|---|---|
| A branch with no PR | Approved at the current tip. The viewer is the human or this session's master/controller. The base is checked out and clean, and the branch has commits | The host: `git merge` into the local base (`server/merge.ts`). Gates from `merge.before` extensions run first |
| The viewer's own PR (`pr-own`) | Approved at the current tip. The viewer is a person, not a session, with ADMIN, MAINTAIN or WRITE on the repo. The PR is open, not a draft, and GitHub reports `MERGEABLE` | GitHub: `gh pr merge --match-head-commit <approved sha>`, so only the approved commit can be merged |
| Someone else's PR (`pr-review`) | Never: the PR's author merges it | n/a |

If the merge isn't possible and the session is approved, the surfaces show a
passive line with the reason and no button, for example "Approved · not
mergeable here: someone else's PR — its author merges it". Possible reasons:
`no-permission`, `not-your-pr`, `dirty`, `pr-checking`, `conflict`, `pr-draft`,
`pr-closed`, `approval-stale`, `github-unknown`. Before approval, nothing is
shown.

When the Merge control is shown, it names its target ("Merge feat/x into
main", "Merge PR #42 into develop") and shows what will run, on every surface,
including the compact bar in the Changes tab:

- for a local merge, the host's warning that no project gates run;
- for a PR, a note that GitHub's branch rules apply.

`POST /sessions/:id/merge` rechecks the same rules before merging. A session
can still merge a child branch locally with `merge_session`. A session can
never merge a pull request.
