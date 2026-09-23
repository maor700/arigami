# Backup, restore and migration

Arigami keeps **all** of its state in one directory — `$ARIGAMI_DIR`
(default `~/.arigami`, `/data` in Docker). Moving an instance is moving that
directory. Two shapes, both `.tgz`:

| | **Full backup** | **Profile bundle** |
|---|---|---|
| purpose | migrate / disaster recovery | share a setup, seed a fresh host, showcase |
| contains | everything in `$ARIGAMI_DIR` (see below) | `profile.json` + `skills/` + `memory-seed/` + `cron.json` + `README.md` |
| secrets | **yes — as they are on disk** (accounts, API keys, users, share secret) | **never** |
| restore | replaces `$ARIGAMI_DIR`, host restarts | applied additively (`profile apply`) |
| CLI | `bin/host export --full [out.tgz]` · `bin/host import file.tgz` | `bin/host export --bundle [out/ \| out.tgz]` · `bin/host profile apply out/` |
| REST | `GET/POST /__api/host/export?mode=full` · `POST /__api/host/import` | `…?mode=bundle` · same import |
| UI | Settings → Host → Export / Import | same |

## What a full backup contains

Everything under `$ARIGAMI_DIR` **except** the host-bound or regenerable bits:

| excluded | why |
|---|---|
| `run/` | pid + lock of the *running* process |
| `chrome-sessions/`, `chrome-base/` | browser profiles (GBs); `chrome-base` is the owner's "my browser" — sign in there again after a restore |
| `logs/`, `tmp/`, `backups/` | logs, export scratch space, previous in-place restores |
| `*-logs.txt` at the root (`mcp-logs.txt`, `wa-logs.txt`) | integration logs that don't live under `logs/` (root level only — an upload named `x-logs.txt` is kept) |
| `user-plugin/` | a symlink shim regenerated at boot (F2) |
| `*.bak-*` | earlier `.bak` copies |
| `skills` | **only** when it's currently a symlink to `user/skills` (the normal, migrated state — extensions.ts rebuilds it every boot). A not-yet-migrated instance still keeps real files there and those ARE backed up. |
| `whatsapp/auth_info` | WhatsApp allows exactly one linked device — see "WhatsApp pairing" below. Off by default; `--whatsapp` opts in on export (native installs keep this auth outside `$ARIGAMI_DIR` anyway, so it only matters for the Docker layout). |

So it **does** include: `config.json`, `repos.json`, `users.json` (pairing
users + API-token hashes), `accounts.json` / `secrets.env` (Claude & integration
credentials, mostly as stored — see below), `state.json` + `sessions.json`
(sessions resume after restore), `chat/`, `memory/` (USER/MEMORY + the sqlite
index), `skills/`, `skill-proposals/`, `profiles/`, `triggers.json`,
`uploads/`, artifacts, share tokens, push subscriptions.

**`accounts.json` is rewritten, not copied verbatim.** A `keychain` account
(the local `claude` login — macOS Keychain or `~/.claude/.credentials.json`)
is a live pointer into *this* machine's OS credential store; it cannot
travel. The export keeps the record (so it shows up rather than silently
vanishing) but marks it `needsReauth: true` — reconnect it from Settings →
Connections on the new machine. `oauth-token` accounts (`claude setup-token`
/ browser auth) travel unchanged; the token itself is portable.

**WhatsApp pairing** (`whatsapp/auth_info`, Docker layout only) is excluded
from both export and import by default, for the same reason a `keychain`
account can't travel: WhatsApp allows exactly one linked device. Restoring a
second machine's pairing while the first is still connected logs the first
one out. Pass `--whatsapp` to `export --full` (REST: `?whatsapp=1`) to carry
it anyway — and to `import` (REST: same) to actually restore one already in
the archive — only once you're sure no other machine still needs that
WhatsApp number.

**`reposDir` / `defaultCwd` are resolved fresh on a cross-platform restore.**
If the archive's manifest says a different OS than the host doing the
import, any *absolute* path in those two config.json keys is dropped (a
`~/…` path is already portable and is left alone) — config.ts falls back to
its own default the moment it next loads, instead of a Linux repo path
landing verbatim on a Windows or macOS import.

A manifest `arigami-export.json` rides at the archive root:

```json
{ "kind": "arigami-backup", "format": 1, "version": "0.1.0", "commit": "0bfe022",
  "createdAt": "2026-08-30T10:00:00.000Z", "host": { "platform": "linux", "arch": "x64", "release": "…", "runtime": "bun 1.x" },
  "include": null, "excludes": ["run", "chrome-sessions", "…"] }
```

`include` lets you take a partial backup (`--include memory,skills,chat`);
the manifest records it.

**The archive is not encrypted.** Treat it like the secrets it contains.

## Restore rules

1. The manifest must be an Arigami backup; a **newer `format` or a newer major
   `version`** than the running host is refused (HTTP 409) — upgrade the host
   first, then import.
2. **Stop-the-world guard**: while any session has a turn in flight the import
   is refused (409) unless you pass `--force` / tick *Force*. Prefer *Restart
   when idle* first.
