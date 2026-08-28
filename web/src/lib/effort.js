// Effort levels mirror `claude --effort <level>` exactly (verified via `claude
// --help`). Shared by the running-session picker (TermControls.jsx) and the
// session-creation picker (Launcher.jsx) so both stay in sync with one list.
import { t } from './i18n.js';

export const EFFORT_OPTIONS = [
  { value: 'default', label: t('rail.effortDefault') },
  { value: 'low', label: t('rail.effortLow') },
  { value: 'medium', label: t('rail.effortMedium') },
  { value: 'high', label: t('rail.effortHigh') },
  { value: 'xhigh', label: t('rail.effortXhigh') },
  { value: 'max', label: t('rail.effortMax') },
];
export const EFFORT_LABEL = Object.fromEntries(EFFORT_OPTIONS.map((o) => [o.value, o.label]));
