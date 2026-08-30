# Telemetry collector (Cloudflare Worker)

The endpoint that opt-in Arigami hosts POST to (`telemetry.endpoint`, default
`https://telemetry.arigami.dev/v1/events`). See [docs/TELEMETRY.md](../../docs/TELEMETRY.md)
for what the payload contains and how a host opts in/out.

This is a placeholder-grade collector — ~100 lines, no dependencies, free tier:

- `POST /v1/events` — validates the payload strictly (schema `v:1`, allow-listed
  event names, uuid id, no free-text fields), then writes it to whichever
  binding exists:
  - **Analytics Engine** dataset (`TELEMETRY`): one row per ping + one row per
    funnel milestone, indexed by the anonymous instance id. Query with SQL
    over the [Analytics Engine API](https://developers.cloudflare.com/analytics/analytics-engine/).
  - **KV** (`TELEMETRY_KV`): the last payload per instance id, 90-day TTL.
- Everything else → 404. Bodies over 64 KB → 413. Malformed → 400.
- It does **not** log IPs, headers or user agents, and returns `204` with no body.

## Deploy

```sh
cd deploy/telemetry-worker
npx wrangler login
npx wrangler deploy          # creates the Analytics Engine dataset on first write
```

Point hosts at it with `ARIGAMI_TELEMETRY_URL=https://<worker>/v1/events` or
`"telemetry": { "endpoint": "…" }` in `$ARIGAMI_DIR/config.json`.

## Useful queries (Analytics Engine SQL)

```sql
-- weekly active instances
SELECT toStartOfInterval(timestamp, INTERVAL '7' DAY) AS week, count(DISTINCT index1) AS instances
FROM arigami_telemetry WHERE blob1 = 'ping' GROUP BY week ORDER BY week;

-- the funnel: how many instances reached each milestone
SELECT blob1 AS milestone, count(DISTINCT index1) AS instances
FROM arigami_telemetry WHERE blob1 != 'ping' AND blob1 != 'onboarding_step'
GROUP BY milestone ORDER BY instances DESC;
```

## Delete an instance's data

A host that clicks **Reset anonymous ID** gets a new uuid; nothing links the two.
To honour a manual request, delete the KV key `instance:<id>`; Analytics Engine
rows expire by the dataset's retention (90 days by default).
