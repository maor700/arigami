---
description: JIT-setup playbook for the `remote` capability — bring Tailscale up on the host (the CLI prints a login URL), open that URL in the session Chrome, sign in with Google SSO using the connected identity, confirm the device, then enable `tailscale serve` through the host REST (POST /__api/remote) and report with evidence. Password/2FA → take-over; sudo prompts are never answered by the agent.
triggers: request_setup returned {state:'auto'} for capability `remote`; "make the cockpit reachable from my phone", "enable remote access", "תחבר את הטיילסקייל".
capability: remote
allowlist: login.tailscale.com tailscale.com accounts.google.com google.com
argument-hint: none
---

# connect-tailscale — login URL → Google SSO → serve

Follow `skills/machine-work/SKILL.md`. Helpers: `skills/_lib/connect.sh`.
Server side: `server/remote.js` via `GET/POST /__api/remote` (exists).

## Hard rules
1. **Never type passwords / 2FA / OTP**, and never answer a `sudo` password prompt —
   if `tailscale` needs root on this host, that is a manual step (report failure
   with the reason; the card shows the human the exact command).
2. `export CONNECT_ALLOW="login.tailscale.com tailscale.com accounts.google.com google.com"`.
3. Consent first; ≤ 2 attempts.
4. Never change ACLs, keys, exit nodes or Funnel here. Only: log the node in, then
   `serve` on the host port via the REST — the same thing Settings → Remote does.

## Steps
0. Opening line + `set_progress`.
1. State: `connect.sh api GET /__api/remote` → `{available, loggedIn, serving}`.
   - `available:false` → `report_setup({ok:false, detail:"tailscale not installed"})`.
   - `loggedIn:true` → skip to step 6.
2. Ask the CLI for a login URL without blocking the session:
   `tailscale login --timeout 10m > "/tmp/ts-login-$ARIGAMI_SESSION_ID.txt" 2>&1 &`
   (fallback on older CLIs: `tailscale up --timeout 10m`). Within ~5 s the file
   contains `https://login.tailscale.com/a/<code>`. If it contains
   "Access denied"/"sudo"/"operator" → rule 1 → fail with that line.
3. `connect.sh open "<login url>"`, `wait-url 'login\.tailscale\.com' 30`, `shot first`,
   `capture_screen({caption:"Tailscale login page loaded"})`.
4. Click **Sign in with Google**. Account chooser → pick the identity email.
   A password/2FA screen, or a non-Google SSO the tailnet is bound to → boundary:
   `capture_screen`, `request_screen({prompt:"Connecting this machine to your tailnet — Tailscale asks you to sign in.", reason:"login", hint:"Sign in, click Connect on the device page, wait for 'Success', then click Done."})`.
5. The device page ("Connect device … as <tailnet>"): click **Connect**. Then
   `wait-url 'login\.tailscale\.com/a/.*success|/admin' 60` or see "Success" in a `shot`.
   The background CLI exits; `connect.sh api GET /__api/remote` must now say `loggedIn:true`
   (poll up to 6 × 5 s).
6. Enable serve: `connect.sh api POST /__api/remote '{"enable":true}'` → `{ok, httpsUrl}`.
   `ok:false` with an HTTPS-certificates hint → not automatable: report failure
   with the hint verbatim (the human enables HTTPS in the admin console once).
7. Evidence + report: `connect.sh shot final` → `publish_artifact` →
   `report_setup({capability:"remote", ok:true, evidence:"<artifact path>", detail:"serving"})`,
   `capture_screen({caption:"Tailscale connected, serve enabled"})`.
8. Summary line — mention the remote URL only as returned by the host (never a raw IP).

## Failure handling
| Symptom | Do |
|---|---|
| Login URL never appears | kill the background CLI, attempt 2 with `tailscale up`; then fail |
| "Device already approved by an admin" pending | fail with "needs admin approval in the Tailscale console" |
| Redirect to a SAML/OIDC portal outside the allowlist | take-over (reason `login`) |
| `POST /__api/remote` says serve not enabled on the tailnet | report failure with the hint; not a retry case |

## Retro
`skill_propose({name:"connect-tailscale", …})` if the login page layout changed.
