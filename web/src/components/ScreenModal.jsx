// The ONE interactive view of the shared host desktop. Opened three ways:
//   - the rail footer icon — the genuinely GLOBAL desktop, no sessionId
//     (`modal = true` → `{}`) — plain enlarge/drive.
//   - "enlarge" on the session side panel (no open request) — that
//     session's OWN machine (T8c), plain enlarge/drive (`modal =
//     {sessionId}`).
//   - "Take over" on a request_screen card / side panel — that session's
//     machine PLUS the request's context (reason chip, prompt/hint) and a
//     footer: optional note, "Cancel request" and "Done" (`modal =
//     {sessionId, requestId}`). Closing it (X / Esc / backdrop) keeps the
//     request open — the card stays, "Take over" brings the modal back —
//     and resumes the Watch-mode snapshots.
// Control never happens inside the chat card: this is the only place input
// reaches the machine (the shared RFB in useScreenConnection.js gives the
// highest-priority visible consumer — us — the real canvas; the card and the
// side panel paint a mirror meanwhile).
// Modeled on the Listeners modal shell (SessionView.jsx) plus a real
// Fullscreen API toggle (the canvas benefits from true fullscreen / pointer
// lock). Mounted ONCE, in App.jsx, from store.screen.modal.
import { useCallback, useEffect, useRef, useState } from 'react';
import ScreenView from './ScreenView.jsx';
import { SCREEN_PRIORITY } from '../lib/useScreenConnection.js';
import { answerScreenRequest, cancelScreenRequest, openScreenRequest, setScreenModal, useStore } from '../lib/store.js';
import * as setupApi from '../lib/setup-api.js';
import { api } from '../lib/api.js';
import { useT } from '../lib/i18n.js';
import { engineLabel } from '../lib/engines.js';
import { MaximizeIcon, MinimizeIcon, MonitorIcon, XIcon } from 'lucide-react';
import { Badge, Button, Input, StatusDot } from './ui/index.js';

