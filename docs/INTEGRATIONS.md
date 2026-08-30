# Integrations — which provider connects what, and why

Arigami reaches other services through three different mechanisms. The
Connections hub shows them in that order, and every capability the host reports
carries a `provider` field saying which one it is.

| provider | what it means | where the token lives |
|---|---|---|
| `native-mcp` | the vendor hosts its own remote MCP server; Claude Code does the OAuth against it directly | this host, `$CLAUDE_CONFIG_DIR/.credentials.json` (mode 600) |
| `composio` | Composio brokers the OAuth and proxies every call | Composio's cloud |
| `local` | this machine (a Google login in its Chrome, the WhatsApp bridge, `gh` credentials, the desktop) | this host |

The bias is deliberate: **native first**. Every service moved off the broker is
one fewer refresh token held by a third party — Composio's May 2026 breach
exfiltrated ~5k GitHub OAuth tokens plus Gmail/Linear/Notion/Slack ones, and
they could not revoke provider-side credentials on their users' behalf.
Composio stays because it is still the only practical path for Google and Slack,
the only path at all for Facebook Pages, and the only one with event triggers.

## Provider per service

| Service | Provider | Why |
|---|---|---|
| Linear, Notion, Sentry, Vercel, Stripe, Figma, Cloudflare, Supabase, Atlassian | `native-mcp` | official hosted server, OAuth with dynamic client registration (or CIMD) — nothing to register, no broker |
| GitHub | `native-mcp` (token) | `api.githubcopilot.com/mcp/` is documented for a PAT, and the host already owns one via the `git` capability (`gh auth token`); OAuth from Claude Code against it is unverified |
| Asana | listed, not connectable | official server, but no dynamic client registration — it needs an OAuth app of your own (client id + secret), which the cockpit cannot create yet |
| Gmail, Google Calendar, Google Drive, Google Docs | `composio` | Google's own MCP servers are a Developer Preview, restricted to the Workspace Developer Preview Program, and require your own GCP OAuth client (they do not support DCR). For a personal `gmail.com` identity Composio is the only hosted-consent path today |
| Slack | `composio` | the official `mcp.slack.com` server needs your own Slack app **and** workspace-admin approval; revisit when Slack supports DCR |
| Facebook Pages | `composio` | there is no Meta Pages MCP server at all (only Meta *Ads*); the alternative is your own Meta app plus App Review |
| WhatsApp | `local` | personal WhatsApp via the whatsmeow bridge. Composio's WhatsApp toolkit is the **Business** Cloud API (WABA templates, per-conversation billing) — a different product, so it is not offered |

Catalog: `server/mcp-catalog.ts`. Adding a service is one row there plus two
i18n strings — no new playbook, no new endpoint, no new card component.

## Connecting a native service

From the cockpit: **Settings → Connections → Direct connections (MCP) →
Connect**. From a session: a tool that needs it returns
`{needs_setup: "mcp:linear"}`, the agent calls `request_setup`, and on
"Connect automatically" it runs `skills/connect-mcp`.

Underneath, both do the same three things:

1. `claude mcp add --transport http <grant> <url>` registers the server.
2. `claude mcp login <grant> --no-browser` prints the vendor's authorize URL and
   then waits **two ways at once**: it listens on `localhost:<port>/callback`
   *and* it reads a pasted redirect URL from stdin (the host runs it under
   `server/lib/pty-bridge.py`).
3. The consent is approved in the session's Chrome — which runs on this host, so
   the loopback callback completes the exchange by itself. A cockpit open on a
   phone cannot reach that loopback, so the card also accepts the final
   `…/callback?code=…` address pasted back.

Disconnect is `claude mcp logout` + `claude mcp remove` + dropping the
ownership record.

### Requirements
- Claude Code **≥ 2.1.191** on the host (`--no-browser` landed there). Older
  hosts get an error naming the version; there is no fallback that could work.
- For vendors that sign in with Google SSO: the `identity` capability, so the
  session's Chrome is already signed in.

## Per-agent connections

An OAuth grant is identified by the **MCP server name** — the same URL under two
names is two independent grants with two vendor identities. That is what makes
per-agent connections possible without a second Anthropic login:

