---
description: Daily standup for a solo developer — summarize yesterday's commits across the registered repos, list what is blocked, and propose today's three most valuable tasks. Use when asked for a standup, a "what did I do yesterday", or a plan for today.
---

# Daily standup (solo)

1. For every repo in `/__api/onboarding/repos` that is cloned, run `git log --since=yesterday --oneline --author="$(git config user.email)"`.
2. Group the commits by repo; one line each, no hashes.
3. List anything that looks stuck: branches with commits but no push, failing tests mentioned in commit messages, TODO/FIXME added yesterday.
4. Propose **three** tasks for today, ordered by value, each one sentence.
5. Keep the whole report under 15 lines. Deliver it as the final message — no files, no side effects.
