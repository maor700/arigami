# Redesign branch — change log

Branch `redesign/…`. This file lists what changed against `master`. Rule of the branch: **no feature disappears**. Every control that exists on `master` is still reachable; a control that moves is listed here as "moved: X from A to B".

## Phase 1 — foundation

### Moved
- *(nothing)* — Phase 1 changes look and primitives only; no control changed place.

### Removed
- *(nothing)*

### Added (infrastructure, not product features)
- `web/src/components/ui/` — the shadcn/ui kit on Radix (Button, DropdownMenu, ContextMenu, Popover, Tooltip + `Tip`, Dialog, AlertDialog, Sheet, Tabs, Collapsible, Command, ScrollArea, Select, Switch, Checkbox, Input/Textarea, Label, Badge + StatusDot, Separator, Skeleton, Kbd, Toast view, Direction provider).
- `web/src/lib/utils.js` (`cn`), `web/components.json`, `web/jsconfig.json`, Vite alias `@` → `src/`.
- `UiProvider` at the app root (Radix direction fed from the language preference + tooltip provider).
- Living style guide at `#/styleguide` (not linked from the product UI).
- Self-hosted Inter (Latin) next to Rubik (Latin + Hebrew).
- Dependencies: `radix-ui`, `cmdk`, `class-variance-authority`, `clsx`, `tailwind-merge`, `lucide-react`, `tw-animate-css`, `@fontsource-variable/inter`.

### Restyled globally through tokens (no call site changed)
- `index.css` token layer rewritten: neutral oklch ramps (light + dark), shadcn semantic tokens as aliases of the existing `--hb-*`, type scale 11/12/13/14/16/20, radii 4/6/8/12, elevation, motion. Every existing token name still works.
- Chat pane palette (`--term-*`) is neutral; the "you" bubble and the question/permission/action cards no longer use mint fills.
- Legacy-look neutralisers (unlayered, attribute-based): `border-2` / `border-[1.5px]` → 1px hairline; `border-ink` → hairline; hard offset shadows → none / hairline card / soft overlay; `font-mono` on chrome → sans (mono stays on `whitespace-pre*`, diffs, `code`/`pre`); `font-bold` → 600; 8–10.5px text classes → 11px floor; accent chips (`bg-chip`) → neutral; the waiting pulse is amber.
- Segmented "selected" fills that were solid ink (`bg-ink`) are a pressed neutral.
- Reduced-motion support; global 2px focus ring in the accent colour.

### Migrated primitives (behaviour unchanged)
- `ui.jsx` `YellowButton` → `ui/Button variant="primary"`; `GhostButton` → `variant="outline"` (same props); `Dot` border is a hairline.
- `Toaster` → `ui/toast.jsx` (same store `lib/toast.js`, same API, same bottom-left stack, auto-dismiss, action, manual dismiss).
- `ConfirmHost` → Radix `AlertDialog` (Enter confirms with the confirm button focused, Esc cancels, focus trap + restore).
- `Dialogs.jsx` `Overlay` backdrop restyled (still portaled, Esc/backdrop close).

### Left for Phase 2 (not touched)
Rail, session header, tab bar, chat cards and composer, Changes tab, launcher, settings, wizard/setup, the hand-rolled menus in Rail/AgentView/TermControls, other hand-written dialogs, `title=` tooltips, remaining mint fills (`bg-brand` is used ~85 times for selected segments and toggles).
