# Getting signed in — `sign_in`

This file is the one description of how an Arigami session gets into a service. The prompt block (`login`,
`server/prompt-blocks.ts`) is three lines that point here; the vault design (`docs/INSTRUCTIONS-AND-VAULT.md`) covers
how values are stored and filled, not the order.

An agent calls **one tool**: `sign_in({site, reason})`. The order is in code (`server/lib/sign-in.ts` `ladder()`,
pinned by `test/sign-in.test.ts`), not in a prompt the model has to run in its head. The tool waits and answers one of:

| Answer | Meaning |
|---|---|
| `{status: "signed_in", via, next}` | done — `via` is `connection`, `saved`, `shared-chrome` or `cli`; `next` says where to work |
| `{status: "blocked", reason}` | stop and tell the human that one reason |
| `{status: "driving", next}` | a new sign-in is open in the owner's own Chrome and the shared desktop is the agent's — see below |

## The ladder

0. **A CLI** (`site: "gcloud"`): a credential that still works (`gcloud auth print-access-token`) is reused. Otherwise
   `gcloud auth login` runs with its browser step in the owner's Chrome (below): `BROWSER` is a tiny opener that hands
   the URL to the chosen profile, and the OAuth redirect lands on gcloud's own localhost listener — no code to copy.
1. **A connection the host already has** — `mcp:<service>` (Linear, Notion, Sentry, Figma, Vercel…), `composio:<toolkit>`
   (Gmail, Calendar, Drive, Slack), `git` (gh). Use its tools; no browser. `browser:true` skips this rung when the web
   page itself is needed.
2. **A saved login that is really signed in**, in the owner's everyday Chrome (any of its profiles) or in My browser.
   "Signed in" means a **session cookie** (`sessionIndicator` in `server/lib/login-sites.ts`: per site — Facebook
   `c_user`+`xs`, Google `SID`, GitHub `user_session`, Reddit `reddit_session`…; for other sites a cookie whose name
   reads like a session and is not a known visitor cookie). A visitor cookie (Facebook's `datr`, `fr`, `sb`, Cloudflare's
   `__cf_bm`, Google's `NID`) is httpOnly+secure too and is **not** a login — that was the false positive that sent an
   approved "Facebook login" with nothing in it. The login moves into the session's browser on the owner's standing
   "Always for <site>" or after their answer on a card. Google does not accept a copied session: signed in there means
   "work in the owner's Chrome" (`via: shared-chrome`), or use the Composio connection.
3. **A new sign-in in the owner's everyday Chrome on the shared desktop** (`:99`, their real profile). Driven with real
   mouse and keyboard (XTEST, `skills/_lib/xinput.py`) — **never DevTools**: a CDP browser trips bot checks (Facebook's
   "I'm not a robot", Google's "this browser may not be secure"). The host takes the shared-desktop lease itself
   (waiting in the queue if needed), opens the site in the chosen profile, and answers `driving`.

No shared desktop on the host (containers, macOS/Windows by default) → rung 3 is `blocked` with that reason.

## Driving a new sign-in

- **The agent looks and clicks**: `desktop_screenshot({shared:true})`, `desktop_pointer({shared:true})`,
  `desktop_keyboard({key, shared:true})` for Enter / Tab. It may type the account email; nothing else of its own.
- **The host types secrets**: the agent clicks into a field and calls `sign_in({site, fill: "username" | "password" | "otp"})`.
  The host checks (`sharedFillGuard`) that it still holds the lease, that the focused window is the owner's own Chrome
  browser process (not a CDP one), and that the page the profile last navigated to (its History) is on the site or a
  sign-in provider. A vault card for exactly that origin and that one field goes up; with the owner's per-site
  **auto** choice, an unlocked vault fills it with no tap. The value goes cockpit → host → `xinput.py type-secret` on
  **stdin** (never argv, never a log line, never the tool result), after the same check runs once more. A TOTP secret in
  the entry (`otp` = an `otpauth://` URI, or KeePass's `TOTP Seed`) fills a one-time-code field the same way.
- **The one hand-over**: a CAPTCHA, an SMS code or a push only the owner can do → `sign_in({site, human: "<exactly what to
  do>"})`. The card says where (the shared desktop, which Chrome profile) and what; the lease is parked meanwhile and
  comes back first.
- **Done**: `sign_in({site, done: true})` waits up to 45 s for the session cookie to reach disk (Chrome writes cookies in
  batches), releases the desktop, and carries that one site into the session's browser. A page that only *looks* signed
  in is not enough.

### The per-site vault permission

The minimal safe rule: the owner approves a site **once** — "Remember this choice" on its vault card, or the choice in
Settings › Connections › Passwords › *Choices per site* (`$ARIGAMI_DIR/login-prefs.json`, origin → `auto` | `manual`).
`auto` fills without a card only when the vault is unlocked in a cockpit tab and holds exactly one entry for that exact
origin; anything else shows the card. `manual` = the owner types that site themselves (the hand-over card). Nothing is
filled on a site that is not on the lease, and never into a window that is not the owner's Chrome.

## Where a login lives: one writer, one account per profile

The signed-in profile of the owner's Chrome is the source. Chrome is the only writer to it; sessions get a **copy of one
site** read from a snapshot of its files (`server/lib/owner-chrome.ts`, a headless Chrome of our own on the copy) and
nothing is written back — no `save_login` into My browser after a sign-in. The owner's two accounts of a site (work and
personal) live in two Chrome profiles: `sign_in({site, account})` picks one (an email, a profile name like `work.example`, a
domain); a site signed in under two profiles without `account` is `blocked` until the agent says which. Without either,
a new sign-in uses the profile signed in to the owner's identity (Google SSO works there), else the one Chrome last used.

## The tools that became internal

`browser_logins`, `request_login`, `request_credentials`, `sso_login` / `sso_look` / `sso_click` / `sso_navigate` /
`sso_done`, `save_login` are not listed to the model and refuse a call with "use sign_in"; their routes stay for the
cards already up and for `sign_in` itself. `save_browser_logins` stays for agent sessions (their own identity).
`shared_desktop_acquire` / `release` and `request_screen` stay for work that is not a sign-in.

## Gotchas

* Chrome's cookies on Linux with the basic password store are `v10` (a fixed key) and readable from a copy; a profile
  tied to a keyring (`v11`) is not offered.
* The owner's Chrome has no DevTools port, so the host knows its page only from the outside: the focused window's pid
  (`xprop _NET_WM_PID`) and the profile's History (committed within ~10 s). A sign-in page loaded more than 20 minutes
  ago is reloaded before a fill.
* `ownerChrome` in config.json / `ARIGAMI_OWNER_CHROME` choose the everyday Chrome (`false` / `0` = off);
  `ARIGAMI_OWNER_CHROME_PROFILE` pins one profile.
* Cloudflare Turnstile on some sites rejects synthetic clicks even in a real-profile Chrome — a site-specific limit;
  that is the `human` hand-over.
