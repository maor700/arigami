# Desktop packaging (`bun build --compile`)

Status: **compiles and boots, live-verified**. `bun build --compile
server/index.ts` produces a self-contained server binary; paired with
`scripts/bundle-resources.ts`'s output next to it, the binary serves the
cockpit and answers the API on a real port with no `~/.arigami`/repo
checkout involved. Not yet tested: starting an actual Claude session from
inside the binary (needs the `claude` CLI wired up — out of scope for this
smoke test) and packaging into an actual Tauri app.

## What's here

- `server/lib/bun-exec.ts` — `bunExec(kind, extraArgs)` returns the
  `{command, args}` to run one of `mcp/host-mcp.js` / `mcp/policy-hook.js` /
  `mcp/ext-mcp.js`. Outside a compiled binary it's `bun <path>` — byte-identical
  to what the three call sites built by hand before this helper existed
  (verified directly, not just by inspection). Inside a compiled binary
  (`resourceRoot()`'s `isCompiledBinary()`, now exported) there's no `bun` on
  PATH, so it re-execs `process.execPath` with `--mcp <kind> [...args]`
  instead.
- `server/index.ts` — the very first thing after computing `ROOT`: if
  `--mcp <kind>` is in `process.argv`, it rewrites argv to the layout the
  target script expects (`ext-mcp.js` reads its module path from `argv[2]`,
  same as `bun mcp/ext-mcp.js <path>`), `await import()`s
  `mcp/<host-mcp|policy-hook|ext-mcp>.js`, then does
  `await new Promise(() => {})` to permanently park this module's own
  evaluation right there. That parking is the whole trick: it means nothing
  below (config-dir creation, the host lock, `server.listen()`) needs to be
  touched or wrapped — the dispatch block is a fully self-contained
  early-exit, and the normal server-boot path is untouched byte-for-byte.
  `host-mcp.js`/`ext-mcp.js` then keep the process alive on their own via the
  open stdio transport; `policy-hook.js` calls `process.exit()` itself.
  (`blocking-call.js` is a fourth file in the task list but it is never
  spawned as its own process — it's a library `host-mcp.js` imports — so
  `bunExec()` only has `host` / `policy` / `ext` kinds.)
- `scripts/bundle-resources.ts <dest-dir>` — copies everything
  `resourceRoot()`-relative that the server actually reads at runtime into
  `<dest-dir>/`:
  `web/dist/`, `sdk/`, `skills/`, `.claude-plugin/`, `mcp/`, `profiles/`,
  `server/assets/`, `server/lib/pty-bridge.py`, `package.json`, `VERSION`.
  The list was built by grepping every `resourceRoot()` call site, not
  guessed. `skills/` and `.claude-plugin/` both have to sit at the bundle
  root because Claude Code's `--plugin-dir ROOT` expects both directly under
  the same root (see `pluginDirArgs()` in server/claude.js).
  Deliberately excluded: `deploy/`, `control-plane/`, `Dockerfile`,
  `docker-compose.yml`, `install.sh`, `test/`, `node_modules/` — none of
  these are read via `resourceRoot()` at runtime.

  `host-mcp.js` and `ext-mcp.js` get an extra step: after the plain copy,
  they're re-bundled with `Bun.build({target:'bun'})`, overwriting the
  copies. Reason: `bunExec()`'s compiled-binary branch reaches them via
  `await import(<absolute path on disk>)`, loaded fresh from disk — NOT
  through the main executable's embedded module graph — so their own
  `import ... from '@modelcontextprotocol/sdk/...'` needs a real
  `node_modules` tree sitting next to them, which a bare `resources/`
  directory doesn't have. Discovered live: `<binary> --mcp host` failed with
  `Cannot find module '@modelcontextprotocol/sdk/server/index.js'` before
  this was added. Bundling inlines the dependency (and the local
  `blocking-call.js` import) so the files are self-contained.
  `policy-hook.js` has no npm deps (only `node:` builtins + `fetch`), so it's
  left as a plain copy.

## How to build

```sh
bun run build:web                                   # web/dist
bun build --compile server/index.ts --outfile dist/arigami-server
bun scripts/bundle-resources.ts dist/resources       # next to the binary
```

`resourceRoot()` expects the resources at `<dirname(execPath)>/resources`, so
`dist/arigami-server` and `dist/resources/` must ship side by side.

## What was fixed to make `--compile` succeed

`bun build --compile` refuses to bundle any `require()` of a module that
transitively contains a top-level `await` (the presence of `await` at module
scope — even inside a runtime-`false` `if` — marks the whole module
"asynchronous" for bundling purposes, independent of whether that branch ever
runs). Two sources of top-level await were blocking every `require()` of
`extensions.js`/`agent-policy.js` from `skills.ts`, `state.ts`, and
`extensions.ts` itself:

1. **`server/lib/children.ts:71-122`** — `initJob()` was `async` solely
   because of `await import('bun:ffi')`. `bun:ffi` is a Bun builtin (no
   top-level await of its own, and — per an earlier spike — available inside
   a compiled binary), so it's now loaded with a synchronous
   `require('bun:ffi')` instead. `initJob()` is now a plain synchronous
   function, and the call site is `initJob();` (no `await`). **Semantics are
   unchanged**: `assignToJob` is still set during module evaluation, in the
   same order, before any importer's code runs — `supervise()` (line ~201,
   itself synchronous) reads `assignToJob` exactly as it did before. This was
   the one piece flagged as Windows-safety-critical (job-object orphan
   protection) and specifically NOT touched in an earlier pass of this task;
   it's fixed now only because the fix keeps the synchronous-before-first-use
   guarantee intact rather than replacing it with an async race.
