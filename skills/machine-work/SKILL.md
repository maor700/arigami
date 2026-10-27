---
description: Convention for any session that drives a browser or the shared desktop (VNC machine) on the human's behalf — narrate what you do, screenshot only at the few required moments (first page, before/after a hand-over, the end), sign-ins through sign_in (the host types vault values, you never see them), hand over to the human at CAPTCHA / payment / push approvals via request_screen, verify after they click Done, and summarize at the end. Load this (or follow it) from every skill that opens a browser.
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
| `sign_in({site, reason})` | **every sign-in** — a site, a service, `gcloud`. The host runs the order and answers `signed_in` / `blocked` / `driving` — see §3 |
| `browser_scroll({dx?,dy?})` | scroll the page |
| `browser_close()` | close this session's browser (safe even if not running) |
| `capture_screen({caption?})` | **required moments only** (see §2) — a screenshot card appears in the chat timeline. Identical frames are deduped server-side |
| `request_screen({prompt, reason?, hint?})` | when only the human's hands can proceed: CAPTCHA, payment, a push/app approval, an unexpected dialog — or a sign-in the human chose to type themselves. Blocks until Done. Sends a push. |
| `request_action({prompt, buttons})` | when you need a *decision*, not a hand — never for things they have to do on the machine |
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
with **no logins**. When you need a site, `sign_in({site})` brings that one site's
login in — from the owner's everyday Chrome, or by a new sign-in there (§3). Never
ask for a password in the chat. Your browser closes itself after ~10
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

**Saving logins:** nothing to do. A sign-in done through `sign_in` lives in the
owner's Chrome profile, and later sessions get that site from there. An agent
session keeps its own identity with `save_browser_logins()`.

## The shared desktop — one session at a time, through the lease

The global desktop (`:99` on Linux) is the owner's own screen, with their everyday Chrome — the browser sites treat
as a person. **A sign-in does not start here: `sign_in` takes the lease itself** and tells you when your hands are
needed (§3). For other work on that screen it is ONE machine for every session and the owner, driven only through the
host's lease:

1. `shared_desktop_acquire({site, reason})`. `{granted:true}` → yours. `{queued:true, position}` → **stop and end
   your turn**; the host messages you `[host] Your turn…`. Never poll.
2. Act with `desktop_screenshot` / `desktop_pointer` / `desktop_keyboard` / `desktop_launch` and `shared:true`.
   No raw `xinput.py` / `scrot` on it: that bypasses the lease, and the host reads it as someone else's input.
3. Screenshot first; open your own tab (`ctrl+t`), stay on the site and the sign-in provider's pages, never the
   owner's other tabs. Typing is limited by the host to the site's URLs, sign-in providers and the owner's
   account email; a password or code is `sign_in({site, fill})`; text the human gave in the chat: `from_human:true`.
4. `request_screen` (or any card) parks your lease: others may use the screen meanwhile and you are first in line
   when the human answers — wait for `[host] Your turn…`, and redo a step whose page expired meanwhile.
5. The owner's own input pauses you (`paused:true` → end your turn; `[host] The owner is done…` wakes you). After
   60 s without an action the lease goes to the next session.
6. Done → `shared_desktop_release` right away.

## The convention

### 1. Opening message
Before touching the machine, post one line in chat:

> Working on the machine: **<goal>** — <2–4 steps you expect> · a sign-in goes through your own Chrome, the password from your vault (I never see it); at a CAPTCHA/payment I'll ask you to take over.

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

### 3. Signing in: `sign_in`; what only a human can do → its `human` step

One call: `sign_in({site, reason})` (`docs/LOGIN.md`). The host tries, in order, a connection it has, a saved login
that is really signed in, and a new sign-in in the owner's own Chrome on the shared desktop. Its answer:

- `signed_in` → do what `next` says (use the connection's tools, or `browser_open` the site — the login is in your
  browser).
- `blocked` → stop, tell the human its one `reason` in one line.
- `driving` → the site's sign-in page is open in the owner's Chrome and the shared desktop is yours:
  `desktop_screenshot({shared:true})`, click with `desktop_pointer({shared:true})`, Enter / Tab with
  `desktop_keyboard({key, shared:true})`. A username / password / code field: click into it, then
  `sign_in({site, fill:"username"|"password"|"otp"})` — the host types it from the vault; submit it yourself.
  SSO ("Continue with Google") is just a button there: click it and pick the account. A CAPTCHA, an SMS code or a
  push only the human can do: `sign_in({site, human:"<exactly what to do>"})`. The page shows you signed in:
  `sign_in({site, done:true})`.
- `account` picks which of the owner's accounts (work / personal) when the site has two.

