---
description: Turn a marketing goal into a one-page campaign brief the whole team works from — objective, audience, key message, proof points, channels, deliverables per agent, timeline and how success is measured. Use when asked for a campaign brief, a launch plan, or "what should the team do this week".
argument-hint: [goal, e.g. "launch <your-product> v2 to existing customers"]
---

# Campaign brief

Produce ONE page (≤ 40 lines) with exactly these sections, in the human's language:

1. **Objective** — one measurable sentence (what changes, by when).
2. **Audience** — who, what they already believe, what would make them act. Pull facts from
   `memory_search` (product notes) before inventing; mark guesses as guesses.
3. **Key message** — one sentence; then 3 proof points (each one line, each checkable).
4. **Channels** — only the channels listed in the shared notes; one line each on the role it plays.
5. **Deliverables per agent** — a table: agent · deliverable · due. Keep it to what this
   campaign really needs (a launch may not need outreach; a webinar may not need visuals).
6. **Timeline** — 3–6 dated milestones.
7. **Success** — 2–3 numbers you will actually be able to read afterwards.

Then `publish_artifact` the brief as `brief.md` and end with the artifact path. If the goal is
missing or ambiguous, ask ONE question with `request_action` (kind `brief:clarify`) — do not
write a brief for a goal you had to guess.
