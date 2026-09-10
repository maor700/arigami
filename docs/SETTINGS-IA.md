# Settings screen — information architecture (SET)

This document is the inventory of every field/card that existed in the Settings screen (and in the
overlapping screens: Integrations, Accounts, Setup → Connections) before the restructure, the decision
for each one (**keep / move / merge / REMOVE**), and the new structure. The decisions are based on real
grep of who consumes the value — not on guessing. The `prefs` keys in localStorage and the server config
are **not** deleted: only the UI changes, so old prefs keep working.

## 1. Inventory — what existed, where, who consumes it, and what was decided

### 1.1 `Settings.jsx` (1324 lines, one long screen)

| # | Field / card | Where it was | Who consumes the value | Decision |
|---|---|---|---|---|
| 1 | Theme (light/dark) | Appearance | `prefs.theme` → `applyTheme()` in `prefs.js` (data-theme on the root) | **keep** → מראה (Appearance) |
| 2 | Language (auto/en/he) | Appearance | `prefs.language` → `i18n.js currentLang()`, `applyBranding()` (dir/lang on the root) | **keep** → מראה |
| 3 | Accent color | Appearance | `prefs.accent` → `--color-brand` + favicon | **keep** → מראה |
| 4 | Logo chooser (crane/fold/plane/boat) | Appearance | `prefs.logo` → **only** `logoDataUri()` for the favicon (`prefs.js:178`). No component renders the logo in the UI | **REMOVE (UI only)** — a picker of 4 tab icons that no one sees inside the app. The `logo` key stays in prefs (the favicon keeps honoring an existing value) |
| 5 | Font size (A−/A+) | Terminal | `prefs.termFontSize` → `ChatPane.jsx:865` (the chat's scale) | **keep** → מראה |
| 6 | Terminal theme (default) | Terminal | `prefs.termTheme` → `termViewFrom()` → `ChatPane.jsx:866`, `TermControls.jsx:345` | **keep** → מראה (sub-group "ברירות מחדל לטרמינל" / "Terminal defaults"). This one really is consumed — it's the default when a session has no override |
| 7 | Text direction (auto/ltr/rtl) | Terminal | `prefs.termDir` → same path as 6 | **keep** → מראה. Same reasoning |
| 8 | Voice mode (hold/toggle) | Voice | `App.jsx:522` (`getPrefs().voiceMode`) | **keep** → קול (Voice) |
| 9 | Microphone | Voice | `prefs.voiceMicId` → `lib/voice.js` | **keep** → קול |
| 10 | "Language" (for voice) | Voice | `prefs.voiceLanguage` → STT hint in `lib/voice.js` | **keep + relabel** → קול. This is **not** a duplicate of #2 — it's the speech-recognition language, but both were labeled `t('settings.language')`. Now: "שפת זיהוי דיבור" (speech recognition language) |
| 11 | Voice hotkey (record) | Voice | `App.jsx:520` (`matchesHotkey`) | **keep** → קול |
| 12 | Auto-send | Voice | `prefs.voiceAutoSend` → `lib/voice.js` | **keep** → קול |
| 13 | `ConnectionsCard` (Google identity + capability list + audit) | after Voice | `GET /setup/capabilities` | **merge** → חיבורים (Connections; split into: identity / Claude / אינטגרציות (integrations) / ערוצים (channels) / גישה מרחוק (remote access) / התראות (notifications) + audit at the bottom) |
| 14 | Remote access (Tailscale, HTTPS serve, URLs) | after Connections | `GET/POST /remote` | **move** → חיבורים › גישה מרחוק |
| 15 | Webhooks (SMS token/URL, Slack/GitHub secrets, custom HMAC, Funnel) | after Remote | `/webhooks/*`, `/remote/funnel` | **move** → חיבורים › ערוצים |
| 16 | WhatsApp bridge (status/QR/connect/disconnect) | after Webhooks | `/whatsapp/*` | **merge** → חיבורים › ערוצים. It was **duplicated**: both here (hardcoded English strings, no i18n) and as a `whatsapp` capability row in ConnectionsCard with `QrStep`. Only one card remains, built on the JIT setup's `QrStep` |
| 17 | Screen share — VNC password | after WhatsApp | `PUT /screen/settings` → `cfg.screen.vncPassword` → **still consumed**: `server/lib/desktops.ts:137,286` (x11vnc `-passwd` for every per-session desktop), `server/vnc.ts:120` (capture), `web/src/lib/useScreenConnection.js:96` (`credentialsrequired` → `/screen/credentials`) | **keep** → מארח (Host). Not redundant: without a password x11vnc runs `-nopw` |
| 18 | Push notifications | after Screen | `lib/push.js` (browser subscription) | **move** → חיבורים › התראות |
| 19 | Brain heartbeat (toggle + every) | after Push | `GET /brain`, `PUT /brain/heartbeat` | **move** → אוטומציה (Automation). **Not** a duplicate: `BrainView.jsx` has no heartbeat at all (empty grep). It was already single-source; we added a link from BrainView to here |
| 20 | Telemetry (toggle, preview, rotate id) | after Heartbeat | `/telemetry*` | **move** → אוטומציה |
| 21 | Host (version/check, manager, restart idle/now, upgrade, log) | after Telemetry | `/host/*`, `/version` | **keep** → מארח |
| 22 | Backup (export full/bundle, import, force, memory) | inside Host | `/host/export`, `/host/import` | **keep** → מארח |
| 23 | Users & access (you/sign-out, pairing code, users list, API tokens) | last | `/auth/*` | **keep** → מארח › משתמשים וגישה (Users & access) |

### 1.2 `IntegrationsView.jsx` (separate screen, from the menu)

| Field | Who consumes it | Decision |
|---|---|---|
| Connecting to Composio (OAuth when there's no key) | `/composio/auth/start`, `/composio/auth/status` | **merge** → חיבורים › אינטגרציות (same empty-state screen "התחבר ל-Composio" (Connect to Composio)) |
| toolkits grid + search + categories + Connected | `/composio/toolkits` | **merge** → חיבורים › אינטגרציות. The categories became chips (instead of a nested sidebar inside a sidebar) |
| Connect (opens a redirect in a new tab, refresh after 3s) | `/composio/connect` | **merge + upgrade**: clicking "חבר" ("Connect") opens the JIT setup's `ConnectDialog` for `composio:<slug>` — **automatic** (a session running connect-composio) when a Google identity exists, **manual** (`OAuthCodeStep` flow=redirect, with real polling instead of a timeout) otherwise |
| Disconnect | `/composio/connections` + DELETE | **merge** → `DELETE /setup/composio:<slug>` (the same server-side logic, including cache invalidation) |

### 1.3 `AccountsView.jsx` (separate screen, from the menu)

| Field | Who consumes it | Decision |
|---|---|---|
| Claude account cards (active/pool/usage/remove) | `/accounts/*`, `store.accounts`, `accountUsage` | **merge** → חיבורים › חשבונות Claude (Claude accounts) (identical content, without the page chrome) |
| Adding: browser PKCE / pasted token | `/accounts/oauth/*`, `POST /accounts` | **merge** → same place. `#/accounts/add` + the `host:open-accounts {add:true}` event (from /mcp and SessionView) still open the add form directly |
| "חבר אוטומטית" ("Connect automatically", the `claude` capability from ConnectionsCard) | `connectViaSession('claude')` | **merge** → a "חבר אוטומטית" button next to "הוסף חשבון" ("Add account") when there's an identity |

### 1.4 `Rail.jsx › ProfileMenu`

| Item | Decision |
|---|---|
| Accounts | **REMOVE** from the menu → `#/settings/connections/claude` |
| Integrations | **REMOVE** from the menu → `#/settings/connections/integrations` |
| Voice control (starts a recording) | **REMOVE** from the menu — there's a hotkey (configured under Settings › קול), a microphone button in the top bar on mobile, and a `/voice` command. The settings themselves live under Settings › קול |
| Skills / Brain / Setup / Settings | **keep** |

### 1.5 `Setup.jsx` ("עוד" (More) ▸)

| Item | Decision |
|---|---|
| Section "Connections" (a StepRow per global step: claude/git/…) | **REMOVE** from Setup — a third duplicate of the same information. Replaced with a link "עוד חיבורים → הגדרות › חיבורים" ("More connections → Settings › Connections") |
| Repos + Profiles | **keep** in Setup (this is workspace onboarding, not settings) |

### 1.6 What was deleted from the code

- `web/src/components/IntegrationsView.jsx`, `AccountsView.jsx`, `setup/ConnectionsCard.jsx` — the content moved to `web/src/components/settings/*`.
- The state `accountsOpen` / `integrationsOpen` / `accountsAddIntent` in `App.jsx`; the old hashes are mapped (see §3).
- **Not deleted**: any key in `prefs.js`, any server route, any locale string still in use.

## 2. The new IA — `#/settings/<category>[/<section>]`

One screen. Category navigation: a left rail on desktop (≥768px), horizontal scrolling chips on mobile.
Each category is a file in `web/src/components/settings/`, ≤300 lines.

| Category | hash | file | content |
|---|---|---|---|
| **מראה** (Appearance) | `appearance` | `Appearance.jsx` | theme, language, accent, font size, terminal defaults (theme/dir) |
| **קול** (Voice) | `voice` | `Voice.jsx` | mode, mic, recognition language, hotkey (recording), auto-send |
| **חיבורים** (Connections) | `connections` | `Connections.jsx` + `ClaudeAccounts.jsx` + `NativeMcp.jsx` + `Integrations.jsx` + `Channels.jsx` + `ConnectDialog.jsx` | sections: `identity` · `claude` · `mcp` (M1 — cards for the providers' own servers, above Composio) · `integrations` ("עוד דרך Composio" ("More via Composio") + git/desktop/repos as capabilities) · `channels` (WhatsApp, SMS webhook, Slack/GitHub, custom, Funnel) · `remote` · `notifications` · audit |
| **אוטומציה** (Automation) | `automation` | `Automation.jsx` | Brain heartbeat, telemetry (+preview, rotate), link to cron in the Launcher |
| **מארח** (Host) | `host` | `Host.jsx` + `Health.jsx` + `Access.jsx` | version/restart/upgrade, backup, **בריאות** (Health; RES1 — the health state of every session, account/model quotas with reset times, and the last 24 hours of events; section `health`), users & access (pairing/users/tokens), VNC password, danger zone (sign-out, reset local preferences) |

## 3. Backward compatibility (deep links)

| Old | New |
|---|---|
| `#/settings` | `#/settings/appearance` |
| `#/accounts` | `#/settings/connections/claude` |
| `#/accounts/add` | `#/settings/connections/claude` + the add form open |
| `#/integrations` | `#/settings/connections/integrations` |
| event `host:open-accounts` | opens Settings › חיבורים › Claude (with `add` if it was sent) |
| voice action `open_settings` | `#/settings/appearance` |
| Palette "Open Accounts" | Settings › חיבורים › Claude |

## 4. Shared components (`settings/shared.jsx`)

- `SettingsSection` — section heading (mono uppercase) + `id` for scroll/anchor + an optional refresh button.
- `SettingCard` — the uniform box (border-hair, rounded-xl, bg-panel) with a title, `StatusPill`, and actions.
- `StatusPill` — `ok / todo / pending / error / running / off` — colors shared with `setup/shared.jsx PILL`.
- `Field`, `Toggle`, `Segmented`, `CopyRow`, `BTN`, `hostPost` — moved over from Settings.jsx.

## 5. Risk / things the owner can veto

1. **Removing the logo picker** (#4) — the value only affects the favicon; if it's wanted back it's 15 lines in `Appearance.jsx` (the `LogoMark` component was kept there, hidden).
2. **Removing "Voice control" from the menu** — if someone relies on it on mobile without a hotkey, one item can be brought back.
3. **Removing the "Connections" section from Setup** — Setup remains a minimal hero + repos/profiles, plus a link to settings.

## 6. AUDIT2 (2026-09-02) — 3 pages + an "מתקדם" ("Advanced") drawer

The `AUDIT-ARIGAMI-SETTINGS.md` audit found 274 items visible by default across 5 pages (200 of them
Composio cards). The second restructure **deleted nothing from the code or the server** — every item
classified ADV/MOVE moved into a collapsed `<details>` drawer at the bottom of the page
(`settings/shared.jsx › Advanced`), and REMOVE items were hidden from the UI
only (their routes remained).

| Page | hash | on screen | in the drawer |
|---|---|---|---|
| **כללי** (General) (`Appearance.jsx`) | `appearance` (the old `voice`, `automation` also land here) | theme · language · font size · [voice: hotkey + mode — only when `GET /config` returns `voiceEnabled:true`] | accent color · terminal theme/direction · voice (microphone/recognition language/auto-send; plus hotkey+mode when voice is off) · brain heartbeat · telemetry toggle |
| **חיבורים** (`Connections.jsx`) | `connections` | Google identity · Claude accounts · one **מחוברים** ("Connected") list (direct MCP + Composio + WhatsApp bridge + Tailscale, the route shown on hover) · **הוסף חיבור** ("Add connection") (`AddConnection.jsx` — a picker with search: MCP catalog + Composio `FEATURED`, typing searches the whole catalog) · push notifications | "שייך ל" ("Belongs to", A2) · active/pool explanation · webhooks (admin) · HTTPS serve · git/desktop/repo status · connections log |
| **מארח** (`Host.jsx`) | `host` | version+update · Claude CLI (installed/update) · restart · upgrade · export/import (3 buttons) · signed in as · device pairing | CLI details (checked/last update/auto) · process manager · upgrade log · export/import options · budgets · בריאות (health; `notify-human` events, filtered by default, last 20) · users and tokens · VNC password · reset preferences |

- **Sign-out** moved to the profile menu in the rail (`Rail.jsx › ProfileMenu`) — the only place left to log out.
- `#/settings/connections/mcp` and `/integrations` (from the launcher, bookmarks) open the "הוסף חיבור" picker.
- A deep link to a section inside the drawer (`#/settings/host/health`, `#/settings/automation/heartbeat`) opens it.
- `NativeMcp.jsx`, `Integrations.jsx` (the grid), `Automation.jsx`, and `Voice.jsx` remain in the repo as components/pieces — not used as pages.
- Telemetry: the endpoint doesn't exist in DNS; `server/telemetry.ts` stops accumulating a queue against an unreachable target (see `docs/TELEMETRY.md`). Only the toggle remains in the UI.
