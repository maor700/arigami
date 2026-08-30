# agency-client — Profile Bundle

**Arigami folded to one client.** An agency or freelancer installs Arigami at
(or for) a client, points it at the client's app repo, and gets a cockpit that
reports weekly, takes in requests as tickets and fans work out to child
sessions — with the human as the only approver and the only one who talks to
the client.

| part | what it does |
|---|---|
| `profile.json` | one placeholder repo `app` (edit `source` in Setup), GitHub as the ticket source, `project-manager` / `dispatch` / `machine-work` workflows enabled |
| `skills/client-status-report/` | weekly status report from git + sessions + tickets → self-contained HTML → `publish_artifact` with a **share link** the human forwards |
| `skills/client-intake/` | pasted request → classified, sized ticket draft → `request_action` (file / file+start / edit / drop) → ticket + optional `create_session` child |
| `memory-seed/MEMORY.md` | three standing rules (one client per host, client language, never contact the client automatically) — appended only if missing |
| `memory-seed/CLIENT.md` | a template describing the client (people, definition of done, ticket source, off-limits). Not loaded into memory: copy it to the workspace root and fill it in |
| `cron.json` | `[agency-client] weekly-report`, Monday 08:00 — registered **disabled** |

## 60 seconds after `apply`

1. **Setup** shows the `app` repo with a placeholder source — replace it with
   the client's repo and let clone → env → install run.
2. **Skills** lists `client-status-report` and `client-intake` with a *bundle*
   badge (they live in `$ARIGAMI_DIR/skills`, never in the repo).
3. Copy `memory-seed/CLIENT.md` to the workspace root and fill in the client's
   name, language, approvers and ticket source.
4. Open a session and paste a client message: *"intake this: the checkout
   button is invisible on mobile"*. The skill drafts a `bug` ticket, asks with
   four buttons, files it, and (if you chose so) spawns a child session whose
   link appears in the reply.
5. Say *"client report for the last 7 days"*. A report card appears with an
   artifact path and a 14-day share link. Forward the link — the client needs
   no account.
6. When you want it weekly, open **Triggers** and enable
   `[agency-client] weekly-report`. Runs push the TL;DR + link to your phone.

## Apply

```sh
install.sh --profile agency-client          # at install time (staged; the wizard finishes it)
bin/host profile apply agency-client        # later, from the shell
curl -X POST /__api/profiles/apply -d '{"source":"agency-client"}'   # from the cockpit / an admin token
```

Copy this directory to make a per-client variant (fill `repos[].source`,
commit your own `CLIENT.md`) — see `docs/INSTALL.md` → *Profile bundles*.
