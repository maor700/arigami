// Strings the HOST writes (health details, card outcomes, CLI errors) are English and developer-shaped.
// The few that a first-run person actually meets are recognised here and shown through the locale files, so
// they follow the UI language; anything unknown is shown as written.
import { t } from './i18n.js';

const RULES = [
  [/^(?:claude|codex) exited \d+:.*(?:not logged in|\/login|unauthori[sz]ed|auth)/i, 'server.engineNotSignedIn'],
  [/not logged in|please run \/login|^not signed in$/i, 'server.engineNotSignedIn'],
  [/^display :?\d+ not reachable/i, 'server.desktopDown'],
  [/^screen disabled/i, 'server.desktopOff'],
  [/skipped by the human/i, 'server.skippedByHuman'],
  [/state mismatch/i, 'server.stateMismatch'],
  [/paste the address your browser landed on/i, 'server.pasteAddress'],
];

/** The localized line for a known host message, else the message itself. */
export function serverText(s) {
  const text = String(s ?? '');
  for (const [re, key] of RULES) if (re.test(text)) return t(key);
  return text;
}