2. **`server/extensions.ts:1424-1509`** — the `bun server/extensions.ts
   list|add|trust|…` CLI block (`if (import.meta.main) { … }`) had a real
   top-level `await`. Wrapped its body in `void (async () => { … })()` — a
   fire-and-forget async IIFE, not a real top-level await. Since this block
   is the last statement in the file, the event loop still runs it to
   completion before the process exits naturally either way, so the CLI's
   `process.exitCode` / `doCommit()` behavior is unchanged. `import.meta.main`
   is false whenever the file is imported (the normal server path), so this
   block never executes there regardless.

No other top-level-await sources turned up — `bun build --compile
server/index.ts` now succeeds outright with just these two changes.

## What WAS verified live (compiled binary, not just `bun run`)

All of this was run against the actual `bun build --compile` output, never
against port 3099 or `~/.arigami` — isolated `ARIGAMI_DIR` under `/tmp`,
`ARIGAMI_PORT=39231`, processes killed and `/tmp` cleaned up after.

- **Binary size: 81 MB** (`arigami-server`, single file).
- **Resources directory size: 3.7 MB** (`web/dist` 2.0M, `skills` 312K,
  `profiles` 336K, `mcp` — now with bundled `host-mcp.js`/`ext-mcp.js` —
  ~900K, `sdk` 56K, `server/assets`+`pty-bridge.py` 28K, `package.json`+
  `VERSION` 8K). Up from 2.8 MB before the mcp-script bundling fix.
- Ran the binary directly (not `bun run`): came up clean, no server-boot
  errors, and served:
  - `GET /__health` → `{"ok":true,"busySessions":0}`
  - `GET /__api/config` → `{"version":"0.1.0",...}` (read from the bundled
    `VERSION`/`package.json`)
  - `GET /__host/` → the built cockpit HTML (from bundled `web/dist`)
  - `GET /__ext-sdk.js` → served (from bundled `sdk/`)
- **The re-exec dispatch itself** (`<binary> --mcp <kind>`), previously
  unreachable without a working `--compile` build, now works for all three
  kinds:
  - `--mcp host` → host-mcp.js's MCP stdio server starts, no server-boot log
    line appears, process stays alive waiting on stdio (confirmed via
    `timeout` exit code 124 = still running, not crashed).
  - `--mcp ext /nonexistent/module.ts` → ext-mcp.js starts, reports its own
    app-level "failed to import" error for the missing module (expected —
    this is ext-mcp.js's designed graceful-degradation, not an SDK-resolution
    crash), and stays alive on stdio exactly like a real extension load
    failure would.
  - `--mcp policy` (no `ARIGAMI_SESSION_ID` set) → exits 0 immediately, per
    policy-hook.js's own `if (!SID || !toolName) process.exit(0)` guard.

Not tested: starting an actual Claude session end-to-end from the compiled
binary (needs the `claude` CLI + a real session flow wired into this smoke
test — out of scope here) and cross-compiling for macOS/Windows
(`--compile-executable-path` / `bun build --compile --target=...`) — this was
all verified on Linux/Bun 1.4.0 only, matching the rest of this task's
verification.

