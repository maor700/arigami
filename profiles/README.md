# Shipped profiles

A **Profile Bundle** folds a fresh host to a purpose: `profile.json` (repos,
issue source, workflows) + `skills/` + `memory-seed/` + `cron.json` +
`README.md`. Applying one is additive and idempotent — repos are upserted,
new skills land in `$ARIGAMI_DIR/skills`, memory lines are appended only if
missing, cron jobs are registered **disabled**. See `docs/INSTALL.md` §3.

| Bundle | For | Ships |
|---|---|---|
| [`bundles/solo-dev/`](bundles/solo-dev/) | one developer, their own repos | `daily-standup` skill, weekday standup cron |
| [`bundles/agency-client/`](bundles/agency-client/) | an agency / freelancer running a cockpit **for one client** | `client-status-report` (weekly report → artifact + share link), `client-intake` (request → ticket → child session), `CLIENT.md` template, weekly-report cron |
| [`bundles/ops/`](bundles/ops/) | an operations team, no product repo | `oncall-triage` (signed webhook → incident session → decision on the phone), `runbook-execute` (real desktop, hands you the wheel at login/2FA), daily digest + sweep crons |
| [`bundles/il-whatsapp-business/`](bundles/il-whatsapp-business/) | a small Hebrew-speaking service business living in WhatsApp | `whatsapp-inbox-triage` (classify → draft → owner approves → send; never auto-sends), `followup` (quotes, appointments), `BUSINESS.md` template (Hebrew), morning-digest cron |

Apply with `install.sh --profile <name>`, `bin/host profile apply <name>`, the
Setup/Wizard profile picker, or `POST /__api/profiles/apply {"source":"<name>"}`.

Your own bundles go in `$ARIGAMI_DIR/profiles/<name>/` (default
`~/.arigami/profiles/`) and override shipped ones by `name`. A thin
`<name>.json` manifest (repos only) is still accepted in either directory.
Nothing private belongs in this directory — bundles are generic templates
with `<placeholder>` repo sources.
