# Session and project autonomy

Status: proposal for human decision; no runtime behavior changed. Investigated at commit `66f53ff9` (2026-10-05).

## Answer: can skills support conditions or variables today?

**Not as an Arigami-evaluated feature.** The host passes raw `SKILL.md` files to the engines. It does not evaluate `autonomy: full`, template variables, or conditional blocks. An author can write “if this session is autonomous, skip this review checkpoint” today, but the model interprets that prose; no renderer removes the other branch or enforces the result.

There are existing parameter *conventions*: `buildSkillPrompt()` tells the model the values of `$ARGUMENTS` and `$SKILL_DIR` in the launch message. It does not substitute them inside the file or create corresponding environment variables there. Process environment variables such as `ARIGAMI_SKILLS` are separately supplied to tools. Engine-native slash-command behavior may provide its own features; those are not an engine-independent Arigami template contract, and this investigation does not claim that either upstream engine has no such features.

The host's frontmatter parser accepts simple `key: string` lines. The skill catalog consumes `description`, `argument-hint`, and `slash`; adding an `autonomy` key alone has no execution effect. Nested YAML is not properly parsed by this parser. References: [parser and catalog](../server/skills.ts#L73), [raw reads](../server/skills.ts#L169), [launch parameters](../server/api.ts#L2312).

## Current path from skill to prompt

1. **Source selection.** Shipped skills live under `ROOT/skills`, user overrides under `$ARIGAMI_DIR/skills`, and extension docs become a third generated pack. The host catalog and `skillDir()` resolve a same-named user skill ahead of the shipped skill. This is source selection, not instruction precedence.
2. **Discovery.** Claude receives the shipped, user and extension plugin directories via `pluginDirArgs()`. Codex receives links to those roots in its session-specific `CODEX_HOME/skills`. The Codex app-server shares preparation code with exec. Both namespaced copies can remain discoverable; `linkSkills()` explicitly notes that Codex does not shadow duplicate names by root order. The host's effective-copy rule does not eliminate explicitly invoked old copies.
3. **Invocation.** `buildFirstPrompt()` selects a skill and says “Read …/SKILL.md in full and follow it exactly,” followed by any extra instructions. The composer rewrites skill shortcuts to namespaced commands. Agents' persona blocks list recommended skills, and agents can read files directly later. There is no single host interception point for every skill read.
4. **Turn composition.** `composeTurnText()` adds first-turn identity/persona/memory and an every-turn Simple-mode reminder before handing the text to the engine. Claude encodes that as a **user** message; XML named `system-reminder` does not give it actual system-message priority. Skill text can enter later in the same turn, after the autonomy instruction.
5. **Existing autonomy.** `AUTONOMY_DIRECTIVE` already says not to ask or wait, and to treat workflow review as auto-approved. Ticket launches and isolated cron runs optionally append it to their first prompt and choose `bypassPermissions`. Some triggered ticket metadata carries `autonomous:true`, but the directive is not a universal session/project policy, is not refreshed by `composeTurnText()`, and is not inherited by `wireWorker()`/`wireFullChild()`. Generic session creation has no equivalent general handling of `body.autonomous`.

