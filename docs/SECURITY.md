# Security model (technical)

Companion to [AUTH.md](AUTH.md). This describes what the host protects, what it
trusts, and what it deliberately does not.

## Assets

- The cockpit: every session's chat, terminal, files, screenshots, the shared
  desktop (`/__vnc`) and the reverse proxy to dev servers on the box.
- `$ARIGAMI_DIR`: Claude OAuth tokens (`accounts.json`), integration
  credentials, memory, users/sessions.
- The MCP surface: any caller of `/__api` can create sessions that run
  `claude --permission-mode bypassPermissions` as the host's user. **`/__api`
  access is shell access.**

## Trust boundaries

| Boundary | Mechanism |
|---|---|
| Network → host | Bind `127.0.0.1` by default. Non-loopback bind requires auth on (boot refuses otherwise). TLS is the fronting proxy's job (`tailscale serve`, Caddy). |
| Browser → host | `arigami_sid` cookie (HttpOnly, SameSite=Lax, Secure on https). Minted only by pairing (one-time code on the host's filesystem) or OIDC with an allow-list. Unauthenticated: `/__api`/`/__mcp` → 401 JSON; navigations → 302 `/__host/`; upgrades → 401 + close. |
| Spawned `claude` → host | Per-session bearer token in the child's env; valid while the session exists; not persisted. One-shots get a per-process host token. |
| CLI → host | `arigami_pat_…` tokens; sha256 at rest; admin creates/revokes. |
| Upstream (proxied dev server) → browser | `Set-Cookie` from upstream is rewritten and may never set `arigami_sid` / `arigami_oidc`. |

Public paths (no credential): `/__api/auth/*`, reduced `/__api/config`,
`/__host/*` (static SPA), `/`, `/__health`, `/__poc-sw.js`,
`/__api/webhooks/{sms,slack,github,custom/<id>}` (C3 — each authenticates
itself, see below) and, for one more release, the legacy `/__api/sms/inbound`.

## Share links (K2)

`/__artifacts/<id>/?t=<token>` is the only cookie-less path into the host by
design. What the bearer of a link gets: **one artifact, one version** (pinned
in the signed payload), read-only static files under the artifact's own
sandboxed CSP. What they do not get: any other artifact or version, `/__api`,
WebSockets, host pages, the proxy — the gate never sets a principal for a
token, only `req.share`. Tokens are HMAC-SHA256 over a per-instance random
secret (`$ARIGAMI_DIR/share-secret`, 0600), verified with `timingSafeEqual`
before the payload is parsed, expire (7 days default, 90 max), and are
revocable by nonce (`share-revoked.json`) or all at once (secret rotation).
A leaked link = a leaked artifact, deliberately; the token also appears in
sub-resource paths (`/~t/<token>/`) so a shared page can load its assets —
`Referrer-Policy: no-referrer` keeps it out of third-party referers, but the
viewer's browser history holds it like any capability URL.

## Webhooks (C3)

`/__api/webhooks/<kind>` is the second cookie-less door. The auth gate lets
exactly four route shapes through with no principal — `sms`, `slack`,
`github`, `custom/<id>` — and `server/webhooks.ts` authenticates each request
itself. Nothing else under `/__api/webhooks/` (token, config, events) is
public; `/__api/sessions` & co. stay 401 for the same caller.

| kind | credential | replay guard |
|---|---|---|
| `sms` | share-token `{kind:'webhook', id:'sms'}` in `?t=` or `X-Arigami-Token` (K2 module, same secret file). Long-lived (1 year), rotated/revoked from Settings → Webhooks; only the *current* token is accepted. | none possible (the phone app cannot sign) — mitigated by rotation + revocation; a replay only re-delivers an SMS the owner already received |
| `slack` | Slack v0: `X-Slack-Signature` = `v0=HMAC(secret, "v0:<ts>:<body>")`, `X-Slack-Request-Timestamp` within ±5 min | signature seen-set, 5 min |
| `github` | `X-Hub-Signature-256` = `sha256=HMAC(secret, body)` | `X-GitHub-Delivery` seen-set, 5 min |
| `custom/<id>` | `X-Arigami-Signature` = `sha256=HMAC(secret, "<ts>.<nonce>.<body>")`, `X-Arigami-Timestamp` (unix s, ±5 min), `X-Arigami-Nonce` | nonce seen-set, 5 min |

Every compare is `timingSafeEqual` (length mismatch still runs one full
compare); every failure is a bare `401 {"error":"unauthorized"}` — the reason
goes to the host log only, never to the wire, and tokens are never logged.
Bodies over 256 KB → 413 before any verification; 120 requests/min per kind →
429, with `X-RateLimit-*` hints on every answer. Secrets live in
`$ARIGAMI_DIR/webhooks.json` (0600) or in the environment / `secrets.env`
(`SLACK_SIGNING_SECRET`, `ARIGAMI_GITHUB_WEBHOOK_SECRET`,
`ARIGAMI_WEBHOOK_SECRET_<ID>`; env wins). A missing secret means the kind is
closed, never open. Verified payloads are appended to `webhooks.jsonl`
(64 KB per event) and are readable by any signed-in principal at
`GET /__api/webhooks/events`.

**Funnel (§7.8).** Settings → Webhooks can turn on `tailscale funnel
--set-path /__api/webhooks` — the *only* path ever exposed to the public
internet; the host verifies the mount by probing its own sms route through
the funnel and expects its 401. Off by default.

## What is *not* protected (known, by design or pending)

- **`/__api/sms/inbound`** — the pre-C3 phone webhook still accepts
  unauthenticated SMS for **one more release** (the live phone automation
  must be repointed first). It answers with a `Deprecation` header and the
  host logs a warning once a minute while it is in use. Anyone reaching the
  origin can inject an SMS event through it (they still cannot read
  anything). Remove `handleLegacySms` + its allowlist line in the release
  after C3.
- **Authorization is coarse.** A session token can call any `/__api` route, not
  only its own session's; API tokens inherit their owner's role; the only
  admin-only surface is `/__api/auth/*` administration. Per-session scoping is
  a follow-up.
- **Pairing = admin.** The code lives on the host's disk (`run/pairing-code`,
  mode 0600); whoever can read it can become admin. That is equivalent to
  local user access, which already owns everything.
- **No CSRF token.** `SameSite=Lax` blocks cross-site POST/WS with the cookie;
  the API is JSON-only and never form-encoded. Cross-site *top-level GET*
  navigations carry the cookie, but no GET is state-changing.
- **`auth.mode: off`** exists for loopback-only installs. Combined with
  `tailscale serve` it re-opens the host to the tailnet — documented in
  AUTH.md, warned at boot.
- Rate limiting exists only for pairing (5 tries / 60 s lock). Brute-forcing a
  32-byte session token is not practical; TLS + Caddy rate limits arrive in C2.

## Reporting

Open a private security advisory on the repository, or contact the maintainer
listed in the project README. Please don't file public issues for
vulnerabilities.
