# Extensions

An **extension** adds tools, documentation, listener types, hooks, notification
channels and tabs to a running Arigami host — **at runtime**. No core build, no
`git pull` inside `/opt/arigami`, no restart.

That last point is the whole reason this exists. Editing the core repo is a
dead end: `git pull --ff-only` refuses to run once a tracked file is modified
(`server/host-control.ts`, `DIRTY_ERROR`), so a single local change costs you
every upstream update from then on. An extension lives in a **second repo you
own**, and the only interface between the two is `manifest.json` plus the
`@arigami/sdk` types.

The full contract — every field, every type, the tab protocol — is
[`sdk/README.md`](../sdk/README.md). This document is the operator's view: where
things live, what each contribution kind turns into, what reloads and what does
not, and what you are trusting when you install one.

---

## 1. Layout

```
$ARIGAMI_DIR/user/                    ← YOUR git repo (host runs `git init`; a remote is optional)
  .gitignore                          node_modules/ *.sqlite .env* *.log
  extensions/<name>/
    manifest.json                     the contract
    ui/                               tabs: static HTML/JS, no bundler needed
    listener.ts                       ListenerProvider(s)
    tools/                            server.ts (MCP, any language) or module.ts (plain functions)
    docs/                             USAGE.md → generated into a skill
    hooks.ts                          on / gates / channels
    README.md
  skills/                             $ARIGAMI_DIR/skills is a symlink to here (see §2)
  mcp-catalog.json                    optional: extra remote-MCP rows
  node_modules/@arigami/sdk → <repo>/sdk       (the loader maintains this symlink)

$ARIGAMI_DIR/extensions.json          host-owned state, mode 0600:
                                      { enabled, settings, secrets, sha }
$ARIGAMI_DIR/ext-plugin/              GENERATED Claude Code plugin (the 3rd --plugin-dir)
$ARIGAMI_DIR/logs/ext-<name>.log      one log per extension
```

Two repos, zero shared files. `/opt/arigami` is upstream's and stays
`ff-only`-updatable forever; `$ARIGAMI_DIR/user` is yours, with your own remote
(a private GitHub repo, a Gitea, nothing at all).

**Secrets are never in your repo.** `settings` and `secrets` live in
`$ARIGAMI_DIR/extensions.json` (0600), outside `user/`, so a `git push` of your
extensions cannot leak them. They reach your code as `ctx.secrets` and as
environment variables for `tools[]`.

A full backup (`bin/host export --full`) carries `user/` — minus
`user/node_modules` and `user/extensions/*/node_modules`, which `bun install`
rebuilds — and skips `ext-plugin/`, which is regenerated on every load.

---

## 2. The skills migration (one time, idempotent, non-destructive)

`$ARIGAMI_DIR/skills` — the user skill pack (F2) — becomes a **symlink** into
`user/skills`, so the skills you have edited are versioned along with everything
else you own. Every path that referenced the old location keeps working.

The loader picks one of four branches on every boot and logs what it did:

| on disk | what happens |
|---|---|
| already a symlink to `user/skills` | nothing (the steady state; silent) |
| nothing there | creates `user/skills`, links it |
| a real directory, `user/skills` absent | **renames** it to `user/skills`, links it back |
| both are real directories | copies only the skills `user/skills` is **missing**, renames the old dir to `skills.replaced-<ts>`, links it |

Nothing is ever deleted. In the last case the old directory is still on disk
under its new name — check it, then remove it yourself if you want to.

After a skill is written (the cockpit editor, an applied proposal, a bundle),
the loader commits the user repo: `arigami: skill <name>`, debounced 5s. If git
has no identity configured it commits as `Arigami <arigami@localhost>` via `-c`,
so a fresh box still gets history.

---

## 3. What each contribution turns into

| manifest | becomes | visible to a session |
|---|---|---|
| `tools[]` | an MCP server named `ext-<name>` in every session's `--mcp-config` | `mcp__ext-<name>__*` |
| `docs[]` | `$ARIGAMI_DIR/ext-plugin/skills/<skill>/SKILL.md`, passed as a third `--plugin-dir` | `/arigami-ext:<skill>` |
| — | a line in the first-turn system-reminder | "Extensions installed: hello (skill …, tools …)" |
| `listeners[]` | a provider in the listener-type registry | `register_listener({type})`, `GET /__api/listener-types` |
| `hooks.on` | subscribers on the domain-event bus | — (server-side) |
| `hooks.gates` | `merge.before`, run before every merge | a 409 with the reason on the merge card |
| `hooks.channels` | notification channels next to Web Push and WhatsApp | — |
| `webhooks[]` | a custom webhook `ext-<name>-<id>` routed to a listener's `onWebhook` | a wake, like a poll |
| `tabs[]` | static pages at `/__ext/<name>/…` | `open_tab({type:'ext', ext})` |
| `settings.schema` | a form in Settings → Extensions | `ctx.settings`, `EXT_SETTINGS` |
| `daemons[]` | **parsed, not run** in this version | — |

