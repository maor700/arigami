// EXT — הגדרות › הרחבות, שורות ההרחבות בחלונית "+", פקודות הסלאש של ההרחבות
// וקלף הצ'אט `ext-card`.
export const strings = {
  'ext.title': 'הרחבות',
  'ext.sub': 'תיקיות שאתה מתקין בעצמך. הרחבה יכולה להוסיף כלים, סקיל, מאזין, hooks וטאב — והיא רצה עם ההרשאות של המארח הזה.',
  'ext.empty': 'אין הרחבה מותקנת. אפשר להוסיף מתיקייה או מכתובת git.',
  'ext.reload': 'טען מחדש',
  'ext.reloading': 'טוען מחדש…',
  'ext.reloaded': 'ההרחבות נטענו מחדש',
  'ext.apiVersion': 'API v{n}',

  // מצב
  'ext.state.loaded': 'פעילה',
  'ext.state.disabled': 'כבויה',
  'ext.state.error': 'שגיאה',

  // הקלף
  'ext.version': 'v{v}',
  'ext.sha': 'קומיט {sha}',
  'ext.enable': 'הפעלה',
  'ext.permissions': 'הרשאות',
  'ext.permissions.none': 'לא מבקשת כלום',
  'ext.contributions': 'תורמת',
  'ext.c.tools': '{n} כלים',
  'ext.c.listeners': '{n} מאזינים',
  'ext.c.docs': '{n} סקילים',
  'ext.c.tabs': '{n} טאבים',
  'ext.c.hooks': '{n} hooks',
  'ext.c.gates': '{n} שערים',
  'ext.c.channels': '{n} ערוצים',
  'ext.c.webhooks': '{n} webhooks',
  'ext.c.none': 'עדיין כלום',
  'ext.warnings': 'אזהרות',

  // טופס ההגדרות
  'ext.settings': 'הגדרות',
  'ext.settings.save': 'שמירה',
  'ext.settings.saving': 'שומר…',
  'ext.settings.saved': 'ההגדרות נשמרו',
  'ext.settings.default': 'ברירת מחדל: {v}',

  // הסרה
  'ext.remove': 'הסרה',
  'ext.remove.title': 'להסיר את “{name}”?',
  'ext.remove.body': 'התיקייה נמחקת. ההגדרות נשמרות, כך שהתקנה חוזרת מחזירה אותן.',
  'ext.remove.confirm': 'הסר',
  'ext.removed': '“{name}” הוסרה',

  // הוספה
  'ext.add': 'הוספת הרחבה',
  'ext.add.hint': 'תיקייה על המארח הזה, או כתובת git לשכפול רדוד.',
  'ext.add.placeholder': '~/my-extension  ·  https://github.com/…/ext.git',
  'ext.add.check': 'המשך',
  'ext.add.checking': 'קורא את המניפסט…',
  'ext.add.installing': 'מתקין…',
  'ext.added': '“{name}” הותקנה',

  // אישור ההרשאות — לפני שמותקן משהו
  'ext.confirm.title': 'להתקין את “{name}”?',
  'ext.confirm.intro': 'קוד של הרחבה רץ בתוך המארח, עם ההרשאות שלו. היא מבקשת:',
  'ext.confirm.install': 'התקנה',
  'ext.confirm.cancel': 'ביטול',
  'ext.confirm.errors': 'ההרחבה לא עוברת ולידציה. התקנה תשאיר אותה במצב שגיאה.',
  'ext.confirm.git.title': 'לשכפל ולהתקין מ-git?',
  'ext.confirm.git.body': 'את המניפסט אפשר לקרוא רק אחרי השכפול, ולכן ההרשאות יוצגו כשהקוד כבר על המארח. שכפל רק ממקור שאתה סומך עליו.',
  'ext.confirm.git.go': 'שכפל והתקן',
  'ext.review.title': '“{name}” הותקנה — עבור על ההרשאות',
  'ext.review.intro': 'היא פעילה עכשיו. אפשר להשאיר, או לכבות עד שתקרא את הקוד.',
  'ext.review.keep': 'להשאיר פעילה',
  'ext.review.disable': 'לכבות',
  'ext.review.remove': 'להסיר',

  // תוויות ההרשאות
  'ext.perm.session:message': 'לשלוח הודעות לסשן',
  'ext.perm.session:prompts': 'להכניס פרומפטים לתור של הסשן',
  'ext.perm.session:tabs': 'לפתוח, לעדכן ולסגור טאבים',
  'ext.perm.session:artifacts': 'לפרסם ארטיפקטים',
  'ext.perm.session:listeners': 'לדרוך מאזינים',
  'ext.perm.notify': 'לשלוח התראות',
  'ext.perm.tools': 'להריץ את הכלי שלה “{name}”',
  'ext.perm.events': 'לעקוב אחרי אירועי מארח “{name}”',
  'ext.perm.unknown': 'הרשאה לא מוכרת — לא נותנת כלום',

  // פס הטאבים + סלאש
  'ext.tabs.heading': 'הרחבות',
  'ext.slashDesc': 'פתיחת “{tab}” ({ext})',

  // קלף צ'אט
  'ext.card.from': 'הרחבה',
};
