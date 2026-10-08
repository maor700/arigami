---
description: Write a 3-touch outreach sequence (partners, influencers, press or prospects) and a prospect table — who, why them, what we offer, the hook per touch — and send NOTHING until the human approves each batch. Use when asked for outreach, a partner list, a press pitch, or an influencer campaign.
argument-hint: [who we are reaching and why, e.g. "20 newsletter authors for the launch"]
---

# Outreach sequence (approval-gated)

1. **Prospect table** (≤ 20 rows): `name/handle · where · why them (one line) · what we offer ·
   source link`. Only prospects you can point to a source for; nothing invented.
2. **Sequence** — three touches, each with a subject/opening line and a body ≤ 90 words:
   - touch 1: the specific reason it is them + one clear ask;
   - touch 2 (+4 days): a proof point or asset, not a nag;
   - touch 3 (+7 days): a short close with an easy out.
   Same plain voice as the brief; a placeholder `{first_name}` is fine, `{company}` is not (say
   why them instead).
3. `publish_artifact` both as `outreach.md`.
4. To send: ONE `request_action` per batch (kind `send-email`, buttons "send batch" / "not now")
   that names the recipients and quotes touch 1. Send only the approved batch, through the
   connected mail account; log what went out in your journal (`memory_write({target:'journal'})`).

Never send from an account that is not connected to YOU (check_setup composio:gmail first);
never message anyone who asked not to be contacted.
