# Windows desktop — handoff

State as of 2026-09-09, branch `fix/windows-desktop` (commit `a9b1c20`,
rebased onto `origin/master` @ `be7b55c`).

**Read `docs/DESKTOP.md` first** — the decisions, the bug write-ups and the
verification log all live there, in the "What was proven (Windows 11)" section
and decisions #5–#7. This file is only the things that are NOT in there: the
open work, the exact machine/branch state, and the update-channel findings.

---

## 1. Where the work is

| | |
|---|---|
| branch | `fix/windows-desktop` |
| commit | `a9b1c20` — 11 files, +726/−92 |
| base | `be7b55c` (`origin/master`), rebased clean |
| pushed | **NO — the branch exists only on this machine** |

`git push -u origin fix/windows-desktop` before continuing anywhere else, or
the work is lost with the machine. Nothing was pushed without approval.

The one file both sides touched during the rebase was `server/extensions.ts`
(upstream added schema-version migration, this branch swapped `symlinkSync` for
`linkDir`). Both survived — verified by diffing each side separately, not by
trusting that the rebase reported no conflict.

## 2. What was fixed

Seven bugs; all detail is in `docs/DESKTOP.md`. One-line each:

1. `node:sqlite` doesn't exist in Bun on Windows → lazy-load it, so
   `listeners.ts` loads and only WhatsApp calls fail. **Side effect worth
   knowing: before this, the Windows host booted with the whole listener
   subsystem silently disabled**, because `index.ts` reaches it through
   `import().catch()`.
2. `isCompiledBinary()` only knew Linux's `/$bunfs/` marker; Windows uses
   `file:///B:/%7EBUN/root/…`. Symptom was a "UI not built yet" placeholder at
   version `0.0.0`, not a crash.
3. Directory symlinks need privilege on Windows → `linkDir()` in
   `server/lib/platform.ts` uses a junction there.
