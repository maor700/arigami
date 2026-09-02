# מסך ההגדרות — ארכיטקטורת מידע (SET)

מסמך זה הוא האינוונטר של כל שדה/כרטיס שהיה במסך ההגדרות (וגם במסכים החופפים לו:
Integrations, Accounts, Setup → Connections) לפני הריסטרקצ'ר, ההחלטה לגבי כל אחד
(**keep / move / merge / REMOVE**), והמבנה החדש. ההחלטות מבוססות על grep אמיתי של מי
צורך את הערך — לא על ניחוש. מפתחות ה-prefs ב-localStorage וקונפיג השרת **לא** נמחקים:
רק ה-UI משתנה, כך ש-prefs ישנים ממשיכים לעבוד.

## 1. אינוונטר — מה היה, איפה, מי צורך, ומה הוחלט

### 1.1 `Settings.jsx` (1324 שורות, מסך אחד ארוך)

| # | שדה / כרטיס | היכן היה | מי צורך את הערך | החלטה |
|---|---|---|---|---|
| 1 | Theme (בהיר/כהה) | Appearance | `prefs.theme` → `applyTheme()` ב-`prefs.js` (data-theme על ה-root) | **keep** → מראה |
| 2 | Language (auto/en/he) | Appearance | `prefs.language` → `i18n.js currentLang()`, `applyBranding()` (dir/lang על ה-root) | **keep** → מראה |
| 3 | Accent color | Appearance | `prefs.accent` → `--color-brand` + favicon | **keep** → מראה |
| 4 | Logo chooser (crane/fold/plane/boat) | Appearance | `prefs.logo` → **רק** `logoDataUri()` ל-favicon (`prefs.js:178`). אין שום קומפוננטה שמציירת את הלוגו ב-UI | **REMOVE (UI בלבד)** — בורר של 4 אייקוני-טאב שאף אחד לא רואה בתוך האפליקציה. המפתח `logo` נשאר ב-prefs (favicon ממשיך לכבד ערך קיים) |
| 5 | Font size (A−/A+) | Terminal | `prefs.termFontSize` → `ChatPane.jsx:865` (scale של הצ'אט) | **keep** → מראה |
| 6 | Terminal theme (ברירת מחדל) | Terminal | `prefs.termTheme` → `termViewFrom()` → `ChatPane.jsx:866`, `TermControls.jsx:345` | **keep** → מראה (תת-קבוצה "ברירות מחדל לטרמינל"). זה כן נצרך — הוא הברירת-מחדל כשאין override לסשן |
| 7 | Text direction (auto/ltr/rtl) | Terminal | `prefs.termDir` → אותו מסלול כמו 6 | **keep** → מראה. אותו נימוק |
| 8 | Voice mode (hold/toggle) | Voice | `App.jsx:522` (`getPrefs().voiceMode`) | **keep** → קול |
| 9 | Microphone | Voice | `prefs.voiceMicId` → `lib/voice.js` | **keep** → קול |
| 10 | "Language" (של הקול) | Voice | `prefs.voiceLanguage` → STT hint ב-`lib/voice.js` | **keep + relabel** → קול. זה **לא** כפילות של #2 — זו שפת הזיהוי הקולי, אבל שתיהן נקראו `t('settings.language')`. עכשיו: "שפת זיהוי דיבור" |
| 11 | Voice hotkey (record) | Voice | `App.jsx:520` (`matchesHotkey`) | **keep** → קול |
| 12 | Auto-send | Voice | `prefs.voiceAutoSend` → `lib/voice.js` | **keep** → קול |
| 13 | `ConnectionsCard` (זהות Google + רשימת capabilities + audit) | אחרי Voice | `GET /setup/capabilities` | **merge** → חיבורים (מפוצל: זהות / Claude / אינטגרציות / ערוצים / גישה מרחוק / התראות + audit בתחתית) |
| 14 | Remote access (Tailscale, HTTPS serve, URLs) | אחרי Connections | `GET/POST /remote` | **move** → חיבורים › גישה מרחוק |
| 15 | Webhooks (SMS token/URL, Slack/GitHub secrets, custom HMAC, Funnel) | אחרי Remote | `/webhooks/*`, `/remote/funnel` | **move** → חיבורים › ערוצים |
| 16 | WhatsApp bridge (סטטוס/QR/connect/disconnect) | אחרי Webhooks | `/whatsapp/*` | **merge** → חיבורים › ערוצים. היה **כפול**: גם כאן (מחרוזות אנגלית קשיחות, ללא i18n) וגם כשורת capability `whatsapp` ב-ConnectionsCard עם `QrStep`. נשאר כרטיס אחד, על בסיס `QrStep` של ה-JIT setup |
| 17 | Screen share — סיסמת VNC | אחרי WhatsApp | `PUT /screen/settings` → `cfg.screen.vncPassword` → **עדיין נצרך**: `server/lib/desktops.ts:137,286` (x11vnc `-passwd` לכל desktop פר-סשן), `server/vnc.ts:120` (capture), `web/src/lib/useScreenConnection.js:96` (`credentialsrequired` → `/screen/credentials`) | **keep** → מארח. לא מיותר: בלי סיסמה x11vnc רץ `-nopw` |
| 18 | Push notifications | אחרי Screen | `lib/push.js` (subscription בדפדפן) | **move** → חיבורים › התראות |
| 19 | Brain heartbeat (toggle + every) | אחרי Push | `GET /brain`, `PUT /brain/heartbeat` | **move** → אוטומציה. **לא היה כפול**: ב-`BrainView.jsx` אין heartbeat בכלל (grep ריק). זה כבר single-source; הוספנו קישור מ-BrainView לכאן |
| 20 | Telemetry (toggle, preview, rotate id) | אחרי Heartbeat | `/telemetry*` | **move** → אוטומציה |
| 21 | Host (version/check, manager, restart idle/now, upgrade, log) | אחרי Telemetry | `/host/*`, `/version` | **keep** → מארח |
| 22 | Backup (export full/bundle, import, force, memory) | בתוך Host | `/host/export`, `/host/import` | **keep** → מארח |
| 23 | Users & access (you/sign-out, pairing code, users list, API tokens) | אחרון | `/auth/*` | **keep** → מארח › משתמשים וגישה |

### 1.2 `IntegrationsView.jsx` (מסך נפרד, מהתפריט)

| שדה | מי צורך | החלטה |
|---|---|---|
| התחברות ל-Composio (OAuth כשאין key) | `/composio/auth/start`, `/composio/auth/status` | **merge** → חיבורים › אינטגרציות (אותו מסך ריק "התחבר ל-Composio") |
| גריד toolkits + חיפוש + קטגוריות + Connected | `/composio/toolkits` | **merge** → חיבורים › אינטגרציות. הקטגוריות הפכו לצ'יפים (במקום sidebar נוסף בתוך sidebar) |
| Connect (פותח redirect בטאב חדש, refresh אחרי 3s) | `/composio/connect` | **merge + שדרוג**: לחיצה על "חבר" פותחת את `ConnectDialog` של ה-JIT setup עבור `composio:<slug>` — **אוטומטי** (סשן שמריץ connect-composio) כשיש זהות Google, **ידני** (`OAuthCodeStep` flow=redirect, עם polling אמיתי במקום timeout) אחרת |
| Disconnect | `/composio/connections` + DELETE | **merge** → `DELETE /setup/composio:<slug>` (אותה לוגיקה בשרת, כולל invalidation של ה-cache) |

### 1.3 `AccountsView.jsx` (מסך נפרד, מהתפריט)

| שדה | מי צורך | החלטה |
|---|---|---|
| כרטיסי חשבונות Claude (active/pool/usage/remove) | `/accounts/*`, `store.accounts`, `accountUsage` | **merge** → חיבורים › חשבונות Claude (התוכן זהה, בלי ה-page chrome) |
| הוספה: PKCE בדפדפן / הדבקת token | `/accounts/oauth/*`, `POST /accounts` | **merge** → שם. `#/accounts/add` + האירוע `host:open-accounts {add:true}` (מ-/mcp ומ-SessionView) עדיין פותחים ישר את טופס ההוספה |
| "חבר אוטומטית" (capability `claude` מ-ConnectionsCard) | `connectViaSession('claude')` | **merge** → כפתור "חבר אוטומטית" ליד "הוסף חשבון" כשיש זהות |

### 1.4 `Rail.jsx › ProfileMenu`

| פריט | החלטה |
|---|---|
| Accounts | **REMOVE** מהתפריט → `#/settings/connections/claude` |
| Integrations | **REMOVE** מהתפריט → `#/settings/connections/integrations` |
| Voice control (מתחיל הקלטה) | **REMOVE** מהתפריט — יש hotkey (מוגדר ב-הגדרות › קול), כפתור מיקרופון בסרגל העליון במובייל, ופקודת `/voice`. ההגדרות עצמן ב-הגדרות › קול |
| Skills / Brain / Setup / Settings | **keep** |

### 1.5 `Setup.jsx` ("עוד" ▸)

| פריט | החלטה |
|---|---|
| Section "Connections" (StepRow לכל צעד גלובלי: claude/git/…) | **REMOVE** מ-Setup — כפילות שלישית של אותו מידע. במקומו קישור "עוד חיבורים → הגדרות › חיבורים" |
| Repos + Profiles | **keep** ב-Setup (זה onboarding של workspace, לא הגדרות) |

### 1.6 מה נמחק מהקוד

- `web/src/components/IntegrationsView.jsx`, `AccountsView.jsx`, `setup/ConnectionsCard.jsx` — התוכן עבר ל-`web/src/components/settings/*`.
- ה-state `accountsOpen` / `integrationsOpen` / `accountsAddIntent` ב-`App.jsx`; ה-hashes הישנים ממופים (ראו §3).
- **לא נמחק**: אף מפתח ב-`prefs.js`, אף route בשרת, אף מחרוזת locale שעדיין בשימוש.

## 2. ה-IA החדש — `#/settings/<category>[/<section>]`

מסך אחד. ניווט קטגוריות: rail שמאלי בדסקטופ (≥768px), צ'יפים אופקיים גלילים במובייל.
כל קטגוריה היא קובץ ב-`web/src/components/settings/`, ≤300 שורות.

| קטגוריה | hash | קובץ | תוכן |
|---|---|---|---|
| **מראה** | `appearance` | `Appearance.jsx` | theme, language, accent, font size, ברירות-מחדל לטרמינל (theme/dir) |
| **קול** | `voice` | `Voice.jsx` | mode, mic, שפת זיהוי, hotkey (הקלטה), auto-send |
| **חיבורים** | `connections` | `Connections.jsx` + `ClaudeAccounts.jsx` + `NativeMcp.jsx` + `Integrations.jsx` + `Channels.jsx` + `ConnectDialog.jsx` | sections: `identity` · `claude` · `mcp` (M1 — כרטיסי השרתים של הספקים עצמם, מעל Composio) · `integrations` ("עוד דרך Composio" + git/desktop/repos כ-capabilities) · `channels` (WhatsApp, SMS webhook, Slack/GitHub, custom, Funnel) · `remote` · `notifications` · audit |
| **אוטומציה** | `automation` | `Automation.jsx` | Brain heartbeat, telemetry (+preview, rotate), קישור ל-cron ב-Launcher |
| **מארח** | `host` | `Host.jsx` + `Health.jsx` + `Access.jsx` | version/restart/upgrade, backup, **בריאות** (RES1 — מצב הבריאות של כל סשן, מכסות חשבונות/מודלים עם זמני איפוס, ואירועי 24 השעות האחרונות; section `health`), users & access (pairing/users/tokens), VNC password, danger zone (sign-out, איפוס העדפות מקומיות) |

## 3. תאימות לאחור (deep links)

| ישן | חדש |
|---|---|
| `#/settings` | `#/settings/appearance` |
| `#/accounts` | `#/settings/connections/claude` |
| `#/accounts/add` | `#/settings/connections/claude` + טופס ההוספה פתוח |
| `#/integrations` | `#/settings/connections/integrations` |
| אירוע `host:open-accounts` | פותח הגדרות › חיבורים › Claude (עם `add` אם נשלח) |
| פעולת קול `open_settings` | `#/settings/appearance` |
| Palette "Open Accounts" | הגדרות › חיבורים › Claude |

## 4. קומפוננטות משותפות (`settings/shared.jsx`)

- `SettingsSection` — כותרת סקשן (mono uppercase) + `id` לגלילה/עוגן + כפתור רענון אופציונלי.
- `SettingCard` — הקופסה האחידה (border-hair, rounded-xl, bg-panel) עם כותרת, `StatusPill`, ו-actions.
- `StatusPill` — `ok / todo / pending / error / running / off` — צבעים אחידים עם `setup/shared.jsx PILL`.
- `Field`, `Toggle`, `Segmented`, `CopyRow`, `BTN`, `hostPost` — הועברו מ-Settings.jsx.

## 5. סיכון / דברים שהבעלים יכול לבטל (veto)

1. **הסרת בורר הלוגו** (#4) — הערך משפיע רק על ה-favicon; אם רוצים אותו בחזרה זה 15 שורות ב-`Appearance.jsx` (הקומפוננטה `LogoMark` נשמרה שם, מוסתרת).
2. **הסרת "Voice control" מהתפריט** — אם יש מי שמסתמך על זה במובייל בלי hotkey, אפשר להחזיר פריט אחד.
3. **הסרת Section "Connections" מ-Setup** — Setup נשאר hero מינימלי + repos/profiles, וקישור להגדרות.

## 6. AUDIT2 (2026-09-02) — 3 עמודים + מגירת "מתקדם"

ביקורת `AUDIT-ARIGAMI-SETTINGS.md` מצאה 274 פריטים גלויים כברירת מחדל על 5 עמודים (200 מהם כרטיסי
Composio). הריסטרקצ'ר השני **לא מחק כלום מהקוד ומהשרת** — כל פריט שסווג ADV/MOVE עבר למגירת
`<details>` מקופלת בתחתית העמוד (`settings/shared.jsx › Advanced`), ופריטי REMOVE הוסתרו מה-UI
בלבד (ה-routes שלהם נשארו).

| עמוד | hash | על המסך | במגירה |
|---|---|---|---|
| **כללי** (`Appearance.jsx`) | `appearance` (גם `voice`, `automation` הישנים מגיעים לכאן) | ערכת נושא · שפה · גודל גופן · [קול: קיצור + מצב — רק כש-`GET /config` מחזיר `voiceEnabled:true`] | צבע הדגשה · ערכת/כיוון טרמינל · קול (מיקרופון/שפת זיהוי/שליחה אוטומטית; וגם קיצור+מצב כשהקול כבוי) · heartbeat של המוח · toggle טלמטריה |
| **חיבורים** (`Connections.jsx`) | `connections` | זהות Google · חשבונות Claude · רשימת **מחוברים** אחת (MCP ישיר + Composio + גשר WhatsApp + Tailscale, המסלול ב-hover) · **הוסף חיבור** (`AddConnection.jsx` — בורר עם חיפוש: קטלוג MCP + `FEATURED` של Composio, הקלדה מחפשת בכל הקטלוג) · התראות פוש | "שייך ל" (A2) · הסבר פעיל/pool · webhooks (admin) · HTTPS serve · סטטוס git/desktop/repo · יומן חיבורים |
| **מארח** (`Host.jsx`) | `host` | גרסה+עדכון · Claude CLI (מותקן/עדכן) · הפעל מחדש · שדרג · ייצוא/ייבוא (3 כפתורים) · מחובר/ת בתור · צימוד מכשיר | פרטי CLI (נבדק/עדכון אחרון/auto) · מנהל תהליך · יומן שדרוג · אפשרויות ייצוא/ייבוא · תקציבים · בריאות (אירועי `notify-human` מסוננים כברירת מחדל, 20 אחרונים) · משתמשים וטוקנים · סיסמת VNC · איפוס העדפות |

- **התנתקות** עברה לתפריט הפרופיל בסרגל (`Rail.jsx › ProfileMenu`) — הפריט היחיד ל-logout.
- `#/settings/connections/mcp` ו-`/integrations` (המשגר, סימניות) פותחים את הבורר "הוסף חיבור".
- deep-link לסקשן שבמגירה (`#/settings/host/health`, `#/settings/automation/heartbeat`) פותח אותה.
- `NativeMcp.jsx`, `Integrations.jsx` (הגריד), `Automation.jsx` ו-`Voice.jsx` נשארו בריפו כקומפוננטות/חלקים — לא בשימוש כעמודים.
- טלמטריה: ה-endpoint לא קיים ב-DNS; `server/telemetry.ts` מפסיק לצבור תור מול יעד לא-נגיש (ראו `docs/TELEMETRY.md`). ב-UI נשאר רק ה-toggle.
