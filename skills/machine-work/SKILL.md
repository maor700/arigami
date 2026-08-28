---
description: Convention for any session that drives a browser or the shared desktop (VNC machine) on the human's behalf — narrate what you do, screenshot only at the few required moments (first page, before/after a hand-over, the end), hand over to the human at login / 2FA / CAPTCHA / payment via request_screen, verify after they click Done, and summarize at the end. Load this (or follow it) from every skill that opens a browser.
---

# Machine work — narrate, capture, hand over, verify

You are operating a machine the human can watch live (the shared desktop shown
in the chat, and mirrored to their phone via push notifications). The human is
not reading your reasoning — they see the chat and the screen. This skill makes
what you do legible, and makes the moments where only they can act painless.

Target pattern: you work, the human watches, at a blocking step they **take
over**, complete it, click **Done**, and you continue.

## Tools you use

| Tool | When |
|---|---|
| `capture_screen({caption?})` | **required moments only** (see §2) — a screenshot card appears in the chat timeline. Identical frames are deduped server-side |
| `request_screen({prompt, reason?, hint?})` | when only the human can proceed (login, 2FA, CAPTCHA, payment, unexpected dialog). Blocks until Done. Sends a push. |
| `request_action({prompt, buttons})` | when you need a *decision*, not a hand — never for things they have to do on the machine |
| `save_browser_logins()` | sync this session's Chrome cookies/logins back to the shared base profile — usually automatic (see "Your own machine" below), call directly if you want it sooner |
| `set_status_summary` / `set_progress` | running status — do NOT use request_action for status |

`capture_screen` is provided by the host MCP (`arigami`). If it is missing in
this session, say so once and continue without screenshots — do not improvise
your own screenshot pipeline.

## Your own machine

Each session gets its own desktop (its own `Xvfb`+VNC, not the shared one)
and its own Chrome profile, allocated the first time you touch any of this —
`request_screen`, `capture_screen`, or opening a browser. Logins carry over
between sessions (a shared base profile each session's Chrome clones from and
syncs back to), but the *desktop* and the open windows on it are yours alone.

**Opening a browser:** use the helper, never launch `google-chrome` yourself:
```
skills/_lib/chrome.sh "https://example.com"
```
It ensures your desktop exists, clones your Chrome profile from the shared
base on first use, and opens the URL there. Run it again (no URL, or a new
one) to reuse the same running Chrome — it won't spawn a second instance.

**Never `pkill chrome`** (or `pkill -f chrome`, or any blanket chrome kill).
Every session runs its own Chrome on its own profile — killing "chrome"
system-wide would take down other sessions' browsers along with yours. You
don't need to kill your own either; the host tears it down when the session
is archived or deleted.

**`$DISPLAY`** is set for you automatically once your desktop exists (from
the session's first request_screen/capture_screen/browser open onward — a
respawn is enough if it was allocated after your process started). If you're
driving X directly instead of through the Chrome helper, use `$DISPLAY`, not
a hardcoded `:99` (that's the *global* desktop, not yours).

**Saving logins:** after you complete a login/2FA/payment flow yourself (no
`request_screen` involved), call `save_browser_logins()` so the next session
starts already signed in. If the human did it via `request_screen` Take
over → Done, this happens automatically — no need to call it yourself.

## The convention

### 1. Opening message
Before touching the machine, post one line in chat:

> עובד על המכונה: **<goal>** — <2–4 steps you expect> · אתקע רק ב-login/2FA/CAPTCHA/תשלום, ואז אבקש שתשתלט.

(English is fine if the human writes English; match their language.)
Set `set_progress` with those steps.

### 2. Capture only at the required moments
Screenshots are for the human's timeline, not a log. Too many bury the ones
that matter (and cost disk). Call `capture_screen({caption})` at exactly these
points:

1. **First page loaded** — once, after the site/app is actually up ("Login page loaded").
2. **Right before `request_screen`** — so the hand-over card shows where you are.
3. **Right after `request_screen` returns** — to verify what the human did ("After human login — dashboard").
4. **The end** — final state, or the failure screen if you stopped.

Anything else only if *you* need to see the screen to decide what to do next
(a page you can't read otherwise, an unexpected dialog). That is a viewing
tool, not documentation — don't caption it as a milestone.

Not: after every click, scroll, form field or navigation in between. If the
screen hasn't changed since the last capture the server returns
`{duplicate:true, url}` and adds no card — don't retry, move on.

Captions: short and factual — "Login page loaded", "Order form filled, not
submitted yet", "Error: card declined".

### 3. Blocked → hand over with `request_screen`
When you reach a step only the human can do:

1. `capture_screen` first (required moment #2 — the card shows where you are).
2. Post one short line in chat: what you were doing and why you stopped.
3. Call:
   ```
   request_screen({
     prompt: "Logging in to <site> to <goal> — it's asking for the SMS code.",
     reason: "2fa",              // login | 2fa | captcha | payment | other
     hint:   "Enter the code from your phone, wait until the dashboard loads, then click Done."
   })
   ```
   - `prompt` ≤ 200 chars — it is the body of the push notification.
   - `reason` — pick the closest; it drives the card label and the push title.
   - `hint` — exactly what to do and what "done" looks like. Always include the
     end state, so the human doesn't click Done one screen too early.
4. Do nothing else while it blocks. Don't retry, don't poll, don't open other
   tabs on the machine — the human is driving it.

Never ask for passwords, codes or card numbers in chat. The human types them
on the machine; you never see them.

If a listener can do it without the human (e.g. `sms-listener` for an OTP the
human agreed to forward), prefer that and mention it — but fall back to
`request_screen` if it doesn't arrive within a minute or two.

### 4. After Done → verify, then continue
`request_screen` returns `{ok, note?}`. The note is what the human says
happened — trust it but verify:

- `capture_screen({caption: "After human login"})` (required moment #3) and re-read the page.
- Check the concrete end state you asked for (logged-in header, dashboard URL,
  payment confirmation).
- If it's not there: say what you see, and either fix it yourself or call
  `request_screen` again with a **more specific** hint. Don't loop silently —
  a second request without explanation reads as the first one being ignored.
- If it timed out (`note` says so): stop, `report_to_master`/`request_action`
  with what's pending; do not keep the machine busy.

Then post one line ("✓ מחובר, ממשיך ל-<next step>") and update `set_progress`.

### 5. Summary at the end
Final chat message, short:

- what was achieved (and what wasn't),
- where the human intervened and why,
- anything left in an unusual state on the machine (open tabs, logged-in
  sessions, unsaved forms) — and whether you cleaned it up.

Take one last `capture_screen({caption: "Final state"})` (required moment #4). If a review is
needed, `request_review` with that summary.

## Anti-patterns
- Calling `request_screen` with only a prompt and no hint ("please help").
- Using `request_action` for "I'm on the login page" — that's status, not a decision.
- Asking the human to paste a code into chat.
- Continuing after Done without checking the page.
- Screenshotting every step "for the record" — only the four required moments plus what you need to see yourself.
- Sending several `request_screen` in a row — each one is a push to their phone.
