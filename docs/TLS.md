# TLS in front of the host (C2) — Caddy, `tailscale serve`, LAN

The host itself never speaks TLS. It listens on `127.0.0.1:3099` (C1 default,
fail-closed) and something in front terminates HTTPS and forwards to loopback.
Three ways, pick one:

| you want | use | certificate | phones |
|---|---|---|---|
| a public name on a VPS | **Caddy, `deploy/caddy/Caddyfile`** (native or compose `--profile tls`) | Let's Encrypt, automatic | just works |
| remote access without opening ports | **`tailscale serve`** | Tailscale-issued, automatic | just works (tailnet) |
| a LAN name / IP, no DNS | **Caddy, `deploy/caddy/Caddyfile.lan`** | self-signed, Caddy's internal CA | install the CA by hand — prefer `tailscale serve` |

**Why TLS at all (K1).** Everything past the login page needs a *secure
context*: the service worker that proxies live dev-server tabs
(`server/proxy.ts`, `web/public/sw.js`), push notifications, the clipboard,
`crypto.subtle`. Browsers grant it to `https://…` and to `http://localhost`
only — so `http://<lan-ip>:3099` shows the cockpit but dev-server tabs sit in
the "starting host proxy…" loop forever. Behind any of the three options above
the same SW proxy works from a laptop and a phone with no path-proxy.

## What the host needs to know: `ARIGAMI_PUBLIC_URL` (and `trustProxy`)

Behind a proxy the host sees `http://127.0.0.1:3099`. Two things need the real
browser-facing origin:

1. **Redirect URIs** (OIDC login, Linear/Composio OAuth) and outgoing share
   links — built by `browserOrigin()` in `server/api.ts`.
2. The **`Secure` flag** on the `arigami_sid` cookie — without it a browser
   still accepts the cookie over https, but it would also be sent over plain
   http if anything ever downgraded.

Two mechanisms, in precedence order (`server/lib/proxy-headers.ts`):

- **`ARIGAMI_PUBLIC_URL=https://<name>`** — explicit, always wins. **Set it to
  exactly the origin users type**, scheme and port included, no trailing
  slash. It must match `ARIGAMI_DOMAIN` (Caddy) / the `tailscale serve`
  hostname, otherwise OAuth callbacks land on a name the proxy doesn't serve
  and cookies for one origin are minted while the browser sits on another.
- **`X-Forwarded-Proto` / `X-Forwarded-Host`** from the proxy — believed only
  when `trustProxy` is on **and the TCP peer is loopback**. `trustProxy`
  defaults to *true when `bind` is loopback* (the proxy is the only thing that
  can reach the socket) and *false otherwise*; override with
  `ARIGAMI_TRUST_PROXY=1|0` or `"trustProxy": true|false` in `config.json`.
  With `ARIGAMI_BIND=0.0.0.0` a remote client could forge the header, hence
  off by default there — and even when forced on, non-loopback peers are
  ignored.

Native Caddy / `tailscale serve` on the same machine → both mechanisms apply;
setting `ARIGAMI_PUBLIC_URL` is still recommended (OAuth providers want a
fixed redirect URI). Docker compose `tls` profile → Caddy reaches the
container over the compose network (not loopback), so **`ARIGAMI_PUBLIC_URL`
is the only source** there; the compose file pins `ARIGAMI_TRUST_PROXY=0`.

## 1. Public VPS — native Caddy (Ubuntu)

