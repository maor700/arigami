# Reviewing a pull request

This session was started from the launcher's **From PR** mode, so it already
knows which PR it is about: `metadata.pr`, `metadata.prNumber`, `metadata.repo`
and `metadata.reviewMode`.

## Before you write anything

Run the import first:

```
pr_import_comments({ session: "<this session id>" })
```

It pulls the PR's existing comments — both the inline review comments and the
conversation — into the **Changes** tab as suggestions. Two reasons it comes
first: repeating a point a reviewer already made is noise, and a comment that
someone else already answered may not be a finding at all.

They arrive as *suggestions*, not as this review's comments. The human accepts
or rejects each one; whatever survives becomes part of the review alongside
yours. Do not accept them on the human's behalf.

## Reviewing

`metadata.reviewMode` says how much you may touch:

- `worktree` — check the PR out (`gh pr checkout`) and read the code around
  each change, not only the diff.
- `nocheckout` — `gh pr diff` and nothing else. The repository may be in use by
  another session.

Either way: **this is somebody else's pull request.** Do not modify, stage,
commit or push code. The output of this session is a review.

Put each finding in the Changes tab as an inline comment on the line it belongs
to, rather than as prose in the chat. That is what gives the human an
accept/reject decision per finding, and it is what the publish step reads.

## Publishing

When the human approves, publish. The host builds the `gh` call for you and
targets `PR #<prNumber>` — not "the open PR for the current branch" — precisely
because this session carries the number. With `nocheckout` there is no branch
to infer from at all, so the metadata is the only thing that makes publishing
possible.

## When the PR moves

Register a listener and the session wakes on reviewer replies, new comments, a
red check or a conflict:

```
register_listener({ type: "github-pr", url: "<metadata.pr>",
                    fire_on: ["new_review", "new_comment", "changes_requested", "ci_failed", "conflicts"] })
```

On wake, run `pr_import_comments` again before responding — what woke you is a
pointer, not the content.
