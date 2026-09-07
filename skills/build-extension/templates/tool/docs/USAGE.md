# {{title}}

{{description}}

## When to use it

{{trigger}}

## The tool

`mcp__ext-{{name}}__{{tool}}({ query, limit? })` → `{ count, rows }`.

* `query` — what to look up (required).
* `limit` — how many rows to return, default 10.
* Errors come back as `{ error: "…" }` rather than a throw; read the message, it says
  whether the problem is configuration (`baseUrl is not set`) or upstream.

## Configuration

`baseUrl` in Settings → Extensions → {{title}}, or
`PATCH /__api/extensions/{{name}} {"settings":{"baseUrl":"https://…"}}`.

A credential, if the source needs one, goes in `secrets` (0600, in
`$ARIGAMI_DIR/extensions.json` — never in the repo) and reaches the tool as
`ctx.secrets.API_KEY`.
