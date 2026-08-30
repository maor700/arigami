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
  'settings.screenTitle': 'Screen share',
  'settings.pushTitle': 'Push notifications',
  'settings.pushEnable': 'Enable push notifications',
  'settings.pushHint': 'Get notified on your phone when listeners fire or Claude needs input',
  'settings.vncPassword': 'VNC password',
  'settings.vncPassword.hint': 'Sent to the embedded viewer when the VNC server asks for VNC-auth. Leave empty if the server has no password.',
  'settings.vncPassword.set': 'A password is set',
  'settings.vncPassword.unset': 'No password set',
  'settings.vncPassword.placeholder': 'New password…',
  'settings.vncPassword.save': 'Save',
  'settings.vncPassword.clear': 'Clear',
  'settings.vncPassword.saved': 'Saved',

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

  // rail
  'rail.integrations': 'Integrations',

  // integrations view
  'integrations.title': 'Integrations',
  'integrations.connectedCount': 'connected',
  'integrations.refresh': 'Refresh',
  'integrations.categories': 'Categories',
  'integrations.all': 'All',
  'integrations.connectedFilter': 'Connected',
  'integrations.search': 'Search integrations…',
  'integrations.connected': 'Connected',
  'integrations.connect': 'Connect',
  'integrations.connecting': 'Connecting…',
  'integrations.disconnect': 'Disconnect',
  'integrations.oauthOpened': 'Authorization page opened in a new tab. Refresh after connecting.',
  'integrations.disconnected': '{name} disconnected.',
  'integrations.notFound': 'Connection not found.',
  'integrations.empty': 'No integrations found.',
  'integrations.noKey.title': 'Connect to Composio',
  'integrations.noKey.body': 'Sign in to access 1,000+ app integrations — Gmail, Linear, WhatsApp, and more.',
  'integrations.oauth.button': 'Sign in with Composio',
  'integrations.oauth.starting': 'Opening…',
  'integrations.oauth.waiting': 'Waiting for browser sign-in…',
  'integrations.oauth.cancel': 'Cancel',

  // Compact relative-time units — appended to a number (e.g. "5m", "4d 18h").
  'time.m': 'm',
  'time.h': 'h',
  'time.d': 'd',
  'time.w': 'w',
  'time.mo': 'mo',
  'time.lt1m': '<1m',
};
