# Auth (C1) — how sign-in works, and how to migrate a live host

Arigami serves one origin (`:3099`). Since C1 that origin is behind a session
cookie: the cockpit, the REST API, `/__ws`, `/__vnc`, the service-worker proxy
and every host page. Nothing new is exposed; everything that was reachable
before is now reachable *by you only*.

## Three ways in

| Who | Credential | Where it comes from |
|---|---|---|
| A browser | cookie `arigami_sid` (HttpOnly, SameSite=Lax, `Secure` when `ARIGAMI_PUBLIC_URL` is https, 30 days) | pairing code or OIDC login |
| A `claude` or `codex` session the host spawned (MCP tools, `curl` from a skill, the review prompt) | `Authorization: Bearer $ARIGAMI_TOKEN` | injected by the host per session; dies with the session |
| A one-shot / headless `claude -p` or `codex exec` (skills analyze, memory episode hook) | `Bearer $ARIGAMI_TOKEN` (host-scoped) | injected by `server/lib/oneshot.ts` |
| A CLI or script you write | `Bearer arigami_pat_…` | Settings → Users & access → API tokens (admin) |

Session bearer tokens live only in memory; API tokens are stored as a sha256
in `$ARIGAMI_DIR/users.json`. Web sessions persist in `$ARIGAMI_DIR/sessions.json`
so a restart doesn't log the phone out.

## First run — pairing

1. Start the host. With no admin yet it prints, next to the listen line:
   `[auth] no admin yet — pairing code: XXXX-XXXX`
   The same code is in `$ARIGAMI_DIR/run/pairing-code`, and `bin/host pair`
   prints/issues one at any time.
2. Open `/__host/`, enter the code (email optional). You're the admin; the code
   is burned. Five wrong codes lock pairing for 60 s.
