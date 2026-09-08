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
