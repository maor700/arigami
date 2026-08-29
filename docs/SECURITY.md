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
`/__api/sms/inbound` (see below), `/__api/webhooks/*` (C3 — authenticated by
share-token inside the handler).

## What is *not* protected (known, by design or pending)

- **`/__api/sms/inbound`** — the phone's SMS forwarder posts here with no
  secret today. Anyone reaching the origin can inject an SMS event (they still
  cannot read anything). C3 moves it under `/__api/webhooks/*` with a signed
  token.
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
- In-process rate limiting exists only for pairing (5 tries / 60 s lock).
  Brute-forcing a 32-byte session token is not practical. Per-IP limits on
  `/__api/auth/*`, `/__api/webhooks/*`, `/__artifacts/*` and TLS come from the
  Caddy edge (`deploy/caddy/`, C2, docs/TLS.md) — they only exist when Caddy
  is in front.
- **`X-Forwarded-Proto` / `-Host` are trusted only from loopback peers** and
  only when `trustProxy` is on (default: on iff `bind` is loopback). With
  `ARIGAMI_BIND=0.0.0.0` the headers are ignored unless `ARIGAMI_TRUST_PROXY=1`
  — and even then only for loopback peers, so a remote client can never forge
  an https origin (server/lib/proxy-headers.ts).

## Reporting

Open a private security advisory on the repository, or contact the maintainer
listed in the project README. Please don't file public issues for
vulnerabilities.
