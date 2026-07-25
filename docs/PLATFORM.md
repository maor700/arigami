# PLATFORM.md — From "Dana's cockpit" to a generic, extensible host

Status: proposal (2026-07-09). Companion to SPEC.md / ONBOARDING.md / TRIGGERS.md / DISPATCHER.md.

## 1. The problem

The core engine is already workflow-agnostic, but the product is welded to one
user's workflow in three places:

1. **Issue tracker = Linear, hardwired.** `server/linear-mcp.ts` (OAuth + MCP
   client), `/__api/linear/*` routes (api.ts:1014-1123), `pages.js` (`/__ticket`
   renderer speaks Linear GraphQL, builds `linear.app/<workspace>` URLs,
   `LINEAR_API_KEY`), `triggers.ts` (the only trigger type is `linear-filter`),
   `Launcher.jsx` (ConnectLinear banner, TicketPicker, `linearMeta.js` caches
   `/linear/labels|statuses`), `config.linearWorkspace`, the `[A-Za-z]+-\d+`
   issue-id regex.
2. **Company/user assumptions in config + profile.** `config.ts` DEFAULTS:
   `prodUrl: app.example.com`, `reposDir: ~/Desktop/repos`, Acme port pools
   (3020-3030, 6021-…), Hebrew voice, Groq models. `profiles/acme.json` is the
   only profile and lives in the core repo.
3. **Personal workflow baked into skills.** `create-from-ticket` calls
   `mcp__linear-server__*` tools by name; `ship-it` enforces `dem-\d+` branch
   names, before/after GIF gates, Chromatic, Slack reviewer notify; `login`,
   `local-env`, `feedback-loop` encode Acme repos, ports, and app.example.com.

What is **already generic** (keep as-is): session lifecycle + chat streaming
(state.ts, claude.js), tabs + proxy (proxy.ts), git/worktrees (git.ts), jobs,
the onboarding engine + profile shape (onboarding.ts), the skills pack delivery
(`--plugin-dir`, skills.ts), listeners scheduler (listeners.ts), dispatch,
accounts, the host MCP surface, voice shell + command bus.

## 2. Target model — VS Code-style layering

```
┌─────────────────────────────────────────────────────┐
│ Skill packs        packs/core  packs/acme  packs/<x> │  ← workflows
├─────────────────────────────────────────────────────┤
│ Providers          issues: linear|jira|trello|monday │  ← integrations
│                            |github|local             │
│                    scm: github | gitlab              │
│                    voice: groq | anthropic           │
├─────────────────────────────────────────────────────┤
│ Host core          sessions · chat · tabs/proxy ·    │  ← engine
│                    git/worktrees · jobs · onboarding │
│                    · listeners · dispatch · accounts │
│                    · host MCP · auth relay           │
└─────────────────────────────────────────────────────┘
        composition root: workspace config (which providers,
        which packs, which repos, port ranges, branch template)
```

Three contribution surfaces, in order of leverage:

### 2.1 IssueProvider (the flagship)

One interface, N implementations. Extracted from what linear-mcp.ts + pages.js
already do:

```ts
interface IssueProvider {
  id: string;                    // 'linear' | 'jira' | 'trello' | 'monday' | 'github' | 'local'
  displayName: string;
  // auth — reuses the generalized OAuth relay (the linear-oauth pattern);
  // token store: ~/.arigami/providers/<id>/auth.json
  status(): { connected: boolean; needsAuth: boolean; authUrl?: string };
  startAuth?(): Promise<{ authUrl: string }>;
  finishAuth?(code: string, state?: string): Promise<void>;
  disconnect?(): void;
  // read
  listIssues(facets: Facets): Promise<Issue[]>;
  getIssue(id: string): Promise<IssueDetails>;      // normalized view-model (see 2.4)
  facetSchema(): Promise<FacetField[]>;             // labels/statuses/projects/priority —
                                                    // drives the FilterBar generically
  parseRef(raw: string): string | null;             // pasted URL or ID → canonical id
  issueUrl(id: string): string;
  // write (optional — capability-gated in UI/skills)
  update?(id: string, patch: IssuePatch): Promise<void>;   // assign / transition
  comment?(id: string, body: string): Promise<void>;
  // triggers
  poll?(facets: Facets, limit: number): Promise<Issue[]>;  // used by issue-filter triggers
}
```

