---
description: JIT-setup playbook for the `identity` capability — get Google signed in ONCE in the owner's own Chrome on the shared desktop (sign_in — the host types the password from the vault, the owner only approves a 2FA push), read which account it is, and register the identity with the host (POST /__api/setup/identity, chromeProfile "chrome:<profile dir>"). After this, sign_in's "Continue with Google" and the connect-* playbooks use that Chrome profile.
triggers: request_setup returned {state:'auto'} for capability `identity`; a SetupCard asks "sign in to Google once"; onboarding; "connect my Google account", "תתחבר לגוגל".
capability: identity
allowlist: accounts.google.com myaccount.google.com google.com
argument-hint: [expected email or which account — work / personal, optional]
---

# connect-identity — Google once, in the owner's own Chrome

Follow `skills/machine-work/SKILL.md` (narration, the screenshot moments). The sign-in itself is `sign_in`
(`docs/LOGIN.md`): it runs in the owner's everyday Chrome on the shared desktop, where Google treats it as a person, and
the host — not you — types the password from the vault.

## Hard rules

1. **Never type passwords, 2FA codes or recovery codes.** The password is `sign_in({site, fill:"password"})`; a phone
   approval, an SMS code or a CAPTCHA is `sign_in({site, human:"<exactly what to do>"})`. You may type the account email.
2. **Consent first.** You run because the human clicked "Connect automatically" or asked. Never start a sign-in on your own.
3. **≤ 2 attempts**, then `report_setup({ok:false})` with the one reason `sign_in` gave.
4. **No secrets on disk.** The email is the only thing written (identity.json).
5. **One account per Chrome profile.** Work and personal Google accounts live in two profiles of that Chrome; pass
   `account` (an email, a profile name, "Profile 1") when the human said which.

## Steps

0. Opening line in chat and `set_progress`: "signing Google in once in your own Chrome — the password from your vault,
   you may get a push on your phone". `export CONNECT_ALLOW="accounts.google.com myaccount.google.com google.com"`
   (`skills/_lib/connect.sh` is used for the host call in step 4).
1. `sign_in({site:"accounts.google.com", reason:"connect your Google account once", account:<if given>})`.
   - `signed_in` → Google is already signed in there: go to step 3 (its `profile` is the Chrome profile dir).
   - `blocked` → `report_setup({capability:"identity", ok:false, detail:<reason>})`, stop.
   - `driving` → step 2.
2. Drive the sign-in (machine-work §3): `desktop_screenshot({shared:true})`; the email box → click it and type the
   account email (`desktop_keyboard({text, shared:true})`, then Return); the password box → click it,
   `sign_in({site:"accounts.google.com", fill:"password"})`, Return; "Verify it's you" / a push / an SMS code →
   `sign_in({site:"accounts.google.com", human:"Approve the sign-in on your phone (Google prompt), then press Done"})`.
   When the page shows the Google account: `sign_in({site:"accounts.google.com", done:true})` → `signed_in`.
3. Read the email: `shared_desktop_acquire({site:"google.com", reason:"read which Google account is signed in"})`,
   `desktop_keyboard({key:"ctrl+t", shared:true})`, type `myaccount.google.com` + Return, `desktop_screenshot({shared:true})`
   and read the address under the avatar; `capture_screen({caption:"Google signed in — your Chrome"})` and publish that
   frame as the evidence (`publish_artifact({path:<the desktop_screenshot file>, title:"identity — Google signed in"})`);
   `shared_desktop_release`. If `$ARGUMENTS` named a different email, stop and
   `request_action` (wrong account vs. continue).
4. Register it: `connect.sh api POST /__api/setup/identity '{"email":"<email>","provider":"google","chromeProfile":"chrome:<profile>"}'`
   with `<profile>` = the `profile` field of the `signed_in` answer (e.g. `Profile 1`). (From an AGENT session the host
   writes the agent's own identity; omit chromeProfile then.)
5. `report_setup({capability:"identity", ok:true, evidence:"<artifact path>"})`, one summary line: which account, which Chrome profile, that the
   password came from the vault and the human only approved what Google asked.

## Failure handling

| Symptom | Do |
|---|---|
| `request_screen` timed out | `report_setup({ok:false, detail:"human did not complete login"})`, stop |
| Google shows "This browser may not be secure" | it should not in the owner's own Chrome; `sign_in({site, human})` with exactly what the page shows |
| Redirect outside the allowlist (SSO portal of a workspace) | do not follow; `request_screen` with reason `login` |
| `POST /__api/setup/identity` → 404 | S1 not deployed on this host: still `report_setup`; mention identity.json wasn't written |
| `sign_in` answers blocked: no shared desktop | the older way, on this session's desktop: `capture_screen`, `request_screen({prompt:"Signing in to Google once so I can connect services for you.", reason:"login", hint:"Sign in (password + 2FA if asked). When you see your Google Account page with your name, click Done."})`; still nothing → `report_setup({ok:false, detail:<reason>})` |

## Retro
If a selector/wait/hint would have saved a round-trip, `skill_propose({name:"connect-identity", …})` once.
