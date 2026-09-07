# template: listener

A background watcher: it polls a source (or receives a webhook), and when something
new shows up it **wakes a session** with a one-line summary.

**Delete this file** after you copy the template.

## Placeholders

| placeholder | where | value |
|---|---|---|
| `{{name}}` | `manifest.json`, the webhook comment | the extension name = the directory name |
| `{{title}}` | `manifest.json`, `label()`, the summaries | short human title |
| `{{description}}` | `manifest.json` | one line: what it watches |
| `{{type}}` | `manifest.json` (twice), `provider.type` | the **globally unique** listener type — this is what `register_listener({type})` takes. Prefix it with the extension name when in doubt (`{{name}}-events`). Built-in types are rejected by validation. |

## What to edit after that

* `Item` and `fetchItems()` — the real source and its shape. Keep using `ctx.fetch` and
  `ctx.signal`; the 20 s deadline then cancels the request for you.
* `schema` in **both** the manifest and the provider — the host validates
  `register_listener` args against it (required keys + primitive types).
* The watermark type `WM` — whatever means "already seen" for your source (an id, a
  timestamp, an etag).
* `defaultIntervalSec` — be honest: 300 s is polite, 30 s is a lot of requests a day.
* Drop `webhooks[]` + `onWebhook` if the source cannot push.

## Rules that bite

* `register()` sets the **baseline** — a listener that fires on everything that already
  existed is the classic bug.
* Return `{kind:'transient'|'auth'|'gone'}` on failure instead of throwing a fake `ok`:
  `transient` gets backoff, `auth` gets counted and surfaced to the human, `gone` stops.
* `summary` is what the session is woken *with*. A pointer ("3 new issues — X, Y"), not
  the payload.
* Editing `listener.ts` reloads within 30 s; existing listeners keep their watermarks.

Try it with `register_listener({ type: '<type>', url: '…' })`, and (if you kept the
webhook) POST to `/__api/webhooks/custom/ext-<name>-inbound`.
