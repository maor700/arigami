# Remote control of a Windows machine

Status: **the browser half is implemented and live-proven end to end; the
whole-desktop half is implemented and proven against a real VNC server, but
its Windows-side install is untested** (it cannot be, without a Windows
machine — see "What needs a real Windows box" at the end).

The complaint this answers: remote control of a Windows machine in Arigami is
"browser only", while Linux gets full control of the machine. That is true,
and it was worse than it sounded — on a non-Linux host the cockpit's screen
view did not work **at all**, in any mode.

---

## 1. How the desktop works today

Everything a session does to "a machine" goes through one interface,
`ScreenDriver` (`server/lib/screen-driver.ts`). Before this branch there were
two implementations that `pickDriver()` selected between: **x11 on Linux,
native-window everywhere else** (`ARIGAMI_SCREEN_DRIVER` forces either, which
is what makes a non-Linux host's shape testable from this Linux box). §3 adds
a third.

### The x11 driver — Linux (the VPS, the dev box)

| piece | how |
| --- | --- |
| the desktop | `server/lib/desktops.ts` spawns a per-session `Xvfb :1xx` + `x11vnc` on a loopback port; a global `:99`/`5900` pair is the fallback |
| live view | `/__vnc` (`server/vnc.ts`) pipes the browser's WebSocket to that VNC port; the cockpit renders it with noVNC |
| control | RFB carries pointer + keyboard back the same way — the human drives the machine |
| `capture_screen` | a hand-rolled RFB client reads the framebuffer (`captureFrame`), falling back to `scrot`/`import` |
| typing | XTEST via `skills/_lib/xinput.py` |
| reach | **the whole desktop** — every window on that display, a window manager, any GUI app, not just a browser |

`request_screen` gives the human that same interactive canvas in a modal. This
is the bar.

### The native-window driver — macOS and Windows

There is no X server to fake: the session's Chrome is a real window on a real
screen. So the driver talks CDP to that Chrome and nothing else.

| piece | how | reach |
| --- | --- | --- |
| the desktop | nothing to allocate — `ensure()` is a no-op | — |
| live view | `server/screencast.ts`, CDP `Page.startScreencast` → JPEG frames | the Chrome window |
| control | **was: none at all** — the bridge explicitly ignored every client message | — |
| `capture_screen` | CDP `Page.captureScreenshot` | the front tab |
| typing | CDP `Input.insertText` (the take-over modal's "type into the desktop" box) | the focused element |

Note that macOS is in exactly the same position as Windows here. There is no
macOS-specific desktop code anywhere in `server/` — no Screen Sharing, no
`kickstart`, nothing. The premise "Linux and macOS have full control, Windows
doesn't" is half right: **Linux is the only platform with full control.** What
made macOS feel fine is that the person running the desktop app is *sitting at
that Mac*, so they never needed remote control of it. A Windows box added as a
machine for the agent to drive is the case where nobody is sitting there, and
that is where the gap bites.

### What was actually broken (worse than "browser only")

`useScreenConnection.js` opened `/__vnc` **unconditionally**, for every
consumer, on every platform. And `/__vnc` bypassed the driver entirely: it
called `ensureDesktop()`/`screenTarget()` from the X11-only `desktops.ts`
directly. On a Windows/macOS host `ensureDesktop()` rejects ("per-session
desktop is unsupported on win32"), `screenTarget()` falls back to the global
`127.0.0.1:5900`, nothing is listening, the TCP connect fails and the socket
closes.

So on a Windows host: the chat card, the side panel and the take-over modal
were all a **black rectangle reading "disconnected"**, and a `request_screen`
the agent raised could not be answered. The screencast bridge existed
server-side but no client spoke its protocol — its own header said so
("nothing else in this repo speaks it yet"). Only the agent's own
`capture_screen` / `browser_*` tools worked, because those go through
`pickDriver()` correctly.

`win32` appeared in exactly two places in `server/`: `isWin` and a Chrome path
lookup. There is no Windows desktop story in the code.

---

## 2. What this branch implemented

The half that needed no software installed on the Windows machine: **make the
browser-window view real remote control, and make the transport something the
host declares rather than something the client assumes.**

- **`server/screencast.ts` relays input.** Client → server JSON messages are
  translated by `inputToCdp()` into CDP `Input.dispatchMouseEvent` /
  `dispatchKeyEvent` / `insertText` and sent down the same CDP socket the
  frames come back on. Mouse (move/down/up, drag via `buttons`), wheel,
  keyboard (with a correct `text` field so keys actually type, and *no* text
  when Ctrl/Meta is held so `Ctrl+C` stays a shortcut), and paste.
  `inputToCdp()` is pure and exported so the whole translation table is unit
  tested. The method name is chosen server-side from a fixed set — a client
  cannot name an arbitrary CDP method through this channel.
- **`web/src/lib/screencastClient.js`** — the client transport, deliberately
  shaped like noVNC's `RFB` class (a canvas inside the host div, a settable
  `viewOnly`, `disconnect()`, connect/disconnect events). That let
  `useScreenConnection.js` keep its whole one-connection-per-desktop /
  ownership / mirroring / hotkey-guard machinery **unchanged** — neither
  transport has a special case in it. Includes the letterbox-aware coordinate
  mapping (`canvasToPage`), drop-latest frame decoding, and backpressure.
- **The host declares the transport.** `ScreenDriver.viewer()` now also
  reports `interactive` and `scope` (`'desktop'` vs `'browser'`), and
  `GET /__api/screen/status` returns `{driver, viewer}`. The cockpit picks
  noVNC or screencast from that. **This is the seam that makes §3 a driver
  change instead of a client rewrite.**
- **`/__vnc` goes through the driver.** It used to call the X11-only
  `desktops.ts` directly; it now hands the socket to `driver.attachViewer`, so
  any RFB-speaking driver gets the bridge for free (that is how §3's driver
  needs no client code). A driver that does *not* speak RFB is refused with
  code `4004` and a log line, instead of dialling a VNC server that isn't
  there and leaving the client on "connecting…" forever.
- **The UI says what it can't do.** When the transport's scope is `browser`,
  the interactive view carries a "Browser window only" chip explaining that a
  native dialog outside the Chrome window will not appear.

### Proven live (this Linux box, real Chrome, real CDP)

Both harnesses are committed — `scripts/check-screencast-input.mjs` (the
server half) and `scripts/check-screencast-client.mjs` (the client half in a
real browser) — precisely so the first person with a Windows machine can run
them **there**. Every assertion in them is platform-independent and Chrome is
located through the host's own `findChromeBin()`, so a pass on Windows closes
most of §4's first block on the spot. Each prints `ALL … CHECKS PASSED` and
exits 0, or a `FAIL` line and exits 1.

Real headless Chrome, a real WebSocket pair into `bridgeToScreencast`, against
a page that records what reaches it:

- screencast frames arrive (1280x713);
- a **click** at scaled coordinates fires the page's `onclick`;
- **keystrokes** land in a focused `<input>`;
- a **paste** (`insertText`) appends to it;
- an unrecognized/hostile client message (`{type:'evil', method:
  'Runtime.evaluate'}`, `{method:'Browser.close'}`) changes nothing.

And the same loop was then closed in a **real browser**, end to end: a second
headless Chrome loaded `web/src/lib/screencastClient.js` as a module and
pointed it at that bridge, with `viewOnly = false` (the take-over modal's
mode). Reading pixels back out of the client's own canvas:

| step | evidence |
| --- | --- |
| frames decode and paint | canvas centre pixel `[255,204,1]` = the remote page's `#ffcc00` |
| a real DOM click lands | dispatching a `PointerEvent` on the canvas at element coordinates set the remote page's title to `CLICKED` |
| the change comes back | the remote page turned `#0066ff`; the viewer's canvas repainted to `[1,101,255]` |

So the full round trip — view → click → the remote page reacts → a new frame →
the viewer sees it — runs on real Chrome on both ends, through the real client
module, with the coordinate mapping doing its job.

A human answering a `request_screen` on a Windows host can now watch the
browser **and drive it** — click links, fill forms, complete a login, paste a
one-time code — from the cockpit, including from a phone.

### What this still does NOT give you

CDP reaches the **Chrome window**. It cannot touch:

- the Windows taskbar, Explorer, or any non-Chrome application;
- a **native file-picker dialog** (the one an "Upload" button opens) — this is
  the limitation most likely to be hit in practice;
- a UAC elevation prompt (secure desktop);
- anything before/after the browser is running.

Sharper than "browser only": the screencast is the page **viewport**. Even
within Chrome, the tab strip, the address bar and Chrome's own modal dialogs
(the print dialog, a permission prompt, "leave site?") are outside the frame
and outside CDP `Input`'s reach. So "complete a login" works; "switch tabs by
clicking the tab strip" does not.

That is the desktop half, and it is §3.

---

## 3. True desktop control on Windows — the options

### Option A — RDP. Rejected.

Built into Windows, but wrong for this product:

- **It replaces the console session rather than mirroring it.** Connecting
  over RDP disconnects/locks whoever is at the physical machine, and the
  agent's Chrome — running in the console session — is *not* in the RDP
  session. "Watch what the agent is doing" becomes impossible, which is the
  main thing `request_screen` is for.
- Not available on Windows Home editions.
- Needs a gateway to reach a browser (Guacamole's `guacd`, or an RDP client
  library); the maintained ones are a C daemon, not a small dependency.

### Option B — a VNC server on the Windows machine. **Recommended — and now built.**

A VNC server on Windows mirrors the **console** session — the same desktop the
agent's Chrome is on. That is the Linux model exactly, and the payoff is that
**everything downstream is already written and already in production on
Linux**: `/__vnc`'s TCP↔WebSocket bridge, noVNC in the cockpit, the RFB
framebuffer capture in `captureFrame()`, the shared-connection/ownership
machinery. None of it is X11-specific — it speaks RFB, and RFB is RFB.

What is Windows-specific is only *"is a VNC server running, and on which
port"*, which is one driver.

Candidates (all free/GPL, all install as a Windows **service** so they survive
logout and start at boot): **TightVNC 2.x** (`tvnserver`, MSI installer,
registry-configured — the usual first choice), **UltraVNC** (adds a mirror
driver for cheaper capture), **TigerVNC** (`winvnc`). Exact package IDs,
silent-install flags and registry keys are **unverified here** — see the end.

**This driver is now written** (`server/lib/screen-driver-winvnc.ts`) and
tested against a real RFB server — see "What was built" below. What is left is
the machine-side install, which cannot be done blind.

Shape of the work, as built:

1. **`server/lib/screen-driver-winvnc.ts`** — a third driver, mostly a thin
   variant of the x11 one:
   - `available()` — probe the configured loopback VNC port (the x11 driver's
     `probeVnc()` already does exactly this);
   - `ensure()` — *no spawn*: the service is managed by Windows, not by us.
     Return a handle if the port answers, throw an actionable error if not
     ("no VNC service on this machine — install it from Settings → Screen
     share");
   - `viewer()` — `{transport:'rfb', path:'/__vnc…', interactive:true,
     scope:'desktop'}`. **The cockpit then needs no change at all** — it
     already renders `rfb` descriptors with noVNC. This is what §2's transport
     seam bought.
   - `capture()` — reuse `captureScreen()`/`captureFrame()` unchanged;
   - `typeText()` — keep the CDP path, drop the XTEST fallback (no XTEST on
     Windows); a later `SendInput` helper can fill that in.
   - `pickDriver()` picks it on `win32` when the port answers, else falls back
     to native-window — so a Windows box **without** the service keeps the
     browser-only control §2 built, rather than losing everything.
2. **Per-session desktops don't port.** Xvfb gives every Linux session its own
   display; Windows has one console session. So on Windows every session
   shares the one desktop, and `ensure()` must return the global handle rather
   than pretending to allocate. The `own` flag in `/__api/screen/status`
   already exists to let the UI say so honestly.
3. **Loopback + password.** The VNC service must bind loopback only (the
   `/__vnc` bridge is the sole path in, matching the Linux trust model). VNC
   auth's password is capped at 8 characters and DES-based — treat it as a
   speed bump, not the boundary; the boundary is the host's own auth.
4. **Install path.** A `winget`/MSI silent install driven from the wizard, the
   way `install.sh` handles Linux packages, plus a doctor check ("VNC service:
   running / not installed").

### Option C — a native agent (capture + `SendInput`). Best long-term.

The Tauri shell (`desktop/src-tauri/`) is already a Rust process on that
machine, and it already has `cfg!(windows)` branches. It could capture the
screen (Windows.Graphics.Capture or BitBlt) and inject input (`SendInput`),
with no third-party install and no service. This is the only option that could
eventually also handle multi-monitor cleanly and drop the VNC password
entirely.

It is also a new subsystem — capture loop, encoder, transport, input mapping —
where Option B is a config file and a probe. And it still cannot touch the UAC
secure desktop without elevation, so it does not dominate B on capability.

**Recommendation: B now, C later if B's third-party dependency becomes a
problem.** B reuses code that is already carrying production traffic on Linux;
C rewrites it.

### What was built for Option B, and what it was tested against

`createWinVncDriver()` is a complete `ScreenDriver`. It is **opt-in**
(`ARIGAMI_SCREEN_DRIVER=winvnc`, or `ARIGAMI_WIN_VNC=1` on win32) and never
inferred, so a Windows box without the service keeps the browser-window
control from §2 instead of losing everything.

Because RFB is RFB, the driver's logic is testable here in full by pointing it
at a genuine `Xvfb`+`x11vnc` pair — the same protocol a Windows VNC service
speaks. What that proved (`test/windows-remote-vnc-driver.test.ts`,
`test/windows-remote-vnc-host.test.ts`):

- `available()`/`status()`/`ensure()` report a live VNC service correctly, and
  with no service reachable every entry point fails fast with one message that
  says what to do, instead of hanging.
- `capture()` returns **real desktop pixels over RFB** — 640x480, matching the
  Xvfb the test spawned, with raw RGBA present for screenshot dedup. That is
  the whole-desktop capture that CDP cannot give.
- An isolated host booted on this driver reports `{driver:'winvnc',
  viewer:{transport:'rfb', interactive:true, scope:'desktop'}}`, **and its
  `/__vnc` bridge really reaches the VNC server** (verified by reading the
  `RFB 003.008` protocol banner back off the bridged WebSocket). The cockpit
  renders that descriptor with the noVNC client it already ships, so there is
  no new client code for a Windows machine at all.
- `?session=` is correctly ignored (one console desktop), `release()` does not
  tear the shared machine down, and `status().perSession === false` stops the
  machine side panel from offering to "allocate" a desktop that already exists.
- The x11 host was re-tested the same way, because `/__vnc` now dispatches
  through the driver: it still serves RFB exactly as before.

---

## 4. What needs a real Windows box to verify

Nothing in §2 needs one — it is platform-independent by construction (CDP is
identical on every OS) and was proven live here under the forced driver. What
follows is honest about everything that is *not* covered by that.

**§2, but on real Windows** (expected to work, never observed):
- The desktop app has **never been built or run on Windows at all**
  (`docs/DESKTOP.md` says so: "Nobody is building or running the Windows
  target today"). So the whole native-window path on Windows — Chrome
  discovery via `WIN_CHROME_PATHS`, `DevToolsActivePort` in the profile dir,
  the sidecar lifecycle, `taskkill /T /F` on quit — is unobserved. My changes
  sit on top of that and inherit its risk.
- Keyboard layouts: the `key`/`code`/`keyCode` mapping was exercised with a
  US layout. A Hebrew or other non-Latin layout on Windows should be checked —
  `insertText` handles the characters, but named-key/modifier behaviour is
  worth one pass.
- Every live check here ran **headless** Chrome. CDP's `Page.startScreencast`
  and `Input.*` are the same headed, but anything touching a real window is
  not: `Page.bringToFront` (which `handOver` calls) has nothing to raise in
  headless, so its behaviour on a real Windows desktop is inferred, not seen.

**§3 (Option B) — the driver is written and proven against a real VNC server,
so what is left is everything on the WINDOWS side of the socket:**
- Whether the chosen VNC server installs silently and unattended, and the
  exact package id / MSI properties (the `winget` id and TightVNC's
  `SET_PASSWORD`-style MSI properties are quoted from memory here and were
  **not** verified against a live machine or a current package index — check
  them before writing them into an installer).
- Whether the service, running as `LocalSystem`, actually mirrors the logged-in
  console session on a modern Windows build (session isolation has bitten
  every VNC-on-Windows project at some point), and what it shows when nobody
  is logged in.
- Whether it can bind loopback-only, and the registry key that does it.
- Whether `captureFrame()`'s RFB negotiation works against that server: it
  requests **Raw encoding at 32bpp** and *throws* on any other encoding. Some
  Windows servers prefer Tight/ZRLE and may not honour a Raw-only
  `SetEncodings`. This is the single most likely concrete failure, and it has
  a known fix (fall back to `Page.captureScreenshot`, or teach the client one
  more encoding).
- Multi-monitor: `captureFrame()` assumes one framebuffer.
- Performance over Tailscale with no mirror driver.

Nothing about the Arigami side of Option B is guesswork any more — the driver,
the transport descriptor, the `/__vnc` dispatch and the RFB capture are all
exercised against a live VNC server in CI-able tests. What is unverified is
Windows itself: the service install, session isolation, and whether that
particular server negotiates the encoding our capture client demands. Until a
Windows machine exists to test on, treat the list above as the acceptance
checklist for the first one that does.

§2 is real, tested end to end in a real browser, and on by default for every
non-Linux host.

---

## 5. A trap in the test suite, if you add tests here

A dozen `*-web.test.js` files replace `globalThis.fetch` and
`globalThis.WebSocket` with inert stubs in `beforeAll` and never put them back,
and bun runs every test file in **one process**. Any test that needs a real
socket or a real HTTP client therefore cannot use the globals: the new host
tests here go through `node:http` and the `ws` package's own client instead.

This is worth knowing because the symptom is maximally misleading — the tests
pass alone and hang in a full run, which reads exactly like the connection bug
they exist to catch.
