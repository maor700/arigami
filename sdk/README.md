# @arigami/sdk — the extension contract (API v1)

An **Arigami extension** is a directory. It adds tools, docs, listeners, hooks,
notification channels and tabs to a running host **at runtime** — no core build,
no `git pull` in `/opt/arigami`, no restart of the host.

```
$ARIGAMI_DIR/user/extensions/<name>/
├── manifest.json      the contract (below)
├── ui/                tabs: index.html + assets (static, base './')
├── listener.ts        ListenerProvider(s) — a Bun module
├── tools/             server.ts (an MCP stdio server) or module.ts (plain functions)
├── docs/              USAGE.md → generated into a skill Claude can read
├── hooks.ts           on: {...}, gates: {...}, channels: {...}
└── README.md
```

`$ARIGAMI_DIR/user/` is **your** git repo (the host runs `git init` if it is
missing; a remote is optional). The core repo (`/opt/arigami`) and your repo
share no files — the only interface between them is `manifest.json` and this
package.

Import types with no install: the loader keeps
`$ARIGAMI_DIR/user/node_modules/@arigami/sdk` symlinked to `<repo>/sdk`.

```ts
import type { ListenerProvider, Hooks, ToolDef } from '@arigami/sdk';
```

---

## manifest.json

```json
{
  "name": "feature-picker",
  "version": "0.2.0",
  "apiVersion": 1,
  "title": "Feature picker",
  "description": "A form that returns a prompt to the chat",

  "tabs": [
    { "id": "picker", "title": "Pick features", "entry": "ui/index.html",
      "icon": "list-check", "openFrom": ["tab-bar", "slash:/pick"] },
    { "id": "from-pr", "title": "From PR", "entry": "ui/pr.html",
      "openFrom": ["launcher"] }
  ],

  "listeners": [
    { "type": "rss", "module": "listener.ts", "export": "rssProvider",
      "schema": { "type": "object", "required": ["url"],
                  "properties": { "url": { "type": "string" } } },
      "defaultIntervalSec": 300 }
  ],

  "tools": [
    { "kind": "mcp", "name": "featdb", "command": "bun", "args": ["tools/server.ts"],
      "env": { "FEATDB_PATH": "${EXT_DIR}/data.sqlite" } },
    { "kind": "module", "name": "echo", "module": "tools/module.ts" }
  ],

  "docs": [
    { "file": "docs/USAGE.md", "skill": "feature-picker",
      "description": "Use when the user wants to plan or pick features, or says /pick" }
  ],

  "hooks": { "module": "hooks.ts", "events": ["merge.done"], "gates": ["merge.before"] },
  "webhooks": [ { "id": "inbound", "listener": "rss" } ],
  "permissions": [ "session:message", "session:tabs", "tools:featdb", "notify", "events:merge.*" ],
  "settings": { "schema": { "teamName": { "type": "string", "default": "" } } }
}
```

| field | meaning |
|---|---|
| `name` | `^[a-z0-9][a-z0-9-]*$`, must equal the directory name |
| `apiVersion` | **1**. A different major is refused (the extension is listed with `state:'error'`, nothing else breaks). |
| `tabs[]` | static pages under `ui/`, served at `/__ext/<name>/<entry>` (sandboxed, see below) |
| `listeners[]` | `module` + `export` naming a `ListenerProvider`; `type` must be globally unique |
| `tools[]` | `kind:'mcp'` (any language, stdio) or `kind:'module'` (TS functions the host wraps). Injected into every session as the MCP server `ext-<name>`, so tools appear as `mcp__ext-<name>__*`. |
| `docs[]` | each entry becomes `$ARIGAMI_DIR/ext-plugin/skills/<skill>/SKILL.md`, listed to Claude as `/arigami-ext:<skill>`. **`description` is the trigger text** — write "use when …". |
| `hooks` | one module with `on` (domain events), `gates` (`merge.before`) and `channels` (notification fan-out) |
| `webhooks[]` | a custom webhook `ext-<name>-<id>` routed to a listener's `onWebhook` |
| `permissions[]` | what a **tab** may ask the shell for: `session:message`, `session:prompts`, `session:tabs`, `session:artifacts`, `tools:<name>`, `notify`, `events:<glob>` |
| `settings.schema` | rendered as a form in Settings → Extensions; values land in `$ARIGAMI_DIR/extensions.json` (never in your repo) |
| `trusted` | ask for the **trusted tier** — a tab served without the sandbox (see *Tabs*). The host only honours it once a human has granted it |
| `daemons[]` | parsed, **not run** in this version |

Secrets are never in the manifest and never in your repo: they live in
`$ARIGAMI_DIR/extensions.json` (`secrets[<name>]`, mode 0600) and reach your
code as `ctx.secrets` and as env for `tools[]`.

---

## Listeners

