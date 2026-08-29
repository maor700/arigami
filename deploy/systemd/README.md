# systemd units

| unit | purpose |
|---|---|
| `arigami.service` | the default instance (`ARIGAMI_DIR=$HOME/.arigami`) — **this is what `bin/host install` installs on Linux** |
| `arigami@.service` | per-instance template: `systemctl enable --now arigami@alice` → `ARIGAMI_DIR=/srv/arigami/alice` |
| `arigami-desktop.service` | optional: the shared `:99`/`5900` desktop as its own unit. Normally unnecessary — the default instance starts that desktop itself on boot (`server/lib/desktops.ts` `ensureGlobalDesktop`) and skips it when the display is already up |

All units carry `__ROOT__`, `__USER__`, `__HOME__`, `__BUN_DIR__` placeholders. `bin/host install` (or `bin/host render-unit`) substitutes them; by hand:

```sh
sed -e 's#__ROOT__#/opt/arigami#g' -e 's#__USER__#arigami#g' \
    -e 's#__HOME__#/home/arigami#g' -e 's#__BUN_DIR__#/home/arigami/.bun/bin#g' \
    deploy/systemd/arigami.service | sudo tee /etc/systemd/system/arigami.service
sudo systemctl daemon-reload && sudo systemctl enable --now arigami
```

Per-host secrets/overrides go in `$ARIGAMI_DIR/env` (`KEY=VALUE` lines, loaded via `EnvironmentFile=-`), never in the unit.

`systemd-analyze verify /etc/systemd/system/arigami.service` should print nothing. Full install + pm2 migration: [docs/DEPLOY.md](../../docs/DEPLOY.md).