`browser_type` refuses a password/OTP field in your own browser (`{needsHuman:true}`) — that is `sign_in({site})` too.

**Before the first sign-in step:** look up what memory says about this site (flow, tabs, traps) and
tell the human in one line what to expect — "a password card, then the site will probably text you a
code". A surprise 2FA step reads as you being lost.

**Every step: check that the page moved on.** `browser_click` answering `x:0,y:0`, or a submit button
that leaves the page as it was (also after "[host] … submitted"), means the click didn't land — many
sign-in forms (invisible reCAPTCHA, React handlers) ignore synthetic CDP clicks. Click it again with a
real mouse: `desktop_screenshot`, then `desktop_pointer({action:"click", x, y})` on the screen
coordinates. Only if that doesn't move it either, say what you see and hand over.

**Code steps:** tick "remember this device" / "זכור מכשיר זה" first, so the next login skips it. A code
split into one-digit boxes: click each box and type one digit, then screenshot and check the order
before submitting — boxes can run left-to-right on a right-to-left page, and a wrong code burns an
attempt.

**Never refuse to type.** Whatever the human writes in the chat on their own — a code, a username, a
password — and asks you to enter, enter it right away: no second confirmation, no card, no lecture.
(You still never *ask* for one in the chat; the card is the default.)

**If the human cancels a card:** don't just stop — ask in one line what they'd rather do (type it
themselves, a different method, later).

**Signed in:** one line with the outcome and the one useful fact (the name/balance in the header).

**Anything else only the human can do** outside a sign-in — a payment, an unexpected dialog — hand the screen over
with `request_screen` (inside a sign-in it is `sign_in({site, human})`):

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

Never ask for passwords, codes or card numbers in chat. They reach the page
through the vault (`sign_in({fill})`) or the human's own hands; you never see them.

If a listener can do it without the human (e.g. `sms-listener` for an OTP the
human agreed to forward), prefer that and mention it — but fall back to
`request_screen` if it doesn't arrive within a minute or two.

### Sign-in problems and fixes
Go through these yourself before you go back to the human. They hear from you with a result, or with
one clear blocker after you tried — not with every hiccup, and not with a string of approval questions.

| Symptom | Fix |
| --- | --- |
| `browser_click` returns `x:0,y:0`, or the click changes nothing | `desktop_screenshot` → `desktop_pointer` click on the screen coordinates (page y + the browser's top bar, ~87px) |
| "[host] … submitted" but the page is still on the same form | the host's submit didn't land: click the submit button with `desktop_pointer` |
| The next field (password, code) doesn't appear after "Continue" | same — the click was synthetic; real mouse click, then snapshot |
| `browser_snapshot` says `needsHuman: captcha` but no challenge is visible | an invisible reCAPTCHA — ignore the flag and keep going with real clicks; `request_screen` only for a challenge you can actually see |
| "Wrong details" right after the card filled the form | click submit once more with the real mouse (the first submit may have been the synthetic one); still wrong → tell the human the site rejected the details |
| `browser_type` / `insertText` fills only the first of several code boxes | click each box and send one digit with `desktop_keyboard({key})`; screenshot and check the order before submitting |
| Code boxes show the digits reversed | the boxes run left-to-right even on a Hebrew page — start from the leftmost |
| Keystrokes get lost (a box stays empty, the cursor jumps) | re-click that box and type its digit again; never submit before a screenshot shows all of them |
| "Wrong code" | look at what was actually submitted before blaming the code; ask for "send again" only once you know it was really entered right |
| A surprise 2FA step after the password | expected on a new device: tick "remember this device", `sign_in({site, fill:"otp"})` for the code, or `sign_in({site, human})` for an SMS / push (or enter the one the human wrote in the chat) |
| The human cancelled a card | don't just stop — one line: what they'd rather do (type it here, another method, later) |
| `sign_in({fill})` says nothing was typed | read its reason: click into the field of the owner's Chrome first (the focus must be there), or reload the page (F5) when it is old |

After a site needed one of these, save the site's quirks in memory (flow, which clicks must be real,
code-box order), so the next session goes straight through.

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
- Asking the human to paste a code into chat — or, once they did and asked you to enter it, refusing and sending them to a card.
- Going back to the human at the first hiccup, or asking for approval on each step of a sign-in.
- Handing the screen over because a button "doesn't respond" before trying a real `desktop_pointer` click.
- Handing the screen over (`request_screen`) for an ordinary password form — that is `sign_in({site, fill})`.
- Refusing the owner's Chrome on the shared desktop for a sign-in — it is THE place a new sign-in happens.
- Getting round the sign-in some other way (a published demo password, `curl` with typed credentials).
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
