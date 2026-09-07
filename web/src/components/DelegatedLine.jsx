// A4 — the {kind:'delegated'} receipt line: a composer @mention or `/as` handed
// the text to an agent.
// UX1 — the line says WHICH of the two things happened, in words:
//   home    → "נפתח בבית של <agent>"      + [פתח בית]  → the agent surface, בית tab
//   session → "נוצר סשן עבודה «title» עם <agent>" + [פתח סשן] → the work session
//   child   → the same, plus "in this project"
// (it used to read "הוקצה ל-<agent>" with the destination as a small suffix —
// which is exactly the confusion this spec is about).
import { useT } from '../lib/i18n.js';
import { api } from '../lib/api.js';
import { toastError, toastSuccess } from '../lib/toast.js';
import { AgentAvatar } from './AgentCard.jsx';

export const openSession = (id) => window.dispatchEvent(new CustomEvent('host:select-session', { detail: { id } }));
// `draftName` only matters for slug '__new__' (the AgentView create-mode surface) —
// it prefills the name field so `/agent new <name>` doesn't lose what was typed.
export const openAgent = (slug, tab, draftName) => window.dispatchEvent(new CustomEvent('host:open-agent', { detail: { slug, tab, draftName } }));

// UX4 — the one delete flow, shared by the rail's Team row menu and the agent
// surface header, so both entry points ask the same question and do the same
// thing (DELETE /agents/:slug: removes the agent's home chat + cron jobs born
// from it + persona/memory/browser dir; work sessions stay, just lose the
// badge — see server/api.ts DELETE /__api/agents/:slug). The rail has no
// reference to the surface if it happens to be open on this agent, so success
// is announced as an event instead of a callback — App.jsx closes the surface
// if it's showing the agent that just went away.
// The delete itself (no prompt): DELETE + toast + the app-wide event that
// closes the surface / drops the rail row. The agent page wraps it in a typed
// name confirmation (AgentView DeleteAgentDialog); the rail row menu keeps the
// plain confirm below.
export async function deleteAgent(agent, t) {
  try {
    await api.del(`/agents/${encodeURIComponent(agent.slug)}`);
    toastSuccess(t('agent.page.deleted'));
    window.dispatchEvent(new CustomEvent('host:agent-deleted', { detail: { slug: agent.slug } }));
    return true;
  } catch (e) {
    toastError(e?.message || String(e));
    return false;
  }
}

export async function deleteAgentConfirmed(agent, t) {
  if (!window.confirm(t('agent.page.deleteConfirm', { name: agent.name }))) return false;
  return deleteAgent(agent, t);
}

const short = (s, n = 44) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s || '');

export function DelegatedLine({ event }) {
  const t = useT();
  const a = event.agent || {};
  const how = ['child', 'home', 'session'].includes(event.how) ? event.how : 'session';
  const name = a.name || a.slug || '';
  const title = short(event.targetTitle);
  const home = how === 'home';
  const label = home
    ? t('chat.delegatedHome', { name })
    : t(how === 'child' ? 'chat.delegatedWorkChild' : 'chat.delegatedWork', { title, name });
  return (
    <div data-delegated-line={a.slug} data-delegated-how={how} className="my-1.5 flex flex-wrap items-center gap-1.5 rounded-[8px] border border-dashed border-[var(--term-accent-border)] px-2.5 py-1.5 font-mono text-[10.5px] text-[var(--term-accent-fg)]">
      <AgentAvatar agent={a} size={14} />
      <span className="font-bold">{label}</span>
      {event.delivered === 'queued' && <span className="text-[var(--term-accent-dim)]">· {t('chat.delegatedQueued')}</span>}
      {event.text && <span dir="auto" className="min-w-0 flex-1 truncate">{event.text}</span>}
      {(home ? !!a.slug : !!event.target) && (
        <button
          type="button"
          {...(home ? { 'data-delegated-open-home': a.slug } : { 'data-delegated-open': event.target })}
          onClick={() => (home ? openAgent(a.slug, 'home') : openSession(event.target))}
          className="ms-auto cursor-pointer rounded bg-[var(--term-accent-border)] px-1.5 hover:opacity-80"
        >
          {t(home ? 'chat.delegatedOpenHome' : 'chat.delegatedOpenSession')} →
        </button>
      )}
    </div>
  );
}

/**
 * UX2 — the {kind:'agent-adopt'} receipt: "אמץ סוכן" applied (or reverted). Says
 * plainly that only turns from now on run under the adopted agent, and offers
 * "החזר לרגיל" while it's still in effect.
 */
export function AgentAdoptLine({ event, sessionId }) {
  const t = useT();
  const reverted = !!event.reverted;
  const a = event.agent || {};
  const revert = () => api.post(`/sessions/${sessionId}/adopt-agent/revert`).catch((e) => toastError(e?.message || String(e)));
  return (
    <div data-agent-adopt={a.slug || ''} data-agent-adopt-reverted={reverted || undefined} className="my-1.5 flex flex-wrap items-center gap-1.5 rounded-[8px] border border-dashed border-[var(--term-accent-border)] px-2.5 py-1.5 font-mono text-[10.5px] text-[var(--term-accent-fg)]">
      {a.slug && <AgentAvatar agent={a} size={14} />}
      <span className="font-bold">{reverted ? t('chat.agentAdoptReverted') : t('chat.agentAdopted', { name: a.name || a.slug })}</span>
      {!reverted && <span className="text-[var(--term-accent-dim)]">{t('chat.agentAdoptedHint')}</span>}
      {!reverted && (
        <button type="button" data-agent-adopt-revert onClick={revert} className="ms-auto cursor-pointer rounded bg-[var(--term-accent-border)] px-1.5 hover:opacity-80">
          {t('chat.agentAdoptRevert')} →
        </button>
      )}
    </div>
  );
}

export default DelegatedLine;
