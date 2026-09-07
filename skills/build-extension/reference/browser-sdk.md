# The tab contract — `window.arigami`

Read this before writing an extension tab. It is the browser half of
`sdk/README.md` (Arigami repo), condensed to what a generated page must get right.
The implementation is `sdk/browser/ext-sdk.js`; the protocol is **frozen for
apiVersion 1**.

## The one rule

A tab is served from `/__ext/<name>/…` with

```
Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups
```

and **without** `allow-same-origin`. The page therefore has an **opaque origin**: no
cookie, no `localStorage`, and **no way to call `/__api`** — a `fetch('/__api/…')`
from a tab is not "discouraged", it fails (401 / opaque-origin error). Everything the
page needs goes through the cockpit shell over `postMessage`, and the shell checks the
extension's `manifest.permissions` before it does anything.

So: **never generate `fetch('/__api/...')`, an `ARIGAMI_TOKEN`, or a `localhost:` URL
inside `ui/`.** Load the SDK and call it:

```html
<script src="/__ext-sdk.js"></script>
```

## The surface

| call | returns | manifest permission |
|---|---|---|
| `arigami.ready()` | `{sessionId, tabId, extension, apiVersion, agent, cwd, settings, lang, permissions}` | — |
| `arigami.sendPrompt(text, {mode})` | `{delivered:'now'\|'queued'}` | `session:message` (`mode:'queue'` also `session:prompts`) |
| `arigami.runTool(name, args)` | the tool's result | `tools:<name>` |
| `arigami.setStatus({badge,color,title})` | `{ok:true}` | `session:tabs` |
| `arigami.openArtifact(path, {title})` | `{ok:true}` | `session:tabs` |
| `arigami.subscribe(events, cb)` | an unsubscribe function | `events:<glob>` per name |
| `arigami.close()` | — | — |

`ready()` resolves when the shell sends `arigami:init`; **await it before enabling any
control**, and catch its rejection — the page may have been opened outside the cockpit,
in which case every call rejects with "this page is not running inside an Arigami tab".

`sendPrompt` follows the host's normal delivery semantics: an idle session gets the
text now, a busy one gets it queued with auto-play (`delivered:'queued'`). That is why
`{mode:'queue'}` is the polite default for a form.

Event names for `subscribe` are the cockpit's own (`chat`, `session-updated`,
`listener-updated`, `ext:<name>`); the shell filters them to this session and to what
the manifest allows, so a glob like `events:chat` in `permissions` is what makes the
subscription work at all.

## The shape of a good tab

A form-style tab is worth building when the human's answer is structured (checkboxes,
a select, a date) and the *result* is a prompt. The pattern, end to end:

1. `await arigami.ready()` → read `ctx.settings` (your `settings.schema` values) and
   `ctx.lang`; enable the buttons.
2. Collect the input with plain HTML — no framework, no bundler, no network.
3. Build **one** sentence of prompt text from the fields and `sendPrompt(text,
   {mode:'queue'})`.
4. `setStatus({badge:'⏳'})` on send, and flip it from `subscribe(['chat'], …)` when a
   result arrives.

Keep the page RTL-aware (`<html lang="he" dir="rtl">` when the human works in Hebrew)
and use `color-scheme: light dark` with `Canvas`/`CanvasText` so it matches the
cockpit's theme in both modes — the template does both.

## Errors

Every call rejects with a real `Error`. The shell answers `ok:false` for an unknown
method, a missing permission, or a message from the wrong window — so a rejection
usually means **a permission is missing from `manifest.json`**, not that the code is
wrong. Show it in the page (the template has a `<pre>` for that) instead of failing
silently.
