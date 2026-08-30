# docs/media — demo recordings

`hands-you-the-wheel.gif` is a 1×1 placeholder. Replace it with the ~25s
recording described in the GTM research (demo 1): a PM session fans out
three children, one hits 2FA in its own desktop, pushes to the phone, the
human types the code and taps Done, the child continues and reports back.

## Showcase shot-list (three profile bundles)

Content only — what to record, not how. Each clip: 20–45 s, phone + desktop
side by side where a push is involved, no audio needed, captions burned in.
Record on a fresh instance with the bundle applied (`bin/host profile apply
<name>`), fake data only (placeholder client / org / business names).

### 1. `agency-client` — "One client, one cockpit" (~40 s)

| t | shot | caption |
|---|---|---|
| 0–5 | Setup → Profile picker, `agency-client` card, click Apply; Skills tab shows two new skills with the *bundle* badge | "Fold Arigami to a client in one click" |
| 5–15 | Chat: paste a client message (*"the checkout button is invisible on mobile"*) → `client-intake` drafts a `bug` ticket (title / label / acceptance) → four-button action bar | "Request → ticket. You decide." |
| 15–22 | Tap **File + start session** on the phone → ticket appears (GitHub issue or `tickets/…md`) and a child session link appears in the reply; rail shows the child | "…and a session starts working it" |
| 22–35 | Chat: *"client report for last 7 days"* → report card → open artifact on the phone: TL;DR / Shipped / Needs your decision → tap **Share link** | "Weekly report your client opens with no login" |
| 35–40 | Triggers → `[agency-client] weekly-report` toggle on | "Or every Monday at 08:00" |

Ending frame: artifact on the phone + green child session in the rail.

### 2. `ops` — "It hands you the wheel — on call" (~45 s)

| t | shot | caption |
|---|---|---|
| 0–5 | Settings → Webhooks → Custom `alerts` created; a terminal `curl` posts one signed test alert | "Alerts arrive on a signed webhook" |
| 5–12 | Chat: *"triage alerts"* → sweep finds the event → `INC payments-api …` child session opens (link) | "One incident, one session" |
| 12–18 | Phone: push *"payments-api: 5xx since 09:41 after deploy … Run runbook restart-workers?"* with three buttons → tap **Run runbook** | "Escalates a decision, not a status" |
| 18–32 | Child desktop (VNC card): shell steps scroll, browser opens the (fake) admin console, stops at SSO login → push *"login needed"* → phone screen card → human logs in → **Done** → agent verifies the page, continues | "Logs in? That's you. Everything else? The agent." |
| 32–40 | `runs/<date>-restart-workers.md` opens: step table with outcomes + screenshots | "Every run is a record" |
| 40–45 | Next morning: `[ops] daily-health-digest` artifact on the phone | "Daily digest, pushed" |

Ending frame: rail with the incident session green, the run record open.

### 3. `il-whatsapp-business` — "העסק שלך עונה בוואטסאפ. אתה מאשר." (~35 s, Hebrew UI, RTL)

| t | shot | caption (HE / EN) |
|---|---|---|
| 0–5 | Settings → WhatsApp paired (green); Skills shows `whatsapp-inbox-triage` + `followup` | "מחובר לוואטסאפ של העסק / Paired to the business WhatsApp" |
| 5–12 | A (fake) customer message lands on the phone: *"כמה עולה תיקון דוד שמש?"* → chat: *"תעבור על הוואטסאפ"* → classification `הצעת-מחיר` + a Hebrew draft with the price from `BUSINESS.md` | "מסווג ומנסח מהמחירון / Classifies, drafts from your price list" |
| 12–20 | Phone: action bar **שלח / ערוך / דלג / אני אטפל** → tap **שלח** → the message appears in WhatsApp; a follow-up line is added to `followups.md` | "שום הודעה לא יוצאת בלי אישור / Nothing is sent without your tap" |
| 20–28 | Three days later (cut): *"מעקבים"* → reminder draft for the same customer → again buttons | "מעקב אחרי הצעות ותורים / Quotes and appointments followed up" |
| 28–35 | Morning: `morning-digest` artifact on the phone — חדש / ממתין / דחוף / מעקבים להיום | "כל בוקר, סיכום / Every morning, a digest" |

Ending frame: WhatsApp thread with the sent reply next to the cockpit action bar.

### Shared rules
- Never show real numbers, names or a real WhatsApp account; use a test phone.
- Keep the phone in frame whenever a push/decision happens — the takeover
  moment is the product.
- Show the `[bundle]` skill badge and the *disabled* cron toggle at least
  once per clip: bundles are additive and gated.
