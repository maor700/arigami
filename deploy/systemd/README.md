# systemd units

| unit | purpose |
|---|---|
| `arigami.service` | the default instance (`ARIGAMI_DIR=$HOME/.arigami`) — **this is what `bin/host install` installs on Linux** |
| `arigami@.service` | per-instance template: `systemctl enable --now arigami@alice` → `ARIGAMI_DIR=/srv/arigami/alice` |
| `caddy.service` | optional TLS edge (C2): native Caddy running `deploy/caddy/Caddyfile` (Let's Encrypt) or `Caddyfile.lan` (self-signed) in front of `127.0.0.1:3099`. Install as `arigami-caddy.service` next to (not instead of) the distro's `caddy.service` — see [docs/TLS.md](../../docs/TLS.md) |
| `arigami-healthcheck.service` + `.timer` | the health watchdog, installed and enabled next to `arigami.service` by `bin/host install` / `install.sh`. `Restart=always` only acts when the process dies; once a minute this checks `/__health` and, after 3 failures in a row (~3 min), restarts the host — for a host that is alive but has stopped answering. It leaves a unit that is stopped on purpose alone, and the first 3 minutes after a start. Log: `journalctl -t arigami-healthcheck`. Off: `systemctl disable --now arigami-healthcheck.timer`. Dry run: `DRY_RUN=1 deploy/systemd/arigami-healthcheck` |
| `arigami-desktop.service` | optional: the shared `:99`/`5900` desktop as its own unit. Normally unnecessary — the default instance starts that desktop itself on boot (`server/lib/desktops.ts` `ensureGlobalDesktop`) and skips it when the display is already up |

All units carry `__ROOT__`, `__USER__`, `__HOME__`, `__BUN_DIR__` placeholders. `bin/host install` (or `bin/host render-unit [unit]`, default `arigami.service`) substitutes them; by hand:

```sh
sed -e 's#__ROOT__#/opt/arigami#g' -e 's#__USER__#arigami#g' \
    -e 's#__HOME__#/home/arigami#g' -e 's#__BUN_DIR__#/home/arigami/.bun/bin#g' \
    deploy/systemd/arigami.service | sudo tee /etc/systemd/system/arigami.service
sudo systemctl daemon-reload && sudo systemctl enable --now arigami
```

Per-host secrets/overrides go in `$ARIGAMI_DIR/env` (`KEY=VALUE` lines, loaded via `EnvironmentFile=-`), never in the unit.

`systemd-analyze verify /etc/systemd/system/arigami.service` should print nothing. Full install + pm2 migration: [docs/DEPLOY.md](../../docs/DEPLOY.md).
