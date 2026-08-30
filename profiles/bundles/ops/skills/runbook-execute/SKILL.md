---
description: Execute an ops runbook (a Markdown procedure from the runbooks repo) step by step on a real desktop — narrate, screenshot at the required moments, hand the human the wheel at login / 2FA / approval dialogs via request_screen, verify after they click Done, and record the run. Follows the machine-work convention. Use when the human says "run runbook <name>", "do the <procedure>", or when oncall-triage got a "Run runbook" answer.
argument-hint: [runbook path or name, e.g. "rotate-api-keys"]
---

# Runbook execution (hands you the wheel)

Load and follow the `machine-work` skill for everything that touches the
desktop. This skill adds the runbook structure on top.

## Runbook format (what the `runbooks` repo contains)
One Markdown file per procedure:

```
# <title>
Owner: <team>   Risk: low|medium|high   Needs: <systems / consoles>
## Preconditions
- …
## Steps
1. [shell]   <command>                     ← runs in this session
2. [browser] <what to do on which page>    ← done on the per-session desktop
3. [human]   <approval / 2FA / payment>    ← request_screen, always
4. [verify]  <what must be true afterwards>
## Rollback
- …
```

## Procedure
1. **Find & read.** Resolve the argument to `runbooks/**/<name>.md` (grep the
   title if no exact file). Print title, risk and preconditions. For `Risk:
   high`, `request_action` a confirm ("Execute <title> (high risk)?") before
   step 1 — even if oncall-triage already asked.
2. **Preconditions.** Check each one read-only. Any failure → stop, report,
   do not improvise.
3. **Steps, in order.** Before each step, `set_status_summary("step N/M: …")`.
   - `[shell]` — run it; on non-zero exit stop and ask
     (`request_action`: Retry / Skip / Abort).
   - `[browser]` — `needs_screen` desktop, capture the first page, do the
     step, capture after.
   - `[human]` — `request_screen({prompt:"<what to do>", reason:"login|2fa|approval", hint:"<where the button is>"})`.
     Wait for Done, capture the screen, verify the expected state before
     moving on. Never type credentials or codes yourself, even if you can
     see them.
   - `[verify]` — evaluate; a failed verify means run the **Rollback**
     section (each rollback line is itself a step) after asking.
4. **Record.** Write `./runs/<date>-<runbook>.md`: who triggered it (cron /
   human / incident session), each step with outcome and timestamp, the
   screenshots' captions, and the final verify result. This file is what the
   daily digest reads.
5. **Finish.** `capture_screen({caption:"done"})`, summarize in ≤ 5 lines, and
   `report_to_master({state:"done"|"blocked"|"error", summary, artifacts:[{kind:"file", path:"runs/…"}]})`
   if you have a master (an incident session or a cron run).
