#!/usr/bin/env bash
# desktop/build.sh — stage the arigami-host sidecar + resources where
# desktop/src-tauri/tauri.conf.json's `bundle.resources` expects them, then
# stop. Run this before `cargo tauri build` / `cargo tauri dev`.
#
# This duplicates nothing: it's docs/DESKTOP.md's own two build steps
# (`bun run build:web` + `bun build --compile` + `bun scripts/bundle-resources.ts`)
# aimed at desktop/src-tauri/resources-staged/ instead of a bare dist/ dir.
#
# Platform-agnostic: .github/workflows/desktop.yml runs this same script on
# the Linux, macOS and Windows runners (git-bash there) before `tauri build`,
# so each installer gets a sidecar compiled for its own platform. `bun build
# --compile` picks the host target and adds the .exe suffix on Windows by
# itself, which is the exact name main.rs's resolve_server_binary() looks for
# there. macOS, Windows and Linux have all been built and run from this
# script; see docs/DESKTOP.md.
set -euo pipefail
cd "$(dirname "$0")/.."   # repo root

STAGE="desktop/src-tauri/resources-staged"
rm -rf "$STAGE"
mkdir -p "$STAGE"

echo "==> building web (bun run build:web)"
bun run build:web

echo "==> compiling server (bun build --compile)"
bun build --compile server/index.ts --outfile "$STAGE/arigami-server" "$@"

echo "==> bundling resources (bun scripts/bundle-resources.ts)"
bun scripts/bundle-resources.ts "$STAGE/resources"

echo "==> staged: $STAGE/arigami-server + $STAGE/resources/"
