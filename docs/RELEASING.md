# Releasing

How a commit on master becomes a version number, an image, and an update on
someone else's machine — and which parts happen without anyone asking.

## The short version

Merge to master. If CI goes green and there is anything worth releasing, the
version bot mints the next semver, tags it, and publishes. Installs notice on
their own within a few hours and say so; they do not update themselves unless
you turned that on.

```
merge to master
  → CI (.github/workflows/ci.yml)                     bun test, readiness gate
  → Version bump (.github/workflows/version-bump.yml) only if CI passed
      bun scripts/release.ts auto                     bump from the commits
      commit `chore(release): vX.Y.Z` + tag           pushed to master
      gh workflow run release.yml --ref vX.Y.Z        ← see "the trivia" below
  → Release image (.github/workflows/release.yml)
      ghcr.io/maor700/arigami:X.Y.Z, :X.Y, :latest, :sha-…
      ghcr.io/maor700/arigami-control-plane:…
      GitHub Release vX.Y.Z, body = that CHANGELOG.md section
  → installs find out (server/lib/self-update.ts, every 6 h)
```

## Where the version lives

One number, mirrored everywhere by `scripts/release.ts` — never edit these by
hand:

| Place | Written by | Read by |
| --- | --- | --- |
| `package.json` `version` | `release.ts` | the source of truth |
| `VERSION` | `release.ts` | the host + Docker builds (no JSON parsing) |
| `web/package.json`, `control-plane/package.json` | `release.ts` | so every package agrees |
| `desktop/src-tauri/tauri.conf.json` | `release.ts` | the desktop app's About dialog + installer names |
| `deploy/helm/arigami-control-plane/Chart.yaml` `appVersion` | `release.ts` | which app version the chart deploys |
| `CHANGELOG.md` | `release.ts` | the GitHub Release body |
| tag `vX.Y.Z` | `release.ts` | what release.yml publishes from |
| `GET /__api/version` | — | the cockpit's Settings → Host → Version |

The list lives in one place — `MIRRORED` in `scripts/release.ts`. A file that
does not exist is skipped, so the list can run ahead of the repo. Two
deliberate exclusions: a chart's own `version:` (that is the chart's revision,
not the app's) and `deploy/helm/arigami-tenant`, whose `appVersion` is
`"latest"` on purpose because it tracks the rolling image. `setChartAppVersion`
only ever rewrites something that already looks like a semver, so `"latest"`
survives even by accident.

Because `/__api/version` reads `VERSION`/`package.json` at runtime, bumping the
file is all it takes for the number in the cockpit to change. There is no
separate "version shown to users" to keep in sync. The Docker images are the
exception — they bake `VERSION` at build time, which is why the tag build also
republishes `:latest` (see below).

## Picking the number

`bun scripts/release.ts auto` reads the conventional commits since the last
`v*` tag and picks:

| In the commits since the last tag | Bump |
| --- | --- |
| a `!` marker or a `BREAKING CHANGE:` body | major |
| any `feat:` | minor |
| anything else (`fix`, `docs`, `chore`, non-conventional subjects) | patch |
| nothing at all (only merges / release commits) | **nothing** — exit 3, a skip |

Two rules worth knowing:

- **Pre-1.0 never auto-mints 1.0.0.** While the major is `0`, a breaking change
  moves the minor (`0.1.x` → `0.2.0`). Calling something 1.0.0 is a statement
  about the project, not about one commit, so it stays a human decision:
  `bun run release major`.
- **Merge commits and `chore(release):` commits are noise.** They never appear
  in the changelog and never decide the bump — which is also what stops the bot
  reacting to its own release commit.

## The trivia that makes the chain work

Anything pushed with the automatic `GITHUB_TOKEN` is deliberately barred from
triggering further workflow runs — GitHub's guard against a workflow looping on
its own commits. Two consequences, both load-bearing:

- **It is why the bot cannot loop.** Its push to master re-triggers nothing.
- **It is why the tag alone is not enough.** A human's `git push --follow-tags`
  fires `release.yml`'s `on.push.tags`; the bot's identical tag push does not.
  So version-bump.yml calls `gh workflow run release.yml --ref vX.Y.Z`
  explicitly. `workflow_dispatch` is the documented exception to the guard.

That dispatch passes `also_latest=true`, so the tag build also republishes
`:latest`. Without it `:latest` would keep the VERSION of the commit *before*
the bump, and a Docker install comparing itself against `:latest` would never
see itself as current.

## How an existing install finds out

`server/lib/self-update.ts` is a timer, armed at boot from `server/index.ts`.
Every ~6 hours it asks `getVersion({refresh:true})` (a `git fetch --tags` plus
the GitHub Releases check) and, when something newer exists, announces it
**once per version**: a `self-update-available` host event on the bus and a push
notification. Repeated ticks on the same version stay quiet, and the fact that
it already announced survives a restart (`self-update.json` in the data dir).

Applying is a separate decision:

| `cfg.host` | Default | Effect |
| --- | --- | --- |
| `updateCheck` | `true` | do the periodic check at all |
| `autoUpgrade` | `false` | apply what it finds, unattended |
| `allowUpgrade` | `true` | (existing) whether an upgrade may run at all |

`autoUpgrade` is off on purpose: an upgrade restarts the host and interrupts
whatever the sessions were doing. When it is on, the upgrade is queued
`when:'idle'` so it waits for busy sessions rather than killing them, and it is
skipped entirely on channels that cannot upgrade in place (Docker, packaged) —
those still get the notification.

`GET /__api/host/self-update` returns what the watcher last saw
(`?check=1` forces a fresh look). Applying still goes through
`POST /__api/host/upgrade`, with its admin check and confirm header.

## Updating an install by hand

| Situation | Command |
| --- | --- |
| host is up, sessions may be running | `bin/host upgrade` — asks the running host, which drains first |
| just asking | `bin/host upgrade --check` — exits 0 if an update exists, 1 if not |
| from cron | `bin/host upgrade --check && bin/host upgrade --idle` |
| host is down | `bash install.sh update` — plain pull/build/restart, no drain |
| from the cockpit | Settings → Host → Version → **Update** |

`bin/host upgrade` needs an admin `ARIGAMI_TOKEN` exported, the same contract as
`bin/host ext` and `bin/host profile`. It deliberately does not reimplement the
upgrade in shell — that sequence lives in `server/host-control.ts`, knows how to
drain, and refuses on a dirty checkout.

## Doing it by hand

The bot is a convenience, not a gate. `bun run release <patch|minor|major|X.Y.Z>`
still does exactly what it did before: writes the files, commits
`chore(release): vX.Y.Z`, makes the annotated tag, pushes nothing. Then
`git push --follow-tags` and `release.yml` picks it up through `on.push.tags` as
usual. version-bump.yml sees a `chore(release):` commit at HEAD and stands
aside, so a hand-cut release is not bumped a second time.

Useful flags: `--dry-run` (print the changelog section, touch nothing),
`--no-commit` (write the files only), `--since <ref>` (changelog from a specific
ref). You can also run the bot itself with **Run workflow → dry run** on the
Version bump workflow to see what it would pick, without minting anything.

## The first automated release

This repo has no `v*` tags. `v0.1.0` was written into `VERSION`/`CHANGELOG.md`
by hand in the VER1 commit and never tagged, so "everything since the last tag"
would have meant the entire history.

`auto` handles that: with no tag, the boundary is the commit that last wrote
`VERSION`. The first automated release therefore covers the ~47 commits that
landed since v0.1.0 was minted, and — no breaking changes, several `feat:` —
lands on **v0.2.0**. After that the tag exists and the normal rule takes over.