// `context` — store.screen.modal: {} for the global view, {sessionId} for a
// session's own machine (no open request), {sessionId, requestId} when
// opened by Take over. `onClose` closes WITHOUT answering.
export default function ScreenModal({ context, onClose }) {
  const t = useT();
  const s = useStore();
  const shellRef = useRef(null); // modal panel — target of the Fullscreen API
  const [status, setStatus] = useState('connecting');
  const [fullscreen, setFullscreen] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [setupErr, setSetupErr] = useState(null);
  // F8: "type into the desktop" — the human's clipboard never crosses VNC, so
  // a code copied on their own machine can be typed here and inserted where
  // the cursor is on the session desktop.
  const [typed, setTyped] = useState('');
  const [typeBusy, setTypeBusy] = useState(false);
  const [typeErr, setTypeErr] = useState(null);
  const typeIt = async (enter) => {
    if (!typed || !context?.sessionId) return;
    setTypeBusy(true);
    setTypeErr(null);
    try {
      await api.post(`/sessions/${context.sessionId}/desktop/type`, { text: typed, enter: !!enter });
      setTyped('');
    } catch (e) {
      setTypeErr(String(e?.message || e).replace(/^HTTP \d+ — /, ''));
    } finally {
      setTypeBusy(false);
    }
  };
  // F6: opened from an identity Setup card (no screen-request) — Done verifies
  // the Google sign-in on the host and resolves the card as done.
  const setupCtx = !context?.requestId && context?.setupId ? context : null;
  const onStatusChange = useCallback((st) => setStatus(st), []);

  // Resolve the request live from the store so an answer arriving from
  // elsewhere (timeout, other tab) drops us back to the plain view.
  const openReq = context?.requestId ? openScreenRequest(s, context.sessionId) : null;
  // The note goes back to whichever engine drives THIS session, not to "Claude".
  const engine = engineLabel(s.sessions.find((x) => x.id === context?.sessionId)?.engine);
  const req = openReq && openReq.requestId === context.requestId ? openReq : null;

  useEffect(() => {
    const onFsChange = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else shellRef.current?.requestFullscreen().catch(() => {});
  };

  // CHAT1: a Done that did not land (the request already closed — timed out,
  // session restarted) is said out loud instead of a button that just
  // re-enables; the human then tells the agent in the composer.
  const [doneErr, setDoneErr] = useState(null);
  const done = async () => {
    if (!req) return;
    setBusy(true);
    setDoneErr(null);
    try {
      await answerScreenRequest(context.sessionId, req.requestId, note.trim(), true);
      window.dispatchEvent(new CustomEvent('host:focus-input'));
    } catch (e) {
      setDoneErr(e?.status === 404 ? t('chat.screenDoneFailed') : String(e?.message || e).replace(/^HTTP \d+ — /, ''));
      setBusy(false);
    }
  };
  const setupDone = async () => {
    if (!setupCtx) return;
    setBusy(true);
    setSetupErr(null);
    try {
      const r = await setupApi.connect(setupCtx.capability || 'identity', { action: 'verify', sessionId: setupCtx.sessionId });
      if (r && r.ok === false) throw new Error(r.error || t('setup.takeover.noAccount'));
      setScreenModal(false);
      window.dispatchEvent(new CustomEvent('host:focus-input'));
    } catch (e) {
      setSetupErr(/no Google sign-in|not signed|noAccount/i.test(String(e?.message || e)) ? t('setup.takeover.noAccount') : String(e?.message || e).replace(/^HTTP \d+ — /, ''));
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

  // Portaled to <body> so no ancestor transform/overflow can clip it. The shell
  // is also the Fullscreen API target, so its buttons keep native `title`s: a
  // kit tooltip portals to <body> and would sit behind a fullscreen element.
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-3 md:p-6" onMouseDown={onClose}>
      <div
        ref={shellRef}
        data-screen-modal=""
        className="flex h-[86vh] w-[1100px] max-w-full flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-dialog"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex min-h-12 items-center gap-2.5 border-b border-border px-4 py-2">
          {req ? <StatusDot status="warn" pulse className="size-2" /> : <MonitorIcon className="size-4 text-muted-foreground" aria-hidden="true" />}
          <span className="text-base font-semibold text-foreground">{req ? t('screen.takeoverTitle') : t('rail.screen')}</span>
          {reasonLabel && <Badge variant="outline">{reasonLabel}</Badge>}
          {statusLabel && status !== 'connected' && <span className="text-xs text-muted-foreground">{statusLabel}</span>}
          <Button
            variant="ghost"
            size="icon"
            onClick={toggleFullscreen}
            title={fullscreen ? t('chat.exitFullscreen') : t('chat.fullscreen')}
            aria-label={fullscreen ? t('chat.exitFullscreen') : t('chat.fullscreen')}
            className="ms-auto"
          >
            {fullscreen ? <MinimizeIcon className="size-4" /> : <MaximizeIcon className="size-4" />}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            title={req ? t('screen.closeKeepOpen') : t('dialogs.close')}
            aria-label={req ? t('screen.closeKeepOpen') : t('dialogs.close')}
          >
            <XIcon className="size-4" />
          </Button>
        </div>

        {req && (
          <div className="flex items-start gap-2.5 border-b border-[var(--hb-warn-line)] bg-[var(--hb-warn-bg)] px-4 py-2.5 text-sm leading-snug" data-screen-control-banner="">
            <div className="min-w-0">
              <div className="font-medium text-foreground">{t('chat.screenControlBanner')}</div>
              {req.prompt && <div dir="auto" className="mt-0.5 text-foreground">{req.prompt}</div>}
              {req.hint && (
                <div dir="auto" className="mt-0.5 text-muted-foreground">
                  <span className="font-medium">{t('chat.screenHint')}:</span> {req.hint}
                </div>
              )}
            </div>
          </div>
        )}

        <ScreenView priority={SCREEN_PRIORITY.modal} sessionId={context?.sessionId} className="min-h-0 flex-1" onStatusChange={onStatusChange} />

        {context?.sessionId && (
          <div className="flex items-center gap-2 border-t border-border px-4 py-2" title={t('screen.typeIntoHint')}>
            <Input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !typeBusy && typeIt(true)}
              placeholder={t('screen.typeInto')}
              dir="auto"
              spellCheck={false}
              className="min-w-0 flex-1 font-mono text-xs placeholder:font-sans"
            />
            <Button variant="outline" disabled={typeBusy || !typed} onClick={() => typeIt(false)}>{t('screen.typeSend')}</Button>
            {typeErr && <span className="text-xs text-destructive">{typeErr}</span>}
          </div>
        )}
        {setupCtx && (
          <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-2.5">
            <span dir="auto" className="min-w-0 flex-1 text-sm text-muted-foreground">
              {setupErr ? <span className="text-destructive">{setupErr}</span> : t('setup.card.identityHint')}
            </span>
            <Button variant="primary" disabled={busy} onClick={setupDone} title={t('setup.card.identityHint')}>
              {busy ? t('setup.takeover.verifying') : t('setup.takeover.modalDone')}
            </Button>
          </div>
        )}
        {req && (
          <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-2.5">
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !busy && done()}
              placeholder={t('chat.screenRequestNotePlaceholder', { engine })}
              dir="auto"
              className="min-w-40 flex-1"
            />
            <Button variant="outline" disabled={busy} onClick={cancel} title={t('screen.cancelRequestHint')}>
              {t('screen.cancelRequest')}
            </Button>
            <Button variant="primary" disabled={busy} onClick={done} title={t('screen.doneHint')}>
              {t('chat.screenRequestDone')}
            </Button>
          </div>
        )}
        {req && doneErr && (
          <div data-screen-done-error dir="auto" className="border-t border-border px-4 py-2 text-xs font-medium text-destructive">{doneErr}</div>
        )}
      </DialogContent>
    </Dialog>
  );
}
