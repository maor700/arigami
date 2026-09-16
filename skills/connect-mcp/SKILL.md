---
description: JIT-setup playbook for `mcp:<service>` — the GENERIC connect flow for every vendor-hosted remote MCP server (Linear, Notion, Sentry, Vercel, Stripe, Figma, Cloudflare, Supabase, Atlassian…). Ask the host to run `claude mcp login <grant> --no-browser`, open the printed authorize URL in the session Chrome, approve with the connected identity, let the loopback callback land (or paste the redirect URL back), verify with the host, and report with an evidence screenshot. Password/2FA screens = take-over. GitHub is token-based and needs no browser at all.
triggers: request_setup returned {state:'auto'} for a capability starting with `mcp:`; a tool result carried needs_setup "mcp:linear" (or any service); "connect Linear/Notion/Sentry/Vercel/Stripe/Figma/Cloudflare/Supabase/Jira", "תחבר את הלינאר".
capability: mcp:<service>
allowlist: localhost accounts.google.com google.com api.githubcopilot.com app.asana.com asana.com atlassian.com cloudflare.com figma.com github.com id.atlassian.com linear.app mcp.asana.com mcp.atlassian.com mcp.cloudflare.com mcp.figma.com mcp.linear.app mcp.notion.com mcp.sentry.dev mcp.stripe.com mcp.supabase.com mcp.vercel.com notion.com notion.so sentry.dev sentry.io stripe.com supabase.com vercel.com
argument-hint: <service slug, e.g. linear>
---

# connect-mcp — the vendor's own OAuth, no broker in between

Follow `skills/machine-work/SKILL.md`. Helpers: `skills/_lib/connect.sh`.
`$ARGUMENTS` (or the `needs_setup` value after `mcp:`) is the service slug.
Server side: `server/mcp-catalog.ts` (the catalog), `server/mcp-auth.js`
(the pty-bridge around `claude mcp login`), `POST /__api/setup/mcp:<service>`.

**Grants are per engine.** A Claude grant (`claude mcp login`) is useless to a Codex session and vice
versa. The host picks the engine from the calling session (`X-Arigami-Session`), so a Codex session runs
`codex mcp login` with no change to the steps below; pass `"engine":"codex"|"claude"` to override.
The capability check says which engines hold the grant (`status.data.engines`); from a Codex session
"granted for claude only" is `ok:false` — connect it again here.

What this connects is a **named grant**. The host derives the name from the
owner: `linear` for the host, `linear--<agent>` when an agent session asks for
its own. You never choose it — the host returns it as `name`.

## Hard rules
1. **Never type passwords / 2FA / OTP.** A vendor login form is the take-over
   boundary (`request_screen`). The only text you ever type is a URL.
2. **Allowlist**: the host returns `domains` for the service in step 1 — that
   subset of the frontmatter list, and nothing else:
   `export CONNECT_ALLOW="<those domains> localhost"`. `localhost` is on the list
   because the consent redirects to a loopback `/callback` — that listener is the
   `claude mcp login` process on THIS machine, not a page for the human, so it is
   never a link you hand anyone.
3. **Consent first** — run only after the human chose "Connect automatically".
4. **≤ 2 attempts**, then `report_setup({ok:false, detail})`.
5. You approve **only the service the card asked for**, with whatever scopes its
   consent screen lists — never add, never widen, never a second workspace.

## Preconditions
- Claude Code ≥ 2.1.191 on the host (`claude mcp login --no-browser` exists).
  If step 1 fails with `unknown command 'login'` / `unknown option`, stop:
  `report_setup({ok:false, detail:"host needs Claude Code >= 2.1.191"})`.
- `identity` connected for the owner you are connecting for — most of these
  vendors sign in with Google SSO, and the agent's own Chrome profile is what
  the consent runs in. Check `GET /__api/setup/capabilities` (as an agent:
  `?owner=agent:<slug>`); if absent, `request_setup({capability:"identity"})`
  first. A vendor with its own username/password is fine too — it just means
  step 4 is a take-over.

