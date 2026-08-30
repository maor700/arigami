# Connecting services just-in-time (`connect-*` playbooks)

Arigami starts with the minimum — pairing and one Claude account. Everything
else (Linear/Notion/Sentry over their own MCP servers, Gmail via Composio,
GitHub, Tailscale remote access, a repo, WhatsApp…)
is connected **from inside the chat, the moment a task needs it**. This
document covers the agent-driven half of that: what is automated, where the
human is still required, and the security model. The server/UI half
(capability registry, `request_setup`, the Setup card) is in the JIT-setup
spec and `server/capabilities.ts`.

## The loop

```
tool result { needs_setup: "composio:gmail", why, hint }
        │
        ▼
agent: request_setup({capability, why})          ← blocks; Setup card + push
        │
        ├─ {state:"auto"}   → agent runs skills/connect-<provider>  → report_setup({ok, evidence})
        ├─ {state:"done"}   → human connected it manually (card sub-form / QR / token)
        └─ {state:"skipped"|"timeout"} → agent offers an alternative, does not nag
        │
        ▼
agent calls the original tool again
```

The card's default is **automatic** when a Google identity is connected in the
session Chrome and the capability is auto-capable; otherwise **manual**. The
human can flip it. Nothing runs automatically without that click.

## Playbooks

| Capability | Skill | Automated by the agent | Human needed when |
|---|---|---|---|
| `identity` | `connect-identity` | open the Google account page, detect state, sync the login to the shared Chrome base profile, register the email with the host | **always the first time** — the password/2FA are typed by the human in Take-over |
| `mcp:<service>` | `connect-mcp` | start `claude mcp login <grant> --no-browser` on the host, open the vendor's own authorize URL, approve with the connected identity, let the loopback callback land (or paste the redirect URL back), poll until the grant is live | vendor login page / 2FA, a workspace or org the card did not name, an admin-approval wall |
| `composio:<toolkit>` | `connect-composio` | fetch the Composio redirect URL, open it, pick the identity account, "unverified app → Advanced → continue", Allow, poll until ACTIVE | provider login page (Slack/Notion/Linear), any password/2FA, redirect outside the allowlist |
| `claude` | `connect-claude` | mint the PKCE authorize URL, click Authorize when claude.ai is signed in, read the code from the callback URL, POST it for exchange | claude.ai login (password / email code) |
| `remote` | `connect-tailscale` | `tailscale login` URL, Google SSO with the identity account, Connect device, enable `serve` via REST | password/2FA, non-Google SSO, `sudo`, tailnet without HTTPS certs, admin approval |
| `git` | `connect-github` | `gh auth login --web` under the host pty-bridge, open the device page, type the one-time device code, Authorize, poll gh | GitHub login page, org SSO |
| `whatsapp` | — (manual only) | — | the QR is scanned by the human on the phone; the card shows it |
| `repo:<name>` | — (manual only) | — | the human picks/enters the repo on the card |

All playbooks share `skills/_lib/connect.sh` (open in the session Chrome with
an allowlist check, `wait-url`, screenshot, click/key/type, REST, report) and
`skills/_lib/xinput.py` (XTEST driver — the session desktop has no xdotool).
They all follow `skills/machine-work/SKILL.md` for narration, the four
screenshot moments and the hand-over protocol.

## Security model

1. **The agent never types secrets.** Passwords, 2FA codes, OTPs, recovery codes,
   CAPTCHA answers, card numbers — every screen that asks for one is the
   *take-over boundary*: the agent calls `request_screen`, the human drives the
   session desktop through the cockpit, clicks Done, and the agent verifies the
   result. The only strings the agent types are URLs and one-time *device* codes
   a CLI printed for it (GitHub `XXXX-XXXX`), which are single-use and public by
   design. `bin/host`/the card's audit line records `human:true|false` per
   connection so this is checkable after the fact.
