---
description: Build a two-week content calendar per channel from a campaign brief — one row per post/email with date, channel, format, working title, hook, call to action and owner — plus first drafts for the first three items. Use when asked for a content calendar, a posting plan, or "what do we publish next week".
argument-hint: [brief artifact path or a one-line goal]
---

# Content calendar (two weeks)

1. Read the brief (an artifact path, a pasted brief, or `memory_search("brief")`). If there is
   none, run the `campaign-brief` skill first.
2. Table, one row per item, ≤ 14 rows: `date · channel · format · working title · hook (≤ 12
   words) · CTA · owner`. Only channels the brief lists. Spread the key message: never the same
   angle twice in a row on one channel.
3. Draft the first THREE items in full (email: subject + body ≤ 120 words; post: ≤ 60 words +
   an image brief line for the image maker). Plain voice, no hype words.
4. `publish_artifact` the calendar as `calendar.md` and end with the path.

Limits: you plan and draft — you never schedule or post. Anything that would go live is a
`request_action` (kind `post:<channel>`) for the human, or a task to the social manager.
