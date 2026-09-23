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
| `browser_open({url?})` / `browser_navigate({url})` | open or move to a page in YOUR session's own Chrome. `browser_open` also screenshots (the "first page loaded" moment). |
| `browser_snapshot({caption?})` | screenshot + `{url, title, text}` of the current page, plus `{needsHuman, reason, hint}` — check this before clicking/typing further |
| `browser_click({x,y}\|{text})` | click by viewport coordinates (from a snapshot screenshot) or by visible text |
| `browser_type({text, submit?})` | type into the focused field. Refuses (returns `needsHuman:true`) on a password/OTP field or a CAPTCHA — see §3 |
| `browser_scroll({dx?,dy?})` | scroll the page |
| `browser_close()` | close this session's browser (safe even if not running) |
| `capture_screen({caption?})` | **required moments only** (see §2) — a screenshot card appears in the chat timeline. Identical frames are deduped server-side |
| `request_screen({prompt, reason?, hint?})` | when only the human can proceed (login, 2FA, CAPTCHA, payment, unexpected dialog). Blocks until Done. Sends a push. |
| `request_action({prompt, buttons})` | when you need a *decision*, not a hand — never for things they have to do on the machine |
| `browser_logins()` | which sites the human is signed in to in THEIR browser — names only. Check before signing in anywhere |
| `request_login({site, reason})` | ask for the human's login to ONE site; they approve on a card and it lands in your browser. Stop and wait for the `[host]` message |
| `save_login({site, reason})` | after a fresh sign-in, offer to save that one site to the human's browser — only on their approval |
| `set_status_summary` / `set_progress` | running status — do NOT use request_action for status |

`capture_screen` and `browser_*` are provided by the host MCP (`arigami`) under the `desktop` and
`browser` tool families respectively (an agent's allowlist may grant one without the other — see
`docs/AGENTS.md` "Tool allowlist"). If a tool you need is missing in this session, say so once and
continue without it — do not improvise a Bash/xdotool workaround, and do not claim you have no way
to look at a page just because `open_tab`/`WebFetch` alone can't drive a real browser: `browser_*` is
the tool-only way to do that, with no `Bash`/`git` required.

**`browser_*` vs `capture_screen`/`open_tab`**: `open_tab` shows the human a page (a cockpit iframe
tab) — it does not let you read or act on it. `capture_screen`/`request_screen` show/hand over the
whole desktop. `browser_*` is what you use to actually LOOK at and DRIVE a real site yourself —
navigate, read the page text, click, type. Prefer it over `Bash` + `skills/_lib/chrome.sh` even when
you do have `Bash` — it is the same underlying browser, with no shell-escaping or coordinate-mapping
to get wrong, and it works for agents that only have `browser`/`desktop`, not `git`.

`browser_navigate`/`browser_open` are refused outside the agent's `domains` allowlist (the same
403 `open_tab` gets) — if you're blocked there, that's a real allowlist decision, not a bug; say
so and ask the human (`request_action`) rather than working around it via `browser_type`ing a URL
into the address bar.

## Showing things to the human (links)

The human may be on a phone, another machine or a tailnet — a
`http://localhost:…` link only works on the host box. So:

- **Static output** (report, HTML, screenshots dir, built site) →
  `publish_artifact` and pass on the `/__artifacts/<id>/` path it returns.
- **Live server** (dev server, Storybook) → bind it to `$PORT` (or the port from
  `allocate_port`) and `open_tab({type:"url", url:"http://localhost:$PORT"})`;
  the host proxies it into a cockpit tab.
- **Never print `http://localhost:…` URLs** in replies, reports, pushes or
  messages. The host returns host-**relative** paths (`/__host/?session=…`,
  `/__artifacts/…`) — forward them as-is. `$ARIGAMI_URL` is an internal base for
  your own API calls, not a link for people.

## Your own machine

