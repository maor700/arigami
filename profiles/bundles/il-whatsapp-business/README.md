# il-whatsapp-business — Profile Bundle

**Arigami מקופל לעסק שירות קטן שעובד בוואטסאפ, בעברית.** הסוכן עובר על
הפניות הנכנסות, מסווג, מנסח תשובה לפי המחירון והטון של העסק — ובעל העסק
מאשר בכפתור אחד מהטלפון. **שום הודעה לא יוצאת בלי אדם.**

| חלק | מה הוא עושה |
|---|---|
| `profile.json` | בלי ריפו ובלי מעקב משימות; רק `machine-work` לעבודה בדפדפן כשצריך |
| `skills/whatsapp-inbox-triage/` | קריאת ההודעות דרך ה-WhatsApp MCP / listener של הפלטפורמה → סיווג (לקוח חדש / תור / הצעת מחיר / שאלה / תלונה / ספאם) → טיוטה בעברית → `request_action` (שלח / ערוך / דלג / אני אטפל) → שליחה **רק** אחרי "שלח". גם מצב digest לבוקר |
| `skills/followup/` | רשימת מעקבים (`followups.md`): הצעת מחיר ללא תשובה, אישור תור יום לפני, "הכול בסדר?" אחרי שירות — טיוטה + אישור בכפתור |
| `memory-seed/MEMORY.md` | שלושה כללים קבועים: BUSINESS.md הוא המקור, הסוכן לא שולח, תשובות קצרות בעברית — נוספים רק אם חסרים |
| `memory-seed/BUSINESS.md` | תבנית תיאור העסק (שירותים, מחירון, שעות, טון, שאלות נפוצות, קווים אדומים). לא נטען לזיכרון — מעתיקים לתיקיית העבודה וממלאים |
| `cron.json` | `[il-whatsapp-business] morning-digest`, א'–ה' 08:30 — נרשם **כבוי** |

## 60 שניות אחרי `apply`

1. **הגדרות → WhatsApp**: סורקים QR פעם אחת. ה-bridge של הפלטפורמה שומר את
   ההודעות מקומית; הסקילים קוראים משם.
2. **Skills** מציג את `whatsapp-inbox-triage` ו-`followup` עם תג *bundle*
   (הם יושבים ב-`$ARIGAMI_DIR/skills`, לא ברפו).
3. מעתיקים את `memory-seed/BUSINESS.md` לתיקיית העבודה וממלאים שירותים,
   מחירון, שעות וטון. בלי זה הסוכן מסווג בלבד ולא מציע מחירים.
4. פותחים סשן וכותבים *"תעבור על הוואטסאפ"*. הסוכן מוצא פנייה: *"כמה
   עולה תיקון דוד שמש?"* → מסווג `הצעת-מחיר` → טיוטה מהמחירון → הטלפון
   רוטט עם ארבעה כפתורים. לוחצים **שלח** — רק אז ההודעה יוצאת, ושורת מעקב
   ("תזכורת אחרי 3 ימים") נוספת ל-`followups.md`.
5. אחרי 3 ימים: *"מעקבים"* → הסוכן מציע תזכורת, שוב כפתור, שוב אדם.
6. ב-**Triggers** מפעילים את `morning-digest` כדי לקבל כל בוקר artifact
   קצר: חדש / ממתין / דחוף / מעקבים להיום.

## English summary

A bundle that folds Arigami to a small Hebrew-speaking service business
living in WhatsApp. `whatsapp-inbox-triage` reads incoming messages through
the platform's WhatsApp MCP + listener, classifies them, drafts a Hebrew
reply from `BUSINESS.md` (services, prices, hours, tone) and asks the owner
via `request_action` — **send / edit / skip / I'll handle it** — before
anything goes out; it never auto-sends. `followup` keeps `followups.md`
(quotes without an answer, appointment confirmations, post-service
check-ins) with the same draft-then-ask flow. The morning-digest cron is
registered disabled. No repos, no ticket tracker. Requires the WhatsApp
bridge to be paired in Settings.

## Apply

```sh
install.sh --profile il-whatsapp-business
bin/host profile apply il-whatsapp-business
curl -X POST /__api/profiles/apply -d '{"source":"il-whatsapp-business"}'
```

להתאמה לעסק אחר — מעתיקים את התיקייה ומשנים את BUSINESS.md ואת המרווחים
ב-`followup`. ראו `docs/INSTALL.md` → *Profile bundles*.
