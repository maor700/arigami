# מנועי-סוכן (engines)

**מנוע** הוא ה-CLI שמריץ בפועל את התור של הסשן. עד עכשיו היה אחד — `claude`.
היום יש שניים: `claude` ו-`codex` (ה-CLI של OpenAI). הבחירה נעשית פעם אחת,
ביצירת הסשן, ונשמרת ב-`session.engine`.

- התפר: `server/lib/engine-driver.ts` (`EngineDriver`, `registerEngine`, `pickEngine`)
- המימושים: `server/claude.js` ו-`server/codex.ts`
- צד-הקוקפיט: `web/src/lib/engines.js`
- בדיקות: `test/codex-engine.test.ts`, `test/engine-ui-wiring.test.js`, `test/engine-ui-web.test.js`

## איך בוחרים

בלאנצ'ר, בורר המנוע הוא ה-select הראשון מארבעה, כי הוא קובע את התוכן של שניים
מהאחרים: רשימת המודלים ורמות המאמץ הן פר-מנוע ולא אוצר-מילים משותף.

- **claude** — רשימת המודלים נמשכת מה-CLI (`server/models.js`), וסולם המאמץ
  אחיד לכל מודל (`--effort`, low…max).
- **codex** — הרשימה סטטית ב-`web/src/lib/engines.js` (הועתקה מ-
  `$CODEX_HOME/models_cache.json`, codex-cli 0.153.4). המאמץ אינו דגל אלא מפתח
  קונפיג `model_reasoning_effort`, והסולם הוא תכונה של **המודל**:
  gpt-5.6-terra מוסיף `ultra` מעל `max`, ו-gpt-5.5 עוצר ב-`xhigh`.

המנוע **אינו עובר בירושה לילדים**: `create_session` מקבל `engine` מפורש, וסשן
שנולד מסשן codex ייוולד על claude אם לא נאמר אחרת. בחירת מנוע לא מתפשטת בעץ
מתחת לרדאר.

מנוע שאין לו דרייבר רשום נכשל ברעש ב-spawn, ולא נופל חזרה בשקט ל-claude.

## מה עובד ב-Codex

אומת חי, לא בתיאוריה: הסשן עולה בקוקפיט, מקבל הודעה, קורא לכלי-בית של אריגמי
דרך MCP (`set_status`, `publish_artifact` נמדדו), ו-`codex exec resume` זוכר
תורים קודמים. המיומנויות (skills) עוברות verbatim דרך symlink —
`$CODEX_HOME/skills/arigami` → `SKILLS_DIR` — וה-namespace יוצא `arigami:<name>`,
בדיוק השם שה-persona כבר מבטיחה. 13 המיומנויות נטענות בלי אזהרות frontmatter.

לוג-הצ'אט, ה-bus, הפרסונות, אתחול-הזיכרון, מצב "פשוט", ה-worktrees והקוקפיט —
כולם אגנוסטיים למנוע ולא נגעו.

שני הבדלים מבניים שכדאי להכיר לפני דיבוג:

1. **תהליך אחד לכל תור.** `codex exec` אינו שיחה ארוכת-חיים על stdin/stdout.
   הוא קורא prompt אחד, מריץ תור, ויוצא 0. התור הבא הוא
   `codex exec resume <thread_id>` חדש מול אותו `$CODEX_HOME`. משמעות מעשית:
   stdin ב-EOF לאורך כל התור.
2. **מזהה השיחה נצפה, לא מוקצה.** ל-codex אין `--session-id`; הוא ממציא מזהה
   ומכריז עליו ב-`thread.started`.

## המגבלות — מה שלא עובד, במפורש

הרשימה הזו היא הסיבה שהמסמך קיים. אל תרככו אותה.

### 1. אין sandbox מקומי

