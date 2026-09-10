# Repo realignment: local master vs. origin/master

**Status (measured 2026-09-08 on /opt/arigami):** the local `master` and `origin/master` have no
common base (`git merge-base` is empty). So `git pull --ff-only` — the flow behind the "עדכן"
(Update) button in Settings — always fails, and a plain `git push` is rejected too. The "גרסה"
(Version) screen shows this as "no common base" and disables updates until realignment happens.

## What happened

On 2026-09-06, three PRs landed on GitHub on top of **rewritten** history (PR #2 —
`chore: scrub personal data…` — rewrote every commit from the very first one, to strip personal
data). The `git fetch` that followed flagged this in the reflog as `forced-update`. The local repo
kept going from the old (unscrubbed) history with another wave of work on top (EXT, compare,
autoplay…). The result: two trees telling the same story up to 9/4, across two different SHA
chains.

## The numbers

| | Local master | origin/master |
|---|---|---|
| Commits on the branch | 371 | 328 |
| Commits not on the other side (by SHA) | 371 | 328 |
| Commits not on the other side **by content** (`git cherry`) | **55** | **18** |
| Of which after the last push (10437ca, 9/4/2026) | 50 | — |
| Last commit | 511a088, 9/8/2026 | b3684f3, 9/6/2026 (merge PR #3) |

File differences between the two heads: **156 files** (1,985+ / 10,693−):

- **58 files only local** — the extension system: `skills/build-extension/` (15),
  `examples/extensions/` (12), `server/notify.ts`, `server/listeners-registry.ts`,
  `server/lib/` (3), ext/autoplay tests (8), web (8).
- **14 files only in origin** — `control-plane/Dockerfile`, `control-plane/docker-entrypoint.sh`,
  and `deploy/helm/arigami-control-plane/` (12) — the content of PR #1 and #3.
- **84 files that differ on both sides** — mostly the scrub (PR #2: names/addresses in tests and
  docs, `web/src` 18, `deploy/helm/arigami-tenant` 5, `control-plane/src` 2) and
  `.github/workflows/release.yml` (origin has an extra job that builds the control-plane image).

Of origin's 18, three are genuinely new content (PR #1 k8s control-plane, PR #2 scrub, PR #3 ci +
`chore(host): drop the pre-rename launchd migration`); the remaining 15 are rewritten versions of
commits that already exist locally, whose diffs the scrub changed. Of the local 55, 50 are new
work since 9/4 and 5 are old commits the scrub touched.

## Option A — rebase local onto the scrubbed origin/master

```
git fetch origin                      # without --prune
git branch backup/master-pre-realign master
git rebase --onto origin/master 10437ca master
# resolve conflicts (expected in the 84 files the scrub touched — mostly tests/docs)
bun test && bun run typecheck
git push origin master                # plain push, no force
```

- **Advantages:** origin stays the public, scrubbed source of truth; no force-push; the GitHub
  history (PR #1–#3, the Release workflow, the images in GHCR) stays continuous; existing
  collaborators/clones don't break.
- **Risks:** ~50 commits to rebase, with conflicts expected in the files the scrub touched; local
  commits that contain personal data the scrub cleaned (the `no-personal-data` test will catch
  it) will need edits; local SHAs change — the active worktrees under
  `/home/arigami/repos/.dispatch-worktrees/` need rebasing too (or a merge after realignment).
- **Time:** one to three hours, mostly conflicts.

## Option B — adopt local as truth, re-scrub, force-push

```
git branch backup/origin-master-pre-realign origin/master
git cherry-pick 86314201 3ac6e47 58d6b8b   # origin content missing locally (k8s control-plane, ci, launchd)
sh scripts/check-personal-data.sh && bun test test/no-personal-data.test.js
# history: git filter-repo (or a manual rewrite) against ~/.arigami/private-terms.txt
git push --force-with-lease origin master
```

- **Advantages:** the 50 new commits aren't touched; the local SHAs (and every worktree's) stay
  put; realignment is a single operation.
