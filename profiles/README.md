# Profiles

The product ships **no** example profiles. A **Profile Bundle** folds a fresh host to a purpose, and yours comes from
your organisation's profile repo (a git URL, see below) or from `$ARIGAMI_DIR/profiles/<name>/` (default
`~/.arigami/profiles/`). A bundle is `profile.json` (repos, issue source, workflows) + `skills/` + `memory-seed/` +
`cron.json` + `agents/` (A4) + `README.md`. Applying one is additive and idempotent — repos are upserted,
new skills land in `$ARIGAMI_DIR/skills`, memory lines are appended only if
missing, cron jobs are registered **disabled**, agents are created under
`$ARIGAMI_DIR/agents/<slug>` only when absent (`--force` overwrites). See `docs/INSTALL.md` §3.

Apply with `install.sh --profile <name>`, `bin/host profile apply <name>`, the
Setup/Wizard profile picker, or `POST /__api/profiles/apply {"source":"<name>"}`.

Installed bundles live in `$ARIGAMI_DIR/profiles/<name>/` (git sources are cloned there). A thin
`<name>.json` manifest (repos only) is still accepted. `ARIGAMI_SHIPPED_BUNDLES_DIR` (default `profiles/bundles/`,
absent in this repo) names a read-only, trusted directory of bundles baked into an image; empty or missing is fine —
the picker then shows a hint that profiles come from the org profile repo. Nothing private belongs in this repository.

## An organisation's profile repo

One private git repo can carry everything a tenant needs, so a new user signs in once (to the company's Google) and
lands in a configured workspace — no GitHub sign-in:

```
profile.json                 manifest; "extensions": [{name, source?, ref?, settings?}]
skills/  agents/  memory-seed/  cron.json  README.md
extensions/<name>/           an extension that ships WITH the profile (manifest.json + code)
```

* **Extensions** install from `extensions/<name>/` (copied; `node_modules` and the user's own settings are kept) or
  from a git `source` pinned by `ref`. Re-applying the same profile changes nothing; a changed extension is updated
  in place; `settings` are seeded only when the host has none for it. **Only a trusted bundle installs extensions**
  — they run code — so an external bundle reports them `skipped`. `bin/host export --bundle` writes them: a git-sourced
  extension as a pinned `ref` (credentials stripped from the URL), anything else vendored; settings with a
  secret-looking key (`token`, `secret`, `password`, `apiKey`) are dropped.
* **Cron `scope`**: `user` (default) — every tenant registers its own copy, for its owner (e.g. "PRs waiting for MY
  review"). `org` — one shared job for the whole organisation; an ordinary tenant does **not** register it
  (`rep.cronSkipped` says so), only a host started with `ARIGAMI_ORG_HOST=1` does. Without this, N tenants would run
  the same org job N times.
* **Private repo, no user sign-in**: the control-plane's `CP_ARIGAMI_GIT_TOKEN` (a read-only deploy token or fine-grained
  PAT) reaches each tenant as `ARIGAMI_GIT_TOKEN`. `server/lib/git-auth.ts` sends it as an HTTP header, only to https
  URLs on `ARIGAMI_GIT_TOKEN_HOSTS` (default `github.com`) — never inside a URL, so it cannot reach a log or
  `.git/config`. It covers the bundle clone and any git-sourced extension.
* **Pinning**: `ARIGAMI_BUNDLE_REF` (a tag, branch or commit; empty = the default branch) is what the first boot
  checks out. The applied `ref` and `commit` are recorded in `$ARIGAMI_DIR/profile.json`.
* **Updates**: `ARIGAMI_BUNDLE` is applied once, on a fresh data dir (`applyBundleEnv` is a no-op once a provenance
  exists). A new version reaches existing tenants through the control-plane's **profile rollout**
  (`docs/CONTROL-PLANE.md` "Profile rollout"): it resolves `CP_ARIGAMI_BUNDLE_REF` to one commit and calls each
  tenant's `/__api/profiles/rollout` with an operator token signed by that tenant's handoff secret — canary tenants
  first, never while a turn is in flight, stopping at the first failure. That re-apply is **trusted** (extensions
  install/update in place, cron by `bundleKey`, `scope: org` still org-host only); skills, agents and the memory seed
  stay additive, so a skill the new version CHANGES is a pending proposal for the user, not an overwrite. A profile that
  does not validate fails the call and changes nothing. A standalone host re-applies with `POST /__api/profiles/apply`
  (admin) as before — untrusted for anything but a shipped bundle.

**Exported bundles are different.** `bin/host export --bundle` (Settings →
Host → *Download profile bundle*) snapshots *your* instance, and its
`memory-seed/` is your own `USER.md` + `MEMORY.md` — a personal profile, not
a template. Review them or export with `--no-memory` before sharing such a
bundle; the CLI and the Settings card both warn when they went in. See
`docs/BACKUP.md` §Sharing a setup.
