// Session-context "machine" side panel: a compact (~280px, collapsible) live
// WATCH view of the shared desktop, docked to the right of SessionView. Opens
// on its own while the selected session has an open request_screen, or
// manually via the 🖥 chip in the terminal header. Same connection as the chat
// card / modal (useScreenConnection); always view-only here — "Take over"
// opens the interactive ScreenModal (the same one the rail icon opens) with
// this request's context, and "Cancel" ends the request with takenOver:false.
// Desktop-only: on phones the inline card is the whole story.
import { useCallback, useEffect, useState } from 'react';
import ScreenView from './ScreenView.jsx';
import { SCREEN_PRIORITY } from '../lib/useScreenConnection.js';
import { api } from '../lib/api.js';
import {
  cancelScreenRequest,
  openScreenRequest,
  openScreenTakeover,
  setScreenModal,
  setScreenPanel,
  useStore,
} from '../lib/store.js';
import { useT } from '../lib/i18n.js';
import { Icon } from '../lib/icons.js';
import { faDisplay, faExpand, faChevronRight, faCirclePlus } from '@fortawesome/free-solid-svg-icons';

// T8c / BROWSE1: this panel must show the SESSION's own machine, never the
// shared one just because none was allocated yet (that's how one session
// ends up watching/clicking inside another's browser — see
// SPEC-ARIGAMI-BROWSER-FOR-AGENTS.md #2). So it does NOT connect ScreenView
// (and therefore never opens /__vnc?session=…) until it knows the session
// actually has its own desktop — an explicit empty state offers to allocate
// one instead. A pending request_screen already means the host allocated one
// server-side (see server/vnc.ts's own ensureDesktop), so that case skips
// straight to connected.
function useOwnDesktop(sessionId, hasRequest) {
  const [own, setOwn] = useState(hasRequest ? true : null); // null = unknown yet
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!sessionId) return;
    if (hasRequest) { setOwn(true); return; }
    let stop = false;
    api.get(`/screen/status?session=${encodeURIComponent(sessionId)}`)
      // `perSession:false` (the winvnc driver — a Windows machine with ONE
      // console desktop that every session shares) means no session can ever
      // own a machine here, which is a different thing from "hasn't got one
      // yet". Without this the panel would sit on its empty state forever,
      // offering to allocate a machine that already exists, in front of a
      // perfectly working desktop.
      .then((r) => { if (!stop) setOwn(r?.perSession === false ? true : !!r?.own); })
      .catch(() => { if (!stop) setOwn(false); });
    return () => { stop = true; };
  }, [sessionId, hasRequest]);
  const allocate = useCallback(async () => {
    if (!sessionId || busy) return;
    setBusy(true);
    try {
      await api.post(`/sessions/${sessionId}/screen/allocate`);
      setOwn(true);
    } catch {
      /* leave the empty state up — the button stays clickable to retry */
    } finally {
      setBusy(false);
    }
  }, [sessionId, busy]);
  return { own, busy, allocate };
}

// Extracted so it's directly testable (renderToStaticMarkup) without the
// async useOwnDesktop effect that decides WHEN to show it.
export function ScreenEmptyState({ busy, onAllocate, onViewShared }) {
  const t = useT();
  const btnPrimary =
    'flex-1 cursor-pointer rounded-[7px] border-[1.5px] border-ink bg-brand px-3 py-1.5 text-[11.5px] font-bold text-[#1a1a1a] shadow-[2px_2px_0_#2a2a2a] disabled:opacity-50';
  return (
    <div data-screen-empty-state className="flex aspect-[16/10] w-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-hair px-3 text-center">
      <span className="text-[18px] text-fgdim"><Icon icon={faDisplay} /></span>
      <span className="font-mono text-[10.5px] text-fgdim">{t('screen.noMachine')}</span>
      <button type="button" disabled={busy} onClick={onAllocate} className={btnPrimary + ' flex-none'}>
        <Icon icon={faCirclePlus} /> {t('screen.allocate')}
      </button>
      <button type="button" onClick={onViewShared} className="cursor-pointer font-mono text-[10px] text-fgdim underline hover:text-fg">
        {t('screen.viewShared')}
      </button>
    </div>
  );
}

