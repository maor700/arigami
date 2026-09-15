// OPENUI phase 2: a host library component on CardFrame/Btn. The desktop
// viewer (ScreenView / noVNC) is NOT rewritten — it is a native component
// wrapped by this card, unmounted the moment the request is answered.
import { useState } from 'react';
import { cancelScreenRequest, openScreenTakeover, useStore, SCREEN_CANCEL_NOTE } from '../lib/store.js';
import { Icon } from '../lib/icons.js';
import { useT } from '../lib/i18n.js';
import { engineLabel } from '../lib/engines.js';
import { SCREEN_PRIORITY } from '../lib/useScreenConnection.js';
import ScreenView from './ScreenView.jsx';
import { faCheck } from '@fortawesome/free-solid-svg-icons';
import { defineHostComponent, loose, str, any, bool, z } from '../openui/define.js';
import { CardFrame, Btn, Prose, SettledLine } from '../openui/primitives.jsx';

// host.request_screen — the agent asks the human to look at / drive the
// shared desktop (manual login, 2FA, CAPTCHA, payment…). Blocking, same
// underlying mechanism as PermissionRequest (server holds the MCP tool call
// open until answered). While unanswered the card is a small WATCH view
// (view-only, never accepts input) + reason/hint + two buttons:
//   Take over — opens the interactive ScreenModal (the same modal the rail
//     icon opens) with this request's context; Done/Cancel live there.
//   Cancel — ends the request with takenOver:false, note "cancelled by user".
// Once answered the card freezes to a static line and unmounts the viewer,
// so old resolved cards in history don't hold open VNC connections.
function ScreenRequestCardView({ props: { sessionId, event } }) {
  // "<engine> wants you to look at the screen" — the request came from THIS
  // session's engine, so a Codex session must not say Claude.
  const engine = engineLabel(useStore().sessions.find((s) => s.id === sessionId)?.engine);
  const t = useT();
  const [busy, setBusy] = useState(false);
  const answered = event.answered;

  const cancel = async () => {
    setBusy(true);
    try {
      await cancelScreenRequest(sessionId, event.requestId);
      window.dispatchEvent(new CustomEvent('host:focus-input'));
    } catch {
      setBusy(false);
    }
  };

  const reasonLabel = event.reason ? t(`chat.screenReason.${event.reason}`) : '';
  const answeredLabel = event.takenOver
    ? t('chat.screenRequestTakenOverDone')
    : event.note === SCREEN_CANCEL_NOTE
      ? t('chat.screenRequestCancelled')
      : t('chat.screenRequestDone');

  return (
    <CardFrame
      tone="accent"
      live
      data-screen-request={answered ? 'answered' : 'open'}
      label={t('chat.screenRequest', { engine })}
      meta={reasonLabel && (
        <span className="rounded-full border border-[var(--term-accent-border)] px-2 py-[1px] text-[11.5px] md:text-[10px] font-bold uppercase tracking-wide text-[var(--term-accent-strong)]">
          {reasonLabel}
        </span>
      )}
      right={!answered && <span className="text-[11.5px] md:text-[10px] text-[var(--term-accent-dim)]">{t('chat.screenModeWatch')}</span>}
    >
      {event.prompt && <Prose className="mt-2">{event.prompt}</Prose>}
      {event.hint && (
        <Prose dim className="mt-1.5">
          <span className="font-bold">{t('chat.screenHint')}:</span> {event.hint}
        </Prose>
      )}
      {answered ? (
        <SettledLine className="mt-2.5">
          <Icon icon={faCheck} /> {answeredLabel}
          {event.note && event.note !== SCREEN_CANCEL_NOTE ? ` — ${event.note}` : ''}
        </SettledLine>
      ) : (
        <>
          {/* the live desktop stays a native component (noVNC) wrapped by this library card */}
          <ScreenView priority={SCREEN_PRIORITY.card} viewOnly sessionId={sessionId} className="mt-2.5 h-[240px] w-full rounded-lg" />
          <div className="mt-2.5 flex items-center justify-end gap-2">
            <Btn variant="secondary" disabled={busy} onClick={cancel} title={t('screen.cancelRequestHint')}>
              {t('screen.cancelRequest')}
            </Btn>
            <Btn variant="primary" disabled={busy} onClick={() => openScreenTakeover(sessionId, event.requestId)} title={t('screen.takeOverHint')}>
              {t('chat.screenTakeOver')}
            </Btn>
          </div>
        </>
      )}
    </CardFrame>
  );
}


export const ScreenRequestCardDef = defineHostComponent({
  name: 'ScreenRequestCard',
  description: 'Host: request_screen — watch the shared desktop, take over or cancel',
  props: loose({
    sessionId: z.string(),
    event: loose({ requestId: str, prompt: any, reason: str, hint: any, answered: any, takenOver: bool, note: any }),
  }),
  component: ScreenRequestCardView,
});

export default function ScreenRequestCard({ sessionId, event }) {
  return <ScreenRequestCardView props={{ sessionId, event }} />;
}
