// The ONE interactive view of the shared host desktop. Opened two ways:
//   - the rail footer icon (global, no request context) — plain enlarge/drive
//   - "Take over" on a request_screen card / side panel — the modal opens
//     with that request's context (reason chip, prompt/hint) and grows a
//     footer: optional note, "Cancel request" and "Done". Closing it (X /
//     Esc / backdrop) keeps the request open — the card stays, "Take over"
//     brings the modal back — and resumes the Watch-mode snapshots.
// Control never happens inside the chat card: this is the only place input
// reaches the machine (the shared RFB in useScreenConnection.js gives the
// highest-priority visible consumer — us — the real canvas; the card and the
// side panel paint a mirror meanwhile).
// Modeled on the Listeners modal shell (SessionView.jsx) plus a real
// Fullscreen API toggle (the canvas benefits from true fullscreen / pointer
// lock). Mounted ONCE, in App.jsx, from store.screen.modal.
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import ScreenView from './ScreenView.jsx';
import { SCREEN_PRIORITY } from '../lib/useScreenConnection.js';
import { answerScreenRequest, cancelScreenRequest, openScreenRequest, useStore } from '../lib/store.js';
import { useT } from '../lib/i18n.js';
import { Icon } from '../lib/icons.js';
import { faXmark, faExpand, faCompress, faDisplay } from '@fortawesome/free-solid-svg-icons';

// `context` — store.screen.modal: {} for the global view, {sessionId,
// requestId} when opened by Take over. `onClose` closes WITHOUT answering.
export default function ScreenModal({ context, onClose }) {
  const t = useT();
  const s = useStore();
  const shellRef = useRef(null); // modal panel — target of the Fullscreen API
  const [status, setStatus] = useState('connecting');
  const [fullscreen, setFullscreen] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const onStatusChange = useCallback((st) => setStatus(st), []);

  // Resolve the request live from the store so an answer arriving from
  // elsewhere (timeout, other tab) drops us back to the plain view.
  const openReq = context?.requestId ? openScreenRequest(s, context.sessionId) : null;
  const req = openReq && openReq.requestId === context.requestId ? openReq : null;

  useEffect(() => {
    const onFsChange = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  useEffect(() => {
    // Esc closes the modal — but while fullscreen, the browser's own Esc
    // handling exits fullscreen first; only close on a second Esc after that.
    const onKey = (e) => { if (e.key === 'Escape' && !document.fullscreenElement) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else shellRef.current?.requestFullscreen().catch(() => {});
  };

  const done = async () => {
    if (!req) return;
    setBusy(true);
    try {
      await answerScreenRequest(context.sessionId, req.requestId, note.trim(), true);
      window.dispatchEvent(new CustomEvent('host:focus-input'));
    } catch {
      setBusy(false);
    }
  };
  const cancel = async () => {
    if (!req) return;
    setBusy(true);
    try {
      await cancelScreenRequest(context.sessionId, req.requestId);
      window.dispatchEvent(new CustomEvent('host:focus-input'));
    } catch {
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
    'flex h-7 w-7 cursor-pointer items-center justify-center rounded-md border border-hair text-fgdim hover:border-ink hover:text-fg';
  const btnPrimary =
    'cursor-pointer rounded-[7px] border-[1.5px] border-ink bg-brand px-3.5 py-1.5 text-[11.5px] font-bold text-[#1a1a1a] shadow-[2px_2px_0_#2a2a2a] disabled:opacity-50';
  const btnSecondary =
    'cursor-pointer rounded-[7px] border-[1.5px] border-border bg-transparent px-3 py-1.5 text-[11.5px] font-bold text-fg hover:bg-bg disabled:opacity-50';

  // Portaled to <body> so no ancestor transform/overflow can clip it.
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-3 md:p-6" onMouseDown={onClose}>
      <div
        ref={shellRef}
        className="flex h-[86vh] w-[1100px] max-w-full flex-col overflow-hidden rounded-[12px] border-[1.5px] border-ink bg-panel shadow-[4px_4px_0_rgba(0,0,0,0.25)]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 border-b border-hair px-4 py-3">
          <span className={`text-[13px] leading-none ${req ? 'text-red-500' : ''}`}><Icon icon={faDisplay} /></span>
          <span className="font-mono text-[13px] font-bold text-fg">{req ? t('screen.takeoverTitle') : t('rail.screen')}</span>
          {reasonLabel && (
            <span className="rounded-full border border-border px-1.5 py-[1px] text-[9.5px] font-bold uppercase tracking-wide text-fgdim">
              {reasonLabel}
            </span>
          )}
          {statusLabel && status !== 'connected' && <span className="font-mono text-[10.5px] text-fgdim">{statusLabel}</span>}
          <button
            type="button"
            onClick={toggleFullscreen}
            title={fullscreen ? t('chat.exitFullscreen') : t('chat.fullscreen')}
            aria-label={fullscreen ? t('chat.exitFullscreen') : t('chat.fullscreen')}
            className={`ms-auto ${iconBtn}`}
          >
            <Icon icon={fullscreen ? faCompress : faExpand} />
          </button>
          <button
            type="button"
            onClick={onClose}
            title={req ? t('screen.closeKeepOpen') : t('dialogs.close')}
            aria-label={req ? t('screen.closeKeepOpen') : t('dialogs.close')}
            className={iconBtn}
          >
            <Icon icon={faXmark} />
          </button>
        </div>

        {req && (
          <div className="flex items-start gap-2 border-b border-hair bg-red-500/10 px-4 py-2 text-[11.5px] leading-snug">
            <span className="pulse-yellow mt-[5px] h-[7px] w-[7px] shrink-0 rounded-full bg-red-500" />
            <div className="min-w-0">
              <div className="font-bold text-fg">{t('chat.screenControlBanner')}</div>
              {req.prompt && <div dir="auto" className="mt-0.5 text-fg">{req.prompt}</div>}
              {req.hint && (
                <div dir="auto" className="mt-0.5 text-fgdim">
                  <span className="font-bold">{t('chat.screenHint')}:</span> {req.hint}
                </div>
              )}
            </div>
          </div>
        )}

        <ScreenView priority={SCREEN_PRIORITY.modal} sessionId={context?.sessionId} className="min-h-0 flex-1" onStatusChange={onStatusChange} />

        {req && (
          <div className="flex items-center gap-2 border-t border-hair px-4 py-2.5">
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !busy && done()}
              placeholder={t('chat.screenRequestNotePlaceholder')}
              className="min-w-0 flex-1 rounded-[7px] border-[1.5px] border-border bg-transparent px-2.5 py-1.5 text-[11.5px] text-fg outline-none placeholder:text-fgdim"
            />
            <button type="button" disabled={busy} onClick={cancel} title={t('screen.cancelRequestHint')} className={btnSecondary}>
              {t('screen.cancelRequest')}
            </button>
            <button type="button" disabled={busy} onClick={done} title={t('screen.doneHint')} className={btnPrimary}>
              {t('chat.screenRequestDone')}
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