export default function ScreenSidePanel({ session }) {
  const t = useT();
  const s = useStore();
  const [status, setStatus] = useState('connecting');
  const [busy, setBusy] = useState(false);
  const onStatusChange = useCallback((st) => setStatus(st), []);
  const req = openScreenRequest(s, session?.id);
  const { own, busy: allocBusy, allocate } = useOwnDesktop(session?.id, !!req);

  const takeOver = () => req && openScreenTakeover(session.id, req.requestId);
  // Enlarge while a request is open IS a takeover (the modal is interactive,
  // so snapshots must pause) — otherwise the same session's machine, just
  // full-size (T8c: NOT the global desktop — this panel is already showing
  // THIS session's own machine, `setScreenModal(true)` with no sessionId is
  // only for the rail icon's genuinely-global view).
  const enlarge = () => (req ? takeOver() : setScreenModal({ sessionId: session.id }));
  const cancel = async () => {
    if (!req) return;
    setBusy(true);
    try {
      await cancelScreenRequest(session.id, req.requestId);
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
    'flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md border border-hair text-fgdim hover:border-ink hover:text-fg';
  const btnPrimary =
    'flex-1 cursor-pointer rounded-[7px] border-[1.5px] border-ink bg-brand px-3 py-1.5 text-[11.5px] font-bold text-[#1a1a1a] shadow-[2px_2px_0_#2a2a2a] disabled:opacity-50';
  const btnSecondary =
    'flex-1 cursor-pointer rounded-[7px] border-[1.5px] border-border bg-transparent px-3 py-1.5 text-[11.5px] font-bold text-fg hover:bg-bg disabled:opacity-50';

  return (
    <aside className="hidden w-[280px] shrink-0 flex-col border-s border-hair bg-panel md:flex">
      <div className="flex items-center gap-2 border-b border-hair px-3 py-2">
        <span className="text-[12px] leading-none text-fg"><Icon icon={faDisplay} /></span>
        <span className="font-mono text-[12px] font-bold text-fg">{t('screen.panelTitle')}</span>
        {/* B12: no machine → nothing to connect to; the empty state below says so */}
        {statusLabel && status !== 'connected' && own !== false && (
          <span className="truncate font-mono text-[10px] text-fgdim">{statusLabel}</span>
        )}
        <span className="ms-auto flex items-center gap-1">
          <button type="button" onClick={enlarge} title={t('screen.enlarge')} aria-label={t('screen.enlarge')} className={iconBtn}>
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
            <span className="pulse-yellow h-[7px] w-[7px] rounded-full bg-brand" />
            <span className="font-bold text-fg">{t('screen.needsYou')}</span>
            {reasonLabel && (
              <span className="rounded-full border border-border px-1.5 py-[1px] text-[9.5px] font-bold uppercase tracking-wide text-fgdim">
                {reasonLabel}
              </span>
            )}
          </div>
          {req.prompt && <div dir="auto" className="mt-1 text-fg">{req.prompt}</div>}
          {req.hint && (
            <div dir="auto" className="mt-1 text-fgdim">
              <span className="font-bold">{t('chat.screenHint')}:</span> {req.hint}
            </div>
          )}
        </div>
      ) : (
        <div className="border-b border-hair px-3 py-1.5 font-mono text-[10.5px] text-fgdim">{t('screen.watching')}</div>
      )}

      {/* T8c: no ScreenView (and no /__vnc connection) until this session is
          known to have its own machine — an explicit empty state instead of
          silently showing the shared desktop. */}
      {own === false ? (
        <div className="px-3 pt-2">
          <ScreenEmptyState busy={allocBusy} onAllocate={allocate} onViewShared={() => setScreenModal(true)} />
        </div>
      ) : (
        // 16:10-ish box; the view scales the desktop to fit. Always view-only.
        <div className="px-3 pt-2">
          <ScreenView priority={SCREEN_PRIORITY.panel} viewOnly sessionId={session?.id} onStatusChange={onStatusChange} className="aspect-[16/10] w-full rounded-lg" />
        </div>
      )}

      {req && (
        <div className="flex items-center gap-2 px-3 py-2.5">
          <button type="button" disabled={busy} onClick={cancel} title={t('screen.cancelRequestHint')} className={btnSecondary}>
            {t('screen.cancelRequest')}
          </button>
          <button type="button" disabled={busy} onClick={takeOver} title={t('screen.takeOverHint')} className={btnPrimary}>
            {t('chat.screenTakeOver')}
          </button>
        </div>
      )}
    </aside>
  );
}