Source anchors: [Claude plugin setup](../server/claude.js#L71), [Codex skills](../server/codex.ts#L238), [app-server shared preparation](../server/codex-app.ts#L13), [composer](../web/src/lib/composer.js#L37), [agent persona](../server/agents.ts#L368), [turn composition](../server/claude.js#L2190), [existing autonomy directive](../server/api.ts#L2291), [trigger ticket launch](../server/triggers.ts#L481), [cron launch](../server/triggers.ts#L738), [full child creation](../server/api.ts#L2936), [generic launch](../server/api.ts#L5367).

## Why a stronger sentence is insufficient

The installed `create-from-ticket` skill explicitly ends with `request_review` and “Stop and wait”; `ship-it` expects a human Verified click and later offers merge choices. Those are instance user skills, not files to change in this host repository. The shipped [project-manager](../skills/project-manager/SKILL.md#L122) requires human branch approval, and the project creation prompt itself asks the agent to ask the human if the goal is unclear.

There is also executable policy. `request_review` first sets “In Review,” then creates an action card with no `kind`. Agent `autoApprove` only handles kind-tagged actions, so it does not automatically cover this tool. `mergeStatus()` checks `metadata.review.state`; normal `mergeSession()` rejects an unapproved branch. Its explicit force path is not a session autonomy policy. Outbound/login/share cards have separate human-only handling. Engine permission mode, model workflow behavior, host action cards, and merge authorization are different mechanisms.

References: [review MCP tool](../mcp/host-mcp.js#L666), [action auto-approval](../server/api.ts#L5980), [human-only card handling](../server/api.ts#L6020), [merge checks](../server/api.ts#L3078), [project launch prompt](../server/api.ts#L5307). These gates must be addressed deliberately; an agent must not fake a human approval or bypass a denied tool through a shell command.

## Contract proposed for all options

`full` means: do not solicit workflow approval or preferences; choose reasonable defaults, record assumptions, run the required checks, and continue within the assigned task. No default makes an unknown fact true, a failed test pass, or an unavailable credential exist. When an authorized task cannot proceed, report a concrete blocker to the controller and finish that attempt without opening an approval question or retrying indefinitely. Continue independent work when possible. This is a noninteractive failure result, not a promise that every task succeeds.

Persist an owner-controlled `autonomy` setting (`supervised | full`) on sessions and project folders, separately from arbitrary agent-writable metadata. Expose the effective mode and provenance to the model, UI, and tools. Suggested resolution:

- Explicit owner session override wins, including an explicit `supervised` override inside a full project.
- Otherwise inherit the current project setting; a child outside a project inherits its parent's effective setting; otherwise default to `supervised`.
- Agents may inherit or narrow their delegated scope but cannot promote themselves to full mode through `set_metadata`, generic PATCH, a skill, or a child-creation payload.
- Resolve at each turn and action. Owner changes increment a policy revision and are audited; active children get a host notification. A revocation is checked before the next controlled operation, without waiting for the model to finish its turn. Project moves/adoptions trigger re-resolution. Prevent cycles in parent traversal.
- Map legacy trigger `autonomous:true` to the new full setting at launch. Absence defaults to supervised. Existing sessions should not become full merely because old metadata happens to contain a similarly named key.

Instruction precedence within the task: platform/system/developer requirements and executable host restrictions remain binding; the owner's task scope and explicit restrictions remain binding; the owner-selected autonomy directive overrides conflicting workflow conventions in skills, persona and memory, regardless of when the skill was read. Skill defaults apply last. Thus “design only; request review” in **this task** remains a real task boundary, not something to auto-approve away. Ordering Markdown blocks is a salience aid, not a new instruction hierarchy.

The initial mode selection should constitute advance authorization for the applicable workflow gates, rather than introducing a new approval at each step. Whether it also authorizes outbound sends, public sharing, deployment, or merge is an explicit product decision, recorded in the host policy. Existing independent restrictions cannot silently disappear. Until that decision is implemented, a denied operation yields a noninteractive blocked result. If the product promises fully unattended shipping, its selected scope must cover all necessary gates up front.

## Three options

| Option | Mechanism | Benefit | Cost / limitation |
| --- | --- | --- | --- |
| 1. Session directive plus policy-aware gates | Persist mode; inject a shared directive every turn; teach host workflow tools the same policy | Smallest useful vertical slice; works with unchanged and late-loaded skills | Model may still ask in prose; host enforcement and engine evaluations remain necessary |
| 2. Session-rendered conditional skills | Materialize a per-session pack from mode-aware templates and point all host-managed loaders at it | Conflicting branches never enter the model context through that pack; deterministic render tests | More loader/cache/path work; raw reads, external skills and old context still need option 1's precedence contract |
| 3. Declarative workflow checkpoints | Skills declare structured steps, defaults, gates and effects; host owns transitions | Reliable noninteractive checkpoint decisions with explicit outcomes and audit | Largest migration; cannot capture arbitrary prose and scripts cheaply; would become a workflow engine |

### Option 1: persisted directive and host decision policy — recommended first

Add a small shared resolver and directive builder, used by `composeTurnText()` on **every** initial, resumed, queued, listener and controller turn. Describe the effective mode, policy revision, scope, defaults, and precedence explicitly. Also expose `ARIGAMI_AUTONOMY` for scripts; it is a convenience snapshot, not an authoritative credential. A long-running process's environment cannot update with a project setting, so actions always re-check live host state. Replace the ambiguous “follow it exactly” launch wording with “follow it subject to the owner's task and session policy.”

Give `request_review` a semantic gate identity. Under supervised policy it behaves as today. Under full policy, absent an explicit task-level human-review requirement, it records a completed checkpoint and returns a structured `continue` outcome without switching to “In Review,” opening a card or synthesizing a “Verified” user message. For generic preference questions, accept an explicit/defaulted value only for a registered choice contract; do not blindly pick a primary button on an arbitrary destructive action. Missing required data produces `blocked`.

Keep human review provenance separate from autonomous continuation, for example `decision: {source: 'autonomy-policy', revision, operation, headSha, at}` rather than `review.state:'approved'`. Let the merge service accept a valid policy grant when the owner-authorized scope includes merge; still verify caller identity, branch/head, current policy and all existing repository constraints. Re-check on a new commit or revoked policy. Do not reuse `force` or forge an approval click. Corresponding outbound/setup/share decisions need their own explicit policy integration if included in the product scope.

This fixes deterministic host waiting states but cannot prove that a model will never type a question. Evaluate late-loaded contradictory skills on all supported engines before describing the conversational behavior as reliable. Add a noninteractive turn-completion check only if evidence shows silent waiting persists; it should emit a bounded continuation or blocker, not an endless “keep going” loop.

### Option 2: conditional rendering, as an incremental extension

Possible **new syntax**, not supported today:

```markdown
---
description: Complete a ticket
arigami-template: 1
---
Session mode: {{arigami.autonomy}}
<!-- arigami:if autonomy=supervised -->
Call request_review and wait for the human's decision.
<!-- arigami:else -->
Record verification evidence and continue to the next authorized step.
<!-- arigami:endif -->
```

Keep the language tiny: allowlisted enum variable, literal output, equality branch, no shell expansion, expressions, file includes or secret-bearing environment substitution. Unknown variables, invalid/nested blocks (unless explicitly supported), and unclosed blocks are compilation errors with a source location. Leave `$ARGUMENTS`, `$SKILL_DIR` and shell examples untouched. Use version opt-in so legacy code samples containing similar syntax remain literal. `autonomy: full` must not grant permission; optional frontmatter such as `arigami-supported-autonomy: full,supervised` would describe compatibility only.

Materialize rendered `SKILL.md` files in a private session directory; never rewrite shared sources. Preserve namespaces and resolve host-selected overrides consistently. Route Claude plugin roots, Codex skill roots, `buildSkillPrompt()` and host-provided skill paths to the rendered pack. Supporting files must retain relative-path semantics: copy the full skill directory initially, then replace only its Markdown; use a session-local helper root when skills reference `../_lib`. Keep source path/hash and a render manifest for diagnostics. Cache by source/supporting-file hashes, renderer version and effective mode; publish a new generation atomically. Determine and test discovery refresh/restart behavior separately for Claude, Codex exec and app-server.

An arbitrary `cat` of an original skill or an external provider's skill bypasses this pack; a conditional renderer is not an access-control boundary. Old instructions also remain in resumed context. Option 1's every-turn directive and host policy are still needed. Migrate `create-from-ticket`, `ship-it`, project-manager and dispatch first, including supporting-file gates, after their owners approve changes.

### Option 3: structured checkpoints

Introduce a versioned workflow description with semantic steps, e.g. `verify → review-checkpoint → publish → report`, and mode-specific transitions/defaults. The host evaluates a checkpoint using mode, task scope and operation capability and returns `continue`, `await-human` (supervised only), or `blocked`. Skill prose explains execution but cannot redefine checkpoint authority. This is the strongest option for repeatable release workflows, but requires rewriting scripts and enforcing all relevant operation entry points; it is too broad for this fix's first iteration.

## Recommendation and rollout

Choose **option 1**, with option 2 available when we need deterministic removal of contradictory skill text. Do not start by templating every skill or interpreting all “ask” sentences heuristically. The common resolver and explicit precedence contract solve the mode distribution problem; host gate handling solves the actual waiting problem. Option 3 can follow if structured workflows become a product goal.

1. Owner approves the contract: inheritance, task-specific limits, operations included in full mode, and blocker semantics. No production setting changes are made by this proposal.
2. Implement protected storage, resolution and every-turn injection across manual launches, tickets, cron, controller creation and both child paths. Update the legacy directive to use that shared implementation. Display effective mode/provenance; retain supervised default.
3. Implement semantic review/preference outcomes and any explicitly approved merge/outbound policy. Audit by operation and policy revision, retain actual human approval records separately, and update tool descriptions so they agree with runtime behavior.
4. Run the matrix below before enabling full mode for a real project. If late skill loads still confuse the model, add option 2 for the affected pack. Do not claim a prompt-only change enables unattended shipping.

Acceptance cases:

- A full project controller starts both full children and dispatch workers: all inherit full unless the owner explicitly supervises one child. No child can elevate mode or scope.
- A supervised session still stops at review. A full session loading a contradictory skill late records evidence and continues; an explicit owner “design only; request review” restriction remains in force.
- Resume, compaction, listener wake, queued input and process restart preserve the effective directive. An owner mode change updates running descendants and the next controlled action.
- Full-mode review creates no pending card, no “In Review” state and no fake user click. Generic unknown questions do not silently authorize effects. Merge grant matches the current head and policy revision.
- Failed checks, unavailable credentials, denied host operations and missing indispensable data produce a bounded blocker report with evidence, never an approval loop. External sends only occur if actually in the selected authorization scope.
- If conditional packs are added: both rendered branches, malformed input, Unicode, duplicate namespaces, supporting paths, simultaneous sessions of opposite modes, and source edits are covered.

## Isolated prototype and evidence

[`autonomy-prototype.mjs`](./prototypes/autonomy-prototype.mjs) demonstrates option 1's pure decision layer: owner-resolved precedence inputs, mode-specific text, and review checkpoint outcomes with separate provenance. It has no server imports or side effects and is not wired into any live prompt or tool. It deliberately does not implement storage/authentication, recursive graph resolution, templates, merge grants or model behavior. Its caller must supply authorized values and already-resolved parent policy.

Verified with `bun test docs/prototypes/autonomy-prototype.test.mjs`: **8 passed, 0 failed** (Bun 1.4.2). The tests use the Node-compatible test API; the initial `node --test` invocation could not run because Node is absent on this host. They exercise supervised defaults, explicit supervised override, project/parent inheritance, invalid mode rejection, fresh policy changes, required human-review boundaries, and noninteractive blockers. Passing them demonstrates deterministic policy behavior only; the engine/host integration cases above remain future acceptance work.

Decision requested: approve option 1 as the first implementation scope, and specify whether full mode includes only workflow checkpoints or also merge/publish/outbound operations already within the assigned task. This design session ends with Changes review as explicitly requested.
