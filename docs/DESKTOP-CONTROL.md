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