4. `CREATE_NO_WINDOW` + a crash-loop guard (5 sub-10s exits → dialog, quit).
5. The app is its own instance: `~/.arigami-desktop` + port 4099.
6. No pairing code locally — via `server/handoff.ts`, **not** `ARIGAMI_AUTH=off`
   (see decision #6 for why off is the wrong trade).
7. Pre-flight port check before the first spawn — fixes the "Sign-in failed"
   a user actually hit.

## 3. Open items

### 3a. The update channel is not wired — three separate gaps

`pickBackend()` (`server/lib/update-backend.ts:122`) returns `packagedBackend`
for any compiled binary, i.e. always in the desktop app. In it:

| method | state |
|---|---|
| `available()` | implemented — compares `currentVersion` to the latest GitHub release |
| `preflight()` | returns `{ok:false, reason:'packaged updates are not implemented yet'}` |
| `plan()` | `null` |
| `run()` | throws **501** |
| `finish` | `'relaunch-app'` — the intended end state is already declared |

The three things missing, in dependency order:

1. **No `tauri-plugin-updater`.** Absent from `Cargo.toml`; no `updater`,
   `pubkey` or `createUpdaterArtifacts` in `tauri.conf.json`; no signing
   keypair. This is the component that downloads, verifies the signature,
   installs per-platform (NSIS/MSI on Windows) and relaunches. Prefer it over
   hand-rolling a download inside `run()`.
2. **`packaged.plan()`/`run()`** need to drive that plugin instead of throwing,
   so the cockpit's existing upgrade button works.
3. **There is nothing to update *from*, and detection is silently dead.**
   `api.github.com/repos/maor700/arigami/releases` → **404**, and so does the
   repo itself unauthenticated: **the repo is private**. `fetchLatestRelease()`
   (`server/version.ts:90`) does `if (!r.ok) return null`, so the one
   implemented half reports "no update available" forever, with no error. Any
   fix must decide hosting: a public release repo, or a private endpoint with
   a token.

**Open decisions (product/infra, not code):** where updates are hosted, and
where the private signing key lives in CI.

### 3b. Orphaned sidecar on a hard kill

`Stop-Process -Force` on the app (Task Manager "End task") leaves
`arigami-server.exe` running and bound to the port. Verified live on Windows.
The `ctrlc` `termination` fix from the Linux pass cannot cover it: the app is
`windows_subsystem = "windows"` so it has no console to receive control events,
and `TerminateProcess` is unhandleable by design.

The fix is a **Job Object** with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` in
`main.rs`. Precedent exists in this codebase: `server/lib/children.ts`'s
`initJob()` does exactly this for session children via `bun:ffi`.

### 3c. WhatsApp on Windows

Pairing works as far as the QR card (confirmed live — a real session got one and
it timed out normally). The **listener** does not: it polls the Baileys SQLite
DB and needs `node:sqlite`, which Bun lacks on Windows. Fix 1 only stopped the
crash. A real fix means an adapter over `bun:sqlite`, whose API differs from
`DatabaseSync`; the surface is small — 6 constructor call sites in
`server/listeners-whatsapp.ts`.

### 3d. The Rust handoff minter is not in the contract test

`main.rs` is now a **third** implementation of handoff's wire format, alongside
`server/handoff.ts` and `control-plane/src/handoff.ts`.
`test/handoff-contract.test.ts` cross-checks only the two TypeScript ones. A
format drift would break desktop sign-in **without failing that suite**. Worth
a test that shells out to the built binary.

### 3e. Cross-platform verification

- **macOS: never built.** Not by this pass, not by the earlier one. Tauri can't
  cross-compile to it.
- **Linux: not rebuilt** since decisions #5–#7. The Linux section in
  `docs/DESKTOP.md` is marked stale where those changes invalidated it. Cross-
  checking from Windows fails in `libdbus-sys`'s build script (needs
  `libdbus-1-dev` + `pkg-config`), so it proves nothing either way.
- Changes 1–4 are guarded by explicit `cfg(windows)` / `isWin`, and `linkDir`'s
  added `path.resolve()` is a no-op because every call site already passes an
  absolute path (checked). No regression expected — but "not expected" is not
  "verified".
- Two `test/extensions.test.ts` failures remain on Windows and are **fixture**
  artifacts, not product bugs: one asserts POSIX mode `0600` (Windows reports
  `666`), the other compares a `path.join()` result to a hardcoded
  `user/skills/...` forward-slash string. The junction fix took this file from
  4 failures to 2.

## 4. Building on Windows

```sh
cargo install tauri-cli --locked --version "^2.0"     # once
cd desktop/src-tauri && cargo tauri icon ../../web/public/icon-512.png   # once
bash desktop/build.sh                                  # web + sidecar, runs in Git Bash
cd desktop/src-tauri && cargo tauri build              # → bundle/msi + bundle/nsis
```

Toolchain that worked: Rust 1.93 (`x86_64-pc-windows-msvc`), VS 2022 Build
Tools + Windows SDK 10.0.22621, Bun 1.3.6, Tauri 2.11.5.

Two traps:

- **`desktop/src-tauri/icons/` is gitignored**, so a fresh clone has none — and
  a Windows bundle cannot be built without the `icon.ico` that
  `cargo tauri icon` generates. This is not optional here.
- **Windows locks a running `.exe`.** Rebuilding while a previous build runs
  fails. Either close it, or build with
  `CARGO_TARGET_DIR=…/target-installer`, which is what produced the current
  installers. Both that dir and `desktop/dist/` are gitignored.

## 5. Machine state right now

- Installed **per-user** at `%LOCALAPPDATA%\Arigami` (NSIS). `C:\Program Files\Arigami`
  (the MSI install) was uninstalled — there were briefly two installs, because a
  silent `/S` run without elevation goes per-user while the manual MSI went
  per-machine.
- **The installed build is pre-codex and pre-preflight**: exe `19:14`, sidecar
  `17:13`, and its bundle `index-Cb2h-Eqe.js` contains **0** occurrences of
  "codex". It predates the `be7b55c` rebase.
- `~/.arigami-desktop` holds a real session (`scratch-1`, the WhatsApp thread).
  Uninstalling does not touch it; it reappears after reinstall.
- The user's own `bin/host` runs separately on **:3099** (`~/.arigami`) and was
  never disturbed.

**Therefore: to get Codex in the app, rebuild.** The engine selector arrived in
`be7b55c` (`feat(engine-ui): בורר מנוע ב-Launcher`, `docs/ENGINES.md`) — after
every artifact currently on disk was built. `bash desktop/build.sh` +
`cargo tauri build`, then reinstall.

## 6. Not investigated

- Screen takeover is **off by config**, not missing: `SessionView.jsx:288`
  returns `null` unless `config.screen.enabled`. Default is `false` on both
  instances, and there is no Settings toggle — it's a `config.json` edit. On
  Windows `pickDriver()` (`screen-driver.ts:85`) selects the **native** driver:
  the session's Chrome is a real window, live view is CDP screencast rather than
  VNC, and "hand over the wheel" is `Page.bringToFront`. `available()` also
  needs Chrome, which is present on this machine. Never enabled or tested here.
- The MSI/NSIS **install path** was only exercised by the user, not scripted:
  verification here ran binaries out of an `msiexec /a` extraction. The one real
  install is what surfaced bug 7.
- Code signing: the installers are unsigned. SmartScreen will warn.
