# Deploying the host (systemd) — and migrating off pm2

B4-lite makes the host restartable from the cockpit: `POST /__api/host/restart`
exits the process with code 0 and *relies on a supervisor to bring it back*.
The supported supervisor on Linux is systemd (`Restart=always`), from the units
in [`deploy/systemd/`](../deploy/systemd/README.md). macOS keeps launchd
(`bin/host install`). pm2 also restarts on exit, so the endpoints already work
under pm2 — but pm2 is an extra global dependency the repo doesn't own, and the
`install.sh` of B1 targets the units, so migrate.

## 1. Fresh install (Linux)

```sh
git clone <repo> /opt/arigami && cd /opt/arigami
bun install --frozen-lockfile && (cd web && bun run build)
bin/host install          # renders deploy/systemd/arigami.service → /etc/systemd/system, enable --now
bin/host doctor           # manager: systemd
```

`bin/host install` needs root or passwordless `sudo`. Without either it prints
the two commands to run by hand (`bin/host render-unit | sudo tee …`).

Optional per-host overrides: `$HOME/.arigami/env` (`ARIGAMI_PORT=…`,
`ARIGAMI_PUBLIC_URL=…`, tokens). It is read by `EnvironmentFile=-`, so it may be
absent.

## 2. Migrating a live pm2-managed host → systemd

Run as the service user (the one pm2 runs as), with sudo available. Downtime is
a few seconds; sessions resume with `--resume` like any host restart.

```sh
cd /opt/arigami
git pull --ff-only                       # get deploy/systemd + bin/host with the systemd branch
bun install --frozen-lockfile && (cd web && bun run build)

# 1. Render + install the unit while pm2 still runs (nothing starts yet).
bin/host render-unit | sudo tee /etc/systemd/system/arigami.service >/dev/null
sudo systemd-analyze verify /etc/systemd/system/arigami.service   # must print nothing
#    ^ verify the RENDERED unit you just installed — not the template under
#      deploy/systemd/ (its __ROOT__/__USER__/__HOME__/__BUN_DIR__ tokens are only filled by `bin/host render-unit`,
#      so running verify on the template reports bogus errors).
sudo systemctl daemon-reload

# 2. Hand over. pm2 must release the port BEFORE the unit starts (T5 hostlock refuses a second copy).
pm2 stop arigami && pm2 delete arigami && pm2 save
sudo systemctl enable --now arigami
bin/host doctor                          # manager: systemd, ● running

# 3. Retire pm2's own boot hook (the `pm2-<user>.service` it generated).
pm2 unstartup systemd                     # prints the exact sudo command; run it
sudo systemctl disable --now pm2-$(id -un) 2>/dev/null || true
```

Verify from the cockpit: Settings → Host shows `Supervisor: systemd`;
"Restart now" brings the host back within ~5 s and `/__ws` reconnects.

### The shared desktop (`:99`)

If you had a hand-written `arigami-vnc.service` (or similar) for the shared
Xvfb/x11vnc desktop, you can keep it: the host detects a display that is already
up and leaves it alone. If you remove it, the host starts the desktop itself on
boot (default instance only, when `Xvfb`+`x11vnc` are installed — `openbox`/`tint2`
are used when present). To keep the desktop out of the host's process tree on
purpose, install `deploy/systemd/arigami-desktop.service` instead.

Logs: `journalctl -u arigami -f`. Upgrade log: `$ARIGAMI_DIR/logs/upgrade.log`.

## 3. Rollback to pm2

```sh
sudo systemctl disable --now arigami
pm2 start "bun server/index.ts" --name arigami --cwd /opt/arigami && pm2 save
```

## 4. What the cockpit endpoints do

| endpoint | behaviour |
|---|---|
| `GET /__api/version` | `{version, tag, available:{version, tag, release}, commit, branch, ahead, behind, sharedBase, updateAvailable}` — `version` is VERSION/package.json (minted by `bun run release`), `available` is the upstream tip's package.json + newest v* tag (+ GitHub's latest release on `?refresh=1`), `sharedBase:false` = no merge base with upstream. Cached 60 s; `?refresh=1` runs `git fetch --tags` first (≤ once / 5 min) |
| `GET /__api/host/self-update` | `{enabled, auto, channel, current, available, updateAvailable, lastCheck, announced, lastApply}` — what the periodic release watcher last saw (`server/lib/self-update.ts`); `?check=1` forces a fresh look. Read-only: applying still goes through `POST /__api/host/upgrade`. Knobs: `host.updateCheck` (on), `host.autoUpgrade` (off). See docs/RELEASING.md |
| `GET /__api/host/status` | `{manager, channel, dirty:[…], uptimeSec, busySessions, pendingRestart:'now'\|'idle'\|null, phase, allowUpgrade, upgrade}` — `dirty` lists the tracked changes that would block an upgrade (VER1). `channel` is `'git'\|'docker'\|'packaged'` (`server/lib/update-backend.ts`, dispatch/update-backend) — which `UpdateBackend` `POST /host/upgrade` will use; only `git` is wired to actually run today |
| `POST /__api/host/restart?when=now` | stop accepting connections, give in-flight claude turns `host.drainTimeoutMs` (20 s) to finish, then exit 0 |
| `POST /__api/host/restart?when=idle` | queue until no session is `working` (max `host.idleTimeoutMin`, 30 min), then as above. `DELETE` cancels while queued |
| `POST /__api/host/upgrade?when=confirm\|now\|idle` | refuse (409, body carries `dirty:[…]`) if the checkout has uncommitted changes (untracked files are fine) or `host.allowUpgrade=false`; else `git fetch --tags` → `git merge-base --is-ancestor HEAD @{u}` (fails early with a readable reason when a ff pull is impossible — docs/GIT-REALIGN.md) → `git pull --ff-only` → `bun install --frozen-lockfile` → `cd web && bun run build`. `when=confirm` (the cockpit's **Update** button, VER1) then parks with `upgrade.needsRestart=true` and the human restarts from the card; `now\|idle` restart by themselves (CLI / orchestrators). Progress streams on `/__ws` as `{type:'host', event:{kind:'upgrade-progress', …}}`, `upgrade-done` carries `{needsRestart, from, to}`; log in `logs/upgrade.log` |

All mutations require the header `X-Arigami-Confirm: yes`, and — when the
caller is a session (`X-Arigami-Session`, set by the `host_restart` MCP tool) —
only master/controller sessions are allowed. Every one of them answers `409` when
no supervisor is detected (`bun server/index.ts` started by hand), so a restart
can never turn into a silent shutdown. **TODO(C1):** put these behind the admin
role once session-cookie auth lands.

Manager detection: `ARIGAMI_SUPERVISOR` env (the units set `systemd`) →
`INVOCATION_ID` (systemd) → `PM2_HOME`/`pm_id` (pm2) → `XPC_SERVICE_NAME` (launchd)
→ `none`. `self` exists for a packaged app's own launcher (no daemon — the
process that spawned us relaunches us after `exit 0`) but is override-only:
there's no auto-detection for it, so it only fires when the launcher sets
`ARIGAMI_SUPERVISOR=self` itself.

Config (`config.json`):

```json
"host": { "allowUpgrade": true, "drainTimeoutMs": 20000, "idleTimeoutMin": 30 }
```
