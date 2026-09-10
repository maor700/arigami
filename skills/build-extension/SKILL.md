---
description: Build the human a custom extension for their own Arigami — a tab (a form/UI in the cockpit), a background listener that watches some source and wakes a session, a tool Claude can call, or an automation on merge/review/listener events. Scaffolds into the user's own repo, validates, loads it at runtime (no host restart), shows it in this same chat, and iterates with the human. Use when they ask for a custom tab/form/screen/button, "watch X for me", a webhook receiver, a new tool, something to run before a merge, or say "build me an extension" — Hebrew: "תבנה לי טאב", "תוסיף כלי", "תעקוב אחרי", "מאזין", "הרחבה", "תבנה לי טופס", "שיריץ בדיקה לפני מיזוג".
argument-hint: [what to build, in free text — "a form that picks features", "watch this RSS", "a tool that reads a Notion DB"]
slash: extend
---

# Build an extension

The human describes something they want their Arigami to do. You **write it, install
it and show it to them in this chat, live** — no host restart, no core build, no PR
against `/opt/arigami`.

An extension is a directory with a `manifest.json`. It can contribute five things,
and the human's request maps onto one or two of them:

| they said | contribution | template |
|---|---|---|
| "a form / a screen / a button / a tab" | `tabs[]` — a sandboxed page in the cockpit | `templates/tab` |
| "watch X", "tell me when Y changes", "when a webhook arrives" | `listeners[]` — a poll/push provider that wakes a session | `templates/listener` |
| "give Claude a tool that…", "read from our DB/API" | `tools[]` (+ `docs[]`) | `templates/tool` |
| "before every merge, run…", "when a merge finishes, notify…" | `hooks` — events, a `merge.before` gate, notification channels | `templates/hooks` |
| "a webhook endpoint for …" | `webhooks[]` routed into a listener | `templates/listener` |

**The contract is `sdk/README.md` in the Arigami repo — read it before you write a
manifest.** For a tab, also read `reference/browser-sdk.md` next to this file: a tab
runs sandboxed and **cannot** call `/__api`; everything goes through `window.arigami`.

---

## 0. Ground rules (read once, they save the whole task)

* **Never write into the Arigami repo.** Extensions live in the human's own repo:
  `$ARIGAMI_DIR/user/extensions/<name>/` (`$ARIGAMI_DIR` from the env, default
  `~/.arigami`). The core repo stays `git pull --ff-only`-able forever; that is the
  entire point of the system.
* `$ARIGAMI_TOKEN` is a **session** token, not an admin one. `POST /__api/extensions/*`
  (add / reload / validate) answers **403 admin only** to you. Use `ARIGAMI_TOKEN=
  bin/host ext …` (blanked, so the CLI runs in-process instead of over REST), and
  `GET /__api/extensions` — which a session *may* read — to check the result.
* **No secrets in files you write.** Settings and secrets live in
  `$ARIGAMI_DIR/extensions.json` (0600, outside the repo) and reach the code as
  `ctx.secrets` / env. Put a `settings.schema` in the manifest instead of a constant.
* Extension code runs **in the host process with the host's privileges** — say this to
  the human at the end (step 7), plainly, once.

---

## 1. Clarify — at most ONE question