```sh
sudo apt install caddy                      # https://caddyserver.com/docs/install
sudo systemctl disable --now caddy          # we run our own unit with our own Caddyfile

# $ARIGAMI_DIR/env — read by BOTH arigami.service and arigami-caddy.service
cat >> ~/.arigami/env <<'EOT'
ARIGAMI_DOMAIN=arigami.example.com
ARIGAMI_PUBLIC_URL=https://arigami.example.com
# stock apt caddy has no rate-limit module — see "Rate limits" below
ARIGAMI_RATELIMIT_FILE=ratelimit-off.caddy
EOT

sed -e 's#__ROOT__#/opt/arigami#g' -e 's#__USER__#arigami#g' -e 's#__HOME__#/home/arigami#g' \
    deploy/systemd/caddy.service | sudo tee /etc/systemd/system/arigami-caddy.service
sudo systemctl daemon-reload
sudo systemctl restart arigami                # picks up ARIGAMI_PUBLIC_URL
sudo systemctl enable --now arigami-caddy
```

DNS `A`/`AAAA` for the name must point at the machine and ports **80 and 443**
must be reachable (HTTP-01 / TLS-ALPN-01). Certificates, the ACME account and
the internal CA live under `$ARIGAMI_DIR/caddy/` (unit sets `XDG_DATA_HOME`).

Check:

```sh
curl -sI https://arigami.example.com/__host/ | grep -i 'strict-transport\|HTTP/'   # 200, HSTS
curl -s -o /dev/null -w '%{http_code}\n' http://<public-ip>:3099/               # refused (loopback bind)
ss -ltnp | grep -E ':(80|443|3099) '                                          # caddy on 80/443, bun on 127.0.0.1:3099
```

Prefer to keep the distro's `caddy.service`? Then instead of our unit put
`import /opt/arigami/deploy/caddy/Caddyfile` in `/etc/caddy/Caddyfile` and
export the env vars in `/etc/caddy/environment`… (Debian's unit doesn't load
one by default — `systemctl edit caddy` → `[Service] EnvironmentFile=…`).

Testing against Let's Encrypt's issuance limits: uncomment the `acme_ca`
staging line in the Caddyfile's global block until the config is right.

## 2. Public VPS — docker compose `tls` profile

```sh
cp docker/.env.example .env                    # + ARIGAMI_DOMAIN, ARIGAMI_PUBLIC_URL
docker compose --profile tls up --build -d
docker compose logs -f caddy                   # "certificate obtained successfully" within ~1 min
```

- `arigami` publishes `127.0.0.1:3199` on the docker host only; `caddy`
  publishes 80/443 and proxies to `arigami:3199` over the compose network.
