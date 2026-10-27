# Connecting services just-in-time (`connect-*` playbooks)

Arigami starts with the minimum — pairing and one engine account (Claude or Codex). Everything
else (Linear/Notion/Sentry over their own MCP servers, Gmail via Composio,
GitHub, Tailscale remote access, a repo, WhatsApp…)
is connected **from inside the chat, the moment a task needs it**. This
document covers the agent-driven half of that: what is automated, where the
human is still required, and the security model. The server/UI half
(capability registry, `request_setup`, the Setup card) is in the JIT-setup
spec and `server/capabilities.ts`.

**Engine.** `mcp:<service>` grants are per engine: a codex session needs its own `codex mcp login`
grant (the host runs it under `$ARIGAMI_DIR/codex-mcp`); `composio:*` works on both; claude.ai
connectors are claude-only. See docs/ENGINES.md §4.

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

The card's default is **automatic** when a sign-in identity (Google, Microsoft or Apple) is connected — signed in in
the owner's own Chrome on the shared desktop — and the capability is auto-capable; otherwise **manual**. The
human can flip it. Nothing runs automatically without that click.

## Playbooks

| Capability | Skill | Automated by the agent | Human needed when |
|---|---|---|---|
| `identity` | `connect-identity` | `sign_in` to the owner's account provider (Google, Microsoft or Apple) in their own Chrome on the shared desktop — the host types the password from the vault — read the account, register email + provider + Chrome profile with the host | **the first time**: approving the vault fill once, and the provider's 2FA push on their phone |
| `mcp:<service>` | `connect-mcp` | start `claude mcp login <grant> --no-browser` on the host, open the vendor's own authorize URL, approve with the connected identity, let the loopback callback land (or paste the redirect URL back), poll until the grant is live | vendor login page / 2FA, a workspace or org the card did not name, an admin-approval wall |
| `composio:<toolkit>` | `connect-composio` | fetch the Composio redirect URL, open it, pick the identity account, "unverified app → Advanced → continue", Allow, poll until ACTIVE | provider login page (Slack/Notion/Linear), any password/2FA, redirect outside the allowlist |
| `claude` | `connect-claude` | mint the PKCE authorize URL, click Authorize when claude.ai is signed in, read the code from the callback URL, POST it for exchange | claude.ai login (password / email code) |
| `codex` | `connect-codex` | start `codex login` on the host, open the ChatGPT authorize URL, approve with the signed-in account, the loopback callback lands on the host by itself | OpenAI login (password / 2FA / email code) |
| `remote` | `connect-tailscale` | `tailscale login` URL, SSO with the identity's provider (in the owner's Chrome, `sign_in({site, url})`), Connect device, enable `serve` via REST | 2FA, a provider the identity is not, `sudo`, tailnet without HTTPS certs, admin approval |
| `git` | `connect-github` | `gh auth login --web` under the host pty-bridge, open the device page, type the one-time device code, Authorize, poll gh | GitHub login page, org SSO |
| `whatsapp` | — (manual only) | — | the QR is scanned by the human on the phone; the card shows it |
| `repo:<name>` | — (manual only) | — | the human picks/enters the repo on the card |

All playbooks share `skills/_lib/connect.sh` (open in the session Chrome with
an allowlist check, `wait-url`, screenshot, click/type, REST, report). Screen-
agnostic by construction: `open`/`nav`/`type`/`click`/`shot` all go through the
host's CDP-backed browser REST (`server/lib/browser-actions.ts` — the same
code behind the `browser_*` MCP tools) — navigation is `Page.navigate`, typing
is `Input.insertText`, and the evidence screenshot is `Page.captureScreenshot`
of the front **tab**, not a scrot of the whole desktop/root window. Only `key`
(a raw key combo with no page-level CDP equivalent) still falls back to
`skills/_lib/xinput.py` (XTEST), and only when the session actually has a
desktop (`$DISPLAY` set) — none of the playbooks below call it today.
They all follow `skills/machine-work/SKILL.md` for narration, the four
screenshot moments and the hand-over protocol. A step that needs the owner's identity provider ("Continue with Google /
Microsoft / Apple") is finished in the owner's own Chrome on the shared desktop, where it is signed in:
`sign_in({site, url:<the consent page>})` (docs/LOGIN.md).

## Security model

