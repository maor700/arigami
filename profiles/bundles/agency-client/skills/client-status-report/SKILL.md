---
description: Weekly client status report for an agency-run cockpit — gather what shipped, what is in progress and what is blocked from git, tickets and child sessions, write it in the client's language, publish it as an artifact and mint a share link the human can forward. Use when asked for a "client report", "weekly status", "what do I tell the client", or when the [agency-client] weekly-report cron fires.
argument-hint: [period, e.g. "last 7 days" or "since 2026-01-01"]
---

# Client status report

You produce the one document the client actually reads. It must be true (from
real sources, never invented), short, and shareable without a login.

## 0. Context
1. Read `CLIENT.md` in the workspace root (see the bundle's `memory-seed/CLIENT.md`
   for the template). Take the client name, language/tone, definition of done
   and the ticket source from it. If it is missing, say so once, produce the
   report in English, and add a line asking the human to create it.
2. Period = the argument, else the last 7 days.

## 1. Gather (read-only)
- **Shipped:** for every cloned repo in `GET $ARIGAMI_URL/__api/onboarding/repos`
  (curl with `-H "Authorization: Bearer $ARIGAMI_TOKEN"`), run
  `git log --since=<period> --merges --first-parent --oneline` on the default
  branch; fall back to plain `git log --since` if there are no merges. Group by
  feature, not by commit; drop hashes.
- **In progress:** `list_sessions` — sessions in this project folder that are
  active or "In Review"; one line each from their `status_summary`. Open
  branches with commits but no merge count as in progress.
- **Blocked / waiting on the client:** sessions whose action bar is waiting for
  a human, tickets labelled `question` or `waiting-client`, and anything in
  the previous report's "next" list that did not move.
- **Tickets:** if `CLIENT.md` names a ticket source, list tickets opened and
  closed in the period (`gh issue list --state all --search "updated:>…"` for
  GitHub). Never call an API that CLIENT.md does not mention.

## 2. Write
A single `report.html` (self-contained, no external assets, readable on a
phone) under `./reports/<YYYY-MM-DD>/`. Sections, in the client's language:

1. **TL;DR** — three sentences max.
2. **Shipped** — bullets, each with what it means for the client, not the commit message.
3. **In progress** — bullet + expected next step.
4. **Needs your decision** — only items that literally need the client; each with the concrete question.
5. **Next week** — up to five items.

No internal hostnames, session ids, or agency-internal notes. If a section is
empty, omit it.

## 3. Publish and hand over
1. `publish_artifact({path:"./reports/<date>", title:"<client> — status <date>", share:true, share_days:14})`.
2. Reply with the artifact path AND the `share_url` (or the warning if the host
   has no public URL — then the human shares it from the card instead).
3. Do **not** email or message the client yourself. The human forwards the link.
4. If you ran from the cron: finish with `report_to_master` — `summary` = the
   TL;DR + the share link. Prefix `[SILENT]` only when nothing happened in the period.
