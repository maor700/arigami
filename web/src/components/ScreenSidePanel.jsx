// Session-context "machine" side panel: a compact (~280px, collapsible) live
// view of the shared desktop, docked to the right of SessionView. Opens on its
// own while the selected session has an open request_screen, or manually via
// the 🖥 chip in the terminal header. It shows the SAME connection as the chat
// card / enlarge modal (useScreenConnection) and shares the Watch/Control state
// with them through the store — "Take over" / "Done" here is the same action as
// on the card. Desktop-only: on phones the inline card is the whole story.
import { useCallback, useState } from 'react';
import ScreenView from './ScreenView.jsx';
import ScreenModal from './ScreenModal.jsx';
import { SCREEN_PRIORITY } from '../lib/useScreenConnection.js';
import {
  answerScreenRequest,
  openScreenRequest,
  setScreenControl,
  setScreenModal,
  setScreenPanel,
  useStore,
} from '../lib/store.js';
import { useT } from '../lib/i18n.js';
import { Icon } from '../lib/icons.js';
import { faDisplay, faExpand, faChevronRight } from '@fortawesome/free-solid-svg-icons';

export default function ScreenSidePanel({ session }) {
  const t = useT();
  const s = useStore();
  const [status, setStatus] = useState('connecting');
  const [busy, setBusy] = useState(false);
  const onStatusChange = useCallback((st) => setStatus(st), []);
  const req = openScreenRequest(s, session?.id);
  const control = !!req && s.screen.controlRequestId === req.requestId;
  const modal = s.screen.modal;

  const done = async () => {
    if (!req) return;
    setBusy(true);
    try {
      await answerScreenRequest(session.id, req.requestId, '', control);
      window.dispatchEvent(new CustomEvent('host:focus-input'));
    } finally {
      setBusy(false);
    }
  };

  const statusLabel = {
    connecting: t('rail.screenConnecting'),
    disconnected: t('rail.screenDisconnected'),
    error: t('rail.screenError'),
  }[status];
  const reasonLabel = req?.reason ? t(`chat.screenReason.${req.reason}`) : '';
  const iconBtn =
    'flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md border border-hair text-fgdim hover:border-ink hover:text-fg';
  const btnPrimary =
    'flex-1 cursor-pointer rounded-[7px] border-[1.5px] border-ink bg-brand px-3 py-1.5 text-[11.5px] font-bold text-[#1a1a1a] shadow-[2px_2px_0_#2a2a2a] disabled:opacity-50';
  const btnSecondary =
    'flex-1 cursor-pointer rounded-[7px] border-[1.5px] border-border bg-transparent px-3 py-1.5 text-[11.5px] font-bold text-fg hover:bg-bg disabled:opacity-50';

  return (
    <aside className="hidden w-[280px] shrink-0 flex-col border-s border-hair bg-panel md:flex">
      <div className="flex items-center gap-2 border-b border-hair px-3 py-2">
        <span className={`text-[12px] leading-none ${control ? 'text-red-500' : 'text-fg'}`}><Icon icon={faDisplay} /></span>
        <span className="font-mono text-[12px] font-bold text-fg">{t('screen.panelTitle')}</span>
        {statusLabel && status !== 'connected' && (
          <span className="truncate font-mono text-[10px] text-fgdim">{statusLabel}</span>
        )}
        <span className="ms-auto flex items-center gap-1">
          <button type="button" onClick={() => setScreenModal(true)} title={t('screen.enlarge')} aria-label={t('screen.enlarge')} className={iconBtn}>
            <Icon icon={faExpand} />
          </button>
          <button type="button" onClick={() => setScreenPanel(false)} title={t('screen.collapse')} aria-label={t('screen.collapse')} className={iconBtn}>
            <Icon icon={faChevronRight} className="rtl:rotate-180" />
          </button>
        </span>
      </div>

      {req ? (
        <div className="border-b border-hair px-3 py-2 text-[11.5px] leading-snug">
          <div className="flex items-center gap-1.5 font-mono text-[10.5px]">
            <span className={`h-[7px] w-[7px] rounded-full ${control ? 'bg-red-500' : 'pulse-yellow bg-brand'}`} />
            <span className="font-bold text-fg">{control ? t('chat.screenModeControl') : t('screen.needsYou')}</span>
            {reasonLabel && (
              <span className="rounded-full border border-border px-1.5 py-[1px] text-[9.5px] font-bold uppercase tracking-wide text-fgdim">
                {reasonLabel}
              </span>
            )}
          </div>
          {req.prompt && <div className="mt-1 text-fg">{req.prompt}</div>}
          {req.hint && (
            <div className="mt-1 text-fgdim">
              <span className="font-bold">{t('chat.screenHint')}:</span> {req.hint}
            </div>
          )}
        </div>
      ) : (
        <div className="border-b border-hair px-3 py-1.5 font-mono text-[10.5px] text-fgdim">{t('screen.watching')}</div>
      )}

      {control && (
        <div className="mx-3 mt-2 flex items-center gap-2 rounded-[7px] border border-red-500/50 bg-red-500/10 px-2.5 py-1.5 text-[11px] font-bold text-fg">
          <span className="pulse-yellow h-[7px] w-[7px] shrink-0 rounded-full bg-red-500" />
          {t('chat.screenControlBanner')}
        </div>
      )}

      {/* 16:10-ish box; the view scales the desktop to fit */}
      <div className="px-3 pt-2">
        <ScreenView
          priority={SCREEN_PRIORITY.panel}
          viewOnly={!control}
          onStatusChange={onStatusChange}
          className={`aspect-[16/10] w-full rounded-lg ${control ? 'ring-2 ring-red-500/60' : ''}`}
        />
      </div>

      {req && (
        <div className="flex items-center gap-2 px-3 py-2.5">
          {control ? (
            <button type="button" disabled={busy} onClick={done} className={btnPrimary}>
              {t('chat.screenRequestDone')}
            </button>
          ) : (
            <>
              <button type="button" disabled={busy} onClick={done} className={btnSecondary}>
                {t('chat.screenRequestDone')}
              </button>
              <button type="button" disabled={busy} onClick={() => setScreenControl(req.requestId)} className={btnPrimary}>
                {t('chat.screenTakeOver')}
              </button>
            </>
          )}
        </div>
      )}

      {modal && <ScreenModal onClose={() => setScreenModal(false)} />}
    </aside>
  );
}
