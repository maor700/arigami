---
description: JIT-setup playbook for the `identity` capability — get the owner's account provider (Google, Microsoft or Apple) signed in ONCE in their own Chrome on the shared desktop (sign_in — the host types the password from the vault, the owner only approves a 2FA push), read which account it is, and register the identity with the host (POST /__api/setup/identity, provider + chromeProfile "chrome:<profile dir>"). After this, "Continue with Google / Microsoft / Apple" and the connect-* playbooks use that Chrome profile.
triggers: request_setup returned {state:'auto'} for capability `identity`; a SetupCard asks to sign in once; onboarding; "connect my Google / Microsoft / Apple account", "תתחבר לגוגל", "תתחבר למיקרוסופט".
capability: identity
allowlist: accounts.google.com myaccount.google.com google.com login.microsoftonline.com login.live.com account.microsoft.com myaccount.microsoft.com appleid.apple.com account.apple.com
argument-hint: [provider google|microsoft|apple, expected email or which account — work / personal; all optional]
---

# connect-identity — the account provider once, in the owner's own Chrome

Which provider: what the human named (or `$ARGUMENTS`); otherwise ask once with `request_action` — Google, Microsoft or
Apple. Chrome's own sign-in (sync) is Google-only and not needed: the provider is signed in INSIDE a Chrome profile, and
a profile without a Chrome account is told apart by its name ("Work", "Personal").

| provider | `sign_in` site | where the account email shows |
|---|---|---|
| google | `accounts.google.com` | `myaccount.google.com` (under the avatar) |
| microsoft | `microsoft` (opens login.microsoftonline.com; personal accounts go on to login.live.com) | `myaccount.microsoft.com` (work) or `account.microsoft.com` (personal) |
| apple | `apple` (opens account.apple.com) | `account.apple.com` |

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

0. Opening line in chat and `set_progress`: "signing <provider> in once in your own Chrome — the password from your vault,
   you may get a push on your phone". `export CONNECT_ALLOW="accounts.google.com myaccount.google.com google.com login.microsoftonline.com login.live.com account.microsoft.com myaccount.microsoft.com appleid.apple.com account.apple.com"`
   (the provider hosts of the table) (`skills/_lib/connect.sh` is used for the host call in step 4).
1. `sign_in({site:<the provider's site>, reason:"connect your Google account once", account:<if given>})`.
   - `signed_in` → Google is already signed in there: go to step 3 (its `profile` is the Chrome profile dir).
   - `blocked` → `report_setup({capability:"identity", ok:false, detail:<reason>})`, stop.
   - `driving` → step 2.
2. Drive the sign-in (machine-work §3): `desktop_screenshot({shared:true})`; the email box → click it and type the
   account email (`desktop_keyboard({text, shared:true})`, then Return); the password box → click it,
   `sign_in({site:<the provider's site>, fill:"password"})`, Return; "Verify it's you" / a push / an SMS code →
   `sign_in({site:<the provider's site>, human:"Approve the sign-in on your phone (Google prompt), then press Done"})`.
   When the page shows the Google account: `sign_in({site:<the provider's site>, done:true})` → `signed_in`.
3. Read the email: `shared_desktop_acquire({site:<the provider's domain>, reason:"read which account is signed in"})`,
   `desktop_keyboard({key:"ctrl+t", shared:true})`, type the account page from the table + Return, `desktop_screenshot({shared:true})`
   and read the account address; `capture_screen({caption:"<provider> signed in — your Chrome"})` and publish that
   frame as the evidence (`publish_artifact({path:<the desktop_screenshot file>, title:"identity — <provider> signed in"})`);
   `shared_desktop_release`. If `$ARGUMENTS` named a different email, stop and
   `request_action` (wrong account vs. continue).
4. Register it: `connect.sh api POST /__api/setup/identity '{"email":"<email>","provider":"<google|microsoft|apple>","chromeProfile":"chrome:<profile>"}'`
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
