# solo-dev — Profile Bundle

The smallest useful bundle: what a single developer wants on a fresh Arigami host.

| part | what it does |
|---|---|
| `profile.json` | no repos pre-seeded (add yours in Setup), no issue tracker |
| `skills/daily-standup/` | a tiny skill: summarize yesterday's commits across your repos and propose today's three tasks |
| `memory-seed/MEMORY.md` | two working-style defaults the agent should know (appended only if missing) |
| `cron.json` | a weekday 09:00 "standup" job — registered **disabled**; enable it in Triggers when you want it |

Apply it with any of:

```sh
install.sh --profile solo-dev            # at install time (staged; the wizard finishes it)
bin/host profile apply solo-dev          # later, from the shell
curl -X POST /__api/profiles/apply -d '{"source":"solo-dev"}'   # from the cockpit / an admin token
```

Copy this directory to make your own bundle — see `docs/INSTALL.md` → *Profile bundles*.
