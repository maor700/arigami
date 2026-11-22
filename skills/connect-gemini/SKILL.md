---
description: JIT-setup playbook for the `gemini` capability — start the Antigravity CLI's own Google sign-in through the host's accounts REST, open the Google authorize URL in the session Chrome; if Google is already signed in pick the identity account and approve, hand the callback address back to the host (it passes the code to agy), verify the Gemini account with GET /__api/accounts, and report with evidence. Password/2FA screens → take-over (the agent never types credentials).
triggers: request_setup returned {state:'auto'} for capability `gemini`; the Setup card "Connect Gemini" chose automatic; "add my Gemini / Google AI account", "תחבר את ג'מיני".
capability: gemini
allowlist: accounts.google.com google.com antigravity.google
argument-hint: (none)
---

# connect-gemini — agy sign-in → Google consent → code back to the host

Follow `skills/machine-work/SKILL.md`. Helpers: `skills/_lib/connect.sh`.
Server side: `server/gemini-login.ts` via `POST /__api/accounts/login/start|code`,
`GET /__api/accounts/login/status?id=`, `GET /__api/accounts`.

## Hard rules
1. **Never type passwords / 2FA / OTP / email codes.** A Google password or code form is not typed by you:
   call `sign_in({site:"google", reason, browser:true})` and follow its answer (the host types vault values —
   you never see them), then reload the page here. A push approval or a CAPTCHA → take-over (`request_screen`).
2. `export CONNECT_ALLOW="accounts.google.com google.com antigravity.google"`.
3. Consent first; ≤ 2 attempts; nothing written to disk by you — agy writes its own token file.
4. Never paste the callback address or the authorization code into chat, an artifact or memory.

## Steps
0. Opening line + `set_progress`.
1. Start: `connect.sh api POST /__api/accounts/login/start '{"provider":"gemini"}'` → `{id, state}`. Keep `id`.
   Poll `connect.sh api GET "/__api/accounts/login/status?id=<id>"` until `url` is set (a few seconds).
   A link comes even when agy is already signed in (this is also how to sign in again). `state:"error"` → read `error`, attempt 2.
2. `connect.sh open "<url>"`, `wait-url 'accounts\.google\.com' 45`, `shot first`,
   `capture_screen({caption:"Google sign-in page for Gemini loaded"})`.
3. Decide from the screenshot:
   - **Account chooser**: click the connected identity's account (`GET /__api/setup/capabilities` → identity).
   - **Consent** ("Antigravity wants to access your Google Account"): click Continue / Allow.
   - **Password / verification form**: rule 1. Anything only the human can do: `capture_screen`,
     `request_screen({prompt:"Connecting Gemini — Google asks you to sign in.", reason:"login", hint:"Sign in and approve; the page ends on a code. Then click Done."})`.
4. Google redirects to `antigravity.google/oauth-callback`, a page that shows an authorization code.
   `wait-url 'antigravity\.google/oauth-callback' 60`, then hand the address over without echoing it:
   `connect.sh api POST /__api/accounts/login/code '{"id":"<id>","code":"<address from connect.sh url>"}'`.
   The host takes the code out of it and hands it to agy. `ok:false` → read the code shown on the page and send that instead.
5. Poll the status every ~3 s (≤ 90 s) until `state:"done"` (`error` → read it, attempt 2 from step 1).
6. Verify: `connect.sh api GET /__api/accounts` lists an account with `provider:"gemini"`.
7. Evidence + report: `connect.sh shot final` → `publish_artifact` →
   `report_setup({capability:"gemini", ok:true, evidence:"<artifact path>"})`,
   `capture_screen({caption:"Gemini account connected"})`.
8. Summary line. Leave Google signed in (it is the human's own login).

## Failure handling
| Symptom | Do |
|---|---|
| `error` names the Antigravity CLI | it is not installed — `report_setup({ok:false, detail:"install the Antigravity CLI (agy) on the host"})` |
| `agy did not offer a sign-in link` | restart from step 1 once |
| `agy: couldn't log in: token exchange failed` / `agy did not accept the code` | the code expired or was cut — restart from step 1 once |
| Google shows "access blocked" / an error page | `shot`, read it, one `request_screen` with reason `other`, then `report_setup({ok:false, detail:"<error>"})` |

## Retro
`skill_propose({name:"connect-gemini", …})` if Google or agy changed the flow.
