---
description: JIT-setup playbook for the `claude` capability — mint the Claude PKCE authorize URL from the host's accounts OAuth REST, open it in the session Chrome; if claude.ai is already signed in click Authorize, read the authorization code from the callback URL, POST it back for the token exchange, and report with evidence. If claude.ai asks for a login/password/2FA → take-over (the agent never types credentials).
triggers: request_setup returned {state:'auto'} for capability `claude`; the minimal wizard/Setup card "Connect Claude" chose automatic; "add my Claude account", "תחבר את קלוד".
capability: claude
allowlist: claude.ai claude.com platform.claude.com console.anthropic.com accounts.google.com google.com
argument-hint: [account label, optional]
---

# connect-claude — authorize page → code → exchange

Follow `skills/machine-work/SKILL.md`. Helpers: `skills/_lib/connect.sh`.
Server side: `server/oauth-login.js` via `POST /__api/accounts/oauth/start|code`,
`GET /__api/accounts/oauth/status?id=` (already exists; no new endpoint needed).

## Hard rules
1. **Never type passwords / 2FA / OTP / magic-link codes.** claude.ai's login
   screen is the take-over boundary. "Continue with Google" is fine to click when
   `identity` is connected — the account chooser is not a password screen.
2. `export CONNECT_ALLOW="claude.ai claude.com platform.claude.com console.anthropic.com accounts.google.com google.com"`.
3. Consent first; ≤ 2 attempts; nothing written to disk by you — the host stores
   the tokens (`accounts.json`), you only relay the code.
4. The authorization code is single-use and expires in minutes: never log it in
   chat, an artifact or memory. Pass it straight to the exchange endpoint.

## Steps
0. Opening line + `set_progress`.
1. Start the flow: `connect.sh api POST /__api/accounts/oauth/start '{"label":"<label or empty>"}'`
   → `{id, url, state:"awaiting-code"}`. Keep `id`.
2. `connect.sh open "<url>"`, `wait-url 'claude\.(ai|com)|accounts\.google\.com' 45`,
   `shot first`, `capture_screen({caption:"Claude authorize page loaded"})`.
3. Decide from the screenshot:
   - **Authorize screen** ("Claude Code wants to access…", button *Authorize*):
     click Authorize.
   - **Login screen** (email box / "Continue with Google"): if `identity` is
     connected click *Continue with Google* and pick the identity email in the
     chooser; if a password/2FA/email-code screen follows, or there is no identity:
     `capture_screen`, `request_screen({prompt:"Connecting your Claude account — claude.ai asks you to sign in.", reason:"login", hint:"Sign in, click Authorize on the next page, wait for the page that shows a code, then click Done."})`.
4. After Authorize (yours or the human's): the host itself watches THIS
   session's Chrome (connect.sh sends `X-Arigami-Session`, so the flow started
   in step 1 is bound to your desktop) and, the moment the
   `platform.claude.com/oauth/code/callback?code=…&state=…` tab appears, exchanges
   the code by itself — nobody pastes anything. Poll
   `connect.sh api GET "/__api/accounts/oauth/status?id=<id>"` every ~3 s (≤ 90 s)
   until `state:"done"`.
5. Fallback (status still `awaiting-code` although the callback page is on
   screen): `connect.sh api POST /__api/accounts/oauth/read-browser '{"id":"<id>"}'`
   (the host reads the tab list / History again); if that also fails, take the
   values from `connect.sh url` and exchange manually:
   `connect.sh api POST /__api/accounts/oauth/code '{"id":"<id>","code":"<code>#<state>"}'`
   → `{ok:true, account:{…}}`. `ok:false` → read `error`; "state mismatch" means the
   page belongs to an older attempt → restart from step 1 (attempt 2).
6. Verify: `connect.sh api GET "/__api/accounts/oauth/status?id=<id>"` → `state:"done"`.
7. Evidence + report: `connect.sh shot final` → `publish_artifact` →
   `report_setup({capability:"claude", ok:true, evidence:"<artifact path>"})`,
   `capture_screen({caption:"Claude account added"})`.
8. Summary line. Leave claude.ai signed in (it is the human's own login).

## Failure handling
| Symptom | Do |
|---|---|
| "Invalid request format" on the authorize page | the flow expired — restart from step 1 once |
| Callback never reached (stuck on claude.ai) | `shot`, read the error, one `request_screen` with reason `other` |
| Exchange `token exchange failed (4xx)` | do not retry with the same code; attempt 2 from step 1, then `report_setup({ok:false, detail:"<error>"})` |
| Google SSO inside claude.ai asks for a password | boundary — take-over |

## Retro
`skill_propose({name:"connect-claude", …})` if Anthropic changed the page flow.
