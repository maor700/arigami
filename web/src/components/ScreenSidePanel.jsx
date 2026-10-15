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
import { ChevronRightIcon, MaximizeIcon, MonitorIcon, PlusIcon } from 'lucide-react';
import { Badge, Button, StatusDot, Tip } from './ui/index.js';

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
  return (
    <div data-screen-empty-state className="flex aspect-[16/10] w-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border px-3 text-center">
      <MonitorIcon className="size-5 text-muted-foreground" aria-hidden="true" />
      <span className="text-xs text-muted-foreground">{t('screen.noMachine')}</span>
      <Button variant="primary" size="sm" disabled={busy} onClick={onAllocate}>
        <PlusIcon className="size-3.5" /> {t('screen.allocate')}
      </Button>
      <Button variant="link" size="xs" className="text-xs text-muted-foreground" onClick={onViewShared}>
        {t('screen.viewShared')}
      </Button>
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

  return (
    <aside className="hidden w-[280px] shrink-0 flex-col border-s border-border bg-background md:flex" data-screen-panel="">
      <div className="flex min-h-11 items-center gap-2 border-b border-border px-3 py-1.5">
        <MonitorIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="text-sm font-medium text-foreground">{t('screen.panelTitle')}</span>
        {/* B12: no machine → nothing to connect to; the empty state below says so */}
        {statusLabel && status !== 'connected' && own !== false && (
          <span className="truncate text-xs text-muted-foreground">{statusLabel}</span>
        )}
        <span className="ms-auto flex items-center gap-0.5">
          <Tip label={t('screen.enlarge')}>
            <Button variant="ghost" size="icon-sm" onClick={enlarge} aria-label={t('screen.enlarge')}><MaximizeIcon className="size-4" /></Button>
          </Tip>
          <Tip label={t('screen.collapse')}>
            <Button variant="ghost" size="icon-sm" onClick={() => setScreenPanel(false)} aria-label={t('screen.collapse')}>
              <ChevronRightIcon className="size-4 rtl:rotate-180" />
            </Button>
          </Tip>
        </span>
      </div>

      {req ? (
        <div className="border-b border-[var(--hb-warn-line)] bg-[var(--hb-warn-bg)] px-3 py-2.5 text-sm leading-snug" data-screen-needs-you="">
          <div className="flex items-center gap-2">
            <StatusDot status="warn" pulse />
            <span className="font-medium text-foreground">{t('screen.needsYou')}</span>
            {reasonLabel && <Badge variant="outline">{reasonLabel}</Badge>}
          </div>
          {req.prompt && <div dir="auto" className="mt-1.5 text-foreground">{req.prompt}</div>}
          {req.hint && (
            <div dir="auto" className="mt-1 text-xs text-muted-foreground">
              <span className="font-medium">{t('chat.screenHint')}:</span> {req.hint}
            </div>
          )}
        </div>
      ) : (
        <div className="border-b border-border px-3 py-2 text-xs text-muted-foreground">{t('screen.watching')}</div>
      )}

      {/* T8c: no ScreenView (and no /__vnc connection) until this session is
          known to have its own machine — an explicit empty state instead of
          silently showing the shared desktop. */}
      {own === false ? (
        <div className="px-3 pt-3">
          <ScreenEmptyState busy={allocBusy} onAllocate={allocate} onViewShared={() => setScreenModal(true)} />
        </div>
      ) : (
        // 16:10-ish box; the view scales the desktop to fit. Always view-only.
        <div className="px-3 pt-3">
          <ScreenView priority={SCREEN_PRIORITY.panel} viewOnly sessionId={session?.id} onStatusChange={onStatusChange} className="aspect-[16/10] w-full rounded-lg border border-border" />
          {/* The shared desktop stays reachable from a session that has its own machine too. */}
          <Button variant="link" size="xs" data-screen-view-shared onClick={() => setScreenModal(true)} className="mt-1 text-xs text-muted-foreground">
            {t('screen.viewShared')}
          </Button>
        </div>
      )}

      {req && (
        <div className="flex items-center gap-2 px-3 py-3">
          <Button variant="outline" className="flex-1" disabled={busy} onClick={cancel} title={t('screen.cancelRequestHint')}>
            {t('screen.cancelRequest')}
          </Button>
          <Button variant="primary" className="flex-1" disabled={busy} onClick={takeOver} title={t('screen.takeOverHint')}>
            {t('chat.screenTakeOver')}
          </Button>
        </div>
      )}
    </aside>
  );
}
