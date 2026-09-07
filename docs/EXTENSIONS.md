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

## 1. Build one from the chat

You do not have to write any of this by hand. **Ask the session for it** — "תבנה לי
טאב עם טופס שמחזיר פרומפט", "תעקוב אחרי ה-RSS של X ותעיר אותי", "תן לי כלי שקורא
מה-Notion DB", "תריץ typecheck לפני כל merge" — and the built-in skill
[`skills/build-extension`](../skills/build-extension/SKILL.md) (`/extend`) takes it
from there:

1. one clarifying question at most, then it picks a name and a contribution kind;
2. scaffolds from a template into `$ARIGAMI_DIR/user/extensions/<name>/` — **your**
   repo, never the core one;
3. `bin/host ext validate <dir>` until it is clean;
4. the host's mtime poll (≤30 s) loads it — no restart of anything;
5. it **shows you the thing in the same chat**: `open_tab` for a tab, a real
   `register_listener` for a listener, a live `POST /__api/ext/<name>/tool/<tool>`
   for a tool;
6. you say what to change, it edits and re-opens;
7. it commits your repo and tells you where the code lives.

That last loop is the point of the whole system: the product writes its own
extension, in the context of the task you are already in, and you look at it while it
is being written.

**What you will see immediately, and what waits for a new session:** a tab, a
listener, a hook or an edited doc is live as soon as it loads; a **new tool** or a
**new skill** appears only in the next session (or after `restart_session`), because
`--mcp-config` and `--plugin-dir` are fixed when a session's `claude` process spawns.
The full matrix is §5.

**Your code, your repo.** `$ARIGAMI_DIR/user/` is a git repo the host creates with
`git init` on first boot and commits to as things change; you never have to do
anything for that to work. A **remote is optional** — add one when you want the code
off the machine:

```bash
git -C ~/.arigami/user remote add origin git@github.com:<you>/arigami-user.git && \
  git -C ~/.arigami/user push -u origin HEAD
# or, with gh authenticated:
gh repo create arigami-user --private --source ~/.arigami/user --push
```

Secrets never go with it: settings and secrets live in `$ARIGAMI_DIR/extensions.json`
(0600), outside the repo.

**What you are agreeing to, in one paragraph.** An extension is code, and it runs
inside the host with the host's privileges — the same trust you already give a skill
that can run Bash. Nothing is ever downloaded on its own, the permissions an extension
asks for are printed before it is installed, and each one can be disabled on its own.
An extension a session wrote a minute ago cannot reach your `/__api` from its tab (the
page is sandboxed — unless you grant it the trusted tier yourself, §7.1), but its
**server** code can do whatever you can do. Install and
generate extensions you would run as yourself; the long version is §7.

---

## 2. Layout

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
  skills/                             $ARIGAMI_DIR/skills is a symlink to here (see §3)
  mcp-catalog.json                    optional: extra remote-MCP rows
  node_modules/@arigami/sdk → <repo>/sdk       (the loader maintains this symlink)

$ARIGAMI_DIR/extensions.json          host-owned state, mode 0600:
                                      { enabled, settings, secrets, sha, trusted }
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

## 3. The skills migration (one time, idempotent, non-destructive)

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

## 4. What each contribution turns into

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
| `tabs[]` | static pages at `/__ext/<name>/…` (sandboxed, or trusted — §7.1) | `open_tab({type:'ext', ext})` |
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

### A tab, and how it talks back

`tabs[]` is a static page under `ui/`, served from an opaque origin (sandbox
without `allow-same-origin`): no cookie, no `/__api`. Everything it can do goes
through `window.arigami` (`<script src="/__ext-sdk.js">`) and is checked against
the manifest permissions by the cockpit shell.

The one call worth spelling out is `sendPrompt(text, {mode})` — how a form's
answer reaches the session:

| `mode` | behaviour | permission |
|---|---|---|
| `'auto'` *(default)* | the host's `deliverToSession` rule: session **idle** → sent now; session **busy** → queued **and** auto-play turned on, so it plays the moment the current turn ends | `session:prompts` or `session:message` |
| `'now'` | written to the session immediately, even mid-turn | `session:message` |
| `'queue'` | queued only — it sits there until the human presses ▶ (or auto-play is already on) | `session:prompts` |

`'auto'` is the default because a form that says nothing wants its prompt to be
acted on, not to wait behind a switch the tab cannot see. Protocol v1 is
unchanged: omitting the mode used to mean `'queue'` and now means `'auto'`; a
page that passes `'queue'` explicitly behaves exactly as it did. An extension
that holds only `session:prompts` never takes the "now" path — `'auto'` queues
for it (with auto-play) instead.

---

## 5. Runtime vs restart

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

## 6. Install, update, remove