## Test suite

`bun run typecheck` — clean, no errors.

`bun test` — same session, back-to-back, identical test/pass/fail counts and
**byte-identical failing-test-name list** before vs. after the
children.ts/extensions.ts fix (1126 tests, 1041 pass, 1 skip, 84 fail, both
runs). The 84 failures are pre-existing/environmental — not caused by
anything in this task — root-caused to two independent sources also
reproducible against master with none of this branch's changes applied:
`test/core.test.js` expects a session's `metadata` to start `{}`, but this
live worker session itself has `chatMode:"simple"` set, which leaks into
`state.createSession()`'s default; a chunk of `*-host.test.ts` /
`ladder-replay` tests hit fixed timeouts (5000ms hook timeout, 15000ms
ladder-replay) that this sandboxed environment's load doesn't always clear —
an earlier run today saw 115 failures with the same root causes, confirming
the count itself is flaky here, not a fixed regression signal. What's solid
is the diff: zero new failures, zero accidentally-fixed failures, from the
children.ts/extensions.ts change.

## Tauri desktop shell (`desktop/`)

Status: **built and run for real, on Linux — macOS itself still isn't
built**. Tauri cannot cross-compile Linux→macOS at all (needs Apple's SDK and
linker), so a macOS `.app` has never come out of this box and can't. But
after the human explicitly asked for at least a Linux build, Rust *was*
installed here (rustup + the Linux system deps: webkit2gtk-4.1, libgtk-3,
libayatana-appindicator3, librsvg2, all -dev packages) and the full
`cargo tauri build` pipeline was run for real — see "What was proven" below.
Everything in `main.rs` compiled clean on the **first** attempt against the
real Tauri 2.11 API (every call this doc used to flag as "unverified from
memory" — `navigate()`, `run_on_main_thread()`, the dialog plugin, the tray
— turned out correct). Actually *running* the built app on this session's
own Xvfb display, on the other hand, immediately surfaced two real bugs that
no amount of reading would have caught; both are fixed and re-verified live
(see below). What remains genuinely unverified is now a much shorter,
macOS-specific list.

### What's here

- `desktop/src-tauri/Cargo.toml`, `tauri.conf.json`, `build.rs`,
  `src/main.rs` — the Tauri project.
- `desktop/src-tauri/capabilities/default.json` — the capability for the
  shell's own windows (`main`, `machine-*`, `picker`), with **no `remote`
  block** (see decision #2 below).
- `desktop/src-tauri/shell-dist/` (was `splash-dist/`) — the shell's own two
  pages, the only pages in the app that are ours:
  - `index.html` — what a machine window shows while it connects, and where
    it parks if the machine doesn't answer. It polls the `shell_status`
    command; the actual probing still happens in Rust.
  - `picker.html` — the machines window: list, switch, "open in a new
    window", add, forget.
  `tauri.conf.json` sets `withGlobalTauri: true` so these two plain HTML
  files can call `window.__TAURI__.core.invoke` with no bundler.
- `desktop/build.sh` — stages the sidecar binary + its `resources/` sibling
  into `desktop/src-tauri/resources-staged/`, the exact layout
  `tauri.conf.json`'s `bundle.resources` map ships and `main.rs` reads back
  via `resource_dir()`. It calls the two tools this doc already describes
  (`bun run build:web`, `bun build --compile`, `bun scripts/bundle-resources.ts`)
  — nothing new, just aimed at a different output directory. macOS only,
  matching the audience of this doc.

### Five decisions (do not change these without re-reading the "why")

1. **The window loads `http://127.0.0.1:3099/__host/` via an ordinary
   external URL, not a bundled `frontendDist` app.** `web/src/lib/hostUrl.js`
   builds every iframe/tab `src` from `window.location.origin`, and the auth
   cookie is `SameSite=Lax`. If the window's origin were anything other than
   the real host origin (a `tauri://` or custom-scheme origin, as a bundled
   SPA would get), every tab would become a cross-site iframe from the
   cookie's point of view and silently 401.
2. **No IPC to that origin.** `capabilities/default.json` has no `remote`
   entry, so the cockpit — and everything same-origin with it, including
   every extension tab rendered as an iframe — gets no `window.__TAURI__`
   and no `invoke`. Per Tauri's own security advisory, on Windows an iframe
   that's same-origin with the top-level window gets IPC access too; since
   all our iframes are same-origin by construction, there is no safe way to
   grant this to the cockpit without also granting it to every tab. Don't.
3. **The shell is the supervisor.** `main.rs` sets `ARIGAMI_SUPERVISOR=self`
   on the sidecar — `server/host-control.ts`'s `detectManager()` reads this
   exact value, and without it the cockpit's restart/upgrade button gets a
   409. The contract: the sidecar exits 0, `run_supervisor()` respawns it.
   Only the *first* boot triggers the connect→navigate dance; every later
   respawn (restart, upgrade, or a crash) is silent — the window is already
   sitting on the real URL, and that page's own reconnect logic (built for
   the ordinary browser product) is what recovers the UI. The sidecar now
   runs **only while some window is pointed at "this computer"**
   (`local_wanted`): switch every window away and it is stopped with
   SIGTERM; switch back and it is started again. Every `claude` under it is
   300MB+, so a local server nobody is looking at is real waste.
