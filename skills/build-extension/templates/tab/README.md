# template: tab

A cockpit tab — a static page under `ui/`, served at `/__ext/<name>/` in a sandbox,
that turns a structured choice into one prompt in the session's chat.

**Delete this file** after you copy the template; it documents the placeholders, it is
not part of the extension.

## Placeholders

| placeholder | where | value |
|---|---|---|
| `{{name}}` | `manifest.json`, the comment in `index.html` | the extension name = the directory name, `^[a-z0-9][a-z0-9-]*$` |
| `{{title}}` | `manifest.json` (twice), `index.html` (title, heading, prompt prefix) | short human title, the human's language |
| `{{description}}` | `manifest.json` | one line: what the tab is for |

## What to edit after that

* The three checkboxes in `ui/index.html` — the `value` is what reaches the prompt.
* `buildPrompt()` — the one sentence the session receives. Keep it one sentence.
* `settings.schema` in the manifest — drop it, or add real settings; the values arrive
  as `ctx.settings` in `arigami.ready()` and as a form in Settings → Extensions.
* `permissions` — remove what you do not use. `session:message` sends now,
  `session:prompts` allows `mode:'queue'`, `session:tabs` allows `setStatus` /
  `openArtifact`, `events:chat` allows the `subscribe` above.

## Rules that bite

* The page has an **opaque origin**: no cookie, no `/__api`, no token. Only
  `window.arigami` (`/__ext-sdk.js`). See the skill's `reference/browser-sdk.md`.
* `entry` must live under `ui/`, and `tabs[].id` is what `open_tab({type:'ext', ext,
  tab})` names.
* Editing `ui/*` is live on the next page load; editing `manifest.json` waits for the
  reload (≤30 s).

Open it with `open_tab({ type: 'ext', ext: '<name>', tab: 'main' })`.