- **Risks:** force-push on a public repo — every old clone breaks (and GitHub's reflog doesn't
  protect against this either); the original scrub (PR #2) is lost and has to be redone over all
  371 commits, including **the history** (not just the head) — otherwise the personal data that
  was cleaned goes public again; tags/Releases built on SHAs that will disappear; GitHub PRs will
  point at orphaned commits.
- **Time:** half an hour for the realignment, plus unknown for a full historical scrub.

## Recommendation

**Option A.** The deciding reason: the PR #2 scrub was **the point** of the rewrite, and it's
already been done and verified on the history in origin. Option B undoes it and exposes
unscrubbed history to the public again until a second scrub is finished, over roughly twice as
many commits. Option A's conflicts are limited to files that are already identified (list:
`git diff --name-only master origin/master`), and most of them are tests/docs.

Before starting, regardless of option:
1. `git branch backup/master-pre-realign master` — nothing gets deleted.
2. Merge the pending branches (dispatch/*) into local master first, so the rebase only has to
   happen once.
3. After realignment: `bun run release minor` → tag `v0.2.0` → `git push --follow-tags` — the
   first tag cut from the realigned repo, and from that point the "עדכן" (Update) button in
   Settings works (ff-only against origin).

**Do not execute this automatically.** This is a decision for the instance owner (a choice card
in session VER1); the session that runs this creates a backup branch before every command and
never runs `fetch --prune` / `reset --hard` against origin.

---

## What actually happened (2026-09-08)

The instance owner chose **Option A**, and the realignment was carried out. In order, what was
done:

1. `git fetch origin` (without `--prune`); backups: `backup/master-pre-realign` (b01a1a7) and
   `backup/ver1-pre-realign` (5518c06). Both still exist.
2. The rebase itself ran in a separate, detached worktree (`/home/arigami/repos/realign-wt`)
   rather than in `/opt/arigami` — so the live host would never run, even for a moment, on a tree
   with conflicts.
3. `git rebase --onto origin/master 10437ca` — 44 non-merge commits (57 including merges, which
   got flattened). 28 applied cleanly; five stopped on conflicts, all of the same kind: local
   scrub commits versus the PR #2 scrub. In every case the local side was chosen, being the more
   neutral of the two ("the owner" instead of a first name, "the club" instead of an employer's
   name).
4. Two exceptional cases:
   - `web/src/components/TabBar.jsx` — a genuine conflict between branding and agent-page, which
     in the original history was resolved in a merge commit that the rebase flattens. The exact
     result of that same merge was restored (from b01a1a7).
   - `test/no-internal-refs.test.js` — git treats it as binary (it has a NUL byte in it), so the
     conflict wasn't flagged and origin's version silently won. That's the version that contains
     the personal terms inline in the code; it was replaced with the local version (215d146),
     which reads an external denylist instead.
5. Result: the new tree differs from the old `master` by **only 24 files**, all of them origin's
   additions (control-plane, deploy/helm/arigami-control-plane, docker/entrypoint.sh,
   DEVOPS-HANDOFF, release.yml). **Zero** differences under `server/`, `web/`, `mcp/`, `bin/`,
   `skills/`, `examples/` — meaning what the host actually runs is exactly identical.
6. Fixed in a separate commit: the personal-data gate didn't recognize the RFC1918 ranges that
   `deploy/helm/arigami-tenant/values.yaml` excludes from `0.0.0.0/0`. After that,
   `check-public-readiness.sh` passes.
7. `master` in `/opt/arigami` was moved to 2abe77b. Its status: **44 commits ahead of
   `origin/master`, zero behind** — meaning a plain `git push origin master` (fast-forward, no
   force) is possible.
8. `dispatch/versions-update` (VER1) was rebased onto the new master. The only conflict:
   `.github/workflows/release.yml` — both jobs were kept (building the control-plane from origin,
   and VER1's `github-release`).

**What's left:** the push to origin hasn't happened yet (waiting on explicit approval). After
that: `bun run release minor` → `v0.2.0` → `git push --follow-tags`, and from that moment the
"עדכן" (Update) button in Settings works ff-only against origin.