Two naming details worth knowing:

* An extension with **one** `tools[]` entry gets the server name `ext-<name>`;
  with several, each gets `ext-<name>-<tool>`. The A3 family covers both
  (`mcp__ext-<name>__*` and `mcp__ext-<name>-*`).
* `docs[].description` is the **trigger text**. It is the line Claude reads when
  deciding whether a skill is relevant, so write "Use when the user …".

### Tools without writing MCP

`kind:'module'` points at a TS file that exports `tools = [{name, description,
inputSchema, run}]`. The host wraps it with `mcp/ext-mcp.js` — a real MCP stdio
server — so you never touch the protocol. `kind:'mcp'` is the escape hatch: your
own server, any language, `{command, args, env}` (with `${EXT_DIR}` expanded).

### Listeners for free

A provider answers two questions — "what is the baseline?" (`register`) and
"what changed since the watermark?" (`poll`) — and inherits the whole existing
machine: 5s scheduler, exponential backoff, auth-fail counting, TTL,
queue-until-idle delivery, coalescing, and watermark-after-delivery
(at-least-once). `poll` runs with a **20 second deadline**; a throw or a timeout
is a `transient` outcome, which is exactly what the backoff already handles.

---

## 4. Runtime vs restart

| you changed | takes effect |
|---|---|
| `docs/*.md` body | immediately — Claude reads `SKILL.md` when it uses the skill |
| `listener.ts`, `hooks.ts` | on the next reload (mtime poll ≤30s, or `POST /__api/extensions/reload`) |
| `ui/*` | on the next page load of the tab |
| `manifest.json` settings, `enabled` | on the next reload |
| a NEW tool, or a NEW skill | **the next session** (or `restart_session`) |
| the host itself | never — the loader needs no host restart |

The one genuine limit is the last-but-one row: `--mcp-config` and `--plugin-dir`
are fixed when a session's `claude` process is spawned, and a live child's
environment cannot be changed. That is a Claude Code constraint, not an Arigami
one.

---

## 5. Install, update, remove

```bash
bin/host ext list
bin/host ext validate examples/extensions/hello
bin/host ext add      examples/extensions/hello      # or a git URL
bin/host ext enable  hello        # / disable
bin/host ext update  hello        # git pull --ff-only, only for a git checkout
bin/host ext reload
bin/host ext remove  hello        # removes the dir; settings history is kept
```

With the host **running**, export an admin API token so the change reaches the
live process:

```bash
ARIGAMI_TOKEN=<admin api token> bin/host ext add <src>
```

Without it (or with the host down) the same commands run in-process against
`$ARIGAMI_DIR` — the same pattern as `bin/host profile`.

REST (admin-only, same gate as `/__api/profiles`):

| route | does |
|---|---|
| `GET /__api/extensions` | the registry view (readable by any signed-in principal) |
| `POST /__api/extensions/reload` | rescan and reload everything |
| `POST /__api/extensions/validate {source}` | validate a directory without installing |
| `POST /__api/extensions/add {source}` | copy a directory / shallow-clone a git URL; returns the manifest **and its permissions** |
| `PATCH /__api/extensions/:name` | `{enabled?, settings?, secrets?}` |
| `POST /__api/extensions/:name/update` | `git pull --ff-only` |
| `DELETE /__api/extensions/:name` | remove the directory |
| `GET /__api/listener-types` | core + extension listener types (this is what the MCP `register_listener` enum is built from) |
| `POST /__api/ext/:name/tool/:tool {args}` | one tool call, for the browser SDK's `runTool` |

---

## 6. Security model — read this before installing anything

**Extension code runs in the host process, with the host's privileges.** It can
read your files, spawn processes and reach your network. This is the same trust
you already extend to a skill with Bash, or to an MCP server you added by hand —
but say it out loud: *installing an extension is running someone's code as
yourself.*

What the host does to keep that honest:

* **Nothing is ever downloaded on its own.** You install from a directory or a
  git URL you named. There is no registry, no auto-update, no background fetch.
* **The permissions are shown first.** `ext add` prints `manifest.permissions`;
  the cockpit shows them on a confirmation card.
