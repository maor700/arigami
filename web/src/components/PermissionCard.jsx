// The permission-request card: the CLI is blocked on a tool call and the
// human allows or denies it (Enter/y · Esc/n while focus is in the card; a
// deny can be undone for a few seconds). OPENUI phase 2: a host library
// component on CardFrame/Btn; the live/stale rule (only the MOST RECENT open
// request grabs focus and keys), the expired state and the composer hand-back
// are exactly as they were.
import { useEffect, useRef, useState } from 'react';
import { answerPermission } from '../lib/store.js';
import { Icon } from './ChatIcon.jsx';
import { useT } from '../lib/i18n.js';
import { keysBlocked, UNDO_MS } from '../openui/keys.js';
import { prettyInput, toolDisplayName, inputRows } from '../lib/pretty-input.js';
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
  const { source, action } = toolDisplayName(toolName);
  const rows = inputRows(event.input);
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
  // Deny waits UNDO_MS before it reaches the agent ("Denying… Undo"), so a
  // stray Esc/n or a mis-tap is recoverable. Leaving the chat mid-countdown
  // still sends it.
  const [denying, setDenying] = useState(false);
  const denyTimer = useRef(null);
  const deny = () => { if (!busy && !denying) setDenying(true); };
  const undoDeny = () => { clearTimeout(denyTimer.current); denyTimer.current = null; setDenying(false); };
  const commitDenyRef = useRef(null);
  commitDenyRef.current = () => { denyTimer.current = null; setDenying(false); answer('deny'); };
  useEffect(() => {
    if (!denying) return;
    denyTimer.current = setTimeout(() => commitDenyRef.current(), UNDO_MS);
    cardRef.current?.querySelector('[data-undo]')?.focus();
    return () => clearTimeout(denyTimer.current);
  }, [denying]);
  useEffect(() => () => { if (denyTimer.current) commitDenyRef.current?.(); }, []);
  // A live request is the actionable card: focus Allow so Enter approves, and
  // answer Enter/y · Esc/n — but only while focus is INSIDE this card, so an
  // Esc that closes a menu, a palette or a dialog elsewhere never denies it.
  // `isLive` (from ChatPane) = the session is blocked on the MOST RECENT
  // request, so an old/stale card never grabs focus/keys.
  // OPENUI phase 3: a STALE request (the transcript moved past it) freezes like
  // an expired one — no live buttons on a dead card, and no keys.
  const frozen = !!answered || expired || !!stale;
  const live = !frozen && !busy && !denying && isLive;
  useEffect(() => {
    if (!live) return;
    if (!cardRef.current?.contains(document.activeElement)) allowRef.current?.focus();
    const onKey = (e) => {
      const card = cardRef.current;
      if (!card || !card.contains(document.activeElement) || keysBlocked(e, card)) return;
      if (e.key === 'Enter' || e.key === 'y' || e.key === 'Y') {
        // Enter on the focused Deny button is a Deny click, not an Allow.
        if (e.key === 'Enter' && document.activeElement !== allowRef.current && document.activeElement?.tagName === 'BUTTON') return;
        e.preventDefault(); e.stopPropagation(); answer('allow');
      }
      else if (e.key === 'Escape' || e.key === 'n' || e.key === 'N') { e.preventDefault(); e.stopPropagation(); deny(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live]);
  return (
    <CardFrame ref={cardRef} tone="accent" live={!frozen} label={t('chat.permissionRequest')} meta={source ? <span className={ACCENT.dim}>{source}</span> : null} data-permission-card={answered || (expired ? 'expired' : stale ? 'stale' : 'open')} data-live={live || undefined}>
      <div className="mt-1.5 text-[13px] text-[var(--term-fg)]">
        {t('chat.permissionWants')} <span dir="ltr" className="font-medium text-[var(--term-strong)]" title={toolName}>{action}</span>
      </div>
      {rows && rows.length === 0 && <div className="mt-1 text-xs text-[var(--term-dim)]">{t('chat.permissionNoParams')}</div>}
      {rows && rows.length > 0 && (
        <dl dir="ltr" className="thin-scroll mt-2 max-h-40 overflow-auto rounded-md bg-[var(--term-codebg)] p-2.5 text-xs leading-relaxed">
          {rows.map((r) => (
            <div key={r.key} className={r.long ? 'flex flex-col' : 'flex gap-2'}>
              <dt className="shrink-0 text-[var(--term-faint)]">{r.key}</dt>
              <dd className="min-w-0 font-mono break-words whitespace-pre-wrap text-[var(--term-dim)]">{r.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {rows === null && (
        <pre dir="ltr" data-code className="thin-scroll mt-2 max-h-40 overflow-auto rounded-md bg-[var(--term-codebg)] p-2.5 font-mono text-xs leading-relaxed whitespace-pre-wrap text-[var(--term-dim)]">
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
        ) : denying ? (
          <SettledLine>
            <Icon icon={faXmark} /> {t('chat.denying')}
            <button
              type="button"
              data-undo
              onClick={undoDeny}
              className="ms-2 cursor-pointer rounded font-medium text-[var(--term-accent-strong)] underline underline-offset-2 outline-none focus-visible:outline-2 focus-visible:outline-ring coarse:min-h-11 coarse:px-2"
            >
              {t('chat.undo')}
            </button>
          </SettledLine>
        ) : (
          <>
            <Btn ref={allowRef} variant="primary" className="" disabled={busy} onClick={() => answer('allow')} title={t('chat.allowHint')}>
              {t('chat.allow')}
            </Btn>
            <Btn variant="quiet" disabled={busy} onClick={deny} title={t('chat.denyHint')}>
              {t('chat.deny')}
            </Btn>
            <span dir="ltr" className="ms-1 text-xs text-[var(--term-accent-dim)]">Enter/y · Esc/n</span>
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