3. The archive is extracted to a staging dir next to `$ARIGAMI_DIR`; the
   current dir is renamed to **`$ARIGAMI_DIR.bak-<UTC stamp>`** and the staging
   dir moved in. `run/` is carried over so the running host keeps its pid/lock
   until it restarts.
   *Docker:* `/data` is a mount point and can't be renamed — the contents are
   swapped instead and the previous data lands in `/data/backups/<stamp>.bak/`.
4. The host restarts (B4-lite: needs a supervisor — systemd / launchd / pm2 /
   the container's entrypoint). A supervisor only counts when it is the
   **parent of this process** (inherited `pm_id` / `INVOCATION_ID` in a host
   started from a shell don't) — without one the host **stays up** on the
   old code/identity and the response says
   `restart: { scheduled: false, reason: "no supervisor — restart manually" }`;
   run `bin/host restart` yourself.
5. Nothing is deleted. Remove `.bak-*` dirs yourself once you're happy.

Restoring another machine's backup brings **its** users and pairing — your
current cookie stops working; pair again with the restored admin, or run
`bin/host pair`.

## Migration recipes

### Laptop → VPS

```sh
# laptop
bin/host export --full ~/arigami-laptop.tgz          # or Settings → Host → Download full backup
scp ~/arigami-laptop.tgz vps:

# vps (already installed with install.sh; the unit is running)
ARIGAMI_TOKEN=<admin API token> bin/host import ~/arigami-laptop.tgz    # via REST, host restarts itself
# or, without a token:
sudo systemctl stop arigami && bin/host import ~/arigami-laptop.tgz && sudo systemctl start arigami
```

Sessions resume (`claude --resume`) as long as the repos exist at the same
paths: `repos.json` points at `reposDir/<name>`; run Setup once so missing
clones are re-provisioned.

### VPS → Docker

```sh
# vps
bin/host export --full backup.tgz
# docker host: copy the file in and import from inside the container
docker cp backup.tgz arigami:/tmp/backup.tgz
docker exec arigami bin/host import /tmp/backup.tgz --force     # /data contents swapped, old data in /data/backups/
docker restart arigami
```

Or from the cockpit: Settings → Host → Import… (the container restarts via its
entrypoint).

### Docker → native

```sh
docker exec arigami bin/host export --full /data/tmp/backup.tgz
docker cp arigami:/data/tmp/backup.tgz .
bin/host stop && bin/host import backup.tgz && bin/host start
```

The Claude account (`accounts.json` / `secrets.env`) travels with the backup;
`bin/host doctor` tells you if the container's `claude` binary path differs
(`ARIGAMI_CLAUDE_BIN`).

### Sharing a setup (no secrets)

```sh
bin/host export --bundle ./my-setup          # a directory you can commit to git
bin/host export --bundle my-setup.tgz        # or one file
bin/host export --bundle --no-memory out/    # leave memory/USER.md + MEMORY.md out
bin/host export --bundle --name team-x out/  # profile.json "name" (default: exported-host)
# elsewhere:
bin/host profile apply ./my-setup            # or: bin/host import my-setup.tgz
```

**`memory-seed/` is personal.** It carries your `memory/USER.md` and
`MEMORY.md` — the profile the host has built of *you* (name, family,
employer, habits…). It is not a secret in the credential sense, but it is
not something to ship to strangers either: the CLI prints a warning when it
went in, the Settings card shows the same line next to its *include memory
seed* checkbox, and the bundle README says so. Review the two files or export
with `--no-memory` (UI: untick the checkbox, REST: `?memory=0`) before
sharing.

The bundle's `name` is always `exported-host` (or `--name` / `?name=`) —
never the name of the last bundle you *applied*. Cron jobs carry a stable
`key` (`<bundle>/<slug>`, e.g. `solo-dev/standup`) that survives export →
import hops, so importing an export back into the same instance **updates**
the existing triggers (prompt/schedule) instead of adding `[exported-host] …`
twins; a hand-made trigger that matches by name + prompt is adopted the same
way. Trigger enabled/disabled state is never changed by a re-apply.

A bundle is exactly what `profiles.ts` applies (see `docs/INSTALL.md` §3):
registered repos (minus local env-file paths) and a few portable settings
(`defaultModel`, `voiceLang`, `sttModel`, `palette`, `devServerPorts`,
`dispatcher`, `brain`) in `profile.json`, every skill from
`$ARIGAMI_DIR/skills/`, `memory/USER.md` + `MEMORY.md` as the seed, and cron
triggers with the host-bound parts stripped (`existing:<session>` modes,
WhatsApp/master delivery). Skills from an exported bundle are **external**
⇒ they land as pending proposals on the receiving host; cron jobs are
registered **disabled**.

## REST

```
GET  /__api/host/export?mode=full|bundle[&include=a,b]      admin; streams a .tgz (Content-Disposition)
POST /__api/host/export   {mode, include?}                   admin + X-Arigami-Confirm: yes; same stream
POST /__api/host/import[?force=1]                            admin + X-Arigami-Confirm: yes
       body: raw application/gzip, or multipart/form-data with one file field
       → full:   {ok, kind:"full", manifest, restoredTo, backupDir, entries, restart|restartError, manager}
       → bundle: {ok, kind:"bundle", …profiles apply report}
       409: sessions working (no force) · newer format/version
```

Upload limit 8 GB; the upload is spooled to `$ARIGAMI_DIR/tmp/` and deleted
afterwards.
