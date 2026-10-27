# Getting signed in to a service — the order to try

An agent that needs a service never starts with a browser. Walk the ladder top to bottom and stop at the first
rung that works.

1. **An Arigami MCP connection** (`mcp:<service>` — Linear, Notion, Sentry, Vercel, Figma…; the host holds the grant
   for every engine, see `connect-mcp`). If the host already has it, use its tools. No browser, no login.
2. **The model's own connection** — a connector the engine itself carries (Claude's or Codex's). Check it before
   opening anything; it costs the human nothing.
3. **The browser**, in this order:
   1. **The session's isolated Chrome over CDP** (`browser_open`, `request_login` / the login vault). Best for in-page
      work: DOM-precise, cheap, concurrent. A site that offers **SSO** (Continue with Google / Microsoft…) → `sso_login`
      first: the SSO runs in the owner's own browser ("My browser" — the only one signed in to their account), the
      agent clicks through it in a tab of its own (no typing, only that site and the sign-in pages), and `sso_done`
      carries the login into the session. No SSO → a fresh sign-in on the site's form with
      `request_credentials`: the human fills it from their credential vault (or types it once on the card), the host
      puts it into the page, and the agent never sees it.
   2. **Blocked by automation detection** (Google "this browser may not be secure", a CAPTCHA, "enter your email",
      Cloudflare Turnstile) → do the SSO in the **shared desktop's Chrome** (the owner's everyday profile, already
      signed in to Google), through the host's lease: `shared_desktop_acquire({site})`, then the `desktop_*` tools with
      `shared:true` — one session at a time, the others queued and woken (see `docs/DESKTOP-CONTROL.md`). If Google
      asks for the password again, that is `request_screen` — the agent never types it.
   3. **Keep the result.** `shared_desktop_release`, then `request_login(site)`: the host reads that one site's login
      from the everyday profile **on disk** (a snapshot copy opened by a headless Chrome of its own — the owner's
      Chrome is never driven or written) and carries it into the session's Chrome, with the same per-site approval,
      policies and post-transfer check as a My-browser login. Off where there is no everyday Chrome (containers,
      Windows/macOS by default); `ownerChrome` in config.json / `ARIGAMI_OWNER_CHROME` set it (`false` / `0` = off).

Passwords, 2FA and OTP are never typed by the agent: a sign-in form is `request_credentials`; a CAPTCHA, a payment or a
push approval is `request_screen`.

## Why a profile copy, not exported cookies

Measured on Linear and Notion (Google SSO, the profile already signed in to Google):

* Exporting only the cookies into a fresh CDP Chrome did **not** sign Linear in (back to its login page). A site's
  session is more than its cookies (localStorage, IndexedDB, device state).
* A CDP Chrome started on a **copy** of the signed-in profile was signed in to Linear immediately, and "Continue with
  Google" on Notion went straight to the account chooser → dashboard, with no Google password or challenge.

## Gotchas

* Chrome refuses `--remote-debugging-port` on its **default** user-data-dir ("requires a non-default data
  directory"). Copy the profile folder (`Profile 1`, the one named after the account — look in `Local State` →
  `profile.info_cache`, not `Default`) plus `Local State` to a new dir, then start Chrome there with the port.
* Do the copy **after** a graceful close, or the cookie journal is half-written.
* A profile copy holds live sessions: keep it under the instance dir with the same permissions as the login vault,
  never commit or share it.
* `--remote-debugging-port` sets `navigator.webdriver`; some sites (and Google's sign-in) react to it. That is why
  rung 3.2 exists.
* Cloudflare Turnstile on some sites rejects synthetic clicks even in a real-profile Chrome — a site-specific
  limit, not a reason to skip the ladder.
