// English strings (the source of truth). Keys are dotted + namespaced.
// Untranslated keys in other locales fall back here.
export const en = {
  // common
  'common.light': 'Light',
  'common.dark': 'Dark',
  'common.auto': 'Auto',
  'common.ltr': 'LTR',
  'common.rtl': 'RTL',
  'common.reset': 'Reset',

  // settings — chrome
  'settings.title': 'Settings',

  // settings — appearance
  'settings.appearance': 'Appearance',
  'settings.theme': 'Theme',
  'settings.theme.hint': 'Light or dark host chrome.',
  'settings.language': 'Language',
  'settings.language.hint': 'Interface language and text direction.',
  'settings.language.auto': 'Automatic',
  'settings.accent': 'Accent color',
  'settings.accent.hint': 'Brand color for buttons, links, highlights, and the logo.',
  'settings.logo': 'Logo',
  'settings.logo.hint': 'Origami mark shown in the browser tab.',

  // settings — terminal
  'settings.terminal': 'Terminal',
  'settings.fontSize': 'Font size',
  'settings.fontSize.hint': 'Chat output text size ({min}–{max}px).',
  'settings.termTheme': 'Terminal theme',
  'settings.termTheme.hint':
    'Default light/dark for the chat terminal. Each terminal has its own toggle in its header.',
  'settings.textDir': 'Text direction',
  'settings.textDir.hint':
    'Default chat direction — Auto detects per message. Each terminal has its own toggle in its header.',

  // Compact relative-time units — appended to a number (e.g. "5m", "4d 18h").
  'time.m': 'm',
  'time.h': 'h',
  'time.d': 'd',
  'time.w': 'w',
  'time.mo': 'mo',
  'time.lt1m': '<1m',
};
