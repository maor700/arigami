#!/bin/sh
# Fake `agy` for the sign-in test: the signed-out menu, the authorize link, the code prompt; the right code writes the token file.
tok="${ARIGAMI_GEMINI_HOME}/antigravity-cli/antigravity-oauth-token"
[ "$1" = "models" ] && exit 0
if [ -s "$tok" ]; then printf 'Antigravity CLI\n> '; sleep 30; exit 0; fi
printf ' Welcome to the Antigravity CLI. You are currently not signed in.\n Select login method:\n > 1. Google OAuth\n'
IFS= read -r _
printf '\033]8;id=x;https://accounts.google.com/o/oauth2/auth?client_id=test&redirect_uri=https%%3A%%2F%%2Fantigravity.google%%2Foauth-callback&state=abc\007Click here to authenticate\033]8;;\007\n paste the authorization code below:\n'
IFS= read -r code
[ -n "$FAKE_AGY_RECORD" ] && printf '%s' "$code" > "$FAKE_AGY_RECORD"
if [ "$code" = "$FAKE_AGY_CODE" ]; then
  mkdir -p "$(dirname "$tok")"
  printf '{"token":{"access_token":"t","expiry":"2020-01-01T00:00:00Z"},"id_token_email":"someone@example.com"}' > "$tok"
  printf 'Signed in\n'
else
  printf 'Invalid authorization code\n'
fi
sleep 30
