// Session statuses are free-form strings the host/agents write ('In Progress',
// 'Done', 'Approved', …) and claude states ('idle', 'working'). The rail, the
// group headers and the header chip showed them raw — English inside a Hebrew
// UI (BUGS1/B1, B7, B21, B31). Known values get a locale label; anything else
// (a custom status) is shown as written.
import { t } from './i18n.js';

const KEYS = {
  'in progress': 'status.inProgress',
  'in review': 'status.inReview',
  blocked: 'status.blocked',
  verified: 'status.verified',
  done: 'status.done',
  completed: 'status.completed',
  approved: 'status.approved',
  booting: 'status.booting',
  idle: 'status.idle',
  working: 'status.working',
  restarting: 'status.restarting',
  dead: 'status.dead',
  'awaiting-input': 'status.awaitingInput',
  'waiting-on-child': 'status.waitingOnChild',
  'needs-you': 'status.needsYou',
};

export function statusLabel(status) {
  if (status == null || status === '') return '';
  const k = KEYS[String(status).trim().toLowerCase()];
  return k ? t(k) : String(status);
}
