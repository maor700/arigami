# marketing-team — Profile Bundle

Six agents that behave like a small marketing team, plus the three shared skills they lean on.
Everything is a **generic template**: the product is `<your-product>` (a placeholder), there are
no accounts, no brand names and no repos. Apply it, then edit each agent's persona and connect
the accounts you actually use (Settings → Connections → "Assign to:" the agent).

| agent | slug | role | default tools | domains |
|---|---|---|---|---|
| awesome | `awesome` | manager — runs the weekly plan, briefs the others, keeps the human as the approver | sessions, triggers, publish | — |
| Mila | `mila` | copywriter — landing copy, emails, ad variants, in the brand voice | web, publish | — |
| Jord | `jord` | image maker — visual briefs, image prompts, simple assets on the desktop | desktop, web, publish | `unsplash.com`, `pexels.com` |
| Reachard | `reachard` | researcher — competitors, audiences, keywords, sources with links | web, publish | `*` |
| Richi | `richi` | outreach — partner / influencer / press sequences, never sends without approval | gmail, web, publish | — |
| Fibi | `fibi` | social manager — the content calendar, post drafts per channel, never posts without approval | web, publish | — |

| part | what it does |
|---|---|
| `agents/<slug>/` | `agent.json` (name, emoji, colour, skills, tools/domains allowlist, a modest daily token budget) + `persona.md` (≤ 20 lines: who you are + your limits) |
| `skills/campaign-brief/` | turn a goal into a one-page campaign brief the whole team works from |
| `skills/content-calendar/` | a two-week content calendar per channel from a brief |
| `skills/outreach-sequence/` | a 3-touch outreach sequence + a prospect table, sent only after approval |
| `memory-seed/MEMORY.md` | the placeholder product facts every agent should know (appended only when missing) |
| `cron.json` | a Monday 09:00 "weekly plan" job born from `awesome` — registered **disabled** |

## How the team is meant to be used

1. Apply the bundle. The six agents appear in the Rail under **Team**; each has a home chat.
2. Open a project folder (or any chat) and type `@awesome plan the launch of <your-product>` —
   from a project controller this spawns a child session born from awesome; from a normal chat
   it lands in awesome's home chat. `/team` lists who is busy. `/as mila write three subject
   lines for the launch email` runs a one-off session as Mila.
3. awesome briefs the others the same way (`create_session({agent:'mila', …})` / `task_session`)
   and reports back; every outbound action (send, post, publish) goes through `request_action`
   so the human stays the only approver.

## Apply

```sh
install.sh --profile marketing-team          # at install time (staged; the wizard finishes it)
bin/host profile apply marketing-team        # later; add --force to overwrite agents you edited
curl -X POST /__api/profiles/apply -d '{"source":"marketing-team"}'
```

Re-applying is idempotent: an agent that already exists on the host is **left alone** (your
persona edits win) unless you pass `--force` (`{"force":true}` over REST). Assets under
`agents/<slug>/assets/` are copied only when missing.

## Make it yours

- Replace `<your-product>` in `memory-seed/MEMORY.md` and the personas with the real product.
- Give Richi a Gmail (Settings → Connections → Assign to: Richi) and Fibi the social accounts you use.
- Tighten or loosen `tools` / `domains` / `budget` per agent — the host enforces them (A3). `publish` is what lets an agent deliver an artifact; a PUBLIC share link always asks the human first (A5).
- Bundle format: `docs/INSTALL.md` §3; agents: `docs/AGENTS.md` → A4.
