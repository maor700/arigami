# ops — Profile Bundle

**Arigami folded to an operations team.** No product repo to build — a
runbooks repo, a signed webhook where alerts land, and a real desktop the
agent drives until a login or approval needs a human hand.

| part | what it does |
|---|---|
| `profile.json` | one placeholder repo `runbooks` (Markdown procedures, no build), `project-manager` + `machine-work` workflows |
| `skills/oncall-triage/` | reads new events from the custom webhook `alerts` → one child session per incident → first facts → `request_action` on the phone (*Run runbook / Keep watching / Close*). Also the daily digest |
| `skills/runbook-execute/` | executes a runbook step by step: shell steps here, browser steps on the per-session desktop, `[human]` steps via `request_screen` (login / 2FA / approval), verify, rollback, run record |
| `memory-seed/MEMORY.md` | where alerts come from, the escalation ladder, "the agent never types production credentials" |
| `cron.json` | `[ops] daily-health-digest` (08:00) and `[ops] oncall-sweep` (every 5 min) — both registered **disabled** |

## 60 seconds after `apply`

1. **Setup** shows `runbooks` with a placeholder source — point it at your
   procedures repo (or an empty repo you fill using the format in
   `skills/runbook-execute/SKILL.md`).
2. **Settings → Webhooks → Custom**: create id `alerts`. You get an endpoint
   and a secret; wire your alerting system (or a relay) to POST there with the
   HMAC headers from `docs/AUTH.md`.
3. Send one test event. Open a session and say *"triage alerts"*: the sweep
   finds the event, opens an `INC …` child session (link in the reply), and
   your phone buzzes with a three-button decision.
4. Tap **Run runbook**. The child switches to `runbook-execute`, runs shell
   steps, opens the console on its own desktop, and at the SSO login pushes
   *"login needed"*. Open the screen card, log in, tap **Done** — it verifies
   and continues, then writes `runs/<date>-<runbook>.md`.
5. In **Triggers**, enable `[ops] oncall-sweep` to make step 3 automatic and
   `[ops] daily-health-digest` for a morning artifact.

## Apply

```sh
install.sh --profile ops
bin/host profile apply ops
curl -X POST /__api/profiles/apply -d '{"source":"ops"}'
```

Copy this directory to make your own — see `docs/INSTALL.md` → *Profile bundles*.
