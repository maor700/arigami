#!/bin/sh
# Fake `codex` for oneshot tests: records argv/env/stdin, writes the -o file.
out=""; prev=""
for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done
stdin=$(cat)
if [ "$FAKE_CODEX_MODE" = "fail" ]; then echo "ERROR: unexpected status 401 Unauthorized" >&2; exit 1; fi
[ -n "$FAKE_CODEX_RECORD" ] && {
  printf '%s\n' "$@" > "$FAKE_CODEX_RECORD.argv"
  printf '%s' "$stdin" > "$FAKE_CODEX_RECORD.stdin"
  env > "$FAKE_CODEX_RECORD.env"
  readlink "$CODEX_HOME/auth.json" > "$FAKE_CODEX_RECORD.auth"
  cp "$CODEX_HOME/config.toml" "$FAKE_CODEX_RECORD.toml"
  for a in "$@"; do [ -f "$a" ] && case "$a" in *schema.json) cp "$a" "$FAKE_CODEX_RECORD.schema";; esac; done
}
printf '%s' "${FAKE_CODEX_OUT:-pong from codex}" > "$out"
