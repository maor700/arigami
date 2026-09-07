# hello — the example extension

This extension exists to prove the extension system works end to end, and to be
the shortest thing to read before writing your own.

## When to use it

The human asked to test extensions, said "hello extension", or wants to see how
a tool, a listener, hooks and a tab hang together.

## What it gives you

* **A tool** — `mcp__ext-hello__hello_echo({ text })` returns the text prefixed
  with the extension's configured greeting. If you can call it, the whole
  `manifest → loader → --mcp-config → session` path is working.
* **A listener type** — `register_listener({ type: 'hello-tick', count: 3 })`
  wakes this session three times, roughly one poll apart, then stops on its own.
  Nothing external is involved, so it is a safe way to watch the wake machinery.
* **A webhook** — `POST /__api/webhooks/custom/ext-hello-tick` turns a delivery
  into the same wake, without waiting for a poll.
* **A tab** — `open_tab({ type: 'ext', ext: 'hello' })` opens a sandboxed page
  that talks to the cockpit through `/__ext-sdk.js` and can send a prompt back
  into this session.
* **Hooks** — it logs `merge.done` and `listener.fired` to
  `$ARIGAMI_DIR/logs/ext-hello.log`, and registers a `merge.before` gate that
  always passes.

## Settings

`greeting` (default `שלום`) — what the tool and the tab greet with. Change it in
Settings → Extensions, or with
`PATCH /__api/extensions/hello {"settings":{"greeting":"hi"}}`.

## Writing your own

Copy this directory, rename it, and read `sdk/README.md` — it is the full
contract. Validate with `bin/host ext validate <dir>`, install with
`bin/host ext add <dir>`, and reload with `bin/host ext reload`.
