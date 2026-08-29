#!/usr/bin/env sh
# Fails if the repository is not ready to be published:
#  - LICENSE must exist and be Apache-2.0
#  - package.json / web/package.json must not be "private": true
#  - both must declare "license": "Apache-2.0"
#  - NOTICE, SECURITY.md, CONTRIBUTING.md, CODE_OF_CONDUCT.md must exist
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fail=0
err() { echo "FAIL: $*" >&2; fail=1; }

[ -f "$ROOT/LICENSE" ] || err "LICENSE is missing"
[ -f "$ROOT/LICENSE" ] && ! grep -q "Apache License" "$ROOT/LICENSE" && err "LICENSE is not Apache-2.0"
for f in NOTICE SECURITY.md CONTRIBUTING.md CODE_OF_CONDUCT.md; do
  [ -f "$ROOT/$f" ] || err "$f is missing"
done

for pkg in package.json web/package.json; do
  p="$ROOT/$pkg"
  [ -f "$p" ] || continue
  if grep -Eq '"private"[[:space:]]*:[[:space:]]*true' "$p"; then
    err "$pkg is marked \"private\": true"
  fi
  if ! grep -Eq '"license"[[:space:]]*:[[:space:]]*"Apache-2.0"' "$p"; then
    err "$pkg does not declare \"license\": \"Apache-2.0\""
  fi
done

if [ "$fail" -ne 0 ]; then
  echo "public-readiness: FAILED" >&2
  exit 1
fi
echo "public-readiness: OK"
