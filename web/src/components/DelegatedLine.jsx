// A4 — the {kind:'delegated'} receipt line: a composer @mention or `/as` handed
// the text to an agent.
// UX1 — the line says WHICH of the two things happened, in words:
//   home    → "Opened in <agent>'s home" + [Open home] → the agent surface, Home tab
//   session → "Work session «title» created with <agent>" + [Open session] → the work session
//   child   → the same, plus "in this project"
// (it used to read "Assigned to <agent>" with the destination as a small suffix —
// which is exactly the confusion this spec is about).
import { useT } from '../lib/i18n.js';
import { api } from '../lib/api.js';
import { toastError, toastSuccess } from '../lib/toast.js';
import { defineHostComponent, loose, str, any, bool, agentRef, z } from '../openui/define.js';
import { ReceiptLine, Btn, AgentAvatar } from '../openui/primitives.jsx';

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

// OPENUI phase 2: both receipts are host library components on ReceiptLine;
// ChatPane renders them through HostCard.
function DelegatedLineView({ props: { event } }) {
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
    <ReceiptLine data-delegated-line={a.slug} data-delegated-how={how}>
      <AgentAvatar agent={a} size={14} />
      <span className="font-bold">{label}</span>
      {event.delivered === 'queued' && <span className="text-[var(--term-accent-dim)]">· {t('chat.delegatedQueued')}</span>}
      {event.text && <span dir="auto" className="min-w-0 flex-1 truncate">{event.text}</span>}
      {(home ? !!a.slug : !!event.target) && (
        <Btn
          variant="tag"
          className="ms-auto"
          {...(home ? { 'data-delegated-open-home': a.slug } : { 'data-delegated-open': event.target })}
          onClick={() => (home ? openAgent(a.slug, 'home') : openSession(event.target))}
        >
          {t(home ? 'chat.delegatedOpenHome' : 'chat.delegatedOpenSession')} →
        </Btn>
      )}
    </ReceiptLine>
  );
}
export const DelegatedLineDef = defineHostComponent({
  name: 'DelegatedLine',
  description: 'Host: receipt — a composer @mention / `/as` handed the text to an agent',
  props: loose({ event: loose({ agent: agentRef, target: str, targetTitle: str, how: str, delivered: str, text: any }) }),
  component: DelegatedLineView,
});
export function DelegatedLine({ event }) {
  return <DelegatedLineView props={{ event }} />;
}

/**
 * UX2 — the {kind:'agent-adopt'} receipt: "Adopt agent" applied (or reverted). Says
 * plainly that only turns from now on run under the adopted agent, and offers
 * "Revert to normal" while it's still in effect.
 */
function AgentAdoptLineView({ props: { event, sessionId } }) {
  const t = useT();
  const reverted = !!event.reverted;
  const a = event.agent || {};
  const revert = () => api.post(`/sessions/${sessionId}/adopt-agent/revert`).catch((e) => toastError(e?.message || String(e)));
  return (
    <ReceiptLine data-agent-adopt={a.slug || ''} data-agent-adopt-reverted={reverted || undefined}>
      {a.slug && <AgentAvatar agent={a} size={14} />}
      <span className="font-bold">{reverted ? t('chat.agentAdoptReverted') : t('chat.agentAdopted', { name: a.name || a.slug })}</span>
      {!reverted && <span className="text-[var(--term-accent-dim)]">{t('chat.agentAdoptedHint')}</span>}
      {!reverted && (
        <Btn variant="tag" className="ms-auto" data-agent-adopt-revert onClick={revert}>
          {t('chat.agentAdoptRevert')} →
        </Btn>
      )}
    </ReceiptLine>
  );
}
export const AgentAdoptLineDef = defineHostComponent({
  name: 'AgentAdoptLine',
  description: 'Host: receipt — this session adopted (or gave back) an agent identity',
  props: loose({ sessionId: str, event: loose({ agent: agentRef, prevAgent: any, reverted: bool }) }),
  component: AgentAdoptLineView,
});
export function AgentAdoptLine({ event, sessionId }) {
  return <AgentAdoptLineView props={{ event, sessionId }} />;
}

export default DelegatedLine;