- Caddy's certificates live in the `caddy-data` volume — don't `down -v` it
  casually (Let's Encrypt rate-limits re-issuance).
- The `caddy` image is built from `deploy/caddy/Dockerfile` (xcaddy +
  caddy-ratelimit). Stock image instead: see "Rate limits".

## 3. Remote access without a public name — `tailscale serve`

```sh
tailscale serve --bg 3099          # https://<machine>.<tailnet>.ts.net → 127.0.0.1:3099
```

Tailscale terminates TLS with a real certificate, forwards to loopback with
`X-Forwarded-Proto: https` (trusted — loopback peer), and no port is opened
to the internet. Set `ARIGAMI_PUBLIC_URL=https://<machine>.<tailnet>.ts.net`
in `$ARIGAMI_DIR/env` and restart the host. This is the recommended way to
reach the cockpit from a phone; see also docs/AUTH.md "Migrating…".

There are no proxy-side rate limits in this setup (the tailnet is the
perimeter); the host's own pairing lock still applies.

## 4. LAN with HTTPS — self-signed via Caddy's internal CA

For a box on a home/office network that isn't on a tailnet and has no public
DNS. `Caddyfile.lan` answers **any** name on `:443` (`arigami.lan`, the mDNS
name, the LAN IP) with a certificate minted by Caddy's local CA.

```sh
# $ARIGAMI_DIR/env
ARIGAMI_CADDYFILE=/opt/arigami/deploy/caddy/Caddyfile.lan
ARIGAMI_PUBLIC_URL=https://arigami.lan          # whatever clients type; add it to their hosts/DNS
ARIGAMI_RATELIMIT_FILE=ratelimit-off.caddy
sudo systemctl enable --now arigami-caddy && sudo systemctl restart arigami
```

Trusting the CA:

- on the Caddy machine: `caddy trust` (uses the same `XDG_DATA_HOME`, so run it
  as the service user or point it at `$ARIGAMI_DIR/caddy`), or copy
  `$ARIGAMI_DIR/caddy/caddy/pki/authorities/local/root.crt` and import it;
- other laptops: import `root.crt` into the OS/browser trust store;
- phones: iOS/Android need the profile installed **and** enabled for TLS —
  fiddly, and Android apps ignore user CAs. **Prefer `tailscale serve` for
  phones.**

Without the CA trusted the browser shows a warning; clicking through gives the
cockpit but **not** a secure context for the service worker → dev-server tabs
won't load. That's the "starting host proxy…" loop again, not a host bug.

## Rate limits

`deploy/caddy/ratelimit.caddy` (429 + `Retry-After`, keyed by client IP):

| path | limit |
|---|---|
| `/__api/auth/*` | 10 / min |
| `/__api/webhooks/*` | 60 / min |
| `/__artifacts/*` | 300 / min |

It needs the [`caddy-ratelimit`](https://github.com/mholt/caddy-ratelimit)
module, which stock `caddy` (apt, `caddy:2` image) doesn't have. Options:

1. **compose `tls` profile** — built in by `deploy/caddy/Dockerfile`.
2. **native** — download a build with the module from
   <https://caddyserver.com/download> (tick `github.com/mholt/caddy-ratelimit`)
   or `xcaddy build --with github.com/mholt/caddy-ratelimit`, and put it at
   `/usr/bin/caddy`.
3. **no plugin** — `ARIGAMI_RATELIMIT_FILE=ratelimit-off.caddy`. The Caddyfile
   then validates on stock caddy; only the host's pairing lock (5 wrong codes
   → 60 s) remains.

`caddy validate --config deploy/caddy/Caddyfile --adapter caddyfile` (with
`ARIGAMI_DOMAIN=x.example` exported) tells you in one line which case you are
in: `unrecognized directive: rate_limit` = stock binary.

## What the Caddy config does (`deploy/caddy/arigami.caddy`)

- `reverse_proxy` to `ARIGAMI_UPSTREAM` (default `127.0.0.1:3099`). Caddy sets
  `X-Forwarded-For/-Proto/-Host` and passes WebSocket upgrades (`/__ws`,
  `/__vnc`, the SW proxy's HMR sockets) through; websocket routes get no
  read/write timeouts, everything streams (`flush_interval -1`, SSE/logs).
- Security headers: `Strict-Transport-Security max-age=31536000;
  includeSubDomains` (no `preload` — opt in yourself), `X-Content-Type-Options
  nosniff`, `X-Frame-Options SAMEORIGIN`, `Referrer-Policy`, `Server` removed.
- `POST /__api/sessions/*/artifacts` body capped at 1 MB (it's a small JSON
  descriptor; the files come from the session's disk). Nothing else is capped
  at the edge — the host's `readBody()` caps JSON bodies at 5 MB itself.
- `encode zstd gzip`.
- Automatic http→https redirect on :80 (Caddy default).

## Migration notes (live single-machine host)

- Before C2 the SW proxy only worked from `http://localhost:3099` on the
  machine itself; `http://<tailscale-ip>:3099` / LAN gave a cockpit whose
  dev-server tabs never loaded. With C1's loopback bind those direct URLs are
  gone anyway — put TLS in front (this doc) and the tabs work everywhere.
- `tailscale serve` users: nothing changes except the cookie is now minted with
  `Secure` (trusted `X-Forwarded-Proto` from loopback). Existing sessions stay
  valid; the flag is added on the next login.
- The cockpit, MCP and one-shots keep talking to `http://127.0.0.1:3099`
  internally (`cfg.hostBase`); the proxy is for browsers only.