3. To pair another device/user later: Settings → Users & access → *Issue code*,
   or `bin/host pair` on the box. Pairing always yields an admin (possession of
   the code == possession of the host's filesystem).

## Config

```jsonc
// $ARIGAMI_DIR/config.json
{
  "bind": "127.0.0.1",          // default. env ARIGAMI_BIND
  "publicUrl": "",              // e.g. "https://my-host.example" — env ARIGAMI_PUBLIC_URL
  "auth": {
    "mode": "pairing",          // "pairing" | "oidc" | "off"   — env ARIGAMI_AUTH
    "cookieDays": 30,
    "oidc": {                   // only for mode "oidc" (adds a button; pairing still works)
      "issuer": "https://accounts.google.com",
      "clientId": "…",
      "clientSecret": "…",      // or secrets.env / env: ARIGAMI_OIDC_CLIENT_SECRET
      "allowedEmails": ["you@example.com"],
      "allowedDomains": ["example.com"],
      "autoCreate": true        // first allowed login ever = admin; later ones = user
    }
  }
}
```

Rules enforced at boot (exit 2 otherwise):

- `auth.mode: "off"` is only accepted with a loopback `bind`. **An
  unauthenticated host never listens on `0.0.0.0`.**
- `auth.mode: "oidc"` needs `issuer` + `clientId`.

`bind` defaults to `127.0.0.1`. Reaching the host from other devices goes
through something that forwards to loopback — `tailscale serve` (Settings →
Remote access does this for you), or Caddy (C2). Direct `http://<lan-ip>:3099`
needs `ARIGAMI_BIND=0.0.0.0` *and* auth on.

### OIDC

- Redirect URI to register with the provider: `<publicUrl>/__api/auth/oidc/callback`
  (when `publicUrl` is empty the host derives the origin from the request the
  same way OAuth connectors do — loopback → http, anything else → https).
- Google: create an OAuth client (Web application), issuer
  `https://accounts.google.com`. Microsoft: issuer
  `https://login.microsoftonline.com/<tenant>/v2.0`. Any spec-compliant
  provider with discovery works (`openid-client`).
- An email must match `allowedEmails` or `allowedDomains`, else 403.

## Internal callers — what changed

Every agent process the host spawns (`claude` or `codex`, same env) gets `ARIGAMI_URL` (now the loopback address the
host actually bound, never `localhost`) and `ARIGAMI_TOKEN`. `mcp/host-mcp.js`
sends it automatically. Skills that `curl` the host must add
`-H "Authorization: Bearer $ARIGAMI_TOKEN"` (the bundled skills already do).
A token is only honoured while its session exists.

`bin/host` (`status`, `doctor`) only needs `/__api/config`, which is public in
its reduced form (`{version, authMode, hasAdmin, oidc}`).

## Migrating the live single-machine host (phone via `tailscale serve`)

Today's host runs `auth.mode` unset (→ `pairing` after upgrade) and binds
everything. After upgrading to C1:

1. **Nothing to do for loopback + `tailscale serve`.** `tailscale serve`
   forwards to `127.0.0.1:3099`, which is the new default bind. The phone's
   first visit shows the Login page: enter the pairing code from `bin/host logs`
   (or `bin/host pair`). The cookie lasts 30 days; push-notification clicks
   open the existing PWA window and reuse it.
2. **Direct `http://<tailscale-ip>:3099` / LAN stops working** (SPEC §7.9).
   Use the `tailscale serve` https URL instead, or set `ARIGAMI_BIND=0.0.0.0`
   explicitly (auth stays on).
3. **Sessions already running** were spawned without `ARIGAMI_TOKEN`; their MCP
   calls get 401 until they are restarted (rail → Restart). New sessions are
   fine. The host token for one-shots is per process, so a host restart is all
   it takes.
4. **Escape hatch while migrating**: `ARIGAMI_AUTH=off` (or `"auth":{"mode":"off"}`)
   keeps the pre-C1 behaviour *only* on a loopback bind. With `tailscale serve`
   in front that still means "anyone on your tailnet who can reach the serve
   URL" — turn it back on once the phone is paired.
5. Set `ARIGAMI_PUBLIC_URL=https://<your-serve-hostname>` (or `publicUrl` in
   config.json) so OAuth/OIDC redirects and future share links use the right
   origin and the cookie is marked `Secure`.

Verify after restart:

```sh
ss -ltnp | grep 3099                     # 127.0.0.1:3099 only
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3099/__api/sessions   # 401
bin/host doctor                          # auth: mode / users.json / pending code
```

## Share links (K2) — the one cookie-less door

`publish_artifact({share:true})` / the card's **Share link** button mint
`/__artifacts/<id>/?t=<token>`: an HMAC-signed capability that opens **that
artifact, at the version it was minted for, and nothing else**. No cookie is
set, no user is created; `/__api/*`, `/__ws`, host pages and the proxy still
return 401 in the same browser. The token carries its expiry (default
`share.defaultDays`=7, max `share.maxDays`=90, config.json) and a nonce that
`Revoke` puts on `$ARIGAMI_DIR/share-revoked.json`; the signing secret is
`$ARIGAMI_DIR/share-secret` (0600, generated on first use — delete it or
`POST /__api/share/revoke-all` to kill every link at once).

Admin view: `GET /__api/share/tokens` lists live links by nonce/expiry/label
(never the token itself); `DELETE /__api/share/tokens/<nonce>` revokes one.

For a link that works off the host box, set `ARIGAMI_PUBLIC_URL` — without it
the returned `share_url` is host-relative and the agent gets a warning.
Assets inside a shared page load through `/__artifacts/<id>/~t/<token>/…`
(the same token in the path), so the page itself must have relative asset
paths — as `publish_artifact` already requires.

## Webhooks (C3) — the other cookie-less door

`/__api/webhooks/<kind>` routes are public in the gate and authenticate
themselves (see `docs/SECURITY.md` → Webhooks for the exact schemes).

- **SMS from the phone (Macrodroid).** Settings → Webhooks → *Rotate* mints a
  long-lived share-token (`kind:'webhook'`, `id:'sms'`) and shows the full URL
  (`ARIGAMI_PUBLIC_URL` + `/__api/webhooks/sms?t=<token>`; host-relative when
  the public URL is unset). Put it in the phone's HTTP action with
  `&from={sms_number}&body={sms_message}` appended — or send the token as
  `X-Arigami-Token`. Rotating kills the previous token at once; *Revoke*
  closes the route. API: `GET|POST|DELETE /__api/webhooks/token` (admin).
- **Slack / GitHub.** Paste the app's signing secret / the hook secret:
  `PUT /__api/webhooks/slack/secret {secret}` / `PUT /__api/webhooks/github/secret`
  (or env `SLACK_SIGNING_SECRET` / `ARIGAMI_GITHUB_WEBHOOK_SECRET`).
- **Custom.** `POST /__api/webhooks/custom {id,label?}` returns the HMAC
  secret **once**; the sender signs `"<ts>.<nonce>.<body>"` with it.
- **Events.** `GET /__api/webhooks/events?kind=&since=&limit=` for any
  principal; the bus broadcasts `{type:'webhook', kind, id}` on arrival.
- **Legacy.** `/__api/sms/inbound` keeps working unauthenticated for one
  release with a `Deprecation` header and a log warning — repoint the phone,
  then it goes away.
- **Public internet.** Settings → Webhooks → *Funnel* exposes only
  `/__api/webhooks` via `tailscale funnel --set-path` (`GET|POST
  /__api/remote/funnel`). Everything else stays tailnet-only.

