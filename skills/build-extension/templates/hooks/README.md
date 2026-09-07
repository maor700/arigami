# template: hooks

Automation on the host's own events: react to a merge, a review, a listener firing —
and, if you want, **block a merge** until a check passes.

**Delete this file** after you copy the template.

## Placeholders

| placeholder | where | value |
|---|---|---|
| `{{name}}` | `manifest.json` | the extension name = the directory name |
| `{{title}}` | `manifest.json`, the notification title | short human title |
| `{{description}}` | `manifest.json` | one line: what it automates |

## What to edit after that

* `manifest.hooks.events` **and** the handlers in `hooks.ts` — they must match, or
  validation warns about the ones with no handler. The events available are
  `session.created`, `listener.fired`, `review.approved`, `merge.done`,
  `merge.conflict`, `action.answered`, `setup.done`, `incident`, `webhook.received`
  (payloads in `sdk/README.md`).
* The gate — or delete `gates` from both files if you only want reactions. A gate is
  the one thing here that can stop a human, so add it deliberately.
* `channels` — uncomment for a notification channel (Telegram, email, anything), and
  put the credential in `secrets`, never in the file.

## Rules that bite

* **A gate fails closed.** Throw, time out (5 min) or return `{ok:false}` and the merge
  is refused with your reason. Keep the command fast; `ctx.exec` has its own timeout.
* `ctx.exec(['bun','run','typecheck'], {cwd: ev.repoRoot})` — an argv **array**, not a
  shell string, so quoting bugs cannot become shell injection.
* Hooks run **in the host process with host privileges**. Do not shell out to anything
  you would not run as yourself.
* `ctx.log()` goes to `$ARIGAMI_DIR/logs/ext-<name>.log` — that is where you look when
  a hook seems silent.
* Editing `hooks.ts` reloads within 30 s; no host restart, ever.
