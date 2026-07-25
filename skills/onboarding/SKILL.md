---
description: Conversational workspace onboarding — add a repo the user names, clone it, resolve its env, install deps, until it's "ready". A THIN wrapper over the deterministic engine at /__api/onboarding/* — it never reimplements clone/install, it drives them and reports progress in the cockpit. Use when a session is launched to set up a workspace, or when the launcher gate sent the user here because no repo was ready.
argument-hint: [repo-url-or-owner/repo]
---

# Onboarding (conversational workspace setup)

You are running INSIDE a Arigami session (`ARIGAMI_SESSION_ID` set, the
`arigami` MCP connected, and the host API reachable at `$ARIGAMI_URL`).

Your job: get a workspace **ready** — with minimal back-and-forth — by driving the
host's onboarding engine. **You do NOT clone or install anything yourself.** Every
mechanical step is an HTTP call to `$ARIGAMI_URL/__api/onboarding/*`; you
converse, decide, call the endpoint, and poll. This keeps behaviour identical to
the Setup UI and to headless trigger-readiness.

## The engine (all you can call)

| Call | Purpose |
|------|---------|
| `GET  /__api/onboarding/status` | the full status tree: `{environment, steps[]}` |
| `POST /__api/onboarding/repos` `{name,source,branch?,envSource?}` | register a repo |
| `POST /__api/onboarding/repos/<name>/clone` | start clone (background job) |
| `POST /__api/onboarding/repos/<name>/env` | resolve env (command kind) |
| `POST /__api/onboarding/repos/<name>/install` | start install (background job) |
| `DELETE /__api/onboarding/repos/<name>` | unregister |

Use `curl -s "$ARIGAMI_URL/__api/onboarding/..."`. Actions return immediately
(`{started:true,state:"running"}`); the work runs in the background.

Each step has `status: ok | missing | error | blocked | running`. A step is
`blocked` until its `dependsOn` are `ok`. Order per repo: **cloned → env → deps**.

## 0. Announce (cockpit is your status surface)

- `mcp__arigami__set_title({ title: "Onboarding" })`
- `mcp__arigami__set_status({ status: "Setting up workspace" })`

## 1. Read status, explain what's missing

`GET /__api/onboarding/status`. Look at the **global** steps first:

- `claude-auth` missing → tell the user to set `CLAUDE_CODE_OAUTH_TOKEN` (from
  `claude setup-token`) or `ANTHROPIC_API_KEY` in the host env and restart. You
  **cannot** fix this from here (it gated your own session — if you're running,
  it's already ok).
- `git-auth` missing → tell them to set `GH_TOKEN` (or, on a native/dev machine,
  `gh auth login`). Needed before any clone of a private repo.

Do not try to auto-fix the global credential steps — surface them clearly and
stop that branch until the user resolves them.

## 2. Pick the repo

- If `$ARGUMENTS` holds a repo (`owner/repo`, a git URL, or a local path), use it.
- Otherwise ask the user: **which repo** (URL / `owner/repo` / local path), and
  whether it needs env (a private registry, a `.env`, or a pull command).

Register it (skip if it's already in `status`):

```bash
curl -s -X POST "$ARIGAMI_URL/__api/onboarding/repos" \
  -H 'content-type: application/json' \
  -d '{"name":"<name>","source":"<source>","envSource":{"kind":"none|file|command","value":"<glob-or-cmd>"}}'
```

- `envSource.kind`: `none` (no secrets), `file` (a `.env` must be present — the
  user provides it; you can't fetch secrets), or `command` (e.g. `vercel env pull`).
- Auto-detection fills install/dev/test from the lockfile + `package.json` after
  clone — you don't specify them unless the user overrides.

## 3. Drive each step to `ok`, in order

Reflect the plan with `set_progress` (Clone / Env / Install), then for each
non-`ok`, non-`blocked` step call its action and **poll** until it settles:

1. `POST .../<name>/clone` → then re-`GET status` every ~3s until
   `repo:<name>.cloned` is `ok` (or `error`). Set that progress row `done`.
2. If `repo:<name>.env` is `missing`:
   - `file` kind → ask the user to provide the `.env` (they paste/place it), then
     re-check. Do not invent secrets.
   - `command` kind → `POST .../<name>/env`, poll to `ok`.
3. `POST .../<name>/install` → poll `repo:<name>.deps` until `ok`. Installs can
   take minutes; the job runs in the background — keep polling, don't block.

On any step `error`, the `detail` carries the output tail — show it to the user,
diagnose (bad URL, missing env, registry 401), fix the cause, and retry the same
action. Don't fall back to running clone/install yourself.

## 4. Done

When every step for the repo is `ok`:

- `mcp__arigami__set_progress({ steps: null })` (clear the strip)
- `mcp__arigami__set_status({ status: "Workspace ready" })`
- Tell the user the repo is ready and what they can do next (start a ticket /
  session against it). If they named more than one repo, repeat from step 2.

## Principles

- **Thin wrapper.** Never `git clone` or run the install command directly — always
  the endpoint. It's idempotent, streams progress, and is the same path triggers
  use headlessly.
- **Minimal prompts.** Only ask for what the engine genuinely can't derive: the
  repo identity, and per-repo secrets/env. Everything else is auto-detected.
- **Surface, don't hide.** Credential gates and step errors go to the user plainly.