4. **A shell page of our own is mandatory.** The window starts on the local
   `shell-dist/index.html`; a background thread probes the chosen machine
   (`probe()` / `wait_local_ready()`), and only once it answers does
   `main.rs` call `WebviewWindow::navigate()` to `<origin>/__host/`. Without
   this, the very first paint would be the engine's own connection-refused
   error page. The same page is also where a window parks when a machine
   doesn't answer — with the error, a "try again" button and one-click chips
   onto the other machines. **A machine that is asleep is a normal state,
   not a failure**, and it must never be a white screen.
5. **`ARIGAMI_ROOT` isn't set — the binary finds its resources by
   position.** `server/lib/resource-root.ts`'s compiled-binary branch expects
   `resources/` next to `process.execPath`. `desktop/build.sh` stages
   `arigami-server` and `resources/` as siblings under
   `resources-staged/`, and `tauri.conf.json` ships that whole directory
   unchanged, so `dirname(execPath)` inside the bundle already has what
   `resourceRoot()` wants with zero extra plumbing.

### The machine switcher (one shell, this computer *or* the VPS)

The point: sometimes the work needs a stronger machine, or software that
isn't on the Mac. So one shell runs the local Arigami **and** mirrors a
remote one (the VPS over Tailscale).

**The law that dictates the whole shape** is decision #1 above, applied
twice: the window's origin must be exactly the machine serving the API.
`web/src/lib/hostUrl.js` builds every tab from `window.location.origin` and
the auth cookie is `SameSite=Lax` per origin. So **switching machines is a
navigation of the window**, never a client-side merge of two machines' data
— that isn't possible at all. Each machine keeps its own cookie in the app's
one jar, so a switch is a navigation, not a re-login (verified — see below).

