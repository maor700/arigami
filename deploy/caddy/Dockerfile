# Caddy with the rate-limit module (github.com/mholt/caddy-ratelimit) — used by
# the `tls` compose profile. Stock `caddy:2` has no `rate_limit` directive;
# to run without the plugin use image `caddy:2` and
# ARIGAMI_RATELIMIT_FILE=ratelimit-off.caddy (see docker-compose.yml).
ARG CADDY_VERSION=2.10
FROM caddy:${CADDY_VERSION}-builder AS builder
RUN xcaddy build \
    --with github.com/mholt/caddy-ratelimit

FROM caddy:${CADDY_VERSION}
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
COPY Caddyfile Caddyfile.lan arigami.caddy ratelimit.caddy ratelimit-off.caddy /etc/caddy/
