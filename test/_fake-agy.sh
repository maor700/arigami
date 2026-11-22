#!/bin/sh
# Fake `agy` for the sign-in test: `acp [--gemini-dir <home>] --login` prints the link, reads the code; the right code writes the token file.
[ "$1" = "models" ] && exit 0
home="$HOME/.gemini"; login=""; prev=""
for a in "$@"; do [ "$prev" = "--gemini-dir" ] && home="$a"; [ "$a" = "--login" ] && login=1; prev="$a"; done
[ -n "$FAKE_AGY_ARGS" ] && printf '%s\n' "$@" > "$FAKE_AGY_ARGS"
[ -z "$login" ] && exit 2
tok="$home/antigravity-cli/antigravity-oauth-token"
printf 'Open this link in a browser to log in with Google:\n\n  https://accounts.google.com/o/oauth2/auth?client_id=test&redirect_uri=https%%3A%%2F%%2Fantigravity.google%%2Foauth-callback&state=abc\n\nThen paste the authorization code, or the full URL of the page you land on, and press Enter:\n\n'
IFS= read -r code || { printf 'login cancelled: no authorization code was entered\n'; exit 1; }
[ -n "$FAKE_AGY_RECORD" ] && printf '%s' "$code" > "$FAKE_AGY_RECORD"
if [ "$code" = "$FAKE_AGY_CODE" ]; then
  mkdir -p "$(dirname "$tok")"
  printf '{"token":{"access_token":"t","expiry":"2020-01-01T00:00:00Z"},"id_token_email":"someone@example.com"}' > "$tok"
  exec sleep 30 # stays up after a sign-in — the host must stop it
else
  printf 'couldn'"'"'t log in: token exchange failed: oauth2: "invalid_grant" "Bad Request"\n'
  exit 1
fi