* **The installed commit is recorded.** `extensions.json` keeps the `sha` of each
  extension that is a git checkout, so a silent change is visible.
* **Per-extension enable/disable.** A disabled extension is parsed and listed and
  contributes nothing — no tools, no listener types, no hooks, no tab.
* **A3 still governs the tools.** Each extension gets a family `ext:<name>`; an
  agent whose allowlist does not name it cannot call its tools, enforced by all
  four existing layers.
* **Failures are contained.** A broken manifest, a listener that throws, a hook
  that throws: the extension is marked `error` (or the call becomes `transient`),
  an incident is filed, and everything else keeps running.
* **Gates fail CLOSED.** That is the exception, and it is deliberate: a
  `merge.before` gate that throws or times out (5 min) blocks the merge, because
  blocking is what a gate is for.
* **Tabs are sandboxed.** `/__ext/…` is served with
  `Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups` and
  **without** `allow-same-origin`. The page has an opaque origin, no cookie and
  no reachable `/__api`; every capability goes through the postMessage bridge,
  which checks the manifest permissions. An extension a session wrote a minute
  ago cannot delete your sessions.

What is **not** in the model: there is no isolation between an extension and the
host. Real isolation needs a separate OS user or a container, which is out of
scope here. Install extensions you would run as yourself.

---

## 7. The example

`examples/extensions/hello` uses every contribution kind and needs no network:

```bash
bin/host ext add examples/extensions/hello
```

Then, from a **new** session:

```
mcp__ext-hello__hello_echo({ text: "world" })
register_listener({ type: "hello-tick", count: 3 })   # wakes you 3× and stops
open_tab({ type: "ext", ext: "hello" })
```

`docs/USAGE.md` inside it explains each piece; the loader turns that file into
the skill `/arigami-ext:hello`.

---

## 8. Domain events

Available to `hooks.on` (payloads are frozen for `apiVersion: 1`):

| event | payload |
|---|---|
| `session.created` | `{ sessionId, title, cwd, agent }` |
| `listener.fired` | `{ listenerId, sessionId, type, summary, terminal }` |
| `review.approved` | `{ sessionId, by, branch }` |
| `merge.done` | `{ sessionId, branch, base, sha, strategy, by }` |
| `merge.conflict` | `{ sessionId, branch, base, files }` |
| `action.answered` | `{ sessionId, actionId, kind, value }` |
| `setup.done` | `{ capability, ok, owner, sessionId }` |
| `incident` | `{ sessionId, action, outcome }` |
| `webhook.received` | `{ kind, customId, event, body }` |

These are in-process only: `emitLocal` never reaches the WebSocket, so a payload
a hook needs (a webhook body, for instance) is not broadcast to browsers.

---

## 9. Notifications

`server/notify.ts` is now the single way out of the host. It fans a payload out
to Web Push **plus** every registered channel:

* `whatsapp` is built in — it sends through the host's one paired WhatsApp
  process, so no second connection is opened. Set the default target with
  `notify.whatsappJid` in `config.json`; a cron trigger's `deliver.whatsapp` may
  also carry an explicit JID (or `true` for the default).
* an extension adds channels from `hooks.ts`:
  `export const channels = { telegram: async (payload, ctx) => … }`.

A channel that is not configured is skipped in silence, and one that throws never
stops the others: a notification is not allowed to become an error.

---

## 10. Your own remote MCP servers

`$ARIGAMI_DIR/user/mcp-catalog.json` is merged into the core catalog, so you can
add a vendor's MCP server (capability id, setup card, `domains` allowlist)
without a PR:

```json
[{ "slug": "acme", "title": "Acme", "url": "https://mcp.acme.com/mcp",
   "auth": "oauth", "domains": ["acme.com", "mcp.acme.com"] }]
```

A user row can **add** a service; it can never shadow a core one, so a
hand-edited file cannot repoint `linear` somewhere else. Invalid rows are
dropped, and the merged list refreshes on every extensions reload.

---

## 11. Writing one

Read [`sdk/README.md`](../sdk/README.md), copy `examples/extensions/hello`, and:

```bash
bin/host ext validate <your dir>     # says exactly what is wrong
bin/host ext add <your dir>
bin/host ext reload                  # after every edit (or wait ≤30s)
```

Import types with no install — the loader keeps
`$ARIGAMI_DIR/user/node_modules/@arigami/sdk` pointed at the repo's `sdk/`:

```ts
import type { ListenerProvider, Hooks, ToolDef } from '@arigami/sdk';
```
