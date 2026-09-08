# Desktop packaging (`bun build --compile`)

Status: **not shippable yet**. `bunExec()` (server/lib/bun-exec.ts) and the
resource bundler (scripts/bundle-resources.ts) are done and verified. The
actual `bun build --compile server/index.ts` fails on a pre-existing
architectural issue unrelated to this work — see "Known blocker" below.

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

## How to build (once the blocker below is fixed)

```sh
bun run build:web                                   # web/dist
bun build --compile server/index.ts --outfile dist/arigami-server
bun scripts/bundle-resources.ts dist/resources       # next to the binary
```

`resourceRoot()` expects the resources at `<dirname(execPath)>/resources`, so
`dist/arigami-server` and `dist/resources/` must ship side by side.

## Known blocker: `bun build --compile` fails today, on master, unrelated to this task

Verified reproducible **before any of this task's changes** (checked out the
call sites' original content and re-ran the same build — identical failure).
`bun build --compile server/index.ts` errors out during bundling with:

```
error: This require call is not allowed because the transitive dependency
"server/extensions.ts" contains a top-level await
    at server/skills.ts:200   (extensionSkills())
    at server/skills.ts:269   (autoCommit after a skill save)
    at server/state.ts:1204   (resolveExtTab())

error: This require call is not allowed because the transitive dependency
"server/lib/children.ts" contains a top-level await
    at server/extensions.ts:926   (refreshFamilies(), require('./agent-policy.js'))
```

Two independent root causes:

1. **`server/extensions.ts:1499`** has a real top-level `await` inside
   `if (import.meta.main) { … }` (the `bun server/extensions.ts trust|untrust|enable|…`
   CLI). Syntactically, ANY top-level `await` — even inside a runtime-false
   `if` — marks the whole module as an "asynchronous module" for bundling
   purposes, so every `require('./extensions.js')` elsewhere in the codebase
   (skills.ts ×2, state.ts) becomes illegal under `--compile`. This one looks
   low-risk to fix (the code path only runs when the file is executed
   directly as a CLI, never during normal server import) but wasn't touched —
   out of scope for this task and not verified against the CLI usage.

2. **`server/lib/children.ts:117`** — `await initJob();` — is a *real*,
   unconditional top-level await that sets up the Windows job-object
   (`CreateJobObjectW` + `KILL_ON_JOB_CLOSE`) BEFORE the module finishes
   loading, which is what guarantees every child the host ever spawns is
   covered by layer-1 orphan protection (see the comment block at the top of
   that file). `server/extensions.ts:926` does
   `require('./agent-policy.js')`, which transitively reaches this file, and
   that require is what the compiler actually rejects.

   **This one was deliberately NOT touched.** Making it non-blocking (e.g.
   fire-and-forget the async init, or lazily await it on first `supervise()`
   call) would open a real window, on every host restart, where children
   spawned before the Windows job object exists get NO layer-1 protection for
   their entire lifetime — not a cosmetic risk, and not one this session
   could verify: there's no Windows box here to test against. Given the
   desktop target is explicitly Mac **and** Windows, gambling on Windows
   process-supervision safety to make a Linux smoke test compile felt like
   the wrong trade.

**What unblocking this needs:** either (a) remove the top-level `await` in
`children.ts` behind a readiness-gate that every `supervise()` call site
awaits before its first spawn (a real design change, needs Windows testing),
or (b) convert the four late `require('./extensions.js' | './agent-policy.js')`
call sites to `await import()` and propagate `async` to their callers (also
non-trivial — `resolveExtTab()` in particular is called from a synchronous
tab-creation path). Both are follow-up work, not something to rush through
inside this task.

## What WAS verified despite the blocker

Since the actual binary can't be produced, the resource bundle and
`bunExec()` were verified independently:

- `bunExec('host' | 'policy' | 'ext')` output compared directly against the
  exact strings/arrays the three call sites built by hand before — identical.
- `bun scripts/bundle-resources.ts <dir>` run for real: produced a
  **2.8 MB** resources directory (`web/dist` 2.0M, `skills` 312K, `profiles`
  336K, `sdk` 56K, `mcp` 96K, `server/assets`+`pty-bridge.py` 28K,
  `package.json`+`VERSION` 8K).
- The real (non-compiled) `server/index.ts` was pointed at that bundle via
  `ARIGAMI_ROOT=<bundle-dir>` (the same override `resourceRoot()` uses, so
  this exercises the exact code path a compiled binary would take once it
  can be built), on an isolated `ARIGAMI_DIR` under `/tmp` and a non-3099
  port. It came up clean and served:
  - `GET /__health` → `{"ok":true,...}`
  - `GET /__api/config` → `{"version":"0.1.0",...}` (read from the bundled
    `VERSION`/`package.json`)
  - `GET /__host/` → the built cockpit HTML (from bundled `web/dist`)
  - `GET /__ext-sdk.js` → served (from bundled `sdk/`)

  Not tested: actually starting a Claude session (needs the `claude` CLI
  wired up in a way this smoke test didn't set up) and the compiled-binary
  re-exec path itself (`--mcp <kind>` dispatch in `server/index.ts`) — that
  code is unreachable without a working `--compile` build.

- `bun:ffi` / `bun:sqlite` availability inside a compiled binary, and
  `await import()` of absolute on-disk paths inside one, were verified in
  an earlier spike (not re-verified here) and are why `bunExec()`'s re-exec
  design and the resource-bundling approach are safe bets once the blocker
  above is cleared.
