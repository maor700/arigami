# Getting signed in to a service — the order to try

An agent that needs a service never starts with a browser. Walk the ladder top to bottom and stop at the first
rung that works.

1. **An Arigami MCP connection** (`mcp:<service>` — Linear, Notion, Sentry, Vercel, Figma…; the host holds the grant
   for every engine, see `connect-mcp`). If the host already has it, use its tools. No browser, no login.
2. **The model's own connection** — a connector the engine itself carries (Claude's or Codex's). Check it before
   opening anything; it costs the human nothing.
3. **The browser**, in this order:
   1. **The session's isolated Chrome over CDP** (`browser_open`, `request_login` / the login vault). Best for in-page
      work: DOM-precise, cheap, concurrent.
   2. **Blocked by automation detection** (Google "this browser may not be secure", a CAPTCHA, Cloudflare Turnstile)
      → do the SSO in the **shared machine's Chrome** (the desktop icon; the human's own profile, already signed in to
      Google), driven with `desktop_*`. This saves the human an intervention. If Google asks for the password again,
      that is `request_screen` — the agent never types it.
   3. **Keep the result.** Close that Chrome **gracefully** (`browser_close` does; a SIGTERM loses fresh cookies), then
      open the CDP Chrome on a **copy of that profile directory** (see below) and carry on.

Passwords, 2FA and OTP are never typed by the agent.

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