A provider plugs into the existing scheduler and gets watermarks, backoff,
auth-fail handling, TTL, queue-until-idle delivery and coalescing for free.

```ts
import type { ListenerProvider } from '@arigami/sdk';

export const rssProvider: ListenerProvider<{ url: string }, { lastTs: number }> = {
  type: 'rss',
  label: (a) => `RSS ${new URL(a.url).hostname}`,
  schema: { type: 'object', required: ['url'], properties: { url: { type: 'string' } } },
  defaultIntervalSec: 300,

  async register(ctx, args) {                       // baseline: never fire on the past
    const items = await fetchItems(ctx, args.url);
    return { params: args, watermark: { lastTs: items[0]?.ts ?? 0 } };
  },

  async poll(ctx, l) {
    let items;
    try { items = await fetchItems(ctx, l.params.url); }
    catch (e: any) { return { kind: e.status === 404 ? 'gone' : 'transient', error: String(e.message) }; }
    const fresh = items.filter((i) => i.ts > l.watermark.lastTs);
    if (!fresh.length) return { kind: 'ok', shouldFire: false, nextWatermark: l.watermark };
    return { kind: 'ok', shouldFire: true, nextWatermark: { lastTs: fresh[0].ts },
             summary: `RSS: ${fresh.length} new items` };
  },
};
```

Rules the host enforces:

* `poll` runs with a **20 s deadline** (`ctx.signal`); a throw or a timeout is a
  `transient` outcome and goes through the normal exponential backoff.
* the watermark advances **after delivery**, never before — wakes are
  at-least-once on purpose.
* `summary` is the text the session is woken with. Keep it a thin pointer.
* `register` is called once, from `register_listener` / `POST
  /__api/sessions/:id/listeners`; `args` were validated against `schema`
  (required keys + primitive types).

---

## Hooks, gates and channels

```ts
import type { Hooks, NotifyChannel } from '@arigami/sdk';

export const hooks: Hooks = {
  on: {
    'merge.done': async (ev, ctx) => { await ctx.notify({ title: `merged ${ev.branch}`, body: ev.sha.slice(0, 7) }); },
    'listener.fired': async (ev, ctx) => { if (ev.type === 'rss') await ctx.sendPrompt(ev.sessionId, 'summarise'); },
  },
  gates: {
    'merge.before': async (ev, ctx) => {
      const r = await ctx.exec(['bun', 'run', 'typecheck'], { cwd: ev.repoRoot, timeoutMs: 120_000 });
      return r.code === 0 ? { ok: true } : { ok: false, reason: `typecheck failed:\n${r.stderr.slice(-800)}` };
    },
  },
};

export const channels: Record<string, NotifyChannel> = {
  telegram: async (payload, ctx) => { /* ctx.fetch(...) */ },
};
```

Domain events (payloads are frozen for v1):

| event | payload |
|---|---|
| `session.created` | `{ sessionId, title, cwd, agent }` |
| `listener.fired` | `{ listenerId, sessionId, type, summary }` |
| `review.approved` | `{ sessionId, by, branch }` |
| `merge.done` | `{ sessionId, branch, base, sha, strategy }` |
| `merge.conflict` | `{ sessionId, branch, base, files }` |
| `action.answered` | `{ sessionId, actionId, value }` |
| `setup.done` | `{ capability, ok, owner }` |
| `incident` | `{ sessionId, action, outcome }` |
| `webhook.received` | `{ kind, customId, body }` |

A hook that throws is written to the extension's log and to the incident file —
it never stops the host. A **gate** that throws or times out (5 min) **fails
closed**: the merge is refused with the gate's message. That is the point of a
gate.

---

## Tools

`kind:'module'` is the cheap path — write functions, the host wraps them in an
MCP server (`mcp/ext-mcp.js`) for you:

```ts
import type { ToolDef } from '@arigami/sdk';

export const tools: ToolDef[] = [
  {
    name: 'hello_echo',
    description: 'Echo a message back, uppercased.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    async run(args, ctx) { return { echo: String(args.text).toUpperCase(), extDir: ctx.extDir }; },
  },
];
```

`kind:'mcp'` is a real MCP stdio server in any language — the host only supplies
`{command, args, env}` and the env vars `EXT_DIR`, `EXT_NAME`, `EXT_SETTINGS`,
`ARIGAMI_URL`, `ARIGAMI_TOKEN`, plus your secrets. `${EXT_DIR}` is expanded in
manifest `env` values.

Tools reach a session only at **spawn** (`--mcp-config`), so a brand-new tool
shows up in the **next** session (or after `restart_session`). Editing a doc is
visible immediately.

---

## Tabs

`ui/` is served at `/__ext/<name>/…` with
`Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups` and
**without** `allow-same-origin` — the page has an opaque origin, no cookie and
no direct `/__api`. Everything goes through the shell:

