// host.request_action UI — shared by the transcript card (ChatPane) and the
// sticky bar (SessionView). A3: an action raised by a session born from an
// agent carries `agent` {slug,name,emoji,color} + `kind`; the card shows the
// agent avatar/name and the "auto-approve this kind from now on" toggle, which
// rides along the answer (`autoApprove:true` → agent.json autoApprove). An
// action the host answered itself shows up as an `action-auto` receipt line.
// Kept DOM-free (no ScreenView/noVNC) so it renders in the bun test harness.
import { useState } from 'react';
import { api } from '../lib/api.js';
import { Icon } from '../lib/icons.js';
import { useT } from '../lib/i18n.js';
import { faCheck, faXmark } from '@fortawesome/free-solid-svg-icons';
import { defineHostComponent, loose, str, any, agentRef, z } from '../openui/define.js';
import { CardFrame, Btn, ReceiptLine, ErrorNote, Prose, AgentAvatar, ACCENT } from '../openui/primitives.jsx';

// The transcript card — rendered inline (not pinned under the input). Buttons
// are human-click-only; the answer is delivered as a message.
// OPENUI phase 2: a host library component (define.js) built from the shared
// primitives; ChatPane renders it through HostCard.
function ActionCardView({ props: { sessionId, action } }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  // A3: "auto-approve this kind from now on" — only meaningful for an action
  // raised by an agent session WITH a kind (stored in agent.json autoApprove).
  const [auto, setAuto] = useState(false);
  // CHAT1: an answer the host refused (session archived, over budget, host
  // unreachable) is shown on the card — never a click that silently does nothing.
  const [err, setErr] = useState(null);
  if (!action || !Array.isArray(action.buttons)) return null;
  const canAuto = !!(action.agent && action.kind && action.kind !== 'review');
  const answer = async (value) => {
    setBusy(true);
    setErr(null);
    try {
      await api.post(`/sessions/${sessionId}/action/answer`, { actionId: action.id, value, ...(canAuto && auto ? { autoApprove: true } : {}) });
    } catch (e) {
      setErr(String(e?.message || e).replace(/^HTTP \d+ — /, ''));
      setBusy(false);
    }
  };
  // Escape hatch: none of the options fit (or the prompt is stale) — clear the
  // sticky bar and keep chatting. The tool call already returned, so this
  // doesn't leave the model waiting.
  const dismiss = async () => {
    setBusy(true);
    setErr(null);
    try { await api.post(`/sessions/${sessionId}/action/dismiss`, { actionId: action.id }); } catch (e) {
      setErr(String(e?.message || e).replace(/^HTTP \d+ — /, ''));
      setBusy(false);
    }
  };
  const variant = (style) => (style === 'primary' ? 'primary' : style === 'danger' ? 'danger' : 'option');
  return (
    <CardFrame
      tone="accent"
      live
      label={t('chat.actionNeeded')}
      meta={
        <>
          {action.agent && (
            <span data-action-agent={action.agent.slug} className={`flex items-center gap-1 rounded-full border border-[var(--term-accent-border)] px-1.5 py-px text-[11.5px] md:text-[10px] ${ACCENT.fg}`}>
              <AgentAvatar agent={action.agent} size={14} />
              <span dir="auto">{action.agent.name}</span>
            </span>
          )}
          {action.kind && <span className={`rounded-full bg-[var(--term-accent-border)] px-1.5 py-px font-mono text-[11px] md:text-[9.5px] ${ACCENT.fg}`}>{action.kind}</span>}
        </>
      }
      right={
        <button
          type="button"
          disabled={busy}
          onClick={dismiss}
          title={t('chat.dismissNoneTitle')}
          aria-label={t('chat.dismiss')}
          className={`cursor-pointer rounded px-1.5 text-[13px] leading-none ${ACCENT.dim} hover:text-[var(--term-accent-strong)] disabled:opacity-40`}
        >
          <Icon icon={faXmark} />
        </button>
      }
    >
      <Prose className="mt-2">{action.prompt}</Prose>
      <div className="mt-2.5 flex flex-wrap gap-2">
        {action.buttons.map((b, i) => (
          <Btn key={i} variant={variant(b.style)} disabled={busy} onClick={() => answer(b.value)}>{b.label}</Btn>
        ))}
      </div>
      {canAuto && (
        <label data-action-auto className={`mt-2.5 flex cursor-pointer items-center gap-1.5 text-[11px] ${ACCENT.fg}`}>
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} disabled={busy} />
          {t('chat.actionAutoApprove', { kind: action.kind, agent: action.agent.name })}
        </label>
      )}
      {err && <ErrorNote data-action-error label={t('chat.answerFailed')}>{err}</ErrorNote>}
    </CardFrame>
  );
}

