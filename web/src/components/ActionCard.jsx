// host.request_action UI — shared by the transcript card (ChatPane) and the
// sticky bar (SessionView). A3: an action raised by a session born from an
// agent carries `agent` {slug,name,emoji,color} + `kind`; the card shows the
// agent avatar/name and the "auto-approve this kind from now on" toggle, which
// rides along the answer (`autoApprove:true` → agent.json autoApprove). An
// action the host answered itself shows up as an `action-auto` receipt line.
// Kept DOM-free (no ScreenView/noVNC) so it renders in the bun test harness.
import { useState } from 'react';
import { api } from '../lib/api.js';
import { Icon } from './ChatIcon.jsx';
import { useT, dirOf } from '../lib/i18n.js';
import BidiText, { Isolated } from './BidiText.jsx';
import { faCheck, faXmark } from '@fortawesome/free-solid-svg-icons';
import { defineHostComponent, loose, str, any, agentRef, z } from '../openui/define.js';
import { buttonVariants } from './ui/button.jsx';
import { CardFrame, Btn, ReceiptLine, ErrorNote, Prose, AgentAvatar, ACCENT } from '../openui/primitives.jsx';
import { useStore } from '../lib/store.js';
import { isApproveValue, approvalIsCurrent, approveEffect } from '../lib/approval.js';

// A review card (request_review) carries THE approve action — the same one as
// the Changes tab's button: one label, and an already-approved state instead of
// a second approve. `review` = {approved, effect:[key, params]} | null.
function useReviewState(sessionId, action) {
  const session = useStore().sessions.find((s) => s.id === sessionId);
  if (action?.kind !== 'review') return null;
  return {
    approved: approvalIsCurrent(session?.metadata, action.approval, action.at),
    effect: approveEffect(action.approval),
  };
}
const buttonLabel = (t, review, b) => (review && isApproveValue(b.value) ? (review.approved ? t('chat.approved') : t('chat.approve')) : b.label);

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
  const review = useReviewState(sessionId, action);
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
            <span data-action-agent={action.agent.slug} className={`flex items-center gap-1 rounded-md border border-[var(--term-accent-border)] px-1.5 py-px text-xs ${ACCENT.fg}`}>
              <AgentAvatar agent={action.agent} size={14} />
              <span dir="auto">{action.agent.name}</span>
            </span>
          )}
          {action.kind && <span className={`rounded-md bg-[var(--term-accent-border)] px-1.5 py-px text-xs ${ACCENT.fg}`}>{action.kind}</span>}
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
        {action.buttons.map((b, i) => {
          const done = !!review?.approved && isApproveValue(b.value);
          return (
            <Btn key={i} variant={variant(b.style)} disabled={busy || done} data-approve={review && isApproveValue(b.value) ? (done ? 'approved' : '') : undefined} onClick={() => answer(b.value)}>
              {review && isApproveValue(b.value) && <Icon icon={faCheck} />} {buttonLabel(t, review, b)}
            </Btn>
          );
        })}
      </div>
      {review && <div data-approve-effect="" dir="auto" className={`mt-1.5 text-xs ${ACCENT.dim}`}>{t(...review.effect)}</div>}
      {canAuto && (
        <label data-action-auto className={`mt-2.5 flex cursor-pointer items-center gap-1.5 text-xs ${ACCENT.fg}`}>
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
      <span className="font-medium">{t('chat.actionAutoApproved', { kind: event.actionKind || '' })}</span>
      <BidiText as="span" text={event.prompt} className="min-w-0 truncate" />
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
  if (style === 'primary') return `cursor-pointer ${buttonVariants({ variant: 'primary', size: 'sm' })}`;
  if (style === 'danger') return `cursor-pointer ${buttonVariants({ variant: 'destructive', size: 'sm' })}`;
  return `cursor-pointer ${buttonVariants({ variant: 'outline', size: 'sm' })}`;
}

export function ActionBar({ session }) {
  const t = useT();
  const action = session.action;
  const [busy, setBusy] = useState(false);
  const [auto, setAuto] = useState(false); // A3: auto-approve this kind from now on
  const [err, setErr] = useState(null); // CHAT1: a refused answer is shown, not swallowed
  const review = useReviewState(session.id, action);
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
    <div className="flex shrink-0 flex-wrap items-center gap-3 border-t border-border bg-muted px-3.5 py-2.5" data-action-bar>
      <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-warn pulse-yellow" />
      {action.agent && (
        <span data-action-agent={action.agent.slug} className="flex shrink-0 items-center gap-1 rounded-md bg-background px-1.5 py-0.5 text-xs text-fg">
          <AgentAvatar agent={action.agent} size={14} />
          <span dir="auto">{action.agent.name}</span>
          {action.kind && <span className="text-xs text-fgdim">· {action.kind}</span>}
        </span>
      )}
      <span dir={dirOf(String(action.prompt ?? ''))} className="min-w-0 flex-1 basis-52 text-xs leading-snug text-fg">
        <Isolated text={String(action.prompt ?? '')} />{' '}
        <span className="text-xs text-fgdim">
          {t('rail.revealedBy')}
        </span>
        {err && (
          <span data-action-error dir="auto" className="block text-xs font-medium text-err">
            {t('chat.answerFailed')} <span className="font-mono font-normal">{err}</span>
          </span>
        )}
      </span>
      <span className="ms-auto flex shrink-0 flex-wrap items-center gap-2">
        {canAuto && (
          <label data-action-auto className="flex cursor-pointer items-center gap-1 text-xs text-fg2">
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} disabled={busy} />
            {t('chat.actionAutoApproveShort')}
          </label>
        )}
        {action.buttons.map((b, i) => (
          <button
            key={i}
            type="button"
            disabled={busy || (!!review?.approved && isApproveValue(b.value))}
            onClick={() => answer(b.value)}
            title={review && isApproveValue(b.value) ? t(...review.effect) : undefined}
            className={`${actionBtnClass(b.style)} disabled:opacity-50`}
          >
            {buttonLabel(t, review, b)}
          </button>
        ))}
      </span>
    </div>
  );
}

