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

### 5. סולם המודלים והכיווץ-לפני-שידור לא רצים

RES1 (ירידה למודל חלש כשהמכסה נגמרת ועלייה בחזרה) ו-LADDER1 (כיווץ ההקשר לפני
replay) שניהם claude-shaped ו**אינם רצים** על סשן codex. סשן codex שנתקע במכסה
נתקע — אין רשת.

### 6. `item.type === 'reasoning'` לא נצפה מעולם

הטיפול בו קיים ב-`handleEvent`, אבל **באף הרצה אמיתית הוא לא הופיע**. הוא כתוב
הגנתית ולא מוכח. אם מישהו יסמוך עליו בעתיד — שיאמת קודם.

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
- **מחיקת סשן מנקה את `$CODEX_HOME` שלו** (`config/codex/<sessionId>`) — שם
  יושבת היסטוריית השיחה.

## הכלל לגבי טקסט בממשק

מחרוזת שמתארת את **המנוע** (מי עובד עכשיו, מי מבקש את המסך, של מי היכולות
האלה) חייבת לעקוב אחרי `session.engine` — לכן ה-locales מחזיקים placeholder
`{engine}` ולא את המילה "Claude". מחרוזת שמתארת את **אריגמי**, או שבאמת מתארת
את ה-CLI של Claude Code עצמו (ההתקנה שלו, פריט ה-keychain שלו, ניצול המנוי
שלו), ממשיכה לומר Claude. שני העוזרים לזה:
`engineLabel()` ו-`engineTermName()` ב-`web/src/lib/engines.js`.
