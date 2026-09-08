# יישור הריפו: master מקומי מול origin/master

**מצב (נמדד 2026-09-08 ב-/opt/arigami):** ל-`master` המקומי ול-`origin/master` אין בסיס משותף (`git merge-base` ריק). לכן `git pull --ff-only` — המסלול של כפתור "עדכן" בהגדרות — נכשל תמיד, וגם `git push` רגיל נדחה. המסך "גרסה" מציג את זה כ"אין בסיס משותף" ומנטרל את העדכון עד שמיישרים.

## מה קרה

ב-2026-09-06 עברו ב-GitHub שלושה PR-ים על היסטוריה **משוכתבת** (PR #2 — `chore: scrub personal data…` — כתב מחדש את כל הקומיטים מהראשון, כדי לנקות מידע אישי). ה-`git fetch` שאחריו סימן את זה ב-reflog כ-`forced-update`. המקומי המשיך מהיסטוריה הישנה (הלא-מנוקה) עם עוד גל עבודה (EXT, compare, autoplay…). התוצאה: שני עצים שמספרים את אותו סיפור עד 4.9 בשתי שרשראות SHA שונות.

## המספרים

| | master מקומי | origin/master |
|---|---|---|
| קומיטים בענף | 371 | 328 |
| קומיטים שאינם בצד השני (לפי SHA) | 371 | 328 |
| קומיטים שאינם בצד השני **לפי תוכן** (`git cherry`) | **55** | **18** |
| מתוכם אחרי ה-push האחרון (10437ca, 4.9.2026) | 50 | — |
| קומיט אחרון | 511a088, 8.9.2026 | b3684f3, 6.9.2026 (merge PR #3) |

הבדלי קבצים בין שני הראשים: **156 קבצים** (1,985+ / 10,693−):

- **58 קבצים רק במקומי** — מערכת ההרחבות: `skills/build-extension/` (15), `examples/extensions/` (12), `server/notify.ts`, `server/listeners-registry.ts`, `server/lib/` (3), טסטים של ext/autoplay (8), web (8).
- **14 קבצים רק ב-origin** — `control-plane/Dockerfile`, `control-plane/docker-entrypoint.sh`, ו-`deploy/helm/arigami-control-plane/` (12) — התוכן של PR #1 ו-#3.
- **84 קבצים שונים בשני הצדדים** — רובם ה-scrub (PR #2: שמות/כתובות בטסטים ובדוקס, `web/src` 18, `deploy/helm/arigami-tenant` 5, `control-plane/src` 2) ו-`.github/workflows/release.yml` (ב-origin יש job נוסף שבונה את image ה-control-plane).

מה-18 של origin, שלושה הם תוכן חדש באמת (PR #1 k8s control-plane, PR #2 scrub, PR #3 ci + `chore(host): drop the pre-rename launchd migration`); 15 הנותרים הם גרסאות משוכתבות של קומיטים שקיימים במקומי, שה-scrub שינה את ה-diff שלהם. מה-55 של המקומי, 50 הם עבודה חדשה מאז 4.9 ו-5 הם קומיטים ישנים שה-scrub נגע בהם.

## אופציה א׳ — rebase של המקומי על origin/master המנוקה

```
git fetch origin                      # בלי --prune
git branch backup/master-pre-realign master
git rebase --onto origin/master 10437ca master
# פותרים קונפליקטים (צפויים ב-84 הקבצים שה-scrub שינה — בעיקר טסטים/דוקס)
bun test && bun run typecheck
git push origin master                # push רגיל, בלי force
```

- **יתרונות:** origin נשאר מקור האמת הציבורי והמנוקה; אין force-push; ההיסטוריה ב-GitHub (PR #1–#3, ה-Release workflow, ה-images ב-GHCR) נשארת רציפה; שיתופי פעולה/clone-ים קיימים לא נשברים.
- **סיכונים:** ~50 קומיטים לעבור rebase, וצפויים קונפליקטים בקבצים שה-scrub נגע בהם; קומיטים מקומיים שמכילים מידע אישי שה-scrub ניקה (הטסט `no-personal-data` יתפוס) יצטרכו עריכה; ה-SHA-ים המקומיים משתנים — ה-worktrees הפעילים תחת `/home/arigami/repos/.dispatch-worktrees/` צריכים rebase גם הם (או merge אחרי היישור).
- **זמן:** שעה–שלוש, בעיקר קונפליקטים.

## אופציה ב׳ — אימוץ המקומי כאמת, scrub מחדש, force-push

```
git branch backup/origin-master-pre-realign origin/master
git cherry-pick 86314201 3ac6e47 58d6b8b   # תוכן origin שאין במקומי (k8s control-plane, ci, launchd)
sh scripts/check-personal-data.sh && bun test test/no-personal-data.test.js
# היסטוריה: git filter-repo (או שכתוב ידני) לפי ~/.arigami/private-terms.txt
git push --force-with-lease origin master
```

- **יתרונות:** לא נוגעים ב-50 הקומיטים החדשים; ה-SHA-ים המקומיים (ושל כל ה-worktrees) נשארים; היישור הוא פעולה אחת.
- **סיכונים:** force-push על ריפו ציבורי — כל clone ישן נשבר (וגם ה-reflog ב-GitHub לא מגן); ה-scrub הראשון (PR #2) הלך לאיבוד וצריך לחזור עליו על 371 קומיטים, כולל **ההיסטוריה** (לא רק הראש) — אחרת המידע האישי שנוקה חוזר לציבור; ה-tag-ים/Releases שייווצרו על SHA-ים שייעלמו; ה-PR-ים ב-GitHub יצביעו על קומיטים יתומים.
- **זמן:** חצי שעה ליישור + לא-ידוע ל-scrub היסטורי מלא.

## המלצה

**אופציה א׳.** הסיבה המכריעה: ה-scrub של PR #2 היה **מטרת** השכתוב, והוא כבר בוצע ונבדק על ההיסטוריה שב-origin. אופציה ב׳ מבטלת אותו ומחזירה לציבור היסטוריה לא-מנוקה עד שיושלם scrub שני, על פי שניים יותר קומיטים. הקונפליקטים באופציה א׳ מוגבלים לקבצים שכבר מזוהים (רשימה: `git diff --name-only master origin/master`), ורובם טסטים/דוקס.

לפני שמתחילים, בכל אופציה:
1. `git branch backup/master-pre-realign master` — לא מוחקים כלום.
2. למזג קודם את הענפים הממתינים (dispatch/*) לתוך master המקומי, כדי לעשות rebase פעם אחת.
3. אחרי היישור: `bun run release minor` → tag `v0.2.0` → `git push --follow-tags` — ה-tag הראשון שיוצא מהריפו המיושר, ומכאן "עדכן" בהגדרות עובד (ff-only מול origin).

**אל תבצעו אוטומטית.** זו החלטה של מאור (כרטיס בחירה בסשן VER1); הסשן שמריץ את זה עושה גיבוי-ענף לפני כל פקודה ולא מריץ `fetch --prune` / `reset --hard` על origin.

---

## מה בוצע בפועל (2026-09-08)

מאור בחר **אופציה א׳**, והיישור בוצע. מה שנעשה, לפי הסדר:

1. `git fetch origin` (בלי `--prune`); גיבויים: `backup/master-pre-realign` (b01a1a7) ו-`backup/ver1-pre-realign` (5518c06). שניהם עדיין קיימים.
2. ה-rebase עצמו רץ ב-worktree נפרד ומנותק (`/home/arigami/repos/realign-wt`) ולא ב-`/opt/arigami` — כדי שההוסט החי לא ירוץ אף רגע על עץ עם קונפליקטים.
3. `git rebase --onto origin/master 10437ca` — 44 קומיטים ללא-מיזוג (57 כולל מיזוגים, שנשטחו). 28 עברו נקי; חמישה עצרו בקונפליקטים, כולם מאותו סוג: קומיטי ה-scrub המקומיים מול ה-scrub של PR #2. בכולם נבחר הצד המקומי, שהוא הנייטרלי מבין השניים ("הבעלים" במקום שם פרטי, "the club" במקום שם מעסיק).
4. שני מקרים חריגים:
   - `web/src/components/TabBar.jsx` — קונפליקט אמיתי בין branding לבין agent-page, שבהיסטוריה המקורית נפתר בקומיט מיזוג שה-rebase משטח. שוחזרה בדיוק התוצאה של אותו מיזוג (מ-b01a1a7).
   - `test/no-internal-refs.test.js` — git מתייחס אליו כבינארי (יש בו בית NUL), ולכן הקונפליקט לא סומן והגרסה של origin נשארה בשקט. זו הגרסה שמכילה את המונחים האישיים בתוך הקוד; הוחלפה בגרסה המקומית (215d146) שקוראת denylist חיצוני.
5. תוצאה: העץ החדש נבדל מ-`master` הישן ב-**24 קבצים בלבד**, וכולם התוספות של origin (control-plane, deploy/helm/arigami-control-plane, docker/entrypoint.sh, DEVOPS-HANDOFF, release.yml). **אפס** הבדלים תחת `server/`, `web/`, `mcp/`, `bin/`, `skills/`, `examples/` — כלומר מה שההוסט מריץ זהה בדיוק.
6. תוקן בקומיט נפרד: שער המידע האישי לא הכיר את טווחי ה-RFC1918 ש-`deploy/helm/arigami-tenant/values.yaml` מחסיר מ-`0.0.0.0/0`. אחריו `check-public-readiness.sh` עובר.
7. `master` ב-`/opt/arigami` הוזז ל-2abe77b. מצבו: **44 קומיטים לפני `origin/master`, אפס מאחור** — כלומר `git push origin master` רגיל (fast-forward, בלי force) אפשרי.
8. `dispatch/versions-update` (VER1) עבר rebase על master החדש. הקונפליקט היחיד: `.github/workflows/release.yml` — שני ה-jobs נשמרו (בניית ה-control-plane מ-origin, ו-`github-release` של VER1).

**מה נשאר:** ה-push ל-origin לא בוצע (ממתין לאישור מפורש). אחריו: `bun run release minor` → `v0.2.0` → `git push --follow-tags`, ומאותו רגע "עדכן" בהגדרות עובד ff-only מול origin.