- **The list** lives in `app_config_dir()/machines.json`: `{machines: [{id,
  name, origin, local}], last}`. Only *remote* machines and the last choice
  are persisted; **"This computer"** is synthesised at runtime (`local_machine()`)
  so its port always matches the build. `normalize_origin()` turns what the
  human types into an origin: an explicit scheme wins; otherwise a hostname
  gets `https` (that's what `tailscale serve` gives you) and a bare IP or
  `localhost` gets `http`. A machine is an origin — any path or query is
  stripped.
- **Switching** is `go_to_machine()`: show our own page, probe, navigate (or
  park on the error page). A newer switch always wins over a slow one — each
  gets a `generation` and a connect thread that lost the race leaves the
  window alone.
- **The indicator is deliberately unmissable**, because the two machines
  render a byte-identical cockpit and one day the human will run something
  heavy on the wrong one. There are four, all live at once: the window title
  (`Arigami — <name> (local|remote)`), a menu titled `Machine: <name>`, the tray
  tooltip, and — injected into the machine page itself — a coloured strip
  along the top plus a name pill in the corner. The strip/pill colour is per
  machine (local keeps the brand yellow). The injection is one-way `eval`,
  **not** IPC: it hands the page nothing.
- **Keyboard**: `Cmd/Ctrl+Alt+1..9` jumps straight to a machine,
  `Cmd/Ctrl+Shift+M` opens the machines window. Both are ordinary menu
  accelerators, so they ship to macOS as-is.
- **"Open in a new window"** creates a `machine-N` window with its own
  machine, its own status and its own title. Two machines side by side in
  one app is a supported state; the local sidecar runs if *any* window wants
  it, and stops when the last one leaves.

#### The two traps, both tested rather than assumed

1. **`Secure` cookies and http.** A cookie with `Secure` is not stored on an
   http origin, so a uniform policy would break the local machine. Tested
   directly against this engine with a stand-in machine that sets one plain
   and one `Secure` cookie: only the plain one ever came back. There is
   nothing to fix — `server/auth.ts`'s `cookieHeader()` already adds `Secure`
   only when `requestIsSecure(req)`, i.e. never for the local sidecar on
   `http://127.0.0.1`, always for a machine reached over `tailscale serve`
   https. The rule for this shell is: **don't set `ARIGAMI_PUBLIC_URL` or any
   https hint on the local sidecar**, and don't try to normalise the two
   machines onto one policy.
2. **A machine that doesn't answer is normal.** DNS failure, TCP timeout and
   a non-200 all end on the shell's own page with a Hebrew explanation
   naming the host, a "try again" button, and chips onto the other machines.
   Never a white screen, never a dead end. `probe()` retries a remote three
   times before giving up; the local machine gets 60s (it has to boot).

#### Known limitation: on Linux, two open windows share one menu bar

`app.set_menu()` sets **one** menu for the whole app, so with two machine
windows open on Linux both menu bars read `Machine: <the focused window's
machine>`. The title bar and the in-page pill are per window and stay
correct, so the indicator is never wrong — just doubled. On macOS there is
only one menu bar to begin with and it belongs to the focused window, which
is exactly the intended behaviour, so this is Linux-only and cosmetic.

#### Known limitation: cookies ignore the port

Cookies are scoped by **host**, not by origin — so two machines on the *same
hostname, different ports* share one cookie jar and will log each other out.
Confirmed live (a machine on `127.0.0.1:39484` was handed the cookie set by
`127.0.0.1:39485`). In real use the machines are different hosts (localhost
vs. a Tailscale name), so this doesn't bite; it is listed because it is
invisible if you hit it.

### Build steps (macOS)

```sh
# once, if you don't already have them:
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
cargo install tauri-cli --locked --version "^2.0"

# once, to generate real app icons from the current brand mark.
# desktop/src-tauri/icons/ is gitignored, and `bundle.icon` lists those
# files, so a fresh clone does NOT build until this has been run:
cd desktop/src-tauri
cargo tauri icon ../../web/public/icon-512.png
cd ../..

# every time server/ or web/ changes. Also required before the FIRST build:
# tauri-build fails with `resource path 'resources-staged' doesn't exist`
# if this hasn't produced the directory yet.
bash desktop/build.sh

# dev run (opens a window against the freshly staged sidecar):
cd desktop/src-tauri && cargo tauri dev

# release build (.app under desktop/src-tauri/target/release/bundle/macos/):
cd desktop/src-tauri && cargo tauri build
```

### The same thing, in CI

`.github/workflows/desktop.yml` runs exactly the sequence above — icons,
`desktop/build.sh`, `tauri build` — on four runners (Linux x64, Windows x64,
macOS arm64, macOS Intel) and attaches the resulting installers to the GitHub
Release for the tag. It uses the npm `@tauri-apps/cli` (via `bun x`) rather than
`cargo install tauri-cli`, which would compile the CLI from source on every
runner.

It is deliberately not part of every release: on a private repo on the Free
plan macOS minutes bill ×10 and Windows ×2, so a full matrix is roughly
200-330 billed minutes. A tag you push by hand builds them; an automated
release only does when the `DESKTOP_INSTALLERS` repository variable is `true`.
docs/RELEASING.md has the full table.

Nothing is signed. Adding that means a Developer ID certificate + an
app-specific password for notarisation on macOS, and a code-signing
certificate on Windows, as repository secrets — until then both platforms warn
on first launch.

First run: the pairing code (needed once, in the cockpit's login screen) is
**not** printed to a visible terminal — the sidecar's stdout/stderr are
redirected to a log file via `app.path().app_log_dir()`. Verified live on
Linux this lands at `~/.local/share/io.arigami.desktop/logs/arigami-server.log`
(keyed by the bundle *identifier*, not "Arigami") — macOS's exact path is
unverified, so don't take "~/Library/Logs/Arigami/" on faith; `find ~/Library/Logs
-iname arigami-server.log` if it's not where you expect. Easier either way:
the same code is also written to `~/.arigami/run/pairing-code` (the file
`bin/host pair` reads/writes) — `cat ~/.arigami/run/pairing-code`.

### What was proven (Linux, full Tauri build+run, done live in this session)

`cargo tauri build` succeeded outright on the first try — `.deb`, `.rpm`, and
an `.AppImage`, all produced, zero compile errors against Tauri 2.11.5. That
alone confirms every previously-"unverified from memory" API call actually
exists with the signature used: `WebviewWindow::navigate()`,
`AppHandle::run_on_main_thread()`, `tauri_plugin_dialog`'s
`.message().title().buttons().blocking_show()` chain, `MenuItem::with_id`,
`TrayIconBuilder`, `app.default_window_icon()`, `app.path().resource_dir()`
and `.app_log_dir()`. Inspecting the built `.deb` (`dpkg -c`) also confirmed
`tauri.conf.json`'s `bundle.resources` object-map form
(`{"resources-staged": "resources-staged"}`) does exactly what it was
assumed to: the whole staged tree landed intact at
`usr/lib/Arigami/resources-staged/{arigami-server,resources/}`, sibling to
nothing else — no glob-flattening surprise. That was the second-biggest risk
in this doc and it's gone.

Then the built binary was actually **run** with a window, on this session's
own Xvfb (`:99`) display — isolated `ARIGAMI_DIR`/`ARIGAMI_WA_DATA_DIR` under
`/tmp`, `ARIGAMI_WA_AUTOSTART=0`, and a temporary non-3099 port patched into
the `ARIGAMI_PORT` const for the duration of the test only (reverted before
every commit — grep `const ARIGAMI_PORT` before trusting any build artifact
left lying around). What ran clean, end to end, screenshotted for evidence:

- The boot page appeared (then `splash-dist/index.html`, now
  `shell-dist/index.html`), the background poll — then
  `config_endpoint_ready()`, now `wait_local_ready()`/`probe()` — detected
  the sidecar, and `navigate()` swapped the window to the real
  `/__host/` origin — landing on the actual cockpit **Sign-in** screen,
  fully styled, logo and all. This is decisions #1 and #4 working exactly as
  designed, not just compiling.
- The pairing code appeared in `~/.arigami/run/pairing-code` as expected.
- Killing the sidecar's pid directly (simulating a crash) made
  `run_supervisor()` respawn it with a new pid automatically and the port
  came back — decision #3's respawn contract, live.
- Killing the *sidecar* with `SIGTERM` and, separately, the *whole app*'s
  own pid with `SIGTERM`, both ended in a clean exit — confirming
  `terminate()`'s `libc::kill(pid, SIGTERM)` (not `Child::kill()`, which is
  `SIGKILL` on Unix and would skip `killAll()` entirely) reaches the handler
  it's meant to.

**Two real bugs turned up from running it that reading the code never would
have caught, both fixed and re-verified live:**

1. `tauri.conf.json` declared the main window in `app.windows` (config
   auto-creates it) *and* `main.rs`'s `setup()` also built it via
   `WebviewWindowBuilder`. Tauri auto-creates configured windows before
   `setup()` runs, so the second creation panicked: `"a webview with label
   'main' already exists"`, and the app never got past that on the very
   first launch. Fixed by emptying `app.windows` in `tauri.conf.json` —
   `main.rs`'s builder is now the only place "main" is created.
2. Sending `SIGTERM` straight to the app's own pid (not through the tray —
   e.g. a real `kill`, or a system shutdown) had no handler at all: Rust's
   default disposition just terminates the process immediately, so
   `run_supervisor()`'s cleanup never ran and `arigami-server` was left
   **orphaned**, listening on its port with no parent. First fix attempt
   (a plain `ctrlc` dependency) still didn't work — live-tested and still
   orphaned the sidecar — because the `ctrlc` crate only catches `SIGINT` by
   default; `SIGTERM` needs its `termination` Cargo feature explicitly
   enabled. With that feature on, re-tested the identical scenario and the
   sidecar now dies cleanly with the app every time.

