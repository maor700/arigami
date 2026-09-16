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

Status: **built and run for real on Linux and on Windows 11 — macOS itself
still isn't built**. Tauri cannot cross-compile to macOS at all (needs Apple's
SDK and linker), so a macOS `.app` has never come out of this box and can't.
The Windows pass (MSI + NSIS installers, GUI driven live) is written up in
"What was proven (Windows 11)" below, including the three Windows-only bugs it
turned up.

On the Linux side: after the human explicitly asked for at least a Linux
build, Rust *was* installed here (rustup + the Linux system deps:
webkit2gtk-4.1, libgtk-3, libayatana-appindicator3, librsvg2, all -dev
packages) and the full
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
  — nothing new, just aimed at a different output directory. Runs unmodified
  on macOS, Linux and Windows (Git Bash): `bun build --compile` targets the
  host, so on Windows it stages `arigami-server.exe`, which is exactly the
  name `resolve_server_binary()` looks for there.

### Seven decisions (do not change these without re-reading the "why")

1. **The window loads `http://127.0.0.1:<port>/__host/` via an ordinary
   external URL, not a bundled `frontendDist` app.** (The port is
   `arigami_port()` — 4099 by default, see decision #5.)
   `web/src/lib/hostUrl.js` builds every iframe/tab `src` from
   `window.location.origin`, and the auth cookie is `SameSite=Lax`. If the
   window's origin were anything other than
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
5. **The app is its own INSTANCE: its own `ARIGAMI_DIR` and its own port.**
   It originally hardcoded :3099 and inherited `~/.arigami`, i.e. the same
   identity as any `bin/host` the user runs — which `hostlock.ts` correctly
   refuses, so the app simply could not start on a machine where the host was
   already running. That is not fixable by changing the port alone:
   `judgeHostInfo()` *does* let a differing port through, but then warns
   "two hosts sharing one dir share state.json/chat and is unsupported".
   Sharing state is the hazard; the port is only how it surfaced.

   So the sidecar is spawned with `ARIGAMI_DIR=<home>/.arigami-desktop` and
   `ARIGAMI_PORT=4099`. That pairing is not invented here — it is the
   convention the rest of the system already follows: `server/lib/config.ts`
   says a non-default `ARIGAMI_DIR` "also shifts every default port range
   (+1000) so a second instance started with no config at all doesn't fight
   the first one for ports", and `bin/host` encodes the same rule
   (`[ "$DIR" != "$HOME/.arigami" ] && PORT=4099`). Both are overridable via
   the `ARIGAMI_DIR` / `ARIGAMI_PORT` env vars.

   **The consequence is a product decision, not just a technical one:** the
   desktop app is a *second, independent* Arigami. It has its own sessions,
   its own memory, its own pairing code — the cockpit you use in a browser on
   :3099 is not the one in this window. If what you want instead is one
   Arigami reachable from both, the app should *attach* to a running host
   rather than spawn a sidecar (skip the spawn, skip the supervisor, and do
   NOT terminate on quit a host it did not start). That alternative is not
   implemented.

   **:4099 is the preferred port, with a fallback range behind it.** This
   used to be a single fixed port, and the reasoning was sound at the time:
   auto-probing would let a second launch start a second host sharing
   `~/.arigami-desktop` on another port — the unsupported shared-state case
   above, which `judgeHostInfo()` only *warns* about once the ports differ.
   The fixed port was what made the second launch refuse.

   `tauri-plugin-single-instance` now refuses the second launch outright (it
   raises the running window instead), so that job no longer belongs to the
   port — and a fixed port only costs us: a foreign process holding :4099, an
   unrelated app or a stale host from a crashed session, left this one unable
   to start at all. So the order is now: an explicit `ARIGAMI_PORT` (a pin,
   honoured even if occupied, so a deliberate override still produces the
   sidecar's own bind error rather than being silently moved), then the port
   this app used last time, then :4099, then the first free port in
   **3300–4000** (`ARIGAMI_DESKTOP_PORT_RANGE=low-high` to change it).

   The last-used port outranks :4099 on purpose. The auth cookie is per
   ORIGIN, so a port that moves between launches is a silent sign-out; once
   this app has fallen back to, say, :3417 it stays there even after :4099
   frees up. The choice is remembered in
   `<ARIGAMI_DIR>/run/desktop-port`.

   Occupancy is probed with `connect()`, not by trying to `bind()`. The bind
   test is the obvious one and it is wrong here: a listener on the IPv6
   wildcard `[::]` does not stop a bind to `127.0.0.1`, so it reported an
   occupied port as free and handed the sidecar a port it could never have.
   Both families are checked.

   **"The port answered" is not "the port is ours."** The window is only
   pointed at the local machine once `/__api/config` reports back the
   `ARIGAMI_INSTANCE_ID` this process generated and handed its own sidecar
   (`local_is_ours()`). `local_pid` being `Some` was the earlier signal and it
   is a proxy, not proof: the supervisor's child can be alive and yet have
   lost the bind — hostlock refused, it is on its way out — while a foreign
   Arigami holds the port and answers every probe. The id is not a
   credential; it is only ever compared against the value this process
   generated, which is why echoing it on a public route costs nothing.

   That refusal has to be detected BEFORE the first spawn, and
   `run_supervisor()` now does exactly that: if `config_endpoint_ready()`
   answers while we hold no child of our own, the port is not ours, and the
   window parks on the shell page with that message. (On the Windows branch
   this quit the whole app; under the machine-switcher it must not — another
   window may be sitting on a remote machine that works fine — so it goes
   through `local_error`, which `wait_local_ready()` already watches.) Skipping this shipped a bug — `wait_for_ready()` only
   asks "does the port answer", so a second copy would watch hostlock.ts
   refuse its own sidecar, see the FIRST copy's host answering, mint a handoff
   token with its own per-run secret, send it to a host holding a different
   secret, and land the user on **"Sign-in failed"**. (The earlier auth-off
   build hid the same collision by silently showing the other instance's
   cockpit.) Verified live: with a real app on :4099, a second copy shows the
   port-taken dialog in ~0.1s and spawns nothing at all.

   *Verified live on Windows:* with a real `bin/host` serving :3099, the app
   booted its own sidecar on :4099 against `~/.arigami-desktop`, showed its
   own first-run pairing screen, and left the :3099 host untouched.

6. **No pairing code on this machine — without disarming auth for everyone.**
   Pairing exists to stop a stranger on the network reaching the host, and
   docs/AUTH.md states the premise: "possession of the code == possession of
   the host's filesystem". Whoever double-clicked the app already has the
   filesystem, so the code proves nothing *here*. It is also physically
   unreachable — it is printed next to the listen line and written to
   `run/pairing-code`, and an installed `.exe`/`.msi` gives the user no
   terminal. Pairing was a dead end at the first screen. That was a real bug
   report, not a hypothetical.

   **`ARIGAMI_AUTH=off` was tried first and is the WRONG trade.** The gate has
   no notion of a request's origin — `auth.ts`'s `principal()` returns
   `{kind:'off'}` for *every* request — so it admits any second device that can
   reach the port too. The loopback bind is not the protection it appears to
   be: the supported way to reach a host remotely is `tailscale serve`, which
   forwards **to** loopback, so `validateAuthBind()` still passes while the
   whole tailnet gets in unauthenticated. `server/index.ts:382` warns exactly
   this, and AUTH.md §4 says it in as many words. The user's own question
   ("and on a second device I *do* get the pairing screen?") is what surfaced
   it; the answer under auth-off was no, in the worst way.

   **What it does instead:** auth stays at its default (`pairing`), and only
   this window is let in — via `server/handoff.ts`, which already exists for
   the same problem in a different shape ("the code it would ask for lives
   inside a pod the user cannot open a shell on"). `main.rs` generates a random
   32-byte secret per app run, passes it to the sidecar as
   `ARIGAMI_HANDOFF_SECRET`, mints a token in that module's exact wire format —
   `base64url(JSON) + "." + base64url(HMAC-SHA256(secret, payloadB64))`, no-pad
   base64url to match Node's — and navigates the window to
   `/__api/auth/handoff?t=…` instead of `/__host/`. That endpoint sets the
   session cookie and 302s to the cockpit.

   The security properties are handoff.ts's, not ones invented here: the token
   is single-use (`jti`, persisted so a restart cannot re-open a spent one),
   the verifier caps its life at 10 minutes regardless of what the minter asked
   for, and the whole mechanism is inert without the secret. The secret never
   touches disk — the only two parties that need it are the app and the child
   it spawned — and if the OS gives us no randomness we set nothing and the
   user gets the ordinary pairing screen rather than a weak key.

   **It is not first-boot-only.** It used to be, and that stranded people:
   a full import replaces `users.json` *and* `sessions.json` and restarts the
   host, so the window's cookie dies with no navigation left to hang a
   handoff on, and the user lands on a pairing screen whose code an installed
   app gives no way to read (`announcePairing()` does not even print one once
   an imported admin exists). Reported live. The login screen now asks the
   shell itself: `web/src/lib/shell.js`'s `shellSignInOnce()` navigates to
   `SIGNIN_SENTINEL_PATH`, `on_navigation` cancels it and re-navigates that
   window to a freshly minted token. Only a window whose machine is `local`
   may ask — `canSignIn` in the payload — because a remote host holds a
   different secret. The loop guard is a `sessionStorage` key **cleared by
   `loadAuth()` the moment a session exists**, not a per-tab latch: the first
   version of this fix latched per tab, `sessionStorage` survives reloads, and
   a SECOND import in the same window therefore skipped the automatic sign-in
   and dropped the user back on the pairing screen — reported live, after the
   fix. Scoped to a failure instead, a handoff that cannot succeed still gets
   exactly one automatic try and then a "Sign in as this computer" button.

   *Verified live on macOS*, twice back to back in one window — the case
   that broke: deleting the window's user out of `users.json` (what an import
   effectively does) invalidated its session; within 20s each time the
   cockpit hit 401, rendered the login screen and signed itself back in, with
   `handoff-used.json` going 1 → 2 → 3. No code typed.

   Note this makes `main.rs` a **third implementation** of that wire format,
   alongside `server/handoff.ts` and `control-plane/src/handoff.ts`, which
   `test/handoff-contract.test.ts` cross-checks against each other. The Rust
   minter is not in that test; it was validated end-to-end instead (below), so
   a format drift would break the desktop sign-in without failing that suite.

   *Verified live on Windows*, against a wiped `~/.arigami-desktop`:
   `authMode` stayed `pairing`; `/__api/auth/me` with no cookie returned
   **401**, i.e. a second device still gets the pairing screen (code present in
   `run/pairing-code`); and the app window nonetheless landed **inside the
   cockpit** with no typing — `users.json` gained `<user>@desktop.local` as
   admin and `handoff-used.json` recorded the token as spent.

7. **`ARIGAMI_ROOT` isn't set — the binary finds its resources by
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
  heavy on the wrong one. The window title (`Arigami — <name> (local|remote)`),
  a menu titled `Machine: <name>`, the tray tooltip, and a coloured strip the
  shell paints across the top of the page — all live at once, all per machine
  (local keeps the brand yellow). The strip follows the same rule as the chip
  below: **with one machine it is not drawn at all**. There is nothing to tell
  apart, so a permanent coloured line across the window is just chrome.
- **The switcher itself is the cockpit's, not the shell's.** It used to be a
  filled brand-coloured pill the shell injected at bottom-left, which is
  exactly where `web/src/components/Rail.jsx` keeps the rail footer's
  buttons — it hid them. It now renders inside the cockpit's own brand row,
  end-justified against the wordmark, as a quiet bordered chip: a dot in the
  machine's colour and the name in `text-fgdim`. The strip is the loud
  signal; the chip is its label.

  **It does not exist until there is a second machine.** With only "this
  computer" there is nothing to switch to, and a control that never does
  anything is worse than none. The way to get a second one is
  **Settings › Host › Machines**, which opens the same machines window — that
  section is the entry point, and it too renders only inside the shell.

  The channel is a global, not IPC. On page load (and again on every
  `refresh_chrome`, so the chip appears the moment a machine is added, with
  no reload) the shell evaluates a script that sets `window.__arigami`
  (`{machines, current, color, sentinel, openPicker}`) and fires an
  `arigami:shell` event; `web/src/lib/shell.js` is the whole cockpit-side
  surface. Outside the shell that global never exists, so the browser
  product is untouched. `openPicker()` navigates to `sentinel`
  (`MACHINES_SENTINEL_PATH`), which `on_navigation` recognises and cancels —
  decision #2 stands, the origin still gets no `invoke()`.

  One trap, hit live: `refresh_chrome` re-evaluates the payload per window,
  and doing that while holding the `windows` lock deadlocks the main thread
  (`machine_of()` takes the same non-reentrant `Mutex`). The app came up with
  no window and no sidecar at all. Snapshot the labels first.
- **A machine has to BE an Arigami.** `add_machine()` used to store any
  address at all, so a typo became a "machine" the window would navigate to.
  It now fetches `<origin>/__api/config` first and requires the `version` and
  `authMode` fields — that route is public, so no cookie is needed. http goes
  over the raw `TcpStream` already in this file; https shells out to `curl`
  (macOS and Windows 10+ both ship it) because there is no TLS client here,
  and a missing `curl` refuses the add rather than waving it through. The
  command is `async` so the up-to-6s check runs off the main thread — a sync
  command would freeze every window while the dialog waited. Covered by
  `cargo test` in `main.rs` (accept / not-Arigami / 404 / nothing listening);
  the https-via-curl path is not covered there.
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
machine>`. The title bar, the strip and the in-page chip are per window and
stay correct, so the indicator is never wrong — just doubled. On macOS there is
only one menu bar to begin with and it belongs to the focused window, which
is exactly the intended behaviour, so this is Linux-only and cosmetic.

#### Known limitation: cookies ignore the port

Cookies are scoped by **host**, not by origin — so two machines on the *same
hostname, different ports* share one cookie jar and will log each other out.
Confirmed live (a machine on `127.0.0.1:39484` was handed the cookie set by
`127.0.0.1:39485`). In real use the machines are different hosts (localhost
vs. a Tailscale name), so this doesn't bite; it is listed because it is
invisible if you hit it.

### A full import and the running process

`importFull()` swaps the whole `$ARIGAMI_DIR` on disk and asks host-control
for a restart. The process doing the swapping is still up, and it still holds
the PRE-import world in memory — so on the way out `shutdown()`'s very first
call, `flushState()`, wrote the old session list straight over the imported
`state.json`. Everything that lives as plain files (`agents/`, `chat/`,
`uploads/`) survived, and the session list did not. It surfaced as **"the
import brought only the agents, not the sessions"**, which is exactly what it
looks like from the cockpit.

`server/state.ts`'s `freezeState()` (and `triggers.ts`'s `freezeTriggers()`)
are the guard, called from `handleHostImport` the moment `importFull` returns:
same shape as the existing `refusedTooNew` flag — once the bytes on disk are
not ours to own, stop writing them, debounced `persist()` included.

Proven both ways with two real hosts (an export from A imported into B, then B
shut down): without the freeze B's `state.json` came back as B's own session,
with it the imported ones survived. `test/state-migrations.test.ts` keeps both
directions.

### Build steps (macOS)

Windows is the same three commands with different prerequisites — install Rust
via [rustup](https://rustup.rs) (the `x86_64-pc-windows-msvc` default host,
which needs the **VS Build Tools** C++ workload plus a Windows SDK) and run
`bash desktop/build.sh` from Git Bash; `cargo tauri build` then writes an MSI
to `target/release/bundle/msi/` and an NSIS installer to
`target/release/bundle/nsis/`. The `cargo tauri icon` step below is **not
optional there**: `icons/` is gitignored, and a Windows bundle cannot be built
without the `icon.ico` it generates.

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

First run: **you are not asked for a pairing code** — the window signs itself
in with a handoff token (decision #6) and opens straight on the cockpit. Auth
itself stays on, so a second device still gets the pairing screen; its code is
in `$ARIGAMI_DIR/run/pairing-code` as always. This paragraph used to explain
where to dig that code out of, and that advice was the bug: it assumed whoever
runs the app can reach a terminal or a `cat`, which is false for anyone who
installed from the `.exe`/`.msi`.

The sidecar's stdout/stderr still go to a log file via
`app.path().app_log_dir()` — that is the place to look when it will not start.
Verified live: `~/.local/share/io.arigami.desktop/logs/arigami-server.log` on
Linux and `%LOCALAPPDATA%\io.arigami.desktop\logs\arigami-server.log` on
Windows (both keyed by the bundle *identifier*, not "Arigami"). macOS's exact
path is still unverified, so don't take "~/Library/Logs/Arigami/" on faith;
`find ~/Library/Logs -iname arigami-server.log` if it isn't where you expect.

### The same thing, in CI

`.github/workflows/desktop.yml` runs exactly the sequence above — icons,
`desktop/build.sh`, `tauri build` — on four runners (`ubuntu-22.04` for Linux
x64, `windows-latest`, `macos-latest` for arm64, `macos-15-intel` for Intel —
`macos-13`, the old Intel label, is retired) and attaches the resulting
installers to the GitHub Release for the tag. It uses the npm
`@tauri-apps/cli` (via `bun x`) rather than `cargo install tauri-cli`, which
would compile the CLI from source on every runner.

It is deliberately not part of every release: on a private repo on the Free
plan macOS minutes bill ×10 and Windows ×2, so a full matrix is roughly
135 billed minutes (measured). A tag you push by hand builds them; an automated
release only does when the `DESKTOP_INSTALLERS` repository variable is `true`.
**Run workflow** takes a `targets` input (`all`, or a comma list of
`linux-x64`, `windows-x64`, `macos-arm64`, `macos-x64`) so one platform can be
built alone. docs/RELEASING.md has the full table.

To exercise the workflow from a branch (GitHub only offers **Run workflow**
for files on the default branch), push a CI-test tag: `v0.0.0-ci-test` builds
everything, `v0.0.0-ci-linux-x64` one line, `v0.0.0-ci-linux-x64+windows-x64`
two. Such a tag skips the version gate, is ignored by release.yml (no images),
and lands its files on a pre-release titled "delete me". Delete the tag and
the pre-release when done (`gh release delete <tag> --cleanup-tag --yes`).

#### Signing — wired, off until the secrets exist

Every platform builds unsigned until these repository secrets exist; the
workflow turns signing on by itself when they do (no edit needed):

| Secret | What |
| --- | --- |
| `APPLE_CERTIFICATE` | the Developer ID Application certificate, `.p12` exported from Keychain, base64 |
| `APPLE_CERTIFICATE_PASSWORD` | the `.p12`'s password |
| `APPLE_SIGNING_IDENTITY` | its name, `Developer ID Application: Name (TEAMID)` |
| `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` | Apple ID + an **app-specific** password + team id — adds notarization (all three, or none) |
| `WINDOWS_CERTIFICATE` | the code-signing `.pfx`, base64 |
| `WINDOWS_CERTIFICATE_PASSWORD` | its password |

What the workflow does with them: on macOS the certificate goes into a
throwaway keychain, the sidecar (`resources-staged/arigami-server`, a Bun
compiled binary the bundler would otherwise leave unsigned inside
`Resources/`) is signed with hardened-runtime + the JIT entitlements Bun
documents, then the Tauri bundler signs the `.app`/`.dmg` with
`APPLE_SIGNING_IDENTITY` and notarizes when the `APPLE_ID` trio is there. On
Windows the `.pfx` is imported into the runner's user store, the sidecar
`.exe` is signed with `signtool`, and the bundler signs the app + `.msi`/`.exe`
via `bundle.windows.certificateThumbprint` (passed as `--config`, timestamped
at DigiCert). Both paths are untested — nobody has the certificates yet — so
expect the first signed run to need a look. Without the secrets both
platforms warn on first launch (Gatekeeper: right-click → Open; SmartScreen:
More info → Run anyway).

### What was proven (Linux, full Tauri build+run, done live in this session)

> **Stale in parts — read with decisions #5 and #6 in mind.** This section
> records a Linux run made *before* the app became its own instance (own
> `ARIGAMI_DIR` + :4099) and before handoff sign-in replaced the pairing
> screen. The compile/bundle/respawn/signal findings below still hold; the
> specific observations about landing on the **Sign-in screen**, about the
> window using **:3099**, and about the code appearing in
> `~/.arigami/run/pairing-code` describe behaviour that no longer exists.
> Nobody has re-run Linux since those two decisions — that is the honest
> state, not a claim that it broke.

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
  *(Superseded: see decisions #5 and #6 — the app now uses its own dir and
  signs the local window in without a code.)*
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
deliberately isolated setup: `ARIGAMI_DESKTOP_PORT=39481` (never 3099; that
env var is now `ARIGAMI_PORT` — see decision #5),
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

### What was proven (Windows 11, full build+run, done live)

**The Windows target is now built and run — installers produced, GUI verified.**
`desktop/build.sh` needed no changes; `cargo tauri build` produced both an MSI
and an NSIS installer, and the app was launched and driven for real. Toolchain
used: Rust 1.93 (`x86_64-pc-windows-msvc`), VS 2022 Build Tools + Windows SDK
10.0.22621, Bun 1.3.6, `cargo-tauri` ^2 (Tauri 2.11.5). `main.rs` compiled
clean with **zero changes** — it was already correctly Windows-aware
(`arigami-server.exe`, the `taskkill` quit path).

Two prerequisites are easy to miss on a fresh clone:

- `desktop/src-tauri/icons/` is **gitignored**, so it does not exist after a
  clone, and `tauri.conf.json`'s `bundle.icon` list references it — including
  `icon.ico`, which is mandatory for a Windows bundle. Run
  `cargo tauri icon ../../web/public/icon-512.png` once, as the macOS steps
  above already say.
- `cargo install tauri-cli --locked --version "^2.0"`.

**Two real bugs blocked the Windows build; both were fixed and re-verified.**
Neither is reachable by reading the code:

1. **`node:sqlite` does not exist in Bun on Windows** (1.3.6 x64 — verified in
   every form: static import, dynamic import, `require`, and `--external` at
   compile time doesn't help either). `server/listeners-whatsapp.ts` imported
   `DatabaseSync` from it *statically*, which made that whole module — and so
   `server/listeners.ts` — unloadable. Plain `bun server/index.ts` survives
   this only by accident: `index.ts` reaches `listeners.js` through
   `import().catch()`, so the throw is swallowed and **the host boots on
   Windows with the entire listener subsystem silently disabled**. A compiled
   binary resolves its graph eagerly and died at boot instead, before ever
   listening: `error: No such built-in module: node:sqlite`. Fixed by
   resolving `node:sqlite` on first use behind a `try`/`catch` (the same lazy
   `require(...) as typeof import(...)` idiom as `server/lib/chrome-cdp.ts:58`),
   so the module always loads, listeners work on Windows, and only the
   WhatsApp-specific calls fail — with a message that says why.
2. **`isCompiledBinary()`'s virtual-filesystem marker is platform-specific.**
   It tested for `/$bunfs/`, which is the Linux/macOS spelling. On Windows a
   compiled Bun binary reports
   `import.meta.url = file:///B:/%7EBUN/root/<binary>` (and
   `import.meta.path = B:\~BUN
oot\<binary>`), so detection returned false,
   `resourceRoot()` took the repo-checkout fallback, and the sidecar resolved
   its root to a path *inside* the virtual filesystem. The symptom was not a
   crash: it served the "UI not built yet" placeholder at version `0.0.0`,
   with `/__ext-sdk.js` 404. `server/lib/resource-root.ts` now matches both
   markers.

A third Windows-only defect turned up from running the shipped sidecar, fixed
the same way:

3. **Directory symlinks need privilege on Windows.**
   `fs.symlinkSync(target, link, 'dir')` requires
   `SeCreateSymbolicLinkPrivilege` — an elevated process or Developer Mode —
   so an ordinary run got
   `EPERM: operation not permitted, symlink '...user\skills' -> '...skills'`
   and left `$ARIGAMI_DIR/skills` and `user/skills` as two unrelated real
   directories. All five call sites (`server/extensions.ts` ×4,
   `server/skills.ts` ×1) now go through `linkDir()` in
   `server/lib/platform.ts`, which uses an NTFS **junction** on Windows: same
   semantics for directories, no privilege needed, and Node still reports it
   as a symlink (`lstat().isSymbolicLink()` true, `readlinkSync()` resolves),
   so every existing `isSymlink()`/readlink check keeps working untouched —
   verified directly. This took `test/extensions.test.ts` on Windows from
   4 failures to 2; the 2 that remain are Windows artifacts in the test
   fixtures themselves (one asserts POSIX mode `0600`, which reports `666`;
   the other compares a `path.join()` result against a hardcoded
   `user/skills/...` forward-slash string).

**What ran clean, end to end** — isolated `ARIGAMI_DIR`, and for the GUI a
temporary non-3099 port patched into the `ARIGAMI_PORT` const for the duration
of the test only (reverted, `main.rs` byte-identical to HEAD afterwards; grep
`const ARIGAMI_PORT` before trusting any build artifact left lying around):

- `cargo tauri build` → `Arigami_0.1.0_x64_en-US.msi` (44.5 MB) and
  `Arigami_0.1.0_x64-setup.exe` (29.7 MB), plus a 9.3 MB unbundled shell.
- The MSI payload was extracted with `msiexec /a` (an administrative install —
  it unpacks without registering anything) and the layout is intact:
  `Arigami/arigami-desktop.exe` beside
  `Arigami/resources-staged/{arigami-server.exe, resources/}`. This is the
  Windows counterpart of the `dpkg -c` check above, and it confirms the same
  thing: `bundle.resources`' object-map form ships the tree unflattened.
- **The sidecar shipped inside the MSI**, run from that installed layout,
  served `/__health` `{"ok":true,...}`, `/__api/config` at version `0.1.0`
  (from the bundled `VERSION`, i.e. bug 2 really is fixed), the real cockpit
  HTML from the bundled `web/dist`, and `/__ext-sdk.js` 200.
- The `--mcp` re-exec dispatch works on Windows: `--mcp host` starts and stays
  alive on stdio, `--mcp policy` exits immediately per its own guard.
- **The GUI**: the window opened titled "Arigami" with the app icon, the
  splash's Rust-side poll detected the sidecar, and `navigate()` swapped the
  window to the real origin — landing on the actual cockpit **sign-in** screen,
  fully styled, logo and Hebrew RTL correct. Decisions #1 and #4, live on
  Windows.
- **Decision #3's respawn**: killing the sidecar's pid directly made
  `run_supervisor()` respawn it with a new pid and the port came back, with the
  app still alive.
- **The window's close button — fired live for the first time on any
  platform.** `WindowEvent::CloseRequested` hides rather than quits: after a
  `WM_CLOSE`, `IsWindowVisible` went false while the app process, the sidecar
  and the port all stayed up. (The Linux run explicitly could not test this.)

Still not exercised on Windows: the **tray menu** (same as Linux — the
`on_menu_event` → `confirm_and_quit` → dialog → `quit_now` path, and the
dialog plugin's `.blocking_show()` return value, are still assumptions), and
`wait_for_ready()`'s 45s-timeout branch with its `show_fatal_and_quit()`
dialog. And see the orphan finding in the next section — hard-killing the app
does leave the sidecar behind.

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
- **macOS code signing of the nested sidecar binary is wired, not proven.**
  For a local/dev `cargo tauri build` it is a non-issue. For Developer ID
  signing + notarization, an unsigned Mach-O inside `Resources/` fails
  notarization, so `.github/workflows/desktop.yml`'s "sign the sidecar" step
  codesigns it (hardened runtime + Bun's JIT entitlements) before the bundler
  signs the `.app` — see "Signing" above. That step has never run for real:
  no certificate exists yet.
- **Orphaned sidecars on quit — fixed, in two layers.** `quit_now()` only
  ever covered the app's *own* exits (the menu item, the tray, a signal
  through `ctrlc`). macOS's Dock → Quit and anything else that leaves through
  the event loop never touched it, so the sidecar kept running, reparented to
  launchd, still holding :4099 — which then trips the port guard on the next
  launch, leaving an app that will not start until someone finds the stray
  process by hand. Seen three times on macOS before it was chased down.
  1. `RunEvent::Exit` in `main()` is the choke point every ordinary exit
     passes through; it SIGTERMs the child and gives `shutdown()`/`killAll()`
     600ms. *Verified*: `tell application "Arigami" to quit` — sidecar gone in
     1s.
  2. Nothing in the shell can cover Force Quit, so the sidecar watches from
     its own side: with `ARIGAMI_SUPERVISOR=self` on a Unix host,
     `server/index.ts` polls `process.ppid` every 2s and runs its normal
     `shutdown()` the moment the parent is gone. *Verified*: `kill -9` on the
     app — the sidecar logged "the desktop shell (pid …) is gone — shutting
     down rather than orphaning" and exited 2s later, port free.

  Windows is not covered by layer 2 (no reparent-to-1 convention); the job
  object below is still the answer there.
- **Windows quit is a real gap, now measured.** `terminate()` falls back to
  `taskkill /PID <pid> /T /F` on Windows — a hard kill, not a graceful signal
  `server/index.ts` has a handler for. That trade ("graceful" for "no orphan")
  holds only when the shell itself gets to run its cleanup. It doesn't when
  the shell is killed outright: **live-tested on Windows, `Stop-Process -Force`
  on the app's own pid (what Task Manager's "End task" does) leaves
  `arigami-server.exe` orphaned, still bound to the port with no parent** —
  the identical failure the Linux run hit and fixed with `ctrlc`'s
  `termination` feature. That fix cannot cover this case on Windows: the app
  is `windows_subsystem = "windows"` so it has no console to receive control
  events, and `TerminateProcess` is unhandleable by design. The fix that would
  work is a **Job Object** with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` — the
  kernel then kills the sidecar when the shell's handle closes, however the
  shell died. `server/lib/children.ts`'s `initJob()` already does exactly this
  for session children via `bun:ffi`, so the pattern is established in this
  codebase; it just isn't applied in `main.rs`. Not implemented.
- **Port collisions are handled now.** The default moved to :4099 with its
  own `~/.arigami-desktop` (decision #5), so the common collision — a
  `bin/host` on :3099 — cannot happen at all any more, and a foreign process
  on :4099 itself now falls back to the 3300–4000 range rather than blocking
  the boot. A second copy of the app no longer reaches this code at all: the
  single-instance plugin stops it before it can spawn anything. What follows
  is the history of how that was handled before those two, and it still
  describes the supervisor's behaviour on any collision that survives them.
  This was not a hypothetical: a user
  launched the Windows build while a `bin/host` already owned :3099 and got a
  **new console window twice a second, without end**. Two defects combined,
  and both are fixed:
  1. `spawn_server()` SUCCEEDS in this scenario — the process starts fine and
     the failure happens *inside* the sidecar, when `hostlock.ts` refuses to
     bind. So the `Err(e)` arm never ran; `child.wait()` returned immediately
     and the loop went straight round again, 500ms later, forever.
     `run_supervisor()` now counts consecutive exits faster than
     `HEALTHY_RUN` (10s) and gives up after `MAX_FAST_EXITS` (5). A run that
     lasts 10s or more resets the counter, so ordinary restart/upgrade cycles
     are untouched. **Changed by the machine-switcher merge:** giving up sets
     `local_error` and parks the window on the shell page instead of calling
     `show_fatal_and_quit()`. It has to — another window may be pointed at a
     remote machine that is working, and quitting the app over a broken local
     sidecar would take that down too. Pointing the last window away from
     "this computer" clears the block and a switch back retries.
  2. Rust's `Command` on Windows gives a console-subsystem child **its own
     console window**, and `arigami-server.exe` is one (that is what
     `bun build --compile` emits). The sidecar spawn now sets
     `CREATE_NO_WINDOW`. Linux never showed this — there is no console to
     pop — so it could only surface once a human ran the Windows build.

  `crash_loop_message()` also distinguishes the two causes rather than
  guessing: if the port answers while our own child keeps dying, something
  else owns it, and the dialog says so by name ("a bin/host checkout, a
  Docker container, or a second copy of this app") instead of the generic
  "didn't answer in time".

  **Verified live on Windows** against a real `bin/host` holding :3099:
  exactly 5 spawn attempts in the log and then silence, zero new `conhost`
  or `cmd` processes (15/5 before, 15/5 after), the dialog captured on
  screen naming port 3099 and the log path, and the app exiting on its own
  with no orphaned sidecar. Two notes on how the merge changed this path.
  The accident described on the branch — the window navigating to the *other*
  host's cockpit, because the readiness poll only asked "does the port answer"
  — is gone: the pre-flight check in decision #5 now runs before the first
  spawn, and readiness afterwards goes through `wait_local_ready()`, which
  watches `local_error` rather than the bare port. And the outcome is a parked
  window, not a dialog and an exit. **Neither the merged guard nor the merged
  pre-flight has been re-run on Windows** — the Windows evidence above is for
  the pre-merge shapes.

  Still unexercised: `wait_local_ready()`'s 60s local timeout — every local
  start in testing came up in well under a second.