ה-bubblewrap המובנה של Codex **לא עולה על המכונה הזו** —
`bwrap: loopback: Failed RTM_NEWADDR`. לכן התהליך רץ תמיד עם
`--dangerously-bypass-approvals-and-sandbox`, לא כאופציה אלא ככפייה בקוד.
הבידוד היחיד שנשאר הוא ה-worktree של הסשן.

לקלוד יש הפרדה שאין כאן: מצבי הרשאה, PreToolUse hook, `--disallowedTools`.
סשן codex הוא, מבחינת הרשאות, המקבילה של `bypassPermissions` — תמיד.

### 2. אין גשר-אישורים חי

ל-`codex exec` אין מקבילה ל-`--permission-prompt-tool`. לכן
`permissions.kind === 'none'`: אין כרטיס אישור בצ'אט, ואף פעולה לא נעצרת
לשאול. אישור אמיתי קיים רק במסלול `app-server` של Codex — **שלא מומש כאן**.

### 3. סוכנים עם allowlist מסורבים

`codexPrepare()` **זורק** אם הסוכן של הסשן מחזיק allowlist של כלים/דומיינים:

> `agent "<slug>" has a tool/domain allowlist, and the codex engine cannot enforce it`

זו החלטה מכוונת. אכיפת A3 בנויה על PreToolUse hook שאין ל-codex, ולהריץ סוכן
כזה בכל זאת אומר שהפרסונה מבטיחה אכיפה שלא קיימת. כישלון רועש ב-spawn עדיף.
מריצים סוכן כזה על claude.

### 4. מענקי MCP מרוחקים מדולגים

ל-Codex מאגר-אישורים (OAuth) משלו תחת `$CODEX_HOME`. מענק שאריגמי הנפיקה עבור
claude פשוט לא שמיש שם, ולכן שרתי MCP מסוג `url` **מדולגים** בבניית ה-config.
שרת מרוחק שתרצו בסשן codex ידרוש OAuth נפרד, משלו.

### 5. סולם המודלים לא רץ; הכיווץ **נבדק בפועל ונמצא בלתי-ישים** מ-`exec`

RES1 (ירידה למודל חלש כשהמכסה נגמרת ועלייה בחזרה) הוא claude-shaped ו**אינו
רץ** על סשן codex — ללא שינוי.

