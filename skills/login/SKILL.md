---
description: Invoked as a subagent. Open the local dev URL in the persistent Playwright Chromium profile (`~/.playwright-acme`, already logged in) and complete login. Reads the preferred auth method from `.claude/settings.local.json` (`user.loginMethod`) — defaults to `google-sso` (click "Continue with Google", let the profile's existing Google session auto-redirect). Falls back to the Firebase E2E credentials when explicitly configured. Returns `{ url, isAuth, needsInteractiveAuth, envFiles }`.
argument-hint: <dev-url> <worktree-path>
disable-model-invocation: true
---

# Login (subagent)

Drive the persistent Playwright Chromium profile (`$PW_PROFILE_DIR`, default `~/.playwright-acme`, via Playwright MCP) to log into the local dev app. All browser actions use `mcp__plugin_playwright_playwright__*` tools; JS snippets below run via `browser_evaluate` (wrap each in `() => { ... }`). Two methods:

- **`google-sso`** (default) — click "Continue with Google" on the login page; the profile's already-authenticated Google session auto-redirects to `/dashboard/*` within a few seconds. No password typed. Uses the operator's real account, so all pages (including `/settings/*`, `/policies/create`) are accessible.
- **`e2e`** — drive the Firebase email/password form with `E2E_EMAIL` / `E2E_PASSWORD` from `.env.local` via the page-side `_lib/login-e2e.js` helper. Useful for shared CI machines or when you specifically need the limited-permission test account.

The method is picked from `.claude/settings.local.json` → `user.loginMethod` (per-machine, gitignored). Default: `google-sso`.

## Inputs

`$ARGUMENTS` — `<dev-url> <worktree-path>`, e.g. `http://localhost:3408/ $WORKTREES_DIR/ENG-1234`.

## Steps

### 1. Sanity-check the dev URL is up

```bash
curl -sI <dev-url> | head -1
```

Expect `HTTP/1.1 200`. If 4xx/5xx, return `isAuth: false, needsInteractiveAuth: false, reason: "dev server not responding"`.

### 2. Read the preferred login method

```bash
source "${ARIGAMI_SKILLS:-$HOME/Desktop/repos/arigami/skills}/_lib/config.sh"
SETTINGS="$WORKSPACE_ROOT/.claude/settings.local.json"
LOGIN_METHOD=$(jq -r ".user.loginMethod // \"$LOGIN_METHOD\"" "$SETTINGS" 2>/dev/null)
AUTH_EMAIL=$(  jq -r '.user.authEmail   // ""'              "$SETTINGS" 2>/dev/null)
```

### 3. Open the dev URL in the Playwright profile

First ensure the **shared** Chrome is up (idempotent; all Playwright MCP servers attach to it over CDP rather than launching their own — see `$PW_MCP_CONFIG` `browser.cdpEndpoint`):

```bash
source "${ARIGAMI_SKILLS:-$HOME/Desktop/repos/arigami/skills}/_lib/config.sh"
"$PW_HELPER_DIR/ensure-browser.sh"
```

- `mcp__plugin_playwright_playwright__browser_tabs(action: "list")` — the list shows **all** tabs in the shared browser, including ones other parallel agents own. Reuse a tab already on `http://localhost:<devPort>/*` for **this** worktree (select it with `action: "select"`); otherwise `browser_tabs(action: "new")`. Only select/close tabs for your own dev port.
- `mcp__plugin_playwright_playwright__browser_navigate(url: <dev-url>)` (Playwright auto-waits for load).

### 4. Detect current login state

```js
;({
  path: location.pathname,
  hasGoogleSso: !!Array.from(document.querySelectorAll('button, a, [role="button"]')).find((el) =>
    /continue with google|sign in with google/i.test(el.textContent || ''),
  ),
  hasPasswordInput: !!document.querySelector('input[type="password"]'),
  hasEmailInput: !!document.querySelector('#email, input[type="email"], input[name="email"]'),
})
```

If `path` is past `/login` (e.g. `/dashboard/*`) → already authenticated, skip to step 7.

### 5. Drive login per `LOGIN_METHOD`

**`google-sso`** (default):

The Acme login is two-step: an email gate, then a provider chooser. Drive both:

1. **Type the email into `#email`** and submit the gate. JS click is fine here (no popup):

   ```js
   ;(() => {
     const el = document.getElementById('email')
     const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
     setter.call(el, '<AUTH_EMAIL>')
     el.dispatchEvent(new Event('input', { bubbles: true }))
     el.dispatchEvent(new Event('change', { bubbles: true }))
     document.querySelector('button[type="submit"]')?.click()
   })()
   ```

   Wait ~1.5s for the provider chooser to render ("Continue with Google", "Continue with Microsoft", ...).

2. **Real mouse click on "Continue with Google"** — NOT a JS `.click()`. The OAuth popup requires a real user gesture or it gets blocked and the page shows "Sign-in failed. Please try again." Playwright clicks are real user gestures:

   ```
   mcp__plugin_playwright_playwright__browser_snapshot()
   # find the "Continue with Google" button's ref in the snapshot, then:
   mcp__plugin_playwright_playwright__browser_click(element: "Continue with Google button", ref: <ref>)
   ```

3. Wait ~5 seconds for Chrome's existing Google session to silently redirect, then poll `location.pathname` until it leaves `/login`, max 10s:

   ```js
   ;(async () => {
     const start = Date.now()
     while (Date.now() - start < 10000) {
       if (!location.pathname.startsWith('/login')) return location.pathname
       await new Promise((r) => setTimeout(r, 500))
     }
     return location.pathname
   })()
   ```

If after the real click the body shows "Sign-in failed. Please try again." (and path stayed on `/login`), the cached Google session is invalid or the account chooser appeared. Return `isAuth: false, needsInteractiveAuth: true, reason: "Google SSO failed — sign in manually as <AUTH_EMAIL>, then reply 'continue'"`.

**`e2e`** (legacy / shared-CI):

Use the page-side script at `$SKILLS_LIB/login-e2e.js` (from config.sh). Stash creds, eval the script via `mcp__plugin_playwright_playwright__browser_evaluate`, poll `window.__loginDone`, verify success. Details in the file's header comment.

### 6. Verify we landed on the dashboard

```js
location.pathname
```

Must start with `/dashboard`. If not, return `isAuth: false, needsInteractiveAuth: true, reason: "<final path>"`.

### 7. List env files

```bash
ls -1 <worktree-path>/.env.local <worktree-path>/.env.development.local 2>/dev/null
```

## Return to main session

Single fenced JSON block — no other code blocks after it.

Success:

```json
{
  "url": "<dev-url>",
  "isAuth": true,
  "needsInteractiveAuth": false,
  "envFiles": [".env.local", ".env.development.local"],
  "authEmail": "<email>",
  "loginMethod": "google-sso" | "e2e" | "pre-existing"
}
```

Failure:

```json
{
  "url": "<dev-url>",
  "isAuth": false,
  "needsInteractiveAuth": true,
  "envFiles": [...],
  "reason": "<short message>",
  "instructions": "Complete the login at <dev-url> in Chrome, then reply 'continue' in the chat."
}
```

Keep your text response under 20 lines.

## Rules

- **Never type Google passwords.** SSO only auto-redirects when the Playwright profile (`$PW_PROFILE_DIR`) already has a valid Google session for the operator's account. If a password prompt appears, return needsInteractiveAuth.
- Never echo, log, or persist credentials beyond `.env.local` (managed by `vercel env pull`).
- Use the dev URL provided — do not navigate to `https://app.example.com`.
- If the user is auth'd to a different tenant than expected, that's not an auth failure — flag it in `instructions` but return `isAuth: true`.
- **Never log out as a setup step.** The worktree port pool (`3020-3070` / `6020-6070`) is designed for cookie reuse — a tab on `localhost:<port>` almost always has a still-valid session. Step 4's probe is authoritative: if it lands on `/dashboard/*`, return `loginMethod: "pre-existing"` immediately. Do not navigate to `/login`, click "switch account", or clear cookies to "be safe" — that burns the saved session and the operator's tokens.
- **Never navigate to `/login` first.** Always navigate to the requested `<dev-url>` (typically `/` or a deep link) and let the app's own router decide whether to redirect to `/login`. Pre-emptively hitting `/login` forces the login UI even when cookies were still valid.
