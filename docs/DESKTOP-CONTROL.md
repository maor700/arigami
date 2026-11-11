# Desktop control — screenshots in, mouse and keyboard out

A host capability, not an engine feature: every session — Claude or Codex — gets the same `desktop_*` MCP
tools, so what a person can do with the machine never depends on which subscription they hold. They act on the
session's **own** desktop (a private Xvfb, see `server/lib/screen-driver-x11.ts`), never on the owner's real screen.

| Tool | What it does |
|---|---|
| `desktop_screenshot` | A **fresh** frame of the session's desktop, returned as an IMAGE (plus `width`, `height`, and a `file` path). Coordinates in the image are screen pixels — what the pointer tool takes. |
| `desktop_pointer` | `move` / `click` / `double_click` / `right_click` / `middle_click` / `drag` (x,y → x2,y2) / `scroll` (dy wheel ticks) at screen coordinates. |
| `desktop_keyboard` | `text` (printable ASCII) or `key` (a key or combo: `Return`, `ctrl+l`, `alt+F4`) into whatever has focus. |
| `desktop_launch` / `desktop_quit` | Start a program on that desktop **detached** (it outlives the call), stop one you started. |

Passwords, 2FA and OTP codes are never typed by the agent — that is `request_screen` (the human types).

## Why this exists

* **A persistent personal browser without an automation port.** `desktop_launch` can start Chrome with
  `--user-data-dir=<dir>` and **no** `--remote-debugging-port`: a normal browser that keeps its logins, driven only
  by pixels. Measured (one trial): it passes the WebDriver check the CDP-driven session Chrome fails; it did **not**
  clear CAPTCHAs any better (both got the same reCAPTCHA image challenge).
* **What is outside a page** — other windows, menus, installers, apps. For anything inside a page prefer the
  `browser_*` tools: DOM-precise, cheaper, no coordinate errors.

## How it works

* `POST /__api/sessions/:id/desktop/{screenshot,act,launch,quit}`; the MCP tools are thin wrappers
  (`mcp/host-mcp.js`). `toMcpContent()` returns an `__image` result as a real MCP image block.
* Input goes through `skills/_lib/xinput.py` (XTEST over ctypes: `move click dblclick drag scroll key type`).
* Linux/x11 only for now; other drivers answer "desktop control needs the x11 driver" — there is no silent fallback.
* Each action is logged (`[desktop] <session> <action> ok|failed`).

## Measured behaviour (first trial, Astra on gpt-6-astra)

51 actions, 0 misplaced clicks on simple pages, but plumbing failures that this layer removes: a screenshot returned
as a file link instead of an image, a background Chrome that died with its shell, and an `xinput.py` path the session
had to guess. Long unattended tasks still need verification between steps: every action is a screenshot round-trip.

## The shared desktop — a lease, not a free-for-all

The global desktop (`:99`, the one the cockpit's screen icon shows) is the owner's own screen. On a host where the
owner keeps an everyday Chrome there, it is the browser Google signs in without a CAPTCHA — so agents want it too.
Every agent action on it goes through the host (`server/lib/shared-desktop.ts`):

| Tool | |
|---|---|
| `shared_desktop_acquire({site, reason})` | `{granted}` or `{queued, position}`. A queued session ends its turn; the host messages it `[host] Your turn…` when the machine is its (FIFO). |
| `desktop_screenshot` / `_pointer` / `_keyboard` / `_launch` with `shared:true` | The same tools, on the shared desktop, for the holder only (`409` with `queued` / `parked` / `paused` / `expired` otherwise). |
| `shared_desktop_release` | Back to the next in line. |

* **Released** after 60 s without an action (120 s for a session just woken from the queue), on release, when the
  session is archived or deleted, and when the owner presses **Take it back** in the screen view (which shows the
  holder, the queue and who waits for the owner).
* **Parked** while the holder waits on the human (`request_screen` — whose card then shows the shared screen — or
  any card): the next session may use the machine, the holder's window stays, and when the human answers the holder
  is at the head of the queue (ahead of sessions that asked earlier).
* **The owner first.** Input on the display that did not come through the host — the owner over VNC — pauses the
  holder until the screen has been quiet for 8 s, and the queue waits too. Told apart by the X server's idle counter
  (`server/lib/xidle.py`, XScreenSaver): every input event resets it, and the host knows when its own XTEST input ran.
* **Guards** (the owner's real browser has no DevTools port, so they are on what goes in): navigation keys only (no
  paste, no closing or quitting windows); typed text only a URL of the leased site or a sign-in provider, or the
  owner's identity email — anything else needs `from_human:true` (text the human gave in the chat); only a browser
  can be launched, without debugging/profile flags; nothing can be quit.
* **Sign-ins take it themselves.** `sign_in` (`docs/LOGIN.md`) acquires the lease for the site (waiting in the queue
  inside the call, no "[host] Your turn" message), opens the site in the chosen profile of the owner's Chrome, and is
  the only path that types a secret there: the HOST types one vault value into the focused field
  (`sign_in({fill})`, `xinput.py type-secret` on stdin) after checking the focused window is the owner's Chrome and
  its last navigation is on the site. While the vault card for that field is up the lease is kept (the field must stay
  focused), not parked. `sign_in({done})` releases it.

