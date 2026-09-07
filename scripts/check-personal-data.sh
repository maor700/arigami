#!/usr/bin/env bash
# Fails if any tracked file carries personal data. Same rules as
# test/no-personal-data.test.js, in shell, so it can run as a pre-commit hook:
#
#   ln -s ../../scripts/check-personal-data.sh .git/hooks/pre-commit
#
# What it looks for:
#   - Israeli phone numbers  (+972… / 0…), unless the digits are a zeroed
#     placeholder: after the operator prefix everything is 0 except at most
#     two trailing digits — 972500000000, 050-0000000, 073-0000001.
#   - WhatsApp JIDs          (…@lid / …@s.whatsapp.net / …@g.us), same rule,
#     plus a small set of documented opaque placeholders.
#   - Real mailboxes         — anything outside the reserved test domains
#     (example.com/.org/.net, .example, .test, .invalid, .local, .localhost)
#     and a short allowlist. Free-mail providers are never allowed.
#   - Any term in $ARIGAMI_DIR/private-terms.txt (default ~/.arigami), one per
#     line, `#` comments ignored. That file is deliberately NOT in the repo:
#     the names being removed must not be written down here to detect them.
#     When it is absent, only the shape rules run.
#
# Findings for the denylist print file:line only — never the term — so hook
# output can't become the leak it is guarding against.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 2
TERMS_FILE="${ARIGAMI_DIR:-$HOME/.arigami}/private-terms.txt"
fail=0

# Same file selection as the test: tracked, text-ish, minus generated/vendored.
mapfile -d '' -t FILES < <(git ls-files -z -- \
  ':!:bun.lock' ':!:web/bun.lock' ':!:test/no-personal-data.test.js' \
  ':!:scripts/check-personal-data.sh' ':!:node_modules/**' ':!:audit/**' \
  ':!:control-plane/data/**')

SCAN=()
for f in "${FILES[@]}"; do
  case "$f" in
    *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs|*.md|*.json|*.jsonc|*.sh|*.ps1|*.cmd|*.yml|*.yaml|\
    *.toml|*.css|*.html|*.txt|*.env|*.example|*.npmrc|*.lock|*.conf|*.service|*.plist|*.py|\
    .env.example|.npmrc|.gitignore|.dockerignore|Dockerfile|LICENSE|NOTICE|bin/host|install.sh)
      SCAN+=("$f") ;;
  esac
done
[ ${#SCAN[@]} -eq 0 ] && { echo "personal-data: nothing to scan"; exit 0; }

report() { echo "FAIL [$1] $2" >&2; fail=1; }

# --- shapes ------------------------------------------------------------------
# The public project slug is the repo's own address and is stripped before
# matching, so a denylist term that is a substring of it can't fire on it.
strip_slug='s#(github\.com|ghcr\.io|raw\.githubusercontent\.com)/[A-Za-z0-9-]+/arigami##g'

# grep -P gives us the same alternations as the test. Placeholder filtering is
# done in the awk pass: keep a hit only if its digits are NOT a zeroed example.
phone_re='(?:\+?972[-\s]?|\b0)(?:5\d|7\d|[23489])[-\s]?\d{3}[-\s]?\d{4}\b'
jid_re='\b\d{6,}@(?:lid|s\.whatsapp\.net|g\.us)\b'
mail_re='\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b'

placeholder() { printf '%s' "$1" | tr -cd '0-9' | grep -qP '^(?:972|0)\d{2}0{5,}\d{0,2}$'; }

jid_placeholder() {
  case "$1" in 1234567890|1234567891|120363000000000000) return 0 ;; esac
  placeholder "$1"
}

mail_allowed() {
  case "${1,,}" in
    *.example.com|example.com|*.example.org|example.org|*.example.net|example.net) return 0 ;;
    *.example|*.test|*.invalid|*.local|*.localhost|localhost|*.arpa) return 0 ;;
    github.com|arigami.local|s.whatsapp.net|g.us|t.io|anthropic.com) return 0 ;;
    evil.com|evil.net|notexample.com|example.com.evil.net|consumer-idp.example) return 0 ;;
  esac
  return 1
}

# Documented placeholders that the shape rules would otherwise flag.
allowed_line() {
  case "$1:$2" in
    'mcp/host-mcp.js':*'+972500000000'*) return 0 ;;
    'server/listeners-whatsapp.ts':*'972500000000'*) return 0 ;;
  esac
  return 1
}

for f in "${SCAN[@]}"; do
  grep -qP '\x00' "$f" 2>/dev/null && continue   # binary
  while IFS=: read -r n line; do
    [ -n "${n:-}" ] || continue
    allowed_line "$f" "$line" && continue
    clean=$(printf '%s' "$line" | perl -pe "$strip_slug" 2>/dev/null)

    while read -r hit; do
      [ -n "$hit" ] || continue
      placeholder "$hit" || report "israeli phone number" "$f:$n"
    done < <(printf '%s' "$clean" | grep -oP "$phone_re" 2>/dev/null)

    while read -r hit; do
      [ -n "$hit" ] || continue
      jid_placeholder "${hit%%@*}" || report "whatsapp JID" "$f:$n"
    done < <(printf '%s' "$clean" | grep -oP "$jid_re" 2>/dev/null)

    while read -r hit; do
      [ -n "$hit" ] || continue
      mail_allowed "${hit##*@}" || report "personal mailbox" "$f:$n"
    done < <(printf '%s' "$clean" | grep -oP "$mail_re" 2>/dev/null)
  done < <(grep -nP "$phone_re|$jid_re|$mail_re" "$f" 2>/dev/null)
done

# --- host-local denylist -----------------------------------------------------
if [ -r "$TERMS_FILE" ]; then
  terms=()
  while IFS= read -r t; do
    t="${t#"${t%%[![:space:]]*}"}"; t="${t%"${t##*[![:space:]]}"}"
    [ -z "$t" ] && continue
    case "$t" in \#*) continue ;; esac
    terms+=("$t")
  done < "$TERMS_FILE"
  if [ ${#terms[@]} -gt 0 ]; then
    pattern=$(printf '%s\n' "${terms[@]}")
    for f in "${SCAN[@]}"; do
      grep -qP '\x00' "$f" 2>/dev/null && continue
      while IFS=: read -r n line; do
        [ -n "${n:-}" ] || continue
        clean=$(printf '%s' "$line" | perl -pe "$strip_slug" 2>/dev/null)
        if printf '%s' "$clean" | grep -qiFf <(printf '%s' "$pattern"); then
          report "private denylist term" "$f:$n"
        fi
      done < <(grep -niFf <(printf '%s' "$pattern") "$f" 2>/dev/null)
    done
  fi
fi

if [ "$fail" -ne 0 ]; then
  echo "personal-data: FAILED — see $ROOT/CONTRIBUTING.md" >&2
  exit 1
fi
echo "personal-data: OK"
