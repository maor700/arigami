# template: tool

A tool Claude can call, written as plain functions. The host turns it into an MCP
server for you (`kind:'module'`), and the `docs/USAGE.md` next to it becomes the skill
`/arigami-ext:<skill>` that tells Claude when to reach for it.

**Delete this file** after you copy the template.

## Placeholders

| placeholder | where | value |
|---|---|---|
| `{{name}}` | `manifest.json`, `tools/module.ts` comments, `docs/USAGE.md` | the extension name = the directory name |
| `{{title}}` | `manifest.json`, `docs/USAGE.md` | short human title |
| `{{description}}` | `manifest.json`, the tool's `description`, `docs/USAGE.md` | what it does / returns — Claude reads this one |
| `{{tool}}` | `manifest.json` permission, `tools/module.ts`, `docs/USAGE.md` | the tool's own name, `[a-z0-9_]+` (e.g. `notion_search`) — a session sees it as `mcp__ext-{{name}}__{{tool}}` |
| `{{trigger}}` | `manifest.json` `docs[].description`, `docs/USAGE.md` | **the trigger text**: "Use when the user asks …". This is the line Claude reads to decide the skill is relevant — write it as a sentence, not a label. It is substituted into `manifest.json`, so escape any `"` in it (or use none). |

## What to edit after that

* `inputSchema` and `run()` — the real arguments and the real call. Return small,
  already-trimmed data: the result lands in the model's context.
* `settings.schema` / `ctx.secrets` — configuration and credentials. Never a constant
  in the file.
* Add more entries to the `tools` array for more tools (one manifest entry stays; the
  module may export several `ToolDef`s). Add each one to `permissions` as
  `tools:<tool>` if a **tab** should be allowed to call it.

## Rules that bite

* **A new tool needs a new session.** `--mcp-config` is fixed at spawn — that is a
  Claude Code limit. Demonstrate it in the current session with
  `POST /__api/ext/{{name}}/tool/{{tool}} {"args":{…}}` instead.
* A `docs[]` entry with an empty `description` fails validation on purpose.
* Editing the doc body is live; adding a *new* doc is a new skill → new session.
* `kind:'mcp'` is the escape hatch when you want your own server in another language:
  `{ "kind":"mcp", "name":"…", "command":"…", "args":[…], "env":{"X":"${EXT_DIR}/…"} }`.
