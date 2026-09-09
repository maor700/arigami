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

Status: **written, not built, not run**. There is no Rust toolchain on this
box, and Tauri cannot cross-compile Linux→macOS at all (needs Apple's SDK and
linker) — the brief for this task said plainly not to install `rustup` to
chase that (disk was already down to ~3.7 GB free once). Everything under
`desktop/src-tauri/` is written from memory of the Tauri v2 API, unchecked by
a compiler. What *was* proven on this box, against the real compiled binary
(see "What was proven" below), is exactly the part that doesn't need Rust to
verify: the resource layout, the readiness check's exact bytes, and the
shutdown signal.

### What's here

- `desktop/src-tauri/Cargo.toml`, `tauri.conf.json`, `build.rs`,
  `src/main.rs` — the Tauri project.
- `desktop/src-tauri/capabilities/default.json` — the main window's
  capability, with **no `remote` block** (see decision #2 below).
- `desktop/src-tauri/splash-dist/index.html` — the boot splash. Static HTML,
  no `<script>` at all: decision #4's polling happens in Rust, not JS, so the
  splash needs zero Tauri JS APIs and therefore zero capability grants.
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
   Only the *first* boot triggers the splash→navigate dance; every later
   respawn (restart, upgrade, or a crash) is silent — the window is already
   sitting on the real URL, and that page's own reconnect logic (built for
   the ordinary browser product) is what recovers the UI.
4. **A splash screen is mandatory.** The window starts on the local
   `splash-dist/index.html`; a background thread does a raw HTTP GET of
   `/__api/config` in a loop (`config_endpoint_ready()`), and only once that
   answers does `main.rs` call `WebviewWindow::navigate()` to the real URL.
   Without this, the very first paint would be the engine's own connection-
   refused error page.
5. **`ARIGAMI_ROOT` isn't set — the binary finds its resources by
   position.** `server/lib/resource-root.ts`'s compiled-binary branch expects
   `resources/` next to `process.execPath`. `desktop/build.sh` stages
   `arigami-server` and `resources/` as siblings under
   `resources-staged/`, and `tauri.conf.json` ships that whole directory
   unchanged, so `dirname(execPath)` inside the bundle already has what
   `resourceRoot()` wants with zero extra plumbing.

### Build steps (macOS)

```sh
# once, if you don't already have them:
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
cargo install tauri-cli --locked --version "^2.0"

# once, to generate real app icons from the current brand mark:
cd desktop/src-tauri
cargo tauri icon ../../web/public/icon-512.png
cd ../..

# every time server/ or web/ changes:
bash desktop/build.sh

# dev run (opens a window against the freshly staged sidecar):
cd desktop/src-tauri && cargo tauri dev

# release build (.app under desktop/src-tauri/target/release/bundle/macos/):
cd desktop/src-tauri && cargo tauri build
```

