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
itself, see below). The legacy unauthenticated `/__api/sms/inbound` is **no longer public** (it needs a normal
credential; use the signed `/__api/webhooks/sms` route).

**One reading of the path.** The gate and the router must agree on what a request path means. A path whose meaning
depends on normalisation — dot segments in any encoding (`..`, `%2e%2e`), a backslash, an encoded slash or backslash,
control characters, an absolute-form target — is refused with `400` before anything else (`server/auth.ts`
`pathIsAmbiguous`; regression tests in `test/security-gate.test.ts`). Before this, `/__api/auth/../sessions` was a
public path to the gate and `/__api/sessions` to the router. A pinned dev-server proxy target (`?__target=` /
`X-Poc-Target`) on the public `/` also needs a signed-in user: it makes the host fetch a URL on the caller's behalf.

## Share links (K2)

`/__artifacts/<id>/?t=<token>` is the main cookie-less path into the host by
design (EXT3 adds a second one of exactly the same shape,
`/__ext/<name>/~t/<token>/…`, below). What the bearer of a link gets: **one artifact, one version** (pinned
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

### Extension tab assets (EXT3)

An extension tab is served under the same CSP `sandbox` (opaque origin), so its
sub-resources carry no cookie either. The entry HTML — served **only** to a real
principal — gets a `<base href="/__ext/<name>/~t/<token>/">`. That token is the
same HMAC primitive with `kind:'extension'`, `scope:'assets'` and a 24h life;
it is host-minted, never user-shareable, hidden from the share lists, and bound
to one extension name. It opens that extension's `ui/` and nothing else: not
another extension, not `/__api`, not a directory under `user/extensions` that
declares no tab, and not an extension that has since been disabled or removed
(the resolver is consulted on every verify). `/__ext-sdk.js` is a public path —
a static script with no secrets, and the one sub-resource a sandboxed page must
load before the postMessage bridge can exist.

## Webhooks (C3)

`/__api/webhooks/<kind>` is the second cookie-less door. The auth gate lets
exactly four route shapes through with no principal — `sms`, `slack`,
`github`, `custom/<id>` — and `server/webhooks.ts` authenticates each request
itself. Nothing else under `/__api/webhooks/` (token, config, events) is
public; `/__api/sessions` & co. stay 401 for the same caller.

| kind | credential | replay guard |
|---|---|---|
| `twilio/voice`, `twilio/status` | `X-Twilio-Signature` = base64 HMAC-SHA1(Twilio Auth Token, public URL + sorted form params); the media-stream WebSocket under the same prefix is authenticated by a one-time token minted after the caller's PIN (server/voice-phone.ts). | status: 5-min signature seen-set; voice: inert by state machine |
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

- **`/__api/sms/inbound`** — the pre-C3 phone webhook was unauthenticated; it is now an ordinary gated route (no
  credential → 401). Point the phone at the signed `/__api/webhooks/sms` URL (Settings → Webhooks).
- **Authorization is coarse for Full sessions.** A Full (default) session's token can call any `/__api` route, not
  only its own session's; API tokens inherit their owner's role; the only admin-only surface is `/__api/auth/*`
  administration. A *restricted* session's token is scoped (below).
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

## Restricted sessions (opt-in)

A session with no profile is **Full** and behaves exactly as described above. A session can instead run under a
**profile** (`server/session-profile.ts`), chosen per session (`POST /__api/sessions {profile}`), per project folder, per
agent or per cron trigger (`$ARIGAMI_DIR/session-profiles.json`, admin-only `PUT /__api/session-profiles`). The effective
profile is stored on the session record by the host at creation and no PATCH can change it. It carries:

| field | effect |
|---|---|
| `tools` / `hostTools` | an A3-style allowlist, enforced by the same layers as an agent's (`--disallowedTools`, the PreToolUse hook, the host MCP's hidden set, the MCP gateway) for claude and codex alike |
| `desktop` | `none`; `own` — its own display and Chrome, never the shared desktop (no fallback); `shared` — the owner's desktop too, but only for 30 minutes after a person presses *Allow* on a card |
| `talkTo` | `parent` / `children`: the only sessions `send_message`, `task_session` and `report_to_master` reach; `from` is always the caller |
| `maySpawn` | may create sessions — always its own children, which inherit its profile |
| `triggers` | may create cron triggers (only its own, delivering to itself or its family; their runs inherit its profile) and listeners |
| `hostRoutes` | host route groups beyond its own session: `memory`, `skills`, `setup`, `agents`, `host-resources` |
| `egress` | with the sandbox on: what its egress proxy lets through besides the model API and its own host — groups (`npm`, `pypi`, `github`, `crates`, `go`) or hosts (`example.com`, `*.example.com`); absent = nothing more |
| `limits` | host-side caps: `concurrent` (sessions of the profile working at once — more wait in a queue), `spendUsd` / `tokens` (one session tree; over it the tree is stopped, turns are refused and the owner is alerted) — `server/profile-limits.ts` |