Not run: the tray icon itself. `libayatana-appindicator` needs a session
D-Bus / StatusNotifierWatcher that this session's bare Xvfb doesn't have
(`Unable to get the session bus: … dbus-launch`), so the "Open"/"Quit" menu
items were never actually clicked through a live UI — only their shared
`quit_now()` logic, exercised via the direct-signal tests above. This is a
property of this *sandbox*, not the code — macOS's tray (`NSStatusItem`) has
no D-Bus dependency at all, so this specific gap is expected to not apply
there, but that itself is unverified since no macOS build exists.

### What the machine switcher was proven to do (Linux, live, with screenshots)

The switcher landed as a WIP commit that **had never been compiled or run** —
a previous worker was killed mid-task. It compiled clean on the first
`cargo check` (zero errors, zero warnings), and then running it found six
real bugs in a row. Everything below was exercised on this session's Xvfb
(`:99`, which does have a window manager and a tint2 panel), against a
deliberately isolated setup: `ARIGAMI_DESKTOP_PORT=39481` (never 3099),
`ARIGAMI_DIR`/`ARIGAMI_WA_DATA_DIR`/`XDG_CONFIG_HOME`/`XDG_DATA_HOME` all
under `/tmp`, `ARIGAMI_WA_AUTOSTART=0`. The "remote" machines were a second
Arigami server on another port plus small Python stand-ins.