Implementations, in build order:
- **linear** — wrap the existing linear-mcp.ts client + pages.js GraphQL
  fallback. Zero behavior change; it just moves behind the interface.
- **local** — host-managed tasks (`~/.arigami/tasks.json`, CRUD via UI +
  MCP). This is the *zero-config default*: a fresh user with no tracker still
  gets the full launcher → session → ship workflow. Also the reference
  implementation for provider authors.
- **github** — issues via `gh` CLI (cheap; no new auth).
- **jira / trello / monday** — REST providers, community-shaped.

Registry: `server/providers/issues/<id>.ts`, in-tree, keyed by id. The active
provider (per workspace) is `workspace.issueProvider = { id, settings }`.
Out-of-tree loading is Phase 4, not now — interface stability first.

### 2.2 Host MCP as the provider indirection for skills

**This is the single highest-leverage change.** Today `create-from-ticket`
says `mcp__linear-server__get_issue(...)` in its prose — the skill itself is
the lock-in. Add host MCP tools that route through the active provider:

- `issue_get(id)` / `issue_list(facets)` / `issue_update(id, patch)` /
  `issue_comment(id, body)`

Then the skill text becomes provider-neutral ("claim the issue:
`issue_update({assignee:'me', state:'in-progress'})`") and works identically
against Linear, Jira, or local tasks. Sessions no longer need the
linear-server MCP configured at all; the host owns the credential.

### 2.3 ScmProvider (second wave)

GitHub is assumed everywhere `gh` is shelled (pages.js PR view-model,
listeners-pr, `/__pr`, ship-it). Same treatment, later: `ScmProvider` with
`prViewModel(url)`, `listReviews(pr)`, `openPr(...)`; `github` is the only
implementation for a while, but the seam makes gitlab/bitbucket possible and
keeps PR-listener types per-provider.

### 2.4 Normalized view-models

`Launcher.jsx normalizeDetails()` already defines the shape (it normalizes
Linear-MCP vs GraphQL payloads). Promote it to the provider contract
(`IssueDetails`: id, title, description-md, state, assignee, labels, priority,
comments[], links[]) and move it server-side. `/__ticket/<id>` becomes
`/__issue/<id>` rendering the view-model; image caching (`/__ticket-img`) is
already provider-agnostic plumbing.

## 3. Workspace config = the composition root

`~/.arigami/workspace.json` (new; config.json stays host-level):

```jsonc
{
  "issueProvider": { "id": "linear", "settings": { "workspace": "your-workspace" } },
  "scmProvider":   { "id": "github" },
  "branchTemplate": "{issueKey}-{slug}",        // replaces the dem- regexes
  "portRanges": { "dev": [3020, 3070], "aux": [6021, 6070] },
  "packs": ["core", "acme"],                     // enabled skill packs
  "defaultWorkflow": "create-from-ticket",       // what "Go" on an issue runs
  "repos": { /* existing repos.json shape, unchanged */ }
}
```

Profiles (onboarding) become **workspace templates**: `profiles/acme.json`
already declares repos + issueSource + workflows — extend it to fill
workspace.json, and move it out of the core repo eventually (a profile is
content, not platform).

Config hygiene that falls out of this:
- `prodUrl` / `storybookCompareUrl` become **per-repo** fields, not global.
- `linearWorkspace` → provider settings.
- Voice defaults (`he`, Groq) are already config-driven — just stop shipping
  personal values as DEFAULTS; first-run picks them.

## 4. Skill packs as extensions

Split `skills/` by audience:

| pack | skills | coupling today |
|---|---|---|
| `packs/core` | onboarding, explain-changes, dispatch, feedback-loop (generic core) | none/near-none |
| `packs/acme` | create-from-ticket, ship-it, login, local-env, feedback-loop (Acme appendix) | Linear tools, dem- branches, GIF/Chromatic gates, app.example.com, port pools |

Pack manifest (`packs/<name>/pack.json`): name, skills, `requiresProviders:
["issues"]`, settings schema. Delivery mechanism is unchanged
(`--plugin-dir` + skills.ts), but the enabled set comes from
`workspace.packs`, and the Skills view groups by pack.

De-personalizing the acme pack is mostly **substitution via the host**, not
templating: branch names come from `branchTemplate`, issue ops go through the
host MCP issue tools (2.2), ports come from `portRanges`, prod/compare URLs
come from the repo entry. What's left genuinely personal (GIF evidence gates,
Chromatic, Slack notify) *stays in the acme pack* — that's the point: it's a
valid workflow, packaged as one option instead of the default.