Each session gets its own desktop (its own `Xvfb`+VNC, not the shared one)
and its own Chrome profile, allocated the first time you touch any of this —
`request_screen`, `capture_screen`, or opening a browser. The profile starts
with **no logins**. The human signs in to sites once, in their own browser
("My browser" in the cockpit); when you need a site, `request_login` asks them
for that one site. Never ask for a password in the chat — a fresh sign-in is
`request_screen`, with the human typing. Your browser closes itself after ~10
minutes unused and reopens, with its tabs, on your next browser step.

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

> Working on the machine: **<goal>** — <2–4 steps you expect> · I'll only get stuck at login/2FA/CAPTCHA/payment, and then I'll ask you to take over.

(Write this in the human's own language — match whatever language they've been writing to you in, English included.)
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

If you're driving with `browser_*`: `browser_type` refuses on its own when the focused field looks
like a password/OTP input or the page shows a CAPTCHA (`{ok:false, needsHuman:true, reason, hint}`),
and `browser_snapshot` reports the same `{needsHuman, reason, hint}` proactively — don't wait to be
refused, check it. Either way the next step is the same: `request_screen`, never typing it yourself.

1. `capture_screen` (or `browser_snapshot`) first (required moment #2 — the card shows where you are).
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

Then post one line ("✓ Connected, moving on to <next step>" — in the human's own language) and update `set_progress`.

### 5. Summary at the end
Final chat message, short:

- what was achieved (and what wasn't),
- where the human intervened and why,
- anything left in an unusual state on the machine (open tabs, logged-in
  sessions, unsaved forms) — and whether you cleaned it up.

Take one last `capture_screen({caption: "Final state"})` (required moment #4). If a review is
needed, `request_review` with that summary.

### 6. Reflect (retro)
Before you finish: did you hit something a future run of this skill should
know — a selector that only works with an extra wait, a site that needs a
specific hand-over hint, a step order that avoided a dead end? If yes, call
`skill_propose({name: "machine-work", rationale, evidence?})` with a small,
concrete change (don't propose speculatively, and don't do this every run —
only when you actually learned something). This is a proposal, not a write —
a human reviews the diff before it touches the live skill.

## Anti-patterns
- Calling `request_screen` with only a prompt and no hint ("please help").
- Using `request_action` for "I'm on the login page" — that's status, not a decision.
- Asking the human to paste a code into chat.
- Continuing after Done without checking the page.
- Screenshotting every step "for the record" — only the four required moments plus what you need to see yourself.
- Sending several `request_screen` in a row — each one is a push to their phone.

## Missing capability → `needs_setup` → `request_setup` (JIT setup)

Tools on this host do not fail when a capability is not configured — they *ask*:
a tool result (MCP or REST) of the form
`{ "needs_setup": "composio:gmail", "why": "read your inbox", "hint": "call request_setup" }`
means the capability (`identity`, `claude` / `codex` (the engine logins, each for its own engine's sessions), `git`, `repo:<name>`, `whatsapp`,
`mcp:<service>`, `composio:<toolkit>`, `desktop`, `push`, `remote`, `telemetry`)
is missing.

When you see one:

1. Call `request_setup({capability, why})` — the host shows a Setup card in the
   chat (and a push) where the human chooses **automatic** or **manual**. It blocks.
2. `{state:"auto"}` → the human asked *you* to connect it: run the matching
   playbook — `skills/connect-<provider>/SKILL.md` (`connect-identity`,
   `connect-composio`, `connect-mcp`, `connect-claude`, `connect-codex`, `connect-tailscale`,
   `connect-github`) —
   and finish with `report_setup({capability, ok, evidence?})`. Then call the
   original tool again.
3. `{state:"done"}` → the human connected it manually: call the tool again.
4. `{state:"skipped"|"timeout"}` → offer an alternative for the task; do not nag.

**Never work around a missing capability** — no scraping instead of the API, no
asking for tokens/passwords in chat, no reading another session's profile. The
card is the only path. Details: `docs/CONNECT.md`.
