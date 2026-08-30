---
description: On-call triage for an ops team — read new alert events from the host's custom webhook, open one child session per incident, gather first facts, and escalate to the human's phone via request_action only when a decision is needed. Also produces the daily health digest. Use when the human says "triage alerts", "what's on fire", "on-call sweep", "health digest", or when the [ops] oncall-sweep / daily-health-digest crons fire.
argument-hint: [mode: sweep (default) | digest | "incident <id>"]
---

# On-call triage

Alerts reach the host as **signed webhook events**, not as chat messages.
Your loop: read the new events → decide which are incidents → one child
session per incident → escalate only what needs a human.

## Wiring (once, by the human)
1. Settings → Webhooks → **Custom** → id `alerts`. The host returns the
   endpoint `/__api/webhooks/custom/alerts` and an HMAC secret.
2. The alerting system (or a tiny relay) POSTs JSON with the
   `X-Arigami-Signature` / `X-Arigami-Timestamp` / `X-Arigami-Nonce` headers
   described in `docs/AUTH.md`. Anything unsigned is a bare 401.
3. To wake this skill automatically, enable `[ops] oncall-sweep` in Triggers
   (every 5 min, off by default). Otherwise run it by hand or keep one standing
   session that re-runs it.

## Sweep mode
1. `curl -s -H "Authorization: Bearer $ARIGAMI_TOKEN" "$ARIGAMI_URL/__api/webhooks/events?kind=custom/alerts&since=<last-seen>&limit=100"`.
   Keep `<last-seen>` (the newest event timestamp you handled) in
   `memory_write({target:"memory", action:"replace"|"add", content:"oncall: last-seen <ts>"})`.
   Nothing new → reply `[SILENT] no new alerts` and stop.
2. For each event, extract: source, severity, service, title, a stable
   fingerprint (service + title). Dedupe by fingerprint against the incident
   sessions already open (`list_sessions`, metadata `incident`).
3. **Not an incident** (info/resolved/duplicate): one line in the journal
   (`memory_write target:"journal"`), no session, no push.
4. **Incident:** `create_session({kind:"full", title:"INC <fingerprint>", needs_screen:false,
   metadata:{incident:"<fingerprint>", severity:"<sev>"}, prompt:"Incident: <title>. Payload: <json>. Run the oncall-triage skill in incident mode."})`.
   Reply with the child's host-relative `url`.

## Incident mode (you are the child)
1. First facts, read-only, ≤ 5 minutes: what the alert says, when it started,
   what changed (recent deploys/merges in the registered repos, `git log
   --since`), is it still firing (re-read the webhook events for the same
   fingerprint).
2. Find a matching runbook: grep `runbooks/` for the service name. If one
   exists, say which and what its first non-read-only step would do.
3. **Escalate a decision, not a status:**
   `request_action({prompt:"<service>: <one-line diagnosis>. Run runbook <name>?", buttons:[
     {label:"Run runbook", value:"run", style:"primary"},
     {label:"Keep watching", value:"watch"},
     {label:"Close — false alarm", value:"close", style:"danger"}]})`
   and stop until the human answers. This is the push to the phone.
4. On `run`: hand over to the `runbook-execute` skill (same session) with the
   runbook path. On `watch`: `register_listener` is not available for webhooks —
   re-check the events every few minutes for up to 30 min, then re-ask.
   On `close`: journal one line and `report_to_master({state:"done"})`.
5. Never restart, delete or fail over anything from this mode without the
   `run` answer. If you are unsure whether an action is destructive, it is.

## Digest mode (daily cron)
Read the last 24 h of `custom/alerts` events, every `./runs/*.md` written by
`runbook-execute` in the period, and the state of the incident sessions
(`list_sessions`). Write `./digests/<date>/index.html` (self-contained):
**open incidents · resolved · runbooks executed (with outcome) · noise
(alerts that were not incidents) · one suggestion** (e.g. a runbook that is
missing). `publish_artifact({path:"./digests/<date>", title:"Ops digest <date>"})`
and `report_to_master` with a two-line summary, `[SILENT]` when nothing happened.