LADDER1 (כיווץ ההקשר לפני replay) **נבדק, לא רק הונח שהוא לא רץ.** לבינארי יש
שני מפתחות קונפיג אמיתיים — `model_auto_compact_token_limit` (סף בטוקנים)
ו-`model_auto_compact_token_limit_scope` (`total` | `body_after_prefix`) —
שנראים כמו המימוש המובנה שחסר כאן. הרצתי חמישה תורים אמיתיים על אותו thread עם
`-c model_auto_compact_token_limit=3000` (שני ערכי ה-scope, בנפרד), וגם עם
`--enable context_management` (הדגל שחוסם את המפתחות האלה — הן "under
development" ברשימת `codex features list`) — עד שההקשר גדל ל-41,474 טוקנים,
**פי ~14 מהסף שהוגדר, ואף כיווץ לא קרה**: אין אירוע `context_compaction` או
`compaction_trigger` בזרם, ו-`cached_input_tokens` רק גדל בין תור לתור, אף פעם
לא קטן.

הסבר סביר (לא רק ניחוש): הקריאה שבאמת **מפעילה** כיווץ —
`thread/compact/start` — קיימת רק בפרוטוקול ה-app-server (JSON-RPC), לא
ב-`exec` (מגבלה 2 למעלה). מי שקורא לה כנראה הלקוח האינטראקטיבי (ה-TUI), שרץ
כתהליך אחד ארוך-חיים וצופה בשימוש בין תורים. `codex exec` הוא **תהליך אחד לכל
תור**; אין תהליך חי בין תורים שיכול "לצפות" בכלום, אז גם אם ה-watcher קיים
בליבה, דפוס ההרצה שאריגמי משתמשת בו לא יכול להפעיל אותו.

**המסקנה: הכיווץ לא סגיר דרך `exec` בלי לממש app-server. סשן codex שנתקע
במכסת-הקשר נתקע — אין רשת, בדיוק כמו שנכתב כאן קודם.** מי שרוצה לנסות שוב:
אל תסתפקו בהוספת המפתח ל-config.toml ותחשבו שסיימתם — זה בדיוק מה שנוסה כאן.

### 6. `item.type === 'reasoning'` לא נצפה מעולם — גם עם מאמץ מלא

הטיפול בו קיים ב-`handleEvent`, אבל **באף הרצה אמיתית הוא לא הופיע**, כולל
הרצה ייעודית עם `gpt-5.6-terra`, `model_reasoning_effort="high"` ו-
`model_reasoning_summary="detailed"` (הפיקסצ'ר:
`test/fixtures/codex-stream/reasoning-test-*.jsonl`). ה-`usage` שחזר מאותה
הרצה כן דיווח `reasoning_output_tokens: 73` — המודל **כן** חושב — הפריט פשוט
לא נפלט על זרם ה-`exec --json`, גם עם כל הדגלים שאמורים להבליט אותו. הטיפול
ב-`handleEvent` נשאר כתוב הגנתית ולא מוכח. אם מישהו ירצה לנסות שוב: זה נבדק
ולא עבד, אז כדאי לחפש במשטח ה-app-server (שם יש `item/reasoning/textDelta`
בפרוטוקול) לפני שמנסים שוב על `exec`.

### 6ב. זיהוי מכסה (rate limit) — הגנתי, **לא אומת**

ל-Codex יש סוג מתועד `RateLimitReachedType` (`rate_limit_reached`,
`workspace_owner_credits_depleted`, `workspace_member_credits_depleted`,
`workspace_owner_usage_limit_reached`, `workspace_member_usage_limit_reached`)
— אבל הוא שדה מובנה בהתראת `account/rateLimits/updated` של פרוטוקול
ה-app-server, לא של `exec`. לא ניסיתי לשחזר מכסה אמיתית: זה דורש לצרוך בפועל
את כל המכסה של חשבון חי, ואין לזה הצדקה רק כדי לתעד הודעת שגיאה. **הזיהוי
ב-`handleEvent` (`rateLimitNote()` ב-`server/codex.ts`) הוא ניחוש מסומן ככזה
בקוד** — ביטוי רגולרי על הטקסט של `turn.failed`/`error` (התבנית `unexpected
status <קוד> ...` כן אומתה חי על 401, `error-noauth` fixture; ההשערה שקוד 429
עוטף באותה צורה, ושמות ה-enum אולי מוטבעים כמילים בגוף השגיאה, לא אומתו).
כשמתקבלת שגיאה שנראית כמו מכסה, האדם מקבל הודעת מערכת נוספת שמסבירה זאת
ומציינת במפורש שהזיהוי לא אומת — לא רק שגיאה גנרית, אבל גם לא מצג-שווא של
ודאות.

### 7. הסשן יורש את env המארח במלואו

תהליך ה-codex מקבל את `process.env` של המארח כולו (פרט ל-
`CLAUDE_CODE_OAUTH_TOKEN` ו-`ANTHROPIC_API_KEY`, שנמחקים במפורש), ובכלל זה
`ARIGAMI_TOKEN` — טוקן חי שמדבר עם ה-host האמיתי.

**זו פאריטי עם קלוד ולא רגרסיה.** גם סשן claude עובד בדיוק ככה. נכתב כאן
במפורש כי בהיעדר sandbox (מגבלה 1) ובהיעדר גשר-אישורים (מגבלה 2), זה מה שסשן
codex יכול להגיע אליו בלי שאף אחד יעצור אותו.

### 8. `~/.codex/skills/.system/` נמחקת בכל שדרוג

זו החבילה של Codex עצמו — היא נמחקת ונכתבת מחדש בכל שדרוג של ה-CLI. **שום דבר
שלנו לא ישב שם, לעולם.** אנחנו גם לא מקשרים אותה פנימה: לסשני אריגמי אין שימוש
ב-imagegen/skill-creator, וההשמטה חוסכת מקום בתקציב-ההקשר של המיומנויות.

### 9. `tool_timeout_sec = 1800`

Codex מוותר על קריאת כלי MCP אחרי `tool_timeout_sec` ומדווח עליה ככישלון.
כלי-הבית החוסמים של אריגמי (`request_screen`, `permission_prompt`) ממתינים
ל**אדם**, לדקות. נמדד: עם 15 שניות בקשת-מסך מתה אחרי 15.1 שניות בדיוק; עם 180
שניות אדם אמיתי ענה ב-38.35 שניות והקריאה עברה.

לכן הערך מוצמד ל-`SCREEN_REQUEST_TIMEOUT_MS` של המארח — 30 דקות. הכפתור
`ARIGAMI_CODEX_TOOL_TIMEOUT_SEC` קיים בעיקר כדי שאפשר יהיה לתרגל את מסלול
הוויתור בשניות במקום בחצי שעה. הורדה שלו בפרודקשן מוכרת זמן-תגובה של אדם תמורת
כלום.

### 10. עוד דברים קטנים שכדאי לדעת

- **שם מודל לא מוכר נבלע בשקט.** Codex נופל למודל ברירת-המחדל שלו בלי שגיאה
  ובלי אזהרה, ולכן `codexModelArgs()` מסנן בעצמו לפי `CODEX_MODEL_RE` וכותב
  warning ללוג. אותו דבר לרמת מאמץ לא-מוכרת.
- **`EFFORTS` ב-`server/codex.ts` חייב להישאר superset** של כל רמה שהבורר
  בקוקפיט מציע (`CODEX_MODELS[].efforts` ב-`web/src/lib/engines.js`). רמה
  שמגיעה לשרת ולא נמצאת ב-set נזרקת, והתור רץ בברירת-המחדל של המודל בזמן
  שה-UI ממשיך להראות את הרמה שהאדם בחר.
- **טאב `/usage` לא קיים בסשן codex.** הוא מודד מנוי ו**חשבון של Claude**;
  לסשן codex אין לא זה ולא זה.
- **בורר מצב-ההרשאות לא מוצג בסשן codex.** במקומו יושבת שורה שמצהירה
  `bypassPermissions` ומסבירה למה. בורר שאפשר לבחור בו "plan" בזמן שהשרת מריץ
  בכל מקרה `--dangerously-bypass-approvals-and-sandbox` הוא שקר בממשק.
  הפרדיקט: `hasPermissionModes()` ב-`web/src/lib/engines.js`.
- **כפתור "רענון רשימת המודלים" ותג עדכון-ה-CLI לא מוצגים בסשן codex** — שניהם
  מדברים על ה-CLI של claude.
- **מחיקת סשן מנקה את `$CODEX_HOME` שלו** (`config/codex/<sessionId>`) — שם
  יושבת היסטוריית השיחה.

## הכלל לגבי טקסט בממשק

מחרוזת שמתארת את **המנוע** (מי עובד עכשיו, מי מבקש את המסך, של מי היכולות
האלה) חייבת לעקוב אחרי `session.engine` — לכן ה-locales מחזיקים placeholder
`{engine}` ולא את המילה "Claude". מחרוזת שמתארת את **אריגמי**, או שבאמת מתארת
את ה-CLI של Claude Code עצמו (ההתקנה שלו, פריט ה-keychain שלו, ניצול המנוי
שלו), ממשיכה לומר Claude. שני העוזרים לזה:
`engineLabel()` ו-`engineTermName()` ב-`web/src/lib/engines.js`.