## 5. UI: schema-driven, not Linear-driven

- **Launcher**: rename the concept to "issue source". ConnectLinear →
  `Connect {provider.displayName}` driven by `status()`. FilterBar renders
  from `facetSchema()` (a labels multi-select and a status select are generic
  widgets already — LabelPicker just needs its options from the schema).
  PasteField placeholder + parsing come from `parseRef`.
  `linearMeta.js` → `providerMeta.js` (`/__api/issues/facets/<field>`).
- **API**: `/__api/issues/*` (list, get, facets, connect, disconnect,
  callback). Keep `/__api/linear/*` as thin aliases for one release, then
  delete.
- **Triggers**: `type: 'issue-filter'` + `providerId`; the linear-filter type
  is migrated in place (state migration: `linear-filter` → `issue-filter`,
  `providerId: 'linear'`).
- **Tabs**: `/__ticket/<id>` → `/__issue/<id>`; the auto-rewrite table in the
  proxy maps provider URL patterns (each provider contributes `parseRef`).
- Rail/панel contributions from packs (VS Code "views") — **not now**; the
  fixed Rail is fine until a second real consumer exists.

## 6. Migration plan

Each phase ships working and keeps today's behavior for the Acme workspace.

- **Phase 0 — config hygiene (small).** Per-repo prodUrl/compareUrl;
  branchTemplate; stop reading `linearWorkspace` outside the provider;
  workspace.json introduced (auto-migrated from current config).
- **Phase 1 — IssueProvider + Linear adapter + local provider.**
  `server/providers/issues/` registry; linear-mcp.ts + pages.js linear bits
  fold into the linear provider; generic `/__api/issues/*`; Launcher +
  linearMeta on the generic endpoints; triggers migrated to `issue-filter`.
  Acceptance: Acme flow byte-identical; a fresh workspace with `local`
  provider can create a task → launch a session from it.
- **Phase 2 — host MCP issue tools + pack split.** `issue_get/list/update/
  comment` on the host MCP; rewrite create-from-ticket + ship-it against them
  (drop `mcp__linear-server__*` from skill prose); split packs core/acme;
  `workspace.packs` gates delivery. Acceptance: create-from-ticket runs
  unmodified against both linear and local providers.
- **Phase 3 — ScmProvider.** Extract the gh-CLI surface; PR listeners typed
  per provider; `/__pr` renders the provider view-model.
- **Phase 4 — out-of-tree extensions (aspirational).** Load providers/packs
  from `~/.arigami/extensions/<name>` (dir with manifest); settings-schema
  UI; only worth it when someone other than us writes one.

## 7. Risks / notes

- The deepest lock-in is in **skill prose**, not server code — 2.2 is the
  keystone; without it every provider still needs a hand-edited skill fork.
- Provider transports differ (Linear = live MCP client, Jira = REST, local =
  fs). The interface must be transport-agnostic; the linear provider keeps its
  MCP client internally.
- Auth relay generalization: the linear OAuth pattern (DCR+PKCE, token file,
  `/__api/.../oauth/callback`) becomes `server/providers/auth-relay.ts` with a
  provider-scoped callback path — this is also what jira/monday will need.
- Naming: the repo/product name ("arigami", `~/.arigami`, `ARIGAMI_*`
  env) reads company-specific. Decide at Phase 4 (rename is churn; a config
  `ARIGAMI_DIR` override already exists).
- Local provider doubles as the **demo/onboarding path** — a new user sees the
  full loop in 2 minutes with zero external accounts. Worth building early for
  that alone.