- **Boot on the remembered machine.** Config read, machine restored, title
  reads `Arigami — <name> (remote)`. The local sidecar did **not** start,
  because the remembered machine was remote.
- **Every switch path**: the picker's "Switch", a menu item, the `Ctrl+Alt+N`
  accelerator, and a chip on the error page. All four navigate the window
  and retitle it.
- **`Ctrl+Shift+M`** opens the machines window; `Escape` closes it.
- **The sidecar follows the window.** Switch away from "this computer" and
  the local port stops listening; switch back and it answers again. Opening
  the local machine in a *second* window started it while the first window
  stayed on the remote; closing that second window stopped it again.
- **An unreachable machine** ends on the shell's error page with the host
  named and one-click chips onto the other machines — screenshotted.
- **The main window's [x] hides** (app and sidecar live on); an extra
  `machine-N` window's [x] closes for real. Neither had ever been clicked
  before this session.
- **The quit dialog** (`tauri_plugin_dialog`'s `.blocking_show()`) really
  does return `bool`: Cancel kept the app running, OK exited it and took the
  local sidecar with it. Also never exercised before.
- **`SIGTERM` to the app's own pid** exits cleanly with no orphaned sidecar.
- **Cookies**: set on machine A, still sent to A after switching to B and
  back, and still sent after a full app restart (they persist in
  `$XDG_DATA_HOME/io.arigami.desktop/cookies`). `Secure` cookies were
  dropped on http, as expected.
- Evidence gallery (screenshots of all of the above):
  `/__artifacts/keP6lAedbX4/`.
- **Decision #2 holds, measured.** A stand-in machine whose page tries
  `invoke('shell_status')` got `"shell_status not allowed. Plugin not
  found"`. Stronger than assumed: this stayed true even after temporarily
  adding an explicit `remote: {urls: [...]}` grant for that origin to
  `capabilities/default.json` (reverted immediately) — app commands are not
  reachable from a machine origin under any capability we could write.

**Six bugs found by running it, all fixed and re-verified:**

1. **A guaranteed startup deadlock.** `shell.cfg.lock().unwrap().last.clone()
   .and_then(|id| shell.find(&id))` keeps the temporary `MutexGuard` alive
   for the whole statement, and `find()` → `all_machines()` locks `cfg`
   again. `std::sync::Mutex` is not reentrant, so `setup()` hung on a futex
   forever — no window, no tray, no server. It only triggers when `last` is
   present, i.e. **every launch after the first**, since `save()` always
   writes it. Located with `strace`; nothing about reading the code suggests
   it.
2. **The badge's `⚠ IPC` warning was a permanent false alarm.** It tested for
   the presence of `window.__TAURI__`, but Tauri injects
   `__TAURI_INTERNALS__` (and, with `withGlobalTauri`, `__TAURI__`) into
   *every* page in the webview, machine origins included. The warning fired
   on every machine page, which is exactly as useless as never firing. It
   now probes a real `invoke()` and warns only if it resolves.
3. **Switching while the main window was hidden was a dead end.** The [x]
   hides the main window; a switch from the picker then changed the machine
   and showed nothing. `go_to_machine()` now shows/unminimizes/focuses its
   window, and picking the machine a window is already on surfaces it
   instead of being a silent no-op.
4. **`Ctrl+Q` opened two stacked quit dialogs**, every time. The app-level
   `on_menu_event` and the tray's own `on_menu_event` are both global
   listeners for the same menu ids, so `handle_menu` ran twice. Both
   registrations are kept (the tray path can't be exercised here to prove
   which is redundant) and the destructive action was made idempotent with
   an `asking_quit` flag.
5. **The whole app menu was rebuilt on every window focus change** — on
   macOS that is the application menu, rebuilt under the user's cursor, and
   on Linux it emitted five `Gtk-WARNING … no accelerator installed` lines
   per switch. `refresh_chrome()` now compares a signature first and skips
   when nothing changed; the warnings went to zero.
6. `desktop/src-tauri/icons/` is gitignored, so a fresh clone cannot build
   until `cargo tauri icon` has been run — and `tauri-build` also refuses to
   build at all while `resources-staged/` is missing. Neither is a code bug,
   but both stop a first build dead; see "Build steps".

### What's still unverified — narrower now, but read before debugging

- **macOS itself was never built.** Every "proven" item above ran on Linux.
  Tauri is designed to abstract window/tray/dialog/resource-path handling
  per platform, and the Linux run is strong evidence the *design* is sound,
  but macOS-specific bundling (a real `.app`, `Info.plist`, `.icns`
  rendering, `NSStatusItem` tray behavior) has zero direct evidence.
- **No real https / Tailscale machine was ever reached.** Every "remote" in
  testing was plain http on loopback. So three things are untested end to
  end: the webview loading a `tailscale serve` origin at all (certificate
  handling included), the auth cookie actually arriving **with** `Secure`
  over that origin (only the negative — `Secure` dropped on http — was
  measured), and `probe()`'s https branch in practice. That branch is also
  weaker by design: there is no TLS client in this shell, so for an https
  origin "the port accepts a TCP connection" is the whole check — a
  reachable host running something else entirely would still be navigated
  to, and the shell page would then show whatever that host serves.
- **The tray icon itself was still never clicked.** The menu *event* path
  it shares with the app menu (`on_menu_event` → `handle_menu` →
  `confirm_and_quit` → the dialog → `quit_now`) is now fully exercised from
  the app menu, and `.blocking_show()`'s `bool` return was watched from real
  Cancel and OK clicks — but no Linux tray widget ever appeared to click, so
  `TrayIconBuilder`'s own menu and tooltip are inferred from the app menu's
  behaviour, not observed. macOS's `NSStatusItem` has no D-Bus dependency,
  so this gap is expected not to apply there; that expectation is untested.
- ~~The window's native close button was never clicked~~ — it has been now
  (there is a window manager on `:99` after all, and `wmctrl`/`xdotool` are
  installed): the main window hides, an extra `machine-N` window closes for
  real, and closing the last window on "this computer" stops the sidecar.
- **macOS code signing of the nested sidecar binary is unresearched.** For a
  local/dev `cargo tauri build` this should be a non-issue, but if this ever
  moves to Developer ID signing + notarization for distribution, an
  unsigned Mach-O binary sitting inside `Resources/` may need its own
  `codesign` pass (or `--deep`) — not looked into here.
- **Windows quit is a known, deliberate gap, not an oversight.** `terminate()`
  falls back to `taskkill /PID <pid> /T /F` on Windows — a hard kill, not a
  graceful signal `server/index.ts` has a handler for. Nobody is building or
  running the Windows target today (not even the Linux validation above
  touched it), so this trades "graceful" for "definitely no orphaned
  process" and says so plainly rather than pretending it's solved.
- **No crash-loop protection.** If the sidecar keeps failing after the first
  successful boot, `run_supervisor()` will keep respawning it every 500ms,
  forever. No backoff, no giving up. (The respawn-on-crash *mechanism itself*
  is proven above — this flags the missing backoff on top of it, not the
  respawn.)
- **The local port is 3099 by default, with no collision handling.** It is
  overridable with `ARIGAMI_DESKTOP_PORT` (added for exactly this reason: no
  test on this box may touch a live host on 3099), but a desktop app owns
  its machine, so 3099 stays the default.
- **Port 3099 collisions are still unhandled.** If something else
  on the Mac is already bound to it (e.g. a manual `bin/host start` from a
  git checkout, run at the same time), the sidecar's own `hostlock.ts` will
  refuse to bind, `wait_local_ready()` will poll for 60s and the window then
  parks on the shell's error page with a generic "didn't answer in time —
  maybe something else is holding the port?" message. There is no detection
  or message specific to that case. The *unreachable* branch itself is now
  proven (a machine that isn't there lands on that page correctly), but the
  60s local timeout specifically was never waited out — every local start in
  testing came up in well under a second.