```html
<script src="/__ext-sdk.js"></script>
<script>
  const ctx = await arigami.ready();                     // {sessionId, cwd, settings, …}
  const r = await arigami.sendPrompt('plan the sprint');           // mode 'auto'
  await arigami.setStatus({ badge: r.delivered === 'now' ? '✓' : '⏳' });
  arigami.subscribe(['chat'], (ev) => { if (ev.kind === 'result') arigami.setStatus({ badge: 'done' }); });
</script>
```

**Your own assets just work — don't hand-write the host path.** Because the
page has an opaque origin, the browser treats every sub-request it makes as
cross-site and sends no session cookie. The host therefore injects a
`<base href="/__ext/<name>/~t/<token>/">` into the entry HTML, where `<token>`
is a short-lived capability for that one extension: write `href="style.css"`,
`src="./app.js"`, `src="img/logo.png"` and they resolve through it. `/__ext-sdk.js`
is a public path and needs no token. Root-absolute references to your own mount
(`src="/__ext/<name>/x.png"`) are rewritten for you; anything else absolute
(`/__api/…`) is not reachable from a tab at all — that is what the bridge is for.

### Launcher tabs — a creation flow that is not the core's

`"openFrom": ["launcher"]` puts the tab in the **new-session launcher**, as a
mode beside "From ticket", "Empty session" and "From trigger".

This exists so that a creation flow belonging to a *role* does not have to
become a mode in everybody's launcher. "Review a pull request" is a developer
profile's; "open the on-call page" is an SRE's. Neither belongs in the core
product, and both are the same shape — pick something from a system the host
knows nothing about, then start a session about it.

A launcher tab runs **before there is a session**, and that changes the
contract:

| | in a session tab | in a launcher tab |
|---|---|---|
| `ready().sessionId` | the session id | `null` |
| `runTool` | works | works — it was never session-scoped |
| `createSession` | refused | the point of the surface |
| `sendPrompt`, `setStatus`, `openArtifact` | work | refused, with a message saying why |
| `subscribe` | session events reach you | only events that carry no session |
| `close()` | deletes the tab | no-op; the human picks another mode |

```html
<script src="/__ext-sdk.js"></script>
<script>
  const ctx = await arigami.ready();
  if (ctx.sessionId === null) {
    // launcher: list, let the human pick, then start.
    // runTool returns the MCP result VERBATIM — content blocks, not your
    // object. Unwrap it, or you get `undefined` and no error to explain it.
    const blocks = await arigami.runTool('list_pulls', { repo: 'acme/app' });
    const { pulls } = JSON.parse(blocks.map((b) => b.text || '').join(''));
    const { id } = await arigami.createSession({
      title: 'Review acme/app#412',
      prompt: 'Review this pull request…',
      agent: 'code-review',
      metadata: { pr: url, prNumber: 412, repo: 'acme/app' },
    });
  }
</script>
```

`createSession` needs the **`host:create-session`** permission. It is the
strongest grant in the system and is in the `host:` namespace for that reason:
every other permission scopes a tab to the one session it already lives in,
this one spawns a new agent process with whatever `permissionMode` it asks for.
An extension whose manifest claims the launcher surface without requesting it
gets a warning from `bin/host ext validate`, and the cockpit does not offer its
mode at all — a mode that can list and pick but not start is worse than an
absent one, because the human only finds out at the last click.

`createSession` accepts `title`, `cwd`, `prompt`, `skill`, `agent`, `engine`,
`model`, `effort`, `permissionMode` and `metadata`. It is an allowlist, not a
pass-through: the orchestration fields `POST /__api/sessions` also understands
(`master`, `kind`, `subtask`, `worktree`…) are dropped, so a tab cannot graft
its session into somebody else's dispatch tree.

`agent` is usually what you want. A session born from an agent inherits its
persona, skills, engine, model, memory namespace and rail colour — which is how
a role-specific launcher mode stays thin: the extension finds the work, the
agent knows how to do it.

### Match the cockpit's theme

`ready()` gives you `theme: 'light' | 'dark'`. **Use it, and do not use
`prefers-color-scheme`.** A tab is a separate document, so `color-scheme: light
dark` with `Canvas`/`CanvasText` resolves from the *operating system's*
preference — which is routinely the opposite of the theme the human chose in
Arigami, and you get a white panel inside a dark cockpit.

The shell re-sends `arigami:init` whenever the theme changes, so apply it on
every init rather than once at boot, and a live switch lands:

```html
<style>
  :root { color-scheme: light; --bg: #ffffff; --fg: #1a1a1a; }
  html[data-theme="dark"] { color-scheme: dark; --bg: #0b0d10; --fg: #e8eaee; }
  body { background: var(--bg); color: var(--fg); }
</style>
<script>
  const apply = (c) => { document.documentElement.dataset.theme = c.theme || 'dark'; };
  window.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'arigami:init') apply(e.data.context);
  });
  apply(await arigami.ready());
</script>
```

