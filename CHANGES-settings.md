# Phase 2 — settings area (settings, onboarding, agents, brain, skills, dialogs)

## Moved
- *(nothing)* — every control stays where it was; Settings keeps its four categories (left list on desktop, tab row on phone) and the Advanced drawer.

## Removed
- *(nothing)*

## Added
- `AddConnectionPanel` export in `settings/AddConnection.jsx` (the panel body, testable without a portal).
- `aria-pressed` on wizard profile cards; `Tip` tooltips on icon-only controls.

## Changed
- Shared: `settings/shared.jsx` and `setup/shared.jsx` (BTN/INPUT constants are neutral ui-kit class strings; `Toggle` = ui `Switch`; `Segmented` neutral radio group; `StatusPill`/`Pill` = `Badge` with status dot; quiet section headings; hairline Advanced drawer).
- `ui/tooltip.jsx` (shared, minimal): `Tip` wraps itself in a `TooltipProvider` so it renders without `UiProvider` (SSR tests).
- Dialogs (`Dialogs.jsx` Overlay + six dialogs, ContextModal, BgProcesses, ScreenModal, ConnectDialog, AddConnection, Extensions install, ShortcutsHelp, AgentView delete) are ui `Dialog`; AgentView ⋯ menu and mobile tab switcher are `DropdownMenu`, details drawer a `Popover`; RepoPicker list is a `Popover`.
- Brain/Skills mode switches are `Tabs` (segmented); routines enable is a `Switch`.
- Accent now only on each view's primary button (+ logo bars in the wizard header).
- Native `<select>` kept where tests inspect options (Connections owner, AgentView model/kind/share days, language/mic selects), restyled with the INPUT class.
- Tests adjusted (behaviour unchanged): agent-page ⋯ menu, settings-audit2 Connections, f8, mcp-native, theme-tokens hero.