export const ActionCardDef = defineHostComponent({
  name: 'ActionCard',
  description: 'Host: request_action — a question with buttons the human answers (never the agent)',
  props: loose({ sessionId: z.string(), action: loose({ id: str, prompt: any, kind: str, agent: agentRef, buttons: any }) }),
  component: ActionCardView,
});
export function ActionCard({ sessionId, action }) {
  return <ActionCardView props={{ sessionId, action }} />;
}

// A3: the host answered a request_action itself (the kind is in the agent's
// autoApprove list) — a one-line receipt in the transcript.
function ActionAutoLineView({ props: { event } }) {
  const t = useT();
  return (
    <ReceiptLine data-action-auto-line="">
      {event.agent && <AgentAvatar agent={event.agent} size={14} />}
      <span className="font-bold">{t('chat.actionAutoApproved', { kind: event.actionKind || '' })}</span>
      <span dir="auto" className="min-w-0 truncate">{event.prompt}</span>
      <span className="ms-auto rounded bg-[var(--term-accent-border)] px-1.5">{event.label || event.value}</span>
    </ReceiptLine>
  );
}
export const ActionAutoLineDef = defineHostComponent({
  name: 'ActionAutoLine',
  description: 'Host: receipt of a request_action the host auto-approved',
  props: loose({ event: loose({ prompt: any, actionKind: str, value: any, label: str, agent: agentRef }) }),
  component: ActionAutoLineView,
});
export function ActionAutoLine({ event }) {
  return <ActionAutoLineView props={{ event }} />;
}

/* ---------- the sticky bar (SessionView) ---------------------------------- */

export function actionBtnClass(style) {
  if (style === 'primary')
    return 'cursor-pointer rounded-lg border-[1.5px] border-ink bg-brand px-3.5 py-[7px] text-[12.5px] font-bold text-[#1a1a1a] shadow-[2px_2px_0_#2a2a2a]';
  if (style === 'danger')
    return 'cursor-pointer rounded-lg border-[1.5px] border-danger bg-danger px-3.5 py-[7px] text-[12.5px] font-bold text-white shadow-[2px_2px_0_#7d2a23]';
  return 'cursor-pointer rounded-lg border-[1.5px] border-suggest-line bg-panel px-3 py-[7px] text-xs text-fg2 hover:bg-suggest';
}

export function ActionBar({ session }) {
  const t = useT();
  const action = session.action;
  const [busy, setBusy] = useState(false);
  const [auto, setAuto] = useState(false); // A3: auto-approve this kind from now on
  const [err, setErr] = useState(null); // CHAT1: a refused answer is shown, not swallowed
  if (!action || !Array.isArray(action.buttons)) return null;
  const canAuto = !!(action.agent && action.kind && action.kind !== 'review');
  const answer = async (value) => {
    setBusy(true);
    setErr(null);
    try {
      await api.post(`/sessions/${session.id}/action/answer`, { actionId: action.id, value, ...(canAuto && auto ? { autoApprove: true } : {}) });
      /* bar clears via WS echo on success */
    } catch (e) {
      setErr(String(e?.message || e).replace(/^HTTP \d+ — /, ''));
    }
    setBusy(false);
  };
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-3 border-t-2 border-ink bg-chip px-3.5 py-2.5">
      <span className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full border-[1.5px] border-ink bg-brand text-xs">
        <Icon icon={faCheck} />
      </span>
      {action.agent && (
        <span data-action-agent={action.agent.slug} className="flex shrink-0 items-center gap-1 rounded-full border border-hair bg-panel px-1.5 py-px text-[11.5px] md:text-[10.5px] text-fg">
          <AgentAvatar agent={action.agent} size={14} />
          <span dir="auto">{action.agent.name}</span>
          {action.kind && <span className="font-mono text-[11px] md:text-[9.5px] text-fgdim">· {action.kind}</span>}
        </span>
      )}
      <span className="min-w-0 flex-1 basis-52 text-xs leading-snug text-fg">
        {action.prompt}{' '}
        <span className="font-mono text-[11.5px] md:text-[10px] text-fgdim">
          {t('rail.revealedBy')}
        </span>
        {err && (
          <span data-action-error dir="auto" className="block text-[11px] font-bold text-err">
            {t('chat.answerFailed')} <span className="font-mono font-normal">{err}</span>
          </span>
        )}
      </span>
      <span className="ms-auto flex shrink-0 flex-wrap items-center gap-2">
        {canAuto && (
          <label data-action-auto className="flex cursor-pointer items-center gap-1 text-[11.5px] md:text-[10.5px] text-fg2">
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} disabled={busy} />
            {t('chat.actionAutoApproveShort')}
          </label>
        )}
        {action.buttons.map((b, i) => (
          <button
            key={i}
            type="button"
            disabled={busy}
            onClick={() => answer(b.value)}
            className={`${actionBtnClass(b.style)} disabled:opacity-50`}
          >
            {b.label}
          </button>
        ))}
      </span>
    </div>
  );
}