2. **Domain allowlist per playbook.** Each `SKILL.md` declares `allowlist:` in its
   frontmatter and exports it as `CONNECT_ALLOW`; `connect.sh open|nav` refuses
   any other host (a domain matches itself and its subdomains — `evil.example.com.attacker.net`
   does not). A redirect that leaves the list is a hand-over, never followed by
   the agent. The union across playbooks is: `accounts.google.com`,
   `myaccount.google.com`, `google.com`, `claude.ai`, `claude.com`,
   `platform.claude.com`, `console.anthropic.com`, `backend.composio.dev`,
   `composio.dev`, `login.tailscale.com`, `tailscale.com`, `github.com`, plus the
   provider domain of a non-Google Composio toolkit (`slack.com`, `linear.app`,
   `notion.so`), and — for `connect-mcp` — the vendor domains of
   `server/mcp-catalog.ts` plus `localhost`: the loopback that
   `claude mcp login` listens on for the OAuth callback is a process on THIS
   machine, never a link handed to a human. Today that is `api.githubcopilot.com`, `app.asana.com`, `asana.com`, `atlassian.com`, `cloudflare.com`, `figma.com`, `id.atlassian.com`, `linear.app`, `mcp.asana.com`, `mcp.atlassian.com`, `mcp.cloudflare.com`, `mcp.figma.com`, `mcp.linear.app`, `mcp.notion.com`, `mcp.sentry.dev`, `mcp.stripe.com`, `mcp.supabase.com`, `mcp.vercel.com`, `notion.com`, `notion.so`, `sentry.dev`, `sentry.io`, `stripe.com`, `supabase.com`, `vercel.com`.
   `test/connect-skills.test.js` fails if a playbook lists anything outside this
   set, and it derives the MCP part from the catalog so adding a service stays a
   data change.
3. **Consent before automation.** The card states exactly what will happen
   ("the agent will open Google's consent page for Gmail and click Allow with
   account X"); the agent only runs after the human clicks *Connect
   automatically*. It never starts a login flow on its own initiative, never
   adds scopes, never touches ACLs/keys/exit nodes/PATs.
4. **Least persistence.** Browser state lives only in the session's Chrome
   profile and the shared base profile it syncs to (`chrome-base/`, the existing
   T8 mechanism — cookies, saved logins, local storage). Tokens are stored by
   the host in its usual places (`accounts.json`, config) via the same REST
   endpoints the UI uses; the agent only relays codes and never writes them to
   files, artifacts, memory or chat. `identity.json` holds the email only.
5. **Bounded retries and evidence.** ≤ 2 attempts, then `report_setup({ok:false, detail})`
   and the card switches to manual with the reason. Every run ends with one
   screenshot published as an artifact and referenced from the audit line in
   `$ARIGAMI_DIR/connections.log` (`{at, sessionId, capability, mode, result, evidence, human}`).
6. **Own desktop, own browser.** Each session drives *its* Xvfb display and
   Chrome profile (`skills/_lib/chrome.sh`); no session touches another's
   browser, and nothing is ever `pkill`ed.

## What the human sees

- A Setup card in the chat: capability, why the agent needs it, the automatic /
  manual switch, and a live "the agent is connecting…" state with the final
  screenshot (green) or the failure reason and the manual form (red).
- A push notification when the card appears and when a take-over is needed.
- Settings → Connections: identity, connected providers, disconnect, last audit lines.

## Adding a playbook

1. `skills/connect-<provider>/SKILL.md` with frontmatter `description`,
   `triggers`, `capability`, `allowlist` (space-separated domains — extend the
   set in `test/connect-skills.test.js` only with a reason).
2. Body sections: hard rules (the "never type passwords" rule verbatim),
   preconditions, numbered steps using `connect.sh`, a failure table, evidence +
   `report_setup`, retro (`skill_propose`).
3. Register `playbook: 'connect-<provider>'` and `autoCapable: true` in
   `server/capabilities.ts`.