`ctx.lang` is there for the same reason — set `document.documentElement.lang`
from it so the page reads right-to-left when the cockpit does.
`examples/extensions/pr-review` does both.

### Sandboxed vs trusted

The above is the **sandboxed** tier: the default, and what you want for a form, a
dashboard, a picker — anything that talks to the session through
`window.arigami`.

A manifest may instead ask for `"trusted": true`. A trusted tab is served with
**no CSP sandbox** and the cockpit gives its iframe **no `sandbox` attribute**,
so the page is same-origin with the cockpit — like `/__ticket` or a proxied url
tab. Plainly: **it runs with the human's full cockpit session.** It keeps the
session cookie, it can use the host proxy and its service worker, and it can call
`/__api` directly as the signed-in human — the manifest permissions still govern
the bridge, but a same-origin page does not have to use the bridge. The SDK is
unchanged either way: same `window.arigami`, same protocol v1.

Ask for the tier only when the tab must be same-origin. The case it was built for
is a tab that embeds **host-proxied** URLs (`/?__target=…`): the proxy is a
service worker plus the auth cookie, and an opaque origin can have neither.

Asking is not getting. The host serves a tab unsandboxed only when the manifest
asks **and** a human granted it (`bin/host ext add --trust`, `bin/host ext trust
<name>`, or the checkbox in the cockpit's install dialog); the grant lives in
`$ARIGAMI_DIR/extensions.json`, not in your repo. So adding the flag in a later
commit escalates nothing — the tab stays sandboxed, with a warning, until the
human decides. `GET /__api/extensions` reports `tier`, `trusted` and
`trustRequested`. One consequence for you as an author: a trusted tab needs no
asset token, so its `<base>` is the plain `/__ext/<name>/…` path.

`window.arigami`: `ready()`, `sendPrompt(text, {mode})`, `runTool(name, args)`,
`setStatus({badge,color,title})`, `openArtifact(path)`, `subscribe(events, cb)`,
`close()`. Each maps to one `arigami:call` message; the shell checks the
manifest permission and refuses anything else. The wire protocol is documented
at the top of `browser/ext-sdk.js` and is frozen for v1.

`sendPrompt` has three delivery modes, and the default is the same rule the
host uses everywhere else (`deliverToSession`, also what a hook's
`ctx.sendPrompt` does):

| `mode` | behaviour | returns |
|---|---|---|
| `'auto'` *(default)* | session idle → sent now; session busy → queued **and** auto-play turned on, so it plays the moment the turn ends | `{delivered:'now'}` / `{delivered:'queued'}` |
| `'now'` | written to the session immediately, even mid-turn | `{delivered:'now'}` |
| `'queue'` | queued only — it waits for the human's ▶ unless auto-play is already on | `{delivered:'queued'}` |

The protocol stays v1: an omitted mode used to mean `'queue'`, and now means
`'auto'`; a page that passes `'queue'` explicitly behaves exactly as before. An
extension holding only `session:prompts` never takes the "now" path — `'auto'`
queues for it (with auto-play) instead.

---

## Install, reload, versions

```
bin/host ext list
bin/host ext validate <dir>
bin/host ext add <dir|git-url>     # copies / shallow-clones into user/extensions/<name>
bin/host ext add <dir> --trust     # …and grant the trusted tier (see Tabs)
bin/host ext trust|untrust <name>  # grant / revoke it later
bin/host ext update [name]         # git pull --ff-only
bin/host ext remove <name>
bin/host ext reload
```

REST (admin): `GET /__api/extensions`, `POST /__api/extensions/reload`,
`POST /__api/extensions/validate {source}`, `POST /__api/extensions/add {source, trust?}`,
`PATCH /__api/extensions/:name {enabled?, settings?, trusted?}`,
`DELETE /__api/extensions/:name`, `POST /__api/extensions/:name/update`,
`GET /__api/listener-types`, `POST /__api/ext/:name/tool/:tool {args}`.

The host also polls mtimes every 30 s and reloads what changed. What is live
immediately: docs, listener providers, hooks, gates, channels, tabs. What needs
a new session: the tool list and the skill list (they are fixed at spawn — a
Claude Code limit, not ours).

**Trust model, stated plainly:** extension code runs **in the host process with
the host's privileges**, exactly like a skill with Bash or an MCP server you
added by hand. Its TAB is the one part that is contained — by the sandbox, unless
you granted the trusted tier. There is no auto-download and no auto-update: you install from a
directory or a git URL you named, the permissions are printed before the install,
and the installed sha is recorded in `extensions.json`. Only install extensions
you would run as yourself.