**Inheritance only narrows.** A child's profile is its parent's narrowed by the folder's, the agent's, the trigger's
and any explicit pick: tool allowlists stack as layers that must all allow, the desktop mode takes the lower one,
`talkTo` / `hostRoutes` intersect, flags AND. Every create path goes through `state.createSession`, which applies it.

**Per-session API scope.** The auth gate refuses (403) any request a restricted session's token makes outside its own
session's routes, its parent's `send`, its children's lifecycle and `task`/`send`, and the host routes its profile
maps to; it never gets a WebSocket, the dev-server proxy or artifacts. Blocking `/__mcp/*` calls must name its own
session. Its own PATCH is limited to cockpit fields and cannot touch the metadata the host reads as authority
(`master`, `agent`, `screen`, cron pointers…). A restricted caller cannot pass `agent`, a foreign `master` or a folder.

**Limits.** Enforcement is host-side and engine-agnostic, but without the sandbox the session still runs as the host's
user: what it can do with Bash on the machine (files, network, sudo) is not limited by the profile. The sandbox
(`sandbox.mode: "docker"`, [SANDBOX.md](SANDBOX.md)) closes that for standalone installs: each restricted session runs
in its own container with no host secrets, no root and no network except an egress proxy with an allowlist. With `auth.mode: off` a local caller without any token is the admin, so a restricted session's
host-route limits hold only with auth on (the host logs a warning when one is created with auth off). A profile binds at
creation: moving a session into a folder later does not change it.

**Grants and the gatekeeper.** A profile may also carry `grants` (`<ext>:<action>`), narrowed by intersection like
`hostRoutes`. The host only stores them; an extension that acts for restricted sessions reads them from the caller facts
the MCP gateway attaches to each call. The bundled `gatekeeper` extension (off by default, `extensions/gatekeeper/`)
is that extension: it holds the bot identities (a GitHub App narrowed to one repo, a Slack bot without
`chat:write.public`/`im:write`, Linear, Sentry without alert-rule write) in its own 0600 store, never in a session's
env or files, and performs only the granted actions in its configured scope. Merge, revert and alert-rule changes run
only on an operator's word in the session's own thread, verified by the message author's Slack user id in its code, or
— for a merge — under the auto-rule (CI green + an approving review on the head commit). Every decision is audit-logged
(`$ARIGAMI_DIR/gatekeeper/audit.log`). Without the sandbox, the same-user limit above applies to its store too; in the
sandbox the store is never mounted.

**Wake-ups.** `triggers` is `false`, `"own-thread"` or `true` (narrowing takes the lower). `"own-thread"` allows only a
Slack listener on the session's own recorded thread (`metadata.origin` — host-protected; set by the session's creator, or
recorded once by an extension holding the `session:origin` permission through the MCP gateway), on itself; cron and any
other listener are refused with the reason. Listeners end with their session (archive or delete).

## Reporting

Open a private security advisory on the repository, or contact the maintainer
listed in the project README. Please don't file public issues for
vulnerabilities.
