// The permission-request card: the CLI is blocked on a tool call and the
// human allows or denies it (Enter/y · Esc/n). OPENUI phase 2: a host library
// component on CardFrame/Btn; the live/stale rule (only the MOST RECENT open
// request grabs focus and keys), the expired state and the composer hand-back
// are exactly as they were.
import { useEffect, useRef, useState } from 'react';
import { answerPermission } from '../lib/store.js';
import { Icon } from '../lib/icons.js';
import { useT } from '../lib/i18n.js';
import { keysBlocked } from '../openui/keys.js';
import { prettyInput } from '../lib/pretty-input.js';
import { faCheck, faXmark } from '@fortawesome/free-solid-svg-icons';
import { defineHostComponent, loose, str, any, bool, z } from '../openui/define.js';
import { CardFrame, Btn, SettledLine, ACCENT } from '../openui/primitives.jsx';

function PermissionCardView({ props: { sessionId, event, live: isLive, stale } }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  // If the server already resolved this request (timeout, or the process
  // died) before we clicked, retrying would just 404 forever — treat any
  // answer failure as "gone" so the card stops offering live buttons.
  const [expired, setExpired] = useState(false);
  const answered = event.answered;
  const toolName = event.toolName ?? event.tool_name ?? event.name ?? 'tool';
  const allowRef = useRef(null);
  const cardRef = useRef(null);
  const answer = async (behavior) => {
    setBusy(true);
    try {
      await answerPermission(sessionId, event.requestId ?? event.request_id, behavior);
      // Hand focus back to the composer so keyboard flow continues.
      window.dispatchEvent(new CustomEvent('host:focus-input'));
    } catch {
      setBusy(false);
      setExpired(true);
    }
  };
  // A live request is the actionable card: focus Allow so Enter approves, and
  // bind Enter/Esc (and y/n) globally so keyboard users can answer without a
  // mouse. `isLive` (from ChatPane) = the session is blocked on the MOST RECENT
  // request, so an old/stale card never grabs focus/keys.
  // OPENUI phase 3: a STALE request (the transcript moved past it) freezes like
  // an expired one — no live buttons on a dead card, and no keys.
  const frozen = !!answered || expired || !!stale;
  const live = !frozen && !busy && isLive;
  useEffect(() => {
    if (!live) return;
    allowRef.current?.focus();
    const onKey = (e) => {
      if (keysBlocked(e, cardRef.current)) return;
      if (e.key === 'Enter' || e.key === 'y' || e.key === 'Y') { e.preventDefault(); e.stopPropagation(); answer('allow'); }
      else if (e.key === 'Escape' || e.key === 'n' || e.key === 'N') { e.preventDefault(); e.stopPropagation(); answer('deny'); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live]);
  return (
    <CardFrame ref={cardRef} tone="accent" live={!frozen} label={t('chat.permissionRequest')} meta={<span className={ACCENT.dim}>{toolName}</span>} data-permission-card={answered || (expired ? 'expired' : stale ? 'stale' : 'open')} data-live={live || undefined}>
      {event.input != null && (
        <pre className="thin-scroll mt-2 max-h-40 overflow-auto rounded-lg bg-[var(--term-codebg)] p-2 font-mono text-[11.5px] md:text-[10.5px] leading-relaxed whitespace-pre-wrap text-[var(--term-dim)]">
          {prettyInput(event.input)}
        </pre>
      )}
      <div className="mt-2.5 flex items-center gap-2">
        {answered ? (
          <SettledLine>
            {answered === 'allow' ? <><Icon icon={faCheck} /> {t('chat.allowed')}</> : <><Icon icon={faXmark} /> {t('chat.denied')}</>}
            {event.answeredMessage ? ` (${event.answeredMessage})` : ''}
          </SettledLine>
        ) : expired || stale ? (
          <SettledLine>
            <Icon icon={faXmark} /> {expired ? t('chat.requestExpired') : t('chat.requestStale')}
          </SettledLine>
        ) : (
          <>
            <Btn ref={allowRef} variant="primary" className="outline-none focus-visible:ring-2 focus-visible:ring-ink" disabled={busy} onClick={() => answer('allow')} title={t('chat.allowHint')}>
              {t('chat.allow')}
            </Btn>
            <Btn variant="quiet" disabled={busy} onClick={() => answer('deny')} title={t('chat.denyHint')}>
              {t('chat.deny')}
            </Btn>
            <span className="ml-1 font-mono text-[11.5px] md:text-[10px] text-[var(--term-accent-dim)]">Enter/y · Esc/n</span>
          </>
        )}
      </div>
    </CardFrame>
  );
}


export const PermissionCardDef = defineHostComponent({
  name: 'PermissionCard',
  description: 'Host: a tool-call permission the human allows or denies',
  props: loose({
    sessionId: z.string(),
    live: bool,
    stale: bool,
    event: loose({ requestId: str, request_id: str, toolName: str, tool_name: str, name: str, input: any, answered: str, answeredMessage: str }),
  }),
  component: PermissionCardView,
});

export default function PermissionCard({ sessionId, event, live, stale }) {
  return <PermissionCardView props={{ sessionId, event, live, stale }} />;
}
