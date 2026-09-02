# Telemetry

Arigami has **one** measurement mechanism and it is **off by default**.

If you opt in, this host periodically POSTs a small JSON document to a
collector. It contains the product-funnel milestones this install has reached
(names and timestamps only), plus a few facts about the install, under a random
instance id. Nothing else — not prompts, not code, not paths, not repo names,
not emails, not hostnames, not IPs.

Source of truth: [`server/telemetry.ts`](../server/telemetry.ts). Collector:
[`deploy/telemetry-worker/`](../deploy/telemetry-worker/).

## Turning it on / off

| Where | How |
| --- | --- |
| First-run wizard | Step **"Help improve Arigami"** — *Yes* / *No thanks*. Both settle the step; skipping leaves it off. |
| Settings → Telemetry | Toggle **Send anonymous usage milestones**. |
| Environment | `ARIGAMI_TELEMETRY=1` / `0` — pins the value and wins over the file. |
| `DO_NOT_TRACK=1` | Forces telemetry **off**, wins over everything, and disables the toggle in the UI. |
| Config file | `$ARIGAMI_DIR/config.json` → `"telemetry": { "enabled": false, "updateCheck": false, "endpoint": "https://telemetry.arigami.dev/v1/events" }` |

Precedence: `DO_NOT_TRACK` → `ARIGAMI_TELEMETRY` → config → **off**.

When telemetry is off the module never opens a socket: no timer, no fetch. You
can verify with `strace -f -e trace=connect -p <host pid>`.

## What is sent

Settings → Telemetry → **Preview payload** shows the exact JSON of the next
send (`GET /__api/telemetry` → `preview`). It always has this shape and only
these keys:

```json
{
  "v": 1,
  "id": "3f4c1c2e-…-9d1a",
  "sentAt": "2026-08-30T10:00:00.000Z",
  "version": "0.4.1",
  "commit": "0bfe022",
  "os": "linux",
  "arch": "x64",
  "docker": true,
  "sessions": "2-5",
  "events": [
    { "name": "install", "at": "2026-08-29T18:02:11.412Z" },
    { "name": "onboarding_step", "at": "…", "step": "claude", "status": "ok" },
    { "name": "first_session", "at": "…" },
    { "name": "first_pm_tree", "at": "…" }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `id` | Random UUID from `$ARIGAMI_DIR/telemetry-id`. Not derived from anything on the machine. |
| `version`, `commit` | `package.json` version and the short git sha of the running checkout. |
| `os`, `arch` | `process.platform` / `process.arch` (`linux`, `darwin`, `win32` · `x64`, `arm64`). |
| `docker` | Whether the host runs in a container. |
| `sessions` | Number of sessions ever created, bucketed: `0`, `1`, `2-5`, `6+`. |
| `events` | Funnel milestones since the last send (see below). Each is a name and an ISO timestamp; `onboarding_step` also carries the step id and its status, both from closed enums. |

### The funnel (K5)

These are the only event names that can appear. They come from
[`server/funnel.ts`](../server/funnel.ts) — the same log the wizard and
`bin/host doctor` read — and are emitted **once per install** (except the
onboarding steps):

| Wire name | When |
| --- | --- |
| `install` | First boot of this data dir |
| `onboarding_step` | A wizard step changed status (`step` + `status`) |
| `onboarding_done` | Every wizard step settled |
| `first_session` | First session created |
| `first_pm_tree` | A master's second child (≥ 2 children) |
| `first_request_screen` | First `request_screen` hand-over |
| `first_proposal_applied` | First skill proposal applied |
| `first_artifact_published` | First `publish_artifact` |
| `first_share_link` | First share link minted |
| `first_cron` | First cron job created |

Any other funnel event is dropped before it can leave the box — the allow-list
is `EVENT_MAP` in `server/telemetry.ts`, and `assertClean()` refuses to send a
payload with an unexpected key, an unknown event name, or any string that
contains `/`, `@`, `\`, whitespace, `://` or looks like a hostname.

### What is never sent

Prompts, transcripts, code, file paths, repository names or URLs, skill
names, session titles, user names, emails, hostnames, IP addresses, tokens,
environment variables, the endpoint itself, or free text of any kind. The
tests in [`test/telemetry.test.ts`](../test/telemetry.test.ts) grep every
payload for these shapes.

## When it is sent

- **Batched**: a new milestone schedules one send five minutes later; all
  unsent milestones ride together.
- **Daily ping**: at most one send per 24 h even with no new milestones, so
  active installs can be counted.
- `POST` with a 5-second timeout. Failures are silent and the batch is retried
  next time; nothing is ever logged to stdout.
- **Unreachable collector** (AUDIT2): a DNS failure (`ENOTFOUND`, `EAI_AGAIN`)
  drops the batch at once; any other failure drops it after 3 consecutive
  misses. After a drop nothing is retried for 24 h and new milestones in that
  window are dropped too — the queue never grows behind a dead endpoint. The
  count is `dropped` in `GET /__api/telemetry`; the Settings UI shows only the
  consent toggle (General › Advanced) and links here for "what is sent".

Local state: `$ARIGAMI_DIR/telemetry.json` (cursor into `funnel.jsonl`, last
send time, last payload, consecutive `failures`, `dropped`, `nextTryAt`).

## Deleting your data

Settings → Telemetry → **Reset ID** (or `rm $ARIGAMI_DIR/telemetry-id`)
generates a new UUID. Nothing links the old id to the new one; rows under the
old id expire on the collector (90 days in the reference worker). There is no
account to delete because there is no account.

## The collector

`telemetry.endpoint` defaults to `https://telemetry.arigami.dev/v1/events`
(placeholder until launch). You can point your hosts at your own collector:
`deploy/telemetry-worker/` is a ~100-line Cloudflare Worker that validates the
payload strictly and writes it to Analytics Engine and/or KV — see its README.
`ARIGAMI_TELEMETRY_URL=https://…` overrides the endpoint from the environment.

## API

| Route | Who | What |
| --- | --- | --- |
| `GET /__api/telemetry` | any signed-in user | `{enabled, reason, configured, dnt, endpoint, id, lastSentAt, lastError, pending, preview}` |
| `POST /__api/telemetry {enabled}` | admin | Toggle (persists to config; marks the wizard step decided) |
| `POST /__api/telemetry/rotate` | admin | New anonymous id, send history cleared |
| `POST /__api/onboarding/wizard/telemetry {action:'enable'\|'disable'}` | admin | The wizard's *Yes* / *No thanks* |