## Steps
0. Opening line + `set_progress`.
1. Start the login:
   `connect.sh api POST /__api/setup/mcp:<service> '{"action":"start"}'` →
   `{name, url, state:"awaiting", domains, docs}`.
   `url` is the vendor's authorize URL. No `url` → read `error`, report, stop.
   Codex: the reply carries `engine:"codex"`; the consent names "Codex" as the client — that is expected.
   (Read-only variant, when the human asked for one: `{"action":"start","readonly":true}`.)
2. `export CONNECT_ALLOW="<domains from step 1> localhost"`, then
   `connect.sh open "<url>"`, `wait-url '<vendor domain>' 45`, `shot first`,
   `capture_screen({caption:"<Service> consent screen"})`.
3. **Account chooser / workspace picker** (Notion asks which workspace, Atlassian
   which site, Sentry which org): pick the one the human named in `why`; if the
   card did not say and there is more than one, `request_action` and ask — do not
   guess. A Google chooser: click the row whose email equals the identity email,
   never "Use another account".
4. **Consent**: click **Authorize / Allow access / Approve**. A login form or a
   2FA prompt instead → boundary (rule 1): `capture_screen`,
   `request_screen({prompt:"Connecting <Service> — it asks you to sign in.", reason:"login", hint:"Sign in, click Authorize, wait for the page that says you can close the tab, then click Done."})`,
   and after Done continue from step 5.
5. The consent redirects to the loopback callback (`localhost`, on the port
   `claude mcp login` picked, with `?code=…`). Because Chrome runs on this host,
   that listener catches it and finishes the exchange itself — usually nothing to
   do. `wait-url 'localhost' 60`.
   **If the tab shows an error, or Chrome could not reach the loopback**, read the
   final URL and hand it back:
   `connect.sh url` → `connect.sh api POST /__api/setup/mcp:<service> '{"action":"paste","code":"<that full URL>"}'`.
6. Poll the host until the grant is live (max 12 × 5 s):
   `connect.sh api POST /__api/setup/mcp:<service> '{"action":"poll"}'` → `ok:true`.
   Still `false` after the window → attempt 2 from step 1, then fail with the
   last `state`/`error`.
7. Evidence + report: `connect.sh shot final` → `publish_artifact` →
   `report_setup({capability:"mcp:<service>", ok:true, evidence:"<artifact path>"})`,
   `capture_screen({caption:"<Service> connected"})`.
   The reply carries `connection.name` — the tools are `mcp__<name>__*`, and they
   appear in **new** sessions (a running session keeps the MCP set it started with).
   If it also carries `toolsAdded`, say so: the host added that pattern to the
   agent's tool allowlist so the agent can actually use what you just connected.
8. Summary line; then **continue the original task** — the tool that returned
   `needs_setup` can be called again from a session started after the connect.

Codex's loopback callback is `127.0.0.1:<port>/callback/<id>?code=…`; the `paste` action forwards it to that listener.

## GitHub (and any other token-based row)
`mcp:github` is `auth: 'bearer'` — no browser, no consent, no callback.
One call does it: `connect.sh api POST /__api/setup/mcp:github '{}'` — the host
reuses the token `gh auth login` already stored (the `git` capability). It fails
with "no GitHub token on this host" → run `skills/connect-github` first, then
retry. Not wired for Codex sessions yet (the host says so). Report as usual; there is no screenshot to take, so evidence is the
`poll` result, and say plainly that no browser was involved.

## Failure handling
| Symptom | Do |
|---|---|
| `unknown command 'login'` / `unknown option '--no-browser'` | host's Claude Code is too old — fail with the version hint, no retries |
| Consent page names a different app or service than the card | do not approve; `report_setup({ok:false, detail:"unexpected consent target"})` |
| Redirect leaves the allowlist | stop, `request_screen` (reason `other`) with the URL host in the hint |
| "This app is not approved for your workspace" / admin-approval wall | fail with the message — an admin has to allow it, a retry cannot |
| Vendor asks to create/pick a paid plan | fail with the message; never buy anything |
| `poll` never turns `ok` although the tab says connected | the exchange did not land: read `connect.sh url` and use `action:"paste"` (step 5) once, then fail |

## Retro
`skill_propose({name:"connect-mcp", …})` for a vendor screen this playbook did
not describe — the point of this skill is that adding a service is a catalog row,
not a new playbook.