First run: the pairing code (needed once, in the cockpit's login screen) is
**not** printed to a visible terminal — the sidecar's stdout/stderr are
redirected to a log file (`~/Library/Logs/Arigami/arigami-server.log` on
macOS, via `app.path().app_log_dir()`). It's also written to
`~/.arigami/run/pairing-code` (same file `bin/host pair` reads/writes) —
that's the easier place to check: `cat ~/.arigami/run/pairing-code`.

### What was proven (this box, no Rust involved)

Ran `desktop/build.sh` for real (it needed `bun install` in the repo root and
`web/` first — this worktree, like others, ships without `node_modules/`),
producing the actual compiled `arigami-server` binary and `resources/` tree
under `desktop/src-tauri/resources-staged/`. Then, standing in for what
`main.rs` does, ran that binary *directly from that staged location* — no
`ARIGAMI_ROOT` override, so it had to find its own resources by position,
exactly like the bundled app will:

```
ARIGAMI_DIR=/tmp/... ARIGAMI_PORT=39231 ARIGAMI_WA_AUTOSTART=0 \
ARIGAMI_WA_DATA_DIR=/tmp/... ARIGAMI_SUPERVISOR=self \
  ./desktop/src-tauri/resources-staged/arigami-server
```

(isolated `ARIGAMI_DIR`/port, WhatsApp autostart off, never port 3099 or
`~/.arigami` — cleaned up after, per this task's rules.)

- **Booted clean** and served `GET /__api/config` → `200`.
- **Confirmed the exact bytes `config_endpoint_ready()` sends and checks**:
  a raw `GET /__api/config HTTP/1.1\r\nHost: ...\r\nConnection: close\r\n\r\n`
  over a bare TCP socket gets back a response starting with literally
  `HTTP/1.1 200 OK` — so the hand-rolled HTTP client in `main.rs` (no crate,
  one request ever) is checking for the right string.
- **`kill -TERM <pid>` made it exit cleanly** — confirms `terminate()`'s use
  of `libc::kill(pid, SIGTERM)` (not `Child::kill()`, which is `SIGKILL` on
  Unix and would skip `server/index.ts`'s `shutdown()`/`killAll()` entirely)
  reaches the handler it's meant to.

That covers every byte in `main.rs` that talks to the sidecar over a
filesystem path, a socket, or a signal. It does **not** cover a single line
of actual Tauri/Rust API usage — window creation, the tray, `navigate()`,
the dialog plugin — because none of that runs without a macOS build.

### What's unverified — read this before debugging a build failure

- **Every Tauri API call in `main.rs` is unverified**, not even
  `cargo check`'d. The highest-risk ones, roughly in order of how likely they
  are to have moved or need a version bump:
  - `WebviewWindow::navigate(url)` — added at some point in the Tauri 2.x
    line specifically for "start on a local page, jump to a remote one"
    apps like this one. If `cargo tauri build` says it doesn't exist, bump
    the `tauri` version pin in `Cargo.toml` before assuming the design is
    wrong.
  - `AppHandle::run_on_main_thread()`, `tauri_plugin_dialog`'s builder chain
    (`.message().title().buttons().blocking_show()`), `MenuItem::with_id`,
    `TrayIconBuilder`, `app.default_window_icon()`,
    `app.path().resource_dir()` / `.app_log_dir()`.
- **`tauri.conf.json`'s `bundle.resources` object-map form**
  (`{"resources-staged": "resources-staged"}`) is assumed to copy the whole
  directory tree unchanged into the bundle's resource dir. If the app builds
  but the sidecar can't find its binary, check what actually landed under
  the bundle's `Resources/` — the documented fallback is the array/glob form
  (`"resources": ["resources-staged/**/*"]`).
- **The icon files don't exist yet.** `tauri.conf.json` points at
  `icons/32x32.png`, `icons/128x128.png`, `icons/128x128@2x.png`,
  `icons/icon.icns`, `icons/icon.ico` — none of which are in the repo. The
  build steps above run `cargo tauri icon` first; skipping that step is the
  single most likely first-command failure.
- **macOS code signing of the nested sidecar binary is unresearched.** For a
  local/dev `cargo tauri build` this should be a non-issue, but if this ever
  moves to Developer ID signing + notarization for distribution, an
  unsigned Mach-O binary sitting inside `Resources/` may need its own
  `codesign` pass (or `--deep`) — not looked into here.
- **Windows quit is a known, deliberate gap, not an oversight.** `terminate()`
  falls back to `taskkill /PID <pid> /T /F` on Windows — a hard kill, not the
  graceful SIGTERM path `server/index.ts` listens for (`SIGBREAK` needs a
  console process group + `GenerateConsoleCtrlEvent`, which needs Win32 FFI
  I have no way to check here). Given nobody is building or running the
  Windows target today, this trades "graceful" for "definitely no orphaned
  process" and says so plainly rather than pretending it's solved.
- **No crash-loop protection.** If the sidecar keeps failing after the first
  successful boot, `run_supervisor()` will keep respawning it every 500ms,
  forever. No backoff, no giving up.
- **Port 3099 is hardcoded, with no collision handling.** If something else
  on the Mac is already bound to it (e.g. a manual `bin/host start` from a
  git checkout, run at the same time), the sidecar's own `hostlock.ts` will
  refuse to bind, the splash will poll for 45s, then show a generic "didn't
  answer in time" dialog — there's no detection or message specific to that
  case.
