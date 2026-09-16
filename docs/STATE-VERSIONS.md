# State-file versions and migrations

**Why this exists.** In the packaged desktop app, the version changes while the user is asleep —
the signed updater downloads it and relaunches. Today the update is manual and the owner notices
immediately if a state file came out wrong; that safety net disappears the moment updates go
automatic. This is the prerequisite for turning on automatic updates, and it lives in the data
layer, not in the packaging.

The contract is identical to the one that already exists for the archive format
(`server/backup.ts`, `BACKUP_FORMAT`): a version number that travels with the data, and a reader
that explicitly refuses a format that's too new instead of guessing.

- Engine: `server/lib/schema-version.ts`
- File registry: `server/lib/state-schemas.ts`
- Tests: `test/state-migrations.test.ts`

## The four rules

1. Every covered file carries `schemaVersion` at its root.
2. **A file without the field is version 1.** Every install that exists in the world is there
   right now, and must load without losing anything. Nothing in the engine requires the field to
   be present.
3. Migration is **forward-only**: a chain of sequential steps that runs on upgrade. Every step is
   idempotent — `up(up(d))` equals `up(d)` — because a migration that dies after writing but
   before stamping the version will run again on the next upgrade.
4. A file that's **too new** is rejected loudly and left untouched. This happens when the updater
   rolls back to an older version after a failed update — an expected case, not an exotic one.
   Stopping with a clear message beats reading a file it doesn't understand and silently
   flattening it.

**Safety net:** before every write, a `<file>.bak-v<from>-<timestamp>` is created alongside it,
and the write itself goes through `<file>.tmp` + `rename`, so a crash mid-write never leaves a
half-written file. These backups are already excluded from every archive — `EXCLUDE_GLOBS` in
`backup.ts` carries `*.bak-*` and `*.tmp`.

**Zero cost when there's nothing to do:** a file that's already at the current version is never
read-mutated-written, never backed up, and never touched at all.

## What's covered

| File | Version | Behavior on refusal |
|---|---|---|
| `state.json` | 2 | Upgrade stops; `flushState` is blocked so the file isn't overwritten |
| `config.json` | 1 | Upgrade stops (instead of falling back to defaults and then overwriting with them) |
| `triggers.json` | 1 | `loaded` stays false — the existing flush logic then never writes |
| `extensions.json` | 1 | Reports "no extensions" loudly, `writeState` is blocked; the host doesn't crash |

The 1→2 step for `state.json` is the **proof step**: it runs the chain end-to-end on a real
install while a human is still watching updates happen, before the updater starts running them
overnight. It removes three per-session run flags that only ever hit disk when the host gets
killed mid-run, and which `state.load()` already discards on read anyway. No behavior change, no
data loss.

## What's deliberately not covered

- **`*.jsonl`** (`incidents`, `funnel`, `sms`, `webhooks`) — append-only logs. There's no single
  document to stamp a version on; it would have to live on every line.
- **Cache and derived data** (`skills-graph.json`, `models.json`, `claude-update.json`,
  `telemetry.json`, `funnel-first.json`, `onboarding.json`, `setup-pending.json`,
  `chrome-base/`, `chrome-sessions/`) — rebuilt whenever missing or stale. A bad read costs a
  recompute, not data.
- **`children.json`, `run/`** — pid records that are only valid while this host process is alive.
  A stale read is already handled by the `hostId`-based sweep.
- **Secret stores** (`accounts.json`, `users.json`, `sessions.json`, `share-*`,
  `vapid-keys.json`, `linear-oauth.json`, `identity.json`, `mcp-connections.json`,
  `webhooks.json`) — stable and 0600. The engine can cover them without change the day one of
  them actually changes shape; stamping a version on them now would mean rewriting live secret
  files for no reason, which is exactly the opposite of the point.

## Adding a file

One entry in `state-schemas.ts`, and two hook points in the module that owns the file:
`migrateFile(...)` before the read on upgrade, and `stamp(...)` on the save path. Without the
second one, the module's next write erases the field and the migration reruns on every upgrade.
