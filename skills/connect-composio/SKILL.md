---
description: JIT-setup playbook for `composio:<toolkit>` (gmail, googledrive, googlecalendar, slack, linear, notion…) — ask the host for the Composio OAuth redirect URL, open it in the session Chrome, pick the identity account, get through Google's "unverified app / Advanced → continue" and Allow screens, poll the connected account until ACTIVE, and report with an evidence screenshot. Password/2FA screens = take-over.
triggers: request_setup returned {state:'auto'} for capability `composio:<toolkit>`; a tool result carried needs_setup "composio:gmail" (or any toolkit); "connect Gmail/Drive/Calendar/Slack/Notion/Linear through Composio", "תחבר את הג'ימייל".
capability: composio:<toolkit>
allowlist: backend.composio.dev composio.dev accounts.google.com google.com slack.com linear.app notion.so
argument-hint: <toolkit slug, e.g. gmail>
---

# connect-composio — OAuth consent in the session Chrome

Follow `skills/machine-work/SKILL.md`. Helpers: `skills/_lib/connect.sh`.
`$ARGUMENTS` (or the `needs_setup` value after `composio:`) is the toolkit slug.

## Hard rules
1. **Never type passwords / 2FA / OTP** — such a screen is the take-over boundary
   (`request_screen`). Composio's flow normally has none when `identity` is connected.
2. **Allowlist**: `export CONNECT_ALLOW="backend.composio.dev composio.dev accounts.google.com google.com <provider domain>"`
   where the provider domain is the one that matches the toolkit (`slack.com`,
   `linear.app`, `notion.so`; Google toolkits need only the Google domains). Nothing else.
3. **Consent first** — run only after the human chose "Connect automatically".
4. **≤ 2 attempts**, then `report_setup({ok:false, detail})`.
5. Scopes are whatever the consent page lists — you do not add or remove anything;
   you click **Allow/Continue** only for the toolkit the card asked for.

## Preconditions
- `identity` connected (`GET /__api/setup/capabilities` → `identity.ok`; as an AGENT
  add `?owner=agent:<slug>` — the agent needs its OWN Google identity, the host's
  shared one does not drive the agent's Chrome profile). If not:
  run `skills/connect-identity` first (call `request_setup({capability:"identity"})`
  so the human sees the card) — never continue with a foreign Google account.
- Composio API key present on the host (the same `GET` shows `composio` status).
  Missing → `report_setup({ok:false, detail:"no Composio key"})`; the card goes manual.

## Steps
0. Opening line + `set_progress`.
1. Get the redirect URL from the host (S1):
   `connect.sh api POST /__api/setup/composio:<toolkit> '{"mode":"auto"}'` → `{redirectUrl, id, owner}`.
   (A2: from an agent session the host keys the Composio account to the agent —
   `user_id: agent:<slug>` — so the agent's Gmail is not the host's Gmail.)
   If that route is `not found` (S1 not deployed) use the legacy twin:
   `connect.sh api POST /__api/composio/connect '{"toolkitSlug":"<toolkit>"}'`.
   An `error` field → report failure, stop.
2. `connect.sh open "<redirectUrl>"` (the host of the URL must be in the allowlist —
   Composio hands out `backend.composio.dev/...` links which then redirect to the
   provider). `open` = ensure Chrome + navigate: if this session's Chrome is
   already running (e.g. connect-identity just used it) it is navigated to the
   URL, you never need a separate `nav`. `wait-url 'accounts\.google\.com|<provider domain>' 45`, `shot first`,
   `capture_screen({caption:"Consent flow opened for <toolkit>"})`.
3. **Account chooser** ("Choose an account"): click the row whose email equals the
   identity email (`GET /__api/setup/capabilities` → identity detail). Never "Use
   another account". If a password box appears instead → boundary (rule 1):
   `capture_screen`, `request_screen({prompt:"Connecting <toolkit> via Composio — Google asks you to sign in.", reason:"login", hint:"Sign in, approve the consent screen, wait for the 'Connected' page, then click Done."})`
   and after Done re-verify from step 5.
4. **"Google hasn't verified this app"** (common with Composio-managed auth):
   click **Advanced** (small link, bottom-left), then **Go to … (unsafe)**.
   Then the scopes page: tick **Select all** if Google shows checkboxes, click
   **Continue / Allow**. Take a viewing `shot` between clicks when you need the
   coordinates — those are not milestone captures.
5. Wait for the redirect back: `wait-url 'composio\.dev' 60`. The page says the
   account is connected (or shows an error text — read it via `shot`).
6. Poll the host until the account is ACTIVE (max 12 × 5 s):
   `connect.sh api GET /__api/composio/connections` → find `id` from step 1 (or
   the newest entry for the toolkit) with `status == "ACTIVE"`.
   `INITIATED`/`FAILED` after the polling window → attempt 2 from step 1, then fail.
   Stale accounts a failed attempt left behind (`INITIALIZING`/`FAILED`) are
   pruned by the host once one account for the toolkit is ACTIVE (also on demand:
   `connect.sh api DELETE "/__api/setup/composio:<toolkit>?orphans=1"`).
7. Evidence + report: `connect.sh shot final` → `publish_artifact` →
   `report_setup({capability:"composio:<toolkit>", ok:true, evidence:"<artifact path>"})`.
   `capture_screen({caption:"<toolkit> connected"})`.
8. Summary line; then **continue the original task** — the tool that returned
   `needs_setup` can be called again now.

## Failure handling
| Symptom | Do |
|---|---|
| Consent page lists a different app/toolkit than asked | do not Allow; `report_setup({ok:false, detail:"unexpected consent target"})` |
| Redirect leaves the allowlist | stop, `request_screen` (reason `other`) with the URL host in the hint |
| "Access blocked: this app's request is invalid" (Google) | fail with the message — the Composio auth config needs a fix, not a retry |
| Provider login page (Slack/Notion/Linear) | take-over (they are not covered by the Google identity) |
| `connections` never ACTIVE | fail after attempt 2, include the last status |

## Retro
`skill_propose({name:"connect-composio", …})` for a new provider-specific screen you had to handle.
