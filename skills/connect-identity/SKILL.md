---
description: JIT-setup playbook for the `identity` capability — get the human logged in to Google ONCE in the session Chrome (take-over; the agent never types the password), verify the signed-in state on myaccount.google.com, sync the login to the shared base profile (save_browser_logins) and register the identity with the host (POST /__api/setup/identity). After this, connect-composio / connect-claude / connect-tailscale can pick the Google account automatically.
triggers: request_setup returned {state:'auto'} for capability `identity`; a SetupCard asks "sign in to Google once"; any connect-* playbook finds no Google account in the session Chrome; "connect my Google account", "תתחבר לגוגל".
capability: identity
allowlist: accounts.google.com myaccount.google.com google.com
argument-hint: [expected email, optional]
---

# connect-identity — Google login once, via take-over

Follow `skills/machine-work/SKILL.md` (narration, the four screenshot moments,
hand-over rules). Helpers: `skills/_lib/connect.sh` (open / nav / url / wait-url /
shot / click / key / type / api / report) and `skills/_lib/chrome.sh`.

## Hard rules (apply to every connect-* playbook)

1. **Never type passwords, 2FA codes, OTPs, recovery codes or CAPTCHA answers.**
   Any screen that asks for one is the **take-over boundary**: `capture_screen`,
   then `request_screen` and wait. `connect.sh type` is for URLs and one-time
   *device* codes shown to you by a CLI — nothing the human knows and you don't.
2. **Domain allowlist.** Export `CONNECT_ALLOW="accounts.google.com myaccount.google.com google.com"`
   before any `open`/`nav`; `connect.sh` refuses everything else. If a redirect lands
   outside the list, stop and hand over — do not follow it yourself.
3. **Consent first.** You only run because the human clicked "Connect automatically"
   on the SetupCard (or asked in chat). Never start a login flow on your own.
4. **≤ 2 attempts.** On the second failure call `report_setup({ok:false})` with the
   reason — the card falls back to manual; you do not loop.
5. **No secrets on disk.** Cookies live only in the session Chrome profile and its
   base sync. Never write tokens/cookies/emails into files, artifacts or memory.

## Steps

0. Opening line in chat (machine-work §1) and `set_progress` with the steps below.
1. `export CONNECT_ALLOW="accounts.google.com myaccount.google.com google.com"`.
2. Open the account page — this is where a signed-in profile shows its avatar,
   and a signed-out one shows the login form:
   `skills/_lib/connect.sh open "https://myaccount.google.com/"` (`open` also
   navigates a Chrome that is already running — it never leaves the old page up)
   then `connect.sh wait-url 'google\.com' 30` and `connect.sh shot first` — view it
   (`Read` the PNG) and `capture_screen({caption:"Google account page loaded"})`.
3. **Already signed in?** (avatar + name on myaccount, URL stays on
   `myaccount.google.com`): skip to step 6.
   **Signed out** looks like a redirect to `google.com/account/about` (the
   marketing page with "Sign in with Google" / "Go to Google Account") — treat it
   exactly like step 4: `connect.sh nav "https://accounts.google.com/"` to reach the
   login form, then hand over.
4. **Login form / account chooser with no session** (URL on `accounts.google.com`):
   this is the boundary. Post one line ("Google asks for the password — handing over"),
   `capture_screen`, then:
   ```
   request_screen({
     prompt: "Signing in to Google once so I can connect services for you — it asks for your password.",
     reason: "login",
     hint:   "Sign in (password + 2FA if asked). When you see your Google Account page with your name, click Done."
   })
   ```
   Do nothing on the machine while it blocks. The host resolves the open identity
   card itself when the human clicks Done and a Google account is detected in the
   session's Chrome (`POST /__api/setup/identity` becomes a no-op then) — a
   `{state:"skipped"}` only ever means the human clicked "Not now".
5. After Done: `capture_screen({caption:"After human login"})`, `connect.sh nav "https://myaccount.google.com/"`,
   `wait-url 'myaccount\.google\.com' 30`, `shot verify` and confirm the signed-in
   state. Not signed in → one more `request_screen` with a more specific hint
   (rule 4), then give up.
6. Offer to keep the login for future sessions: `save_login({ site: "google.com",
   reason: "so other sessions can ask for it" })`. The human sees a card and
   nothing is saved unless they approve; only Google moves, nothing else in your
   browser. When you run as an AGENT (ARIGAMI_AGENT is set), `save_browser_logins()`
   instead keeps it in the agent's own profile (`agents/<slug>/browser`).
7. Register the identity with the host. The email is what the account page shows
   (top-right avatar → the address). Read it from the screenshot; if `$ARGUMENTS`
   gave an expected email and it differs, stop and `request_action` (wrong account
   vs. continue). Then:
   `connect.sh api POST /__api/setup/identity '{"email":"<email>","provider":"google","chromeProfile":"base"}'`
   (S1 writes `$ARIGAMI_DIR/identity.json` — no secrets, the email only. A2: from
   an agent session the host writes the AGENT's `agents/<slug>/identity.json`
   instead — owner `agent:<slug>`; omit `chromeProfile` then.)
8. Evidence: `connect.sh shot final` → `publish_artifact({path:<png>, title:"identity — Google signed in"})`
   → `report_setup({capability:"identity", ok:true, evidence:"<artifact path>"})`.
   `capture_screen({caption:"Final state — Google signed in"})`.
9. Summary line (machine-work §5): what was connected, that the human typed the
   password (you didn't), and that Chrome is left signed in on purpose.

## Failure handling

| Symptom | Do |
|---|---|
| `request_screen` timed out | `report_setup({ok:false, detail:"human did not complete login"})`, stop |
| Google shows "This browser may not be secure" | hand over with hint "sign in from the Take-over view; if Google refuses, use Manual on the card" |
| Redirect outside the allowlist (SSO portal of a workspace) | do not follow; `request_screen` with reason `login` |
| `POST /__api/setup/identity` → 404 | S1 not deployed on this host: still `report_setup`; mention identity.json wasn't written |
| No desktop (`DISPLAY` unset, `chrome.sh` fails) | `report_setup({ok:false, detail:"no desktop"})` — the card goes manual |

## Retro
If a selector/wait/hint would have saved a round-trip, `skill_propose({name:"connect-identity", …})` once.
