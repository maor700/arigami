# CLIENT.md — who this cockpit works for

> Copy this file to the root of the client's workspace (next to the `app`
> repo) and fill it in. Every skill in the `agency-client` bundle reads it
> first. Keep it short; it is loaded on every client-facing task.

## Client
- **Name:** <client name>
- **Product / app:** <what the `app` repo is>
- **Language & tone for client-facing text:** <e.g. English, friendly-formal>
- **Timezone / working days:** <e.g. UTC+2, Mon–Fri>

## People
| role | name | how to reach | approves? |
|---|---|---|---|
| client owner | <name> | <email / chat> | yes — scope & priorities |
| agency lead | <name> | <email / chat> | yes — everything shipped |
| dev contact | <name> | <email / chat> | no |

## Definition of done
- <e.g. tests pass, deployed to staging, client owner has seen it>

## Where work is tracked
- **Tickets:** <GitHub issues on the `app` repo / a board URL>
- **Ticket labels used by intake:** `client-request`, `bug`, `feature`, `question`
- **Report cadence:** weekly, Monday morning (the `[agency-client] weekly-report` cron, off by default)

## Off-limits
- <systems, data or actions the agent must never touch without the human — e.g. production DB, billing>
