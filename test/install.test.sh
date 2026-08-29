#!/usr/bin/env bash
# install.sh smoke tests — no root, no network, nothing installed:
#   syntax (bash -n), shellcheck when available, --help, bad flag → exit 2,
#   --dry-run prints the plan without touching the target dirs, and the
#   Profile Bundle CLI (server/profiles.ts) round-trips against a scratch
#   ARIGAMI_DIR. Run: bash test/install.test.sh   (also wired into `bun test`
#   via test/install.test.ts).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SH="$ROOT/install.sh"
fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "ok - $*"; }

bash -n "$SH" || fail "bash -n install.sh"
pass "install.sh parses"

if command -v shellcheck >/dev/null 2>&1; then
  shellcheck -s bash "$SH" || fail "shellcheck install.sh"
  shellcheck -s bash "$ROOT/bin/host" || fail "shellcheck bin/host"
  pass "shellcheck clean"
else
  echo "skip - shellcheck not installed"
fi

out="$(bash "$SH" --help)" || fail "--help exit code"
grep -q -- '--profile' <<<"$out" || fail "--help mentions --profile"
pass "--help"

set +e; bash "$SH" --definitely-unknown >/dev/null 2>&1; rc=$?; set -e
[ "$rc" = 2 ] || fail "unknown flag should exit 2 (got $rc)"
pass "unknown flag → 2"

scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
out="$(ARIGAMI_DIR="$scratch/data" ARIGAMI_PORT=4777 bash "$SH" --dry-run --server --unattended --profile solo-dev \
  --dir "$scratch/app" --user "$(id -un)" 2>&1)" || fail "dry-run exit code: $out"
grep -q 'DRY RUN' <<<"$out" || fail "dry-run banner"
grep -q "install dir: $scratch/app" <<<"$out" || fail "dry-run honours --dir"
grep -q "data dir: $scratch/data" <<<"$out" || fail "dry-run honours ARIGAMI_DIR"
grep -q 'port: 4777' <<<"$out" || fail "dry-run honours ARIGAMI_PORT"
grep -q 'desktop: no' <<<"$out" || fail "--server implies no desktop"
grep -q 'profile apply solo-dev' <<<"$out" || fail "dry-run plans the profile apply"
grep -q 'git clone' <<<"$out" || fail "dry-run plans the clone"
grep -q 'env (0600)' <<<"$out" || fail "dry-run plans the env file"
[ ! -e "$scratch/app" ] || fail "dry-run created the install dir"
[ ! -e "$scratch/data" ] || fail "dry-run created the data dir"
pass "--dry-run prints the plan and touches nothing"

out="$(bash "$SH" --dry-run --desktop --dir "$scratch/app" 2>&1)" || fail "desktop dry-run"
grep -q 'desktop: yes' <<<"$out" || fail "--desktop"
pass "--desktop dry-run"

set +e; out="$(ARIGAMI_DIR="$scratch/data" bash "$SH" update --dir "$scratch/nope" 2>&1)"; rc=$?; set -e
[ "$rc" != 0 ] || fail "update on a non-checkout must fail"
grep -q 'not a git checkout' <<<"$out" || fail "update error message"
pass "update refuses a non-checkout"

# ---- profile bundle CLI (what bin/host profile … calls) ----------------------
if command -v bun >/dev/null 2>&1; then
  export PATH="$HOME/.bun/bin:$PATH"
  cd "$ROOT"
  ARIGAMI_DIR="$scratch/data" bun server/profiles.ts list | grep -q '"solo-dev"' || fail "profiles list shows solo-dev"
  ARIGAMI_DIR="$scratch/data" bun server/profiles.ts validate solo-dev | grep -q '"ok": true' || fail "validate solo-dev"
  set +e; ARIGAMI_DIR="$scratch/data" bun server/profiles.ts validate no-such-bundle >/dev/null 2>&1; rc=$?; set -e
  [ "$rc" != 0 ] || fail "validate unknown bundle must fail"
  ARIGAMI_DIR="$scratch/data" bun server/profiles.ts pending solo-dev >/dev/null || fail "pending solo-dev"
  [ -f "$scratch/data/pending-profile" ] || fail "pending-profile written"
  grep -q 'solo-dev' "$scratch/data/pending-profile" || fail "pending-profile content"
  ARIGAMI_DIR="$scratch/data" bun server/profiles.ts current | grep -q '"pending"' || fail "current shows pending"
  pass "profiles.ts list/validate/pending/current"
else
  echo "skip - bun not installed"
fi

echo "all install.sh tests passed"