Read the request, pick the contribution kind(s) from the table, and ask **one**
question only if you genuinely cannot start without the answer. Good single questions
(ask in the human's own language — these are just illustrative in English):

> "A tab with a form that returns a prompt to the chat, or a listener that pings me when something changes?"
> "What exactly should be checked before merge — typecheck, tests, or both?"

Everything else you **decide yourself** and show — a name (`^[a-z0-9][a-z0-9-]*$`,
derived from what they asked), the fields of a form, the poll interval. It is faster
to show them a working tab and let them correct it than to interview them.

Announce what you are building in one line, then build it.

---

## 2. Scaffold from a template

```bash
EXT_ROOT="${ARIGAMI_DIR:-$HOME/.arigami}/user/extensions"
NAME=feature-picker                      # lowercase, digits, dashes
SKILL_DIR=$(ls -d /opt/arigami/skills/build-extension \
              "${ARIGAMI_DIR:-$HOME/.arigami}"/skills/build-extension 2>/dev/null | head -1)
mkdir -p "$EXT_ROOT"
cp -r "$SKILL_DIR/templates/tab" "$EXT_ROOT/$NAME"      # or listener | tool | hooks
```

Then replace every `{{placeholder}}` in the copy (`manifest.json` and the code file)
and delete the template's `README.md` — it documents the placeholders, it is not part
of the extension. Each template README lists its placeholders; the shared ones are:

| placeholder | value |
|---|---|
| `{{name}}` | the extension name — **must equal the directory name** |
| `{{title}}` | a short human title, the human's language |
| `{{description}}` | one line: what it does |

Write the extension's own `README.md` (two or three lines) so the human's repo stays
readable.

**Combining kinds**: copy one template, then paste the extra manifest block and file
from another. One directory may hold a tab *and* a tool *and* hooks — `hello` in the
Arigami repo (`examples/extensions/hello`) is exactly that, and is worth reading once.

---

## 3. Validate, and fix until clean

```bash
ARIGAMI_TOKEN= bin/host ext validate "$EXT_ROOT/$NAME"
```

**The empty `ARIGAMI_TOKEN=` is not decoration.** `bin/host ext` goes over REST as soon
as it sees a token — and yours is a session token, so the call comes back `403 admin
only`. Blanking it for that one command makes the CLI run the check in-process, which
is exactly what you want. (`POST /__api/extensions/validate` is the same check, and is
admin-only, so it is never your path.) It prints `{ok, errors, warnings}` and
says exactly what is wrong: a file that does not exist, an export that is missing, a
listener type that is already taken, a `docs[].description` that is empty. **Do not go
on while `ok` is false** — a broken manifest loads as `state: 'error'` and contributes
nothing.

Warnings are worth reading: an unknown permission grants nothing, and a `daemons[]`
entry is parsed but never run by this host version.

---

## 4. Install = the host picks it up

You scaffolded **inside** `user/extensions/`, so it is already installed — there is
nothing to copy. The live host mtime-polls every 30 s and loads what changed. Confirm
it landed (this endpoint is readable with your session token):

```bash
curl -fsS -H "Authorization: Bearer $ARIGAMI_TOKEN" "$ARIGAMI_URL/__api/extensions" \
  | grep -o "\"name\":\"$NAME\"[^}]*" 
```

Look for `"state":"loaded"`. If it is still absent after ~40 s, or shows `error`, tell
the human and ask them to press **Reload** in Settings → Extensions (or to run
`ARIGAMI_TOKEN=<admin token> bin/host ext reload`); an admin token is the one thing you
do not have.

`ext add` is for a directory **somewhere else** or a git URL (`ARIGAMI_TOKEN=
bin/host ext add <src>` copies/clones it in and prints the permissions). It *refuses* a name that already
exists — so never call it on a directory you just created in place.

---

## 5. Show it, in this chat

Do the one that matches what you built, immediately — the human should see the thing,
not a description of it.

**A tab:**

```
open_tab({ type: 'ext', ext: '<name>', tab: '<tab id from the manifest>' })
```

**A listener** — register it with a demo argument and say what will wake you:

```
register_listener({ type: '<listener type>', ...args })
```

If it is webhook-driven, give the human the URL to POST to:
`<the host>/__api/webhooks/custom/ext-<name>-<webhook id>` (hand over the host-relative
path; never a `localhost:` URL).

**A tool** — a tool list is fixed when a session's `claude` process spawns, so **this
session cannot see it**. Say so in one sentence, and demonstrate it anyway through the
host:

```bash
curl -fsS -X POST -H "Authorization: Bearer $ARIGAMI_TOKEN" -H 'content-type: application/json' \
  "$ARIGAMI_URL/__api/ext/$NAME/tool/<tool_name>" -d '{"args":{...}}'
```

(That route needs `tools:<tool_name>` in the manifest `permissions` — put it there.)
Then tell them: a **new session** (or `restart_session`) will have
`mcp__ext-<name>__<tool_name>`. The same is true of the skill generated from `docs[]`.

**Hooks / a gate** — nothing to open: state which event it listens to, that the log is
`$ARIGAMI_DIR/logs/ext-<name>.log`, and — for a gate — that a **failing gate blocks the
merge**, which is the point.

---

## 6. Iterate

The human will want changes. Edit the file, and:

* `ui/*` — reload the tab (`open_tab` again, or they refresh). Instant.
* `listener.ts` / `hooks.ts` / `manifest.json` — the mtime poll reloads within 30 s;
  re-run `bin/host ext validate` first, every time.
* a **new tool** or a **new doc/skill** — still needs a new session.

Keep the loop tight: change one thing, show it, ask "Like this?" (in the human's own language) — not a list of options.

---

## 7. Finish

1. **Commit the human's repo.** A reload does *not* commit (only `ext add`/`remove` and
   the skill editor do), so do it yourself:

   ```bash
   git -C "${ARIGAMI_DIR:-$HOME/.arigami}/user" add -A
   git -C "${ARIGAMI_DIR:-$HOME/.arigami}/user" -c user.name=Arigami -c user.email=arigami@localhost \
       commit -q -m "arigami: extension $NAME"
   ```

2. **Tell them where it lives and what it costs**, in two sentences, no lists — in the
   human's own language (illustrative English below):

   > Your code lives at `~/.arigami/user/extensions/<name>/` — your own git repo, entirely
   > separate from the core, and it's included in backups. Note: extension code runs inside
   > the host with its own permissions (like a skill with Bash), and the permissions it asks
   > for are listed in `manifest.json`.

3. If they want it off the machine: `git -C ~/.arigami/user remote add origin <url>` —
   or `gh repo create <name> --private --source ~/.arigami/user --push` if `gh` is
   authenticated. A remote is **optional**; the repo is created and committed either way.

---

## Reference

* `sdk/README.md` (Arigami repo) — the full contract: every manifest field, the
  `ListenerProvider` rules, hooks/gates/channels, tools, tabs.
* `reference/browser-sdk.md` (next to this file) — **read before writing a tab**: the
  `window.arigami` surface and the permissions each call needs.
* `docs/EXTENSIONS.md` (Arigami repo) — the operator's view: layout, what reloads vs
  what needs a new session, the security model, REST/CLI.
* `examples/extensions/hello` (Arigami repo) — one working example of every kind.
