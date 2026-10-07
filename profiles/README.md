# Shipped profiles

A **Profile Bundle** folds a fresh host to a purpose: `profile.json` (repos,
issue source, workflows) + `skills/` + `memory-seed/` + `cron.json` +
`agents/` (A4) + `README.md`. Applying one is additive and idempotent — repos are upserted,
new skills land in `$ARIGAMI_DIR/skills`, memory lines are appended only if
missing, cron jobs are registered **disabled**, agents are created under
`$ARIGAMI_DIR/agents/<slug>` only when absent (`--force` overwrites). See `docs/INSTALL.md` §3.

| Bundle | For | Ships |
|---|---|---|
| [`bundles/solo-dev/`](bundles/solo-dev/) | one developer, their own repos | `daily-standup` skill, weekday standup cron |
| [`bundles/agency-client/`](bundles/agency-client/) | an agency / freelancer running a cockpit **for one client** | `client-status-report` (weekly report → artifact + share link), `client-intake` (request → ticket → child session), `CLIENT.md` template, weekly-report cron |
| [`bundles/ops/`](bundles/ops/) | an operations team, no product repo | `oncall-triage` (signed webhook → incident session → decision on the phone), `runbook-execute` (real desktop, hands you the wheel at login/2FA), daily digest + sweep crons |
| [`bundles/marketing-team/`](bundles/marketing-team/) | a small marketing team as **agents** (A4): manager awesome, copywriter Mila, image maker Jord, researcher Reachard, outreach Richi, social manager Fibi | six `agents/<slug>/` (persona + tools/domains/budget), `campaign-brief`, `content-calendar`, `outreach-sequence` skills, placeholder-product memory seed, disabled weekly-plan cron born from awesome |
| [`bundles/il-whatsapp-business/`](bundles/il-whatsapp-business/) | a small Hebrew-speaking service business living in WhatsApp | `whatsapp-inbox-triage` (classify → draft → owner approves → send; never auto-sends), `followup` (quotes, appointments), `BUSINESS.md` template (Hebrew), morning-digest cron |

Apply with `install.sh --profile <name>`, `bin/host profile apply <name>`, the
Setup/Wizard profile picker, or `POST /__api/profiles/apply {"source":"<name>"}`.

Your own bundles go in `$ARIGAMI_DIR/profiles/<name>/` (default
`~/.arigami/profiles/`) and override shipped ones by `name`. A thin
`<name>.json` manifest (repos only) is still accepted in either directory.
Nothing private belongs in this directory — bundles are generic templates
with `<placeholder>` repo sources.

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
* **Updates**: `ARIGAMI_BUNDLE` is applied once, on a fresh data dir (`applyBundleEnv` is a no-op once a provenance
  exists), so shipping a new profile version to existing tenants needs an explicit re-apply
  (`POST /__api/profiles/apply`) — the control-plane does not drive that yet.

**Exported bundles are different.** `bin/host export --bundle` (Settings →
Host → *Download profile bundle*) snapshots *your* instance, and its
`memory-seed/` is your own `USER.md` + `MEMORY.md` — a personal profile, not
a template. Review them or export with `--no-memory` before sharing such a
bundle; the CLI and the Settings card both warn when they went in. See
`docs/BACKUP.md` §Sharing a setup.
