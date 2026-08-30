---
description: JIT-setup playbook for the `git` capability — run `gh auth login --web` under the host's pty-bridge (the wizard's existing gh-login action), read the one-time device code + URL, open github.com/login/device in the session Chrome; if GitHub is already signed in type the device code and click Authorize, poll until gh reports logged-in, and report with evidence. GitHub login/password/2FA → take-over (the device code is the only thing the agent ever types).
triggers: request_setup returned {state:'auto'} for capability `git`; a tool result carried needs_setup "git" (clone/push/PR needs credentials); "log in to GitHub", "תחבר את הגיטהאב".
capability: git
allowlist: github.com
argument-hint: none
---

# connect-github — device flow, driven from the session Chrome

Follow `skills/machine-work/SKILL.md`. Helpers: `skills/_lib/connect.sh`.
Server side: `server/git-login.ts` (pty-bridge around `gh auth login --web`)
via `POST /__api/onboarding/wizard/git {action:"gh-login"|"gh-cancel"}` and
`GET /__api/onboarding/wizard` → `ghLogin:{state, code, url}` (exists, admin-only).

## Hard rules
1. **Never type passwords / 2FA / OTP / recovery codes.** The GitHub login page is
   the take-over boundary. The **device code** (`XXXX-XXXX`) is the only text you
   type: it is shown to you by the CLI, single-use, and not a secret the human holds.
2. `export CONNECT_ALLOW="github.com"` — nothing else (GitHub SSO for an org lands on
   the org's IdP → take-over).
3. Consent first; ≤ 2 attempts.
4. Never create a PAT, SSH key, or change scopes; gh's default web-flow scopes only.

## Steps
0. Opening line + `set_progress`.
1. Start the flow: `connect.sh api POST /__api/onboarding/wizard/git '{"action":"gh-login"}'`
   → `ghLogin.state` `starting`. If `error` says gh is not installed →
   `report_setup({ok:false, detail:"gh CLI not installed"})` (card → token/manual).
2. Poll `connect.sh api GET /__api/onboarding/wizard` every 2 s (max 30 s) until
   `ghLogin.state == "awaiting"` and both `code` and `url` are set.
3. `connect.sh open "<url>"` (always `https://github.com/login/device`),
   `wait-url 'github\.com/login' 30`, `shot first`, `capture_screen({caption:"GitHub device page loaded"})`.
4. Decide from the screenshot:
   - **"Device Activation" with a code box** → signed in: click the first box,
     `connect.sh type "<code>"`, click **Continue**.
   - **"Sign in to GitHub"** → boundary: `capture_screen`,
     `request_screen({prompt:"Connecting GitHub for git/PR access — GitHub asks you to sign in.", reason:"login", hint:"Sign in, enter code <code>, click Authorize GitHub CLI, wait for 'Congratulations', then click Done."})`.
5. Authorization page ("Authorize GitHub CLI"): click **Authorize**. Then
   `wait-url 'github\.com/login/device/success|/login/device' 60` and a `shot`
   showing "Congratulations, you're all set!".
6. Poll `GET /__api/onboarding/wizard` until `ghLogin.state == "done"` (max 12 × 5 s).
   `error` → attempt 2 from step 1 (after `gh-cancel`), then fail.
7. Evidence + report: `connect.sh shot final` → `publish_artifact` →
   `report_setup({capability:"git", ok:true, evidence:"<artifact path>"})`,
   `capture_screen({caption:"GitHub CLI authorized"})`.
8. Summary line; continue the original git task.

## Failure handling
| Symptom | Do |
|---|---|
| Code expired ("This code has expired") | `gh-cancel`, attempt 2 from step 1 |
| Org SSO / SAML page | take-over (reason `login`) |
| `wizard` returns 403 (not admin) | `report_setup({ok:false, detail:"needs an admin session"})` |
| Success page but `ghLogin.state` stays `awaiting` | wait the full window; then fail with "gh did not confirm" |

## Retro
`skill_propose({name:"connect-github", …})` if GitHub's device page changed.