1. **The agent never types secrets.** A password, a TOTP code: the HOST types it from the owner's vault into the field
   the agent clicked (`sign_in({fill})`, docs/LOGIN.md) — the agent never sees it. A 2FA push, an SMS code, a CAPTCHA,
   a card number — every screen only the human can do is the *take-over boundary*: `sign_in({human})` /
   `request_screen`, the human acts, clicks Done, and the agent verifies the result. The only strings the agent types are URLs and one-time *device* codes
   a CLI printed for it (GitHub `XXXX-XXXX`), which are single-use and public by
   design. `bin/host`/the card's audit line records `human:true|false` per
   connection so this is checkable after the fact.
2. **Domain allowlist per playbook.** Each `SKILL.md` declares `allowlist:` in its
   frontmatter and exports it as `CONNECT_ALLOW`; `connect.sh open|nav` refuses
   any other host (a domain matches itself and its subdomains — `evil.example.com.attacker.net`
   does not). A redirect that leaves the list is a hand-over, never followed by
   the agent. The union across playbooks is: `accounts.google.com`,
   `myaccount.google.com`, `google.com`, the other identity providers' sign-in and account pages
   (`login.microsoftonline.com`, `login.live.com`, `account.microsoft.com`, `myaccount.microsoft.com`,
   `appleid.apple.com`, `account.apple.com`), `claude.ai`, `claude.com`,
   `platform.claude.com`, `console.anthropic.com`, `auth.openai.com`, `openai.com`, `chatgpt.com`, `backend.composio.dev`,
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
4. **Least persistence.** The identity's sign-in lives in the owner's own Chrome profile on the shared desktop (one
   profile per account); sessions get one site's login copied from there, nothing is written back. Tokens are stored by
   the host in its usual places (`accounts.json`, config) via the same REST
   endpoints the UI uses; the agent only relays codes and never writes them to
   files, artifacts, memory or chat. `identity.json` holds the email only.
5. **Bounded retries and evidence.** ≤ 2 attempts, then `report_setup({ok:false, detail})`
   and the card switches to manual with the reason. Every run ends with one
   screenshot published as an artifact and referenced from the audit line in
   `$ARIGAMI_DIR/connections.log` (`{at, sessionId, capability, mode, result, evidence, human}`).
6. **Own desktop, own browser — except a sign-in.** Each session drives *its* Xvfb display and Chrome profile
   (`skills/_lib/chrome.sh`); a sign-in step runs in the owner's Chrome on the shared desktop, one session at a time
   under the host's lease (docs/DESKTOP-CONTROL.md). Nothing is ever `pkill`ed.

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

## WhatsApp: one linked device per host

Native install and update run `scripts/install-whatsapp.sh`; the Docker image
runs that same pinned-source installer at build time. Existing native installs
can run it from the Arigami checkout after installing Node >=22 and npm. It
preserves `auth_info` and `data`, and retries an incomplete dependency install.
No package download is needed when the bridge starts.

All authorized sessions use the host's single managed bridge and pairing, not a
separate browser login. Native pairing lives in
`~/.local/lib/whatsapp-mcp/auth_info`; Docker links it to
`$ARIGAMI_DIR/whatsapp/auth_info` on the persistent volume. Do not remove that
volume during upgrades. Revoked/logged-out devices still need a new scan.
The setup card displays a local QR PNG and reports missing-install/crash reasons.

`whatsapp` tool `download_media` takes `{chat_jid, message_id}` from message
history and returns `{path, mime_type, bytes}`. It supports received/synced
images (including those without captions), video, audio, stickers and documents.
Metadata is stored in the shared message database; files land in its `media/`
directory with private permissions. Downloads are explicit and capped at 50 MiB;
expired/unavailable WhatsApp media can fail even when metadata is retained.
Historical messages without stored media metadata cannot be downloaded until
WhatsApp syncs them again. Use `publish_artifact` to show a downloaded file to
the human; don't expose a server-local filesystem path as a web link.

Validation: `bun test test/whatsapp-install.test.ts test/whatsapp-media.test.ts
test/bugs1-whatsapp.test.ts test/setup-web.test.js test/install.test.ts` covers
repair/idempotence, preserved pairing/data, process restart, media scope/limits,
and QR/error presentation. A real QR scan and a Docker-volume restart remain
release smoke checks requiring a linked test device and a Docker runtime.
