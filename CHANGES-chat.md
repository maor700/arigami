# Redesign — chat area (phase 2, `chat`)

Rule of the branch: **no feature disappears**. Everything below is a restyle unless listed under *moved* / *added*.

## Moved
- **moved: model / effort / permission mode** — now ALSO one pill in the composer (`ComposerPill`, popover with three sections, same endpoints, same "stop and switch" confirmation while a turn runs, Claude-only "refresh models" + CLI-update chip kept) (decision D7). The header gear (`TermControls`) is untouched in this branch and still carries them next to Context / Direction / Theme / Restart / Clear; whoever redesigns the header (D10) decides whether the gear drops its duplicates. Reachable in 2 clicks either way.
- **moved: context meter** — a small `63%` chip with a status dot next to the pill (opens the same Context modal as before). The gear keeps its own entry.
- **moved: composer code** — `PendingPromptsPanel` and `ChatFooter` moved from `SessionView.jsx` to the new `Composer.jsx` (behaviour unchanged; `SessionView` imports `ChatFooter`). Two tests that grep source (B26 phone font size, agents-ux2 `/agent new`) now read `Composer.jsx`.

## Added
- `@` button in the composer (inserts `@` and opens the agent palette; typing `@` still works) — decision D7 asks `@` to stay visible.
- **Plan card**: a `TodoWrite` call renders as "Plan 2/4" with a checklist (D15 "Plan card (if a todo/plan event exists)"); in Simple mode it still folds into the summary row.
- Working indicator has a quiet shimmer (static under reduced motion). No timer, no Retry button (D15: needs defined semantics).
- Chat column is centred, max 48rem.

## Removed
- *(nothing)* — the "YOU" label above a user message is now visually hidden (`sr-only`), the recap tint of a turn's last message is gone (cosmetic).

## Restyled (per piece)
- **Messages** — assistant prose: Inter/Rubik 15px, no bubble; user message: neutral surface, hairline, no mint; hover row (time · copy · quote) is always visible on touch; attachment chips on the message.
- **Tool calls** — one muted row per call (lucide glyph per tool, name, target, `+N −M`, chevron; Radix Collapsible); Simple mode keeps ONE summary row per turn ("What happened behind the scenes · N actions" with the kind glyphs) that expands to the individual calls, and the "Edited N files" row. Thinking is a collapsible. Output: LTR monospace block, 5 lines then "more" / "show full (N KB)". Full mode shows the rows inline (the Simple/Terminal difference is unchanged — no group wrapper in Full).
- **Diff card** (`DiffCard.jsx`, behaviour unchanged: path, new-file badge, +/−, 14-line preview, show more/collapse, "not applied", 400-line cap link, copy path, lazy highlight) — Linear look: file glyph, tinted rows from the status tokens, sans header.
- **Cards** — `openui/primitives.jsx` (`CardFrame`, `Btn`, `ReceiptLine`, `ErrorNote`…) is now neutral: hairline card, small status dot (amber + pulse while it waits for you, green/red for outcomes), buttons are `ui/Button` (ONE `primary` per card). This restyles Permission, Question, Action (card + sticky bar), Setup, Screen request, Screenshot, Artifact, Merge, Agent draft, Ext, Delegated/adopt/auto lines, OpenUI blocks. Permission stays exactly as today: Allow / Deny, Enter-y / Esc-n, closed / expired states — **no "Always allow", no "Undo" (D8)**.
- **Setup / connect cards** (`setup/*`, `EngineConnect`): neutral surface, status as a dot (`Pill`), the two engine cards are equal and neutral (no double accent), `BTN`/`BTN2` in `setup/shared.jsx` are `ui/Button` classes. Glyphs go through `ChatIcon.jsx` (FontAwesome constants resolve to lucide).
- **Composer** — rounded card: textarea · attach · `@` · `/` (capabilities) · pill · context chip … Stop (while working) · Queue (while working) · mic · Send. Send is the only accent fill in the chat and only when there is something to send. Attachment chips, quote preview, drop zone, queue panel (count pill, auto-play switch, drag reorder, ▶ now, ✕), slash / mention palettes all kept and restyled (`SlashCommands.jsx`).
- **Chat mode switch** (Simple | Terminal) — neutral segmented control.
- **Chat text size** — the scale is now relative to the 16px default (was 12px), so the default pref gives 15px prose.

## Not done / decisions
- Syntax highlighting: **kept the existing lowlight highlighter** (not swapped to Shiki).
- The message list is **not virtualised** (windowing as before).
- `setup/shared.jsx`, `Wizard.jsx` consumers: `BTN`, `BTN2`, `PILL`, `Pill` changed look globally (Settings → Connections, wizard, Setup page share them) — conflict-prone with the settings area's branch.
- `MicButton` default box restyled (the rail passes its own className and keeps its size).
- Shared files touched: `index.css` (`.term`, `.md`, shimmer, chat column), `openui/primitives.jsx`, `SessionView.jsx` (ChatFooter removed, `ChatModeToggle` classes), `MicButton.jsx`, `locales/{en,he}/chat.js` (+`chat.plan`).
- Tests: `redesign-chat-web.test.js` added; `setup-web.test.js` (xmlns is not a link), `bugs1-web`, `agents-ux2-web` retargeted.
