# Shipped profiles

A profile is a declarative manifest that seeds the generic core — it registers
repos, ports, the issue source and the skills to enable, then the normal
per-step onboarding (clone → env → deps) runs. See `docs/ONBOARDING.md` §6.

| Profile | For |
|---|---|
| `solo-dev/` (Profile Bundle, from `install.sh --profile solo-dev`) | one developer, one or more of their own repos |
| `agency-client.json` | an agency/freelancer running a cockpit per client |
| `ops.json` | operations & automation with no product repo |

Your own profiles go in `$ARIGAMI_DIR/profiles/` (default `~/.arigami/profiles/`)
and override shipped ones by `name`. Nothing private belongs in this directory.