```bash
bin/host ext list
bin/host ext validate examples/extensions/hello
bin/host ext add      examples/extensions/hello      # or a git URL; --trust for §7.1
bin/host ext enable  hello        # / disable
bin/host ext trust   hello        # / untrust — the trusted tier (§7.1)
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

That fallback is what a **session** uses: the token a session holds
(`$ARIGAMI_TOKEN`) is a *session* principal, not an admin, so `POST
/__api/extensions/*` answers `403 admin only` to it. A session validates with
`ARIGAMI_TOKEN= bin/host ext validate <dir>` — blanking the token is what makes the
CLI run the check in-process instead of over REST — writes into
`user/extensions/<name>/` directly, and lets the mtime poll load it; `GET /__api/extensions` — readable by any signed-in
principal — is how it checks that the live host picked it up.

REST (admin-only, same gate as `/__api/profiles`):

| route | does |
|---|---|
| `GET /__api/extensions` | the registry view (readable by any signed-in principal) |
| `POST /__api/extensions/reload` | rescan and reload everything |
| `POST /__api/extensions/validate {source}` | validate a directory without installing |
| `POST /__api/extensions/add {source, trust?}` | copy a directory / shallow-clone a git URL; returns the manifest **and its permissions**. `trust:true` also grants the trusted tier (§7.1) — the caller must have named that consequence |
| `PATCH /__api/extensions/:name` | `{enabled?, settings?, secrets?, trusted?}` (`trusted` = the tier, §7.1) |
| `POST /__api/extensions/:name/update` | `git pull --ff-only` |
| `DELETE /__api/extensions/:name` | remove the directory |
| `GET /__api/listener-types` | core + extension listener types (this is what the MCP `register_listener` enum is built from) |
| `POST /__api/ext/:name/tool/:tool {args}` | one tool call, for the browser SDK's `runTool` |

---

## 7. Security model — read this before installing anything

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
* **Tabs are sandboxed** — unless you granted the extension the trusted tier
  (§7.1). `/__ext/…` is served with
  `Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups` and
  **without** `allow-same-origin`. The page has an opaque origin, no cookie and
  no reachable `/__api`; every capability goes through the postMessage bridge,
  which checks the manifest permissions. An extension a session wrote a minute
  ago cannot delete your sessions.
  Because that origin is opaque, the tab's own sub-requests carry no cookie
  either: the entry HTML (served only to an authenticated request) gets a
  `<base href="/__ext/<name>/~t/<token>/">`, where `<token>` is a 24h
  HMAC capability scoped to **that** extension — the same mechanism published
  artifacts use (F5). It opens no other extension, no `/__api`, and stops
  working the moment the extension is disabled. `/__ext-sdk.js` is public: it
  is a static script with no secrets, and it is the one file a sandboxed page
  must be able to load before the bridge exists at all.

What is **not** in the model: there is no isolation between an extension and the
host. Real isolation needs a separate OS user or a container, which is out of
scope here. Install extensions you would run as yourself.

### 7.1 Sandboxed vs trusted

A tab is served at one of two tiers. **Sandboxed is the default and covers
almost everything** — a form, a dashboard, a picker, anything that talks to the
session through `window.arigami`.

| | **sandboxed** (default) | **trusted** (`"trusted": true` + a grant) |
|---|---|---|
| CSP on `/__ext/<name>/…` | `sandbox allow-scripts allow-forms allow-popups`, no `allow-same-origin` | none |
| the cockpit's `<iframe sandbox>` | same list | absent |
| origin | opaque | the cockpit's own |
| session cookie | no | yes |
| `/__api` | unreachable; only the bridge | reachable **directly, as the signed-in human** |
| host proxy / service worker | unusable (an opaque origin cannot have one) | usable |
| own assets | through the `~t/<token>` capability in `<base>` | ordinary same-origin requests |
| `window.arigami` | works | works, unchanged |

The tier exists for one real case: **a tab that must embed host-PROXIED URLs**
(`/?__target=…`). The proxy is a service worker plus the auth cookie, and an
opaque origin can have neither, so those panes come back blank or 401 in a
sandboxed tab. `examples/extensions/compare` is that case, and the shipped
example of the tier.

Say the consequence out loud, because that is the whole point of the grant: **a
trusted tab runs with your full cockpit session, exactly like the core UI.** The
manifest permission list still governs the bridge, but a trusted page does not
have to use the bridge — it can call `/__api` itself. Grant it only to a tab that
genuinely needs the origin, and only to code you have read.

Two yeses are required, and that is deliberate:

1. the **manifest** asks — `"trusted": true`;
2. a **human grants** it, recorded per extension in `$ARIGAMI_DIR/extensions.json`
   (`trusted: { "<name>": true }`).

The loader ANDs the two. So an extension you installed sandboxed cannot escalate
itself by adding the flag in a later commit: `ext update` pulls the new manifest,
the tab stays sandboxed, and the extension carries a warning until you decide.
Revoking is the same switch in reverse (the tab is remounted).

```bash
bin/host ext add ./compare --trust    # or answer the y/N it asks on a terminal
bin/host ext trust   compare          # grant later (after reading the code)
bin/host ext untrust compare          # back to the sandbox
```

In the cockpit: the install dialog shows a checkbox that names the consequence,
and each extension's card shows its tier with a grant/revoke button.
`GET /__api/extensions` reports `tier` (`'sandboxed' | 'trusted'`), `trusted` and
`trustRequested` for every row.

---

## 8. The example

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

## 9. Domain events

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

## 10. Notifications

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

## 11. Your own remote MCP servers

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

## 12. Writing one

The fastest way is to not write it: ask the session (§1, the `build-extension`
skill). By hand: read [`sdk/README.md`](../sdk/README.md), copy
`examples/extensions/hello` — or one of
[`skills/build-extension/templates/`](../skills/build-extension/templates)
(`tab`, `listener`, `tool`, `hooks`, each with a README listing its placeholders) —
and:

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
