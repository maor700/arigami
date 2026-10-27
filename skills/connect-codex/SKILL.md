---
description: JIT-setup playbook for the `codex` capability — start `codex login` through the host's accounts REST, open the ChatGPT authorize URL in the session Chrome; if ChatGPT is already signed in approve it, let the loopback callback land on this host by itself, verify the Codex account with GET /__api/accounts, and report with evidence. Sign-in/password/2FA screens → take-over (the agent never types credentials).
triggers: request_setup returned {state:'auto'} for capability `codex`; the Setup card "Connect Codex" chose automatic; "add my Codex / ChatGPT account", "תחבר את קודקס".
capability: codex
allowlist: localhost auth.openai.com openai.com chatgpt.com accounts.google.com google.com
argument-hint: [account label, optional]
---

# connect-codex — codex login → authorize page → loopback

Follow `skills/machine-work/SKILL.md`. Helpers: `skills/_lib/connect.sh`.
Server side: `server/codex-account.ts` via `POST /__api/accounts/login/start|code`,
`GET /__api/accounts/login/status?id=`, `GET /__api/accounts`.

## Hard rules
1. **Never type passwords / 2FA / OTP / email codes.** "Continue with Google" is fine to click when `identity` is connected.
   A vendor's own username / password / code form is not typed by you either: call
   `sign_in({site, reason, browser:true})` for it and follow its answer (the sign-in runs in the owner's own Chrome, the host types vault values — you never see them), then reload the page here. A push approval or a CAPTCHA → take-over (`request_screen`).
2. `export CONNECT_ALLOW="localhost auth.openai.com openai.com chatgpt.com accounts.google.com google.com"`.
3. Consent first; ≤ 2 attempts; nothing written to disk by you — codex writes its own `auth.json`.
4. Never paste the callback address into chat, an artifact or memory.

## Steps
0. Opening line + `set_progress`.
1. Start: `connect.sh api POST /__api/accounts/login/start '{"provider":"codex","label":"<label or empty>"}'`
   → `{id, state}`. Keep `id`. Poll `connect.sh api GET "/__api/accounts/login/status?id=<id>"`
   until `url` is set (a few seconds; `state:"error"` → read `error`, attempt 2).
2. `connect.sh open "<url>"`, `wait-url 'auth\.openai\.com|chatgpt\.com|accounts\.google\.com' 45`,
   `shot first`, `capture_screen({caption:"Codex sign-in page loaded"})`.
3. Decide from the screenshot:
   - **Consent / "Continue" screen** (already signed in): click it.
   - **Login screen** (email box / "Continue with Google"): with `identity` connected,
     finish it in the owner's Chrome, where their Google is signed in: `sign_in({site:"<service>", url:"<the page's current URL>", reason})`, pick the identity email and Allow there (`desktop_screenshot` / `desktop_pointer` with shared:true), then `sign_in({site, done:true})` and continue polling here; an OpenAI email/password or code form →
     `sign_in` (rule 1); anything else only the human can do: `capture_screen`,
     `request_screen({prompt:"Connecting your Codex account — OpenAI asks you to sign in.", reason:"login", hint:"Sign in and approve; the page ends on a 'signed in' screen. Then click Done."})`.
4. The redirect goes to codex's loopback on this host, and the session Chrome IS on this host,
   so it completes by itself — nothing to paste. Poll the status every ~3 s (≤ 90 s) until `state:"done"`.
5. Fallback (still `awaiting` while the callback page is on screen): take the address from
   `connect.sh url` and hand it over without echoing it:
   `connect.sh api POST /__api/accounts/login/code '{"id":"<id>","code":"<address>"}'`, then poll again.
6. Verify: `connect.sh api GET /__api/accounts` lists an account with `provider:"codex"`.
7. Evidence + report: `connect.sh shot final` → `publish_artifact` →
   `report_setup({capability:"codex", ok:true, evidence:"<artifact path>"})`,
   `capture_screen({caption:"Codex account added"})`.
8. Summary line. Leave ChatGPT signed in (it is the human's own login).

## Failure handling
| Symptom | Do |
|---|---|
| `could not start codex` / ENOENT | the Codex CLI is missing — `report_setup({ok:false, detail:"install the Codex CLI: npm i -g @openai/codex"})` |
| status `error` "timed out" | restart from step 1 once |
| "device code / workspace admin" page | not this flow — restart from step 1; then take-over with reason `other` |
| Stuck on auth.openai.com with an error | `shot`, read it, one `request_screen` with reason `other`, then `report_setup({ok:false, detail:"<error>"})` |

## Retro
`skill_propose({name:"connect-codex", …})` if OpenAI changed the page flow.