| owner | grant name | registered at | tools |
|---|---|---|---|
| the host | `linear` | `user` scope — every session sees it | `mcp__linear__*` |
| agent `sales` | `linear--sales` | `local` scope in `$ARIGAMI_DIR/agents/sales/` — no other agent's session sees it | `mcp__linear--sales__*` |

The host injects an agent's grants into its sessions with `--mcp-config`, under
**the grant name** — a different name would start a fresh, unauthenticated OAuth
flow rather than reuse the credential. `--strict-mcp-config` is deliberately not
used for sessions: it would also drop the *user's* own MCP servers (the WhatsApp
bridge, the Composio gateway, anything added by hand) from every agent session.
Isolation between agents comes from the local scope above; taking tools away on
purpose is A3's allowlist.

Ownership records — names, URLs, timestamps, never a token:

```
$ARIGAMI_DIR/mcp-connections.json              the host's own
$ARIGAMI_DIR/agents/<slug>/connections.json    one agent's
```

When an agent that **has** a tools allowlist connects a service, the host adds
`mcp__<grant>__*` to that allowlist and says so — A3 denies whole MCP servers no
pattern reaches, and connecting something an agent then cannot call is a trap,
not a safety feature.

## Export / import

A full backup (`bin/host export --full`) carries the ownership records: they hold
no secret, and on the new machine the capability simply reports "needs
authentication" until you reconnect. It never carries `.credentials.json` —
`mcpOAuth` grants are plaintext, machine-local, and tied to a loopback OAuth flow
on the machine that created them. Profile bundles carry neither.

## Linear has two grants on purpose

The Launcher's ticket list has its own Linear client (`server/linear-mcp.ts`,
its own store in `$ARIGAMI_DIR/linear-oauth.json`), separate from the
`mcp:linear` grant an agent uses. They are not merged in this release because two
independent OAuth clients must not share one refresh token — providers rotate it,
and the second client's next refresh would revoke the first's. So: connect Linear
in the Launcher for the ticket view, and in Connections for agent tools. The
Launcher banner says so. Retiring the hand-rolled client (and pointing the ticket
view at the native grant through Claude Code) is follow-up work.

## What the spike established

Verified on this host against Claude Code 2.1.251, driving a locally hosted
OAuth+MCP server (`test/fixtures/mcp-oauth-stub.ts`) so no vendor consent was
involved:

1. `claude mcp login <name> --no-browser` prints `Visit this URL to authorize:`
   followed by the authorize URL **on stdout**, wrapped in an OSC-8 hyperlink
   escape; it then prints `Waiting for authorization… (^C to cancel)` and
   `Or paste the redirect URL here:`. Both completions work: following the
   redirect into the loopback finished the exchange with nothing typed, and
   pasting the redirect URL on stdin finished it too. Success line:
   `Authenticated with "<name>".`, exit 0.
2. The grant is stored in `$CLAUDE_CONFIG_DIR/.credentials.json` (mode 600) under
   `mcpOAuth["<serverName>|<16-hex hash>"]`, with `serverName, serverUrl,
   accessToken, refreshToken, expiresAt, clientId, redirectUri, discoveryState`.
   Three names for the same URL produced the same hash and three separate
   entries — the hash is of the URL, the **name** is the identity of the grant.
3. **A `--mcp-config` server injected under a different name does NOT reuse the
   credential** (open item §4.5 of the research). Injected as `stub-b` against a
   URL already granted to `stub-a`, Claude Code sent no Authorization header, got
   a 401 and began a fresh discovery + registration; injected as `stub-a` it sent
   the stored token. Hence: inject under the grant name.
4. A name containing `--` is accepted end to end, and its tools come out as
   `mcp__<name>__*` (observed: `mcp__stub--sales__ping`) — which is what an A3
   allowlist has to match.
5. `claude mcp logout <name>` clears the token but keeps the entry; `claude mcp
   get <name>` reports `✔ Connected` / `! Needs authentication`.

Background and the vendor-by-vendor survey: `RESEARCH-ARIGAMI-NATIVE-MCP.md`.
Playbook security model: [CONNECT.md](CONNECT.md).
