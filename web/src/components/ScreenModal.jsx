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
import { Icon } from '../lib/icons.js';
import { Button } from './ui/button.jsx';
import { Badge, StatusDot } from './ui/badge.jsx';
import { Input } from './ui/input.jsx';
import { Tip } from './ui/tooltip.jsx';
import { Dialog, DialogContent, DialogTitle } from './ui/dialog.jsx';
import { faXmark, faExpand, faCompress, faDisplay } from '@fortawesome/free-solid-svg-icons';

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

  // Radix Dialog: portaled to <body>, focus trap/restore, Esc + backdrop close.
  // Esc closes the modal — but while fullscreen, the browser's own Esc handling
  // exits fullscreen first; only close on a second Esc after that.
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        ref={shellRef}
        showClose={false}
        aria-describedby={undefined}
        onEscapeKeyDown={(e) => { if (document.fullscreenElement) e.preventDefault(); }}
        className="flex h-[86vh] w-[min(68.75rem,calc(100vw-1.5rem))] max-w-full flex-col gap-0 overflow-hidden p-0"
      >
        <div className="flex items-center gap-2.5 border-b border-hair px-4 py-3">
          <span className="text-sm leading-none text-muted-foreground"><Icon icon={faDisplay} /></span>
          <DialogTitle className="text-sm">{req ? t('screen.takeoverTitle') : t('rail.screen')}</DialogTitle>
          {reasonLabel && <Badge variant="outline">{reasonLabel}</Badge>}
          {statusLabel && status !== 'connected' && <span className="text-xs text-fgdim">{statusLabel}</span>}
          <Tip label={fullscreen ? t('chat.exitFullscreen') : t('chat.fullscreen')}>
            <Button variant="ghost" size="icon-sm" onClick={toggleFullscreen} aria-label={fullscreen ? t('chat.exitFullscreen') : t('chat.fullscreen')} className="ms-auto">
              <Icon icon={fullscreen ? faCompress : faExpand} />
            </Button>
          </Tip>
          <Tip label={req ? t('screen.closeKeepOpen') : t('dialogs.close')}>
            <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label={req ? t('screen.closeKeepOpen') : t('dialogs.close')}>
              <Icon icon={faXmark} />
            </Button>
          </Tip>
        </div>

        {req && (
          <div className="flex items-start gap-2 border-b border-hair bg-muted px-4 py-2 text-xs leading-snug">
            <StatusDot status="err" pulse className="mt-1.5" />
            <div className="min-w-0">
              <div className="font-medium text-fg">{t('chat.screenControlBanner')}</div>
              {req.prompt && <div dir="auto" className="mt-0.5 text-fg">{req.prompt}</div>}
              {req.hint && (
                <div dir="auto" className="mt-0.5 text-fgdim">
                  <span className="font-medium">{t('chat.screenHint')}:</span> {req.hint}
                </div>
              )}
            </div>
          </div>
        )}

        <ScreenView priority={SCREEN_PRIORITY.modal} sessionId={context?.sessionId} className="min-h-0 flex-1" onStatusChange={onStatusChange} />

        {context?.sessionId && (
          <Tip label={t('screen.typeIntoHint')}>
            <div className="flex items-center gap-2 border-t border-hair px-4 py-2">
              <Input
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && !typeBusy && typeIt(true)}
                placeholder={t('screen.typeInto')}
                dir="auto"
                spellCheck={false}
                className="flex-1 font-mono text-xs placeholder:font-sans"
              />
              <Button disabled={typeBusy || !typed} onClick={() => typeIt(false)}>{t('screen.typeSend')}</Button>
              {typeErr && <span className="text-xs text-err">{typeErr}</span>}
            </div>
          </Tip>
        )}
        {setupCtx && (
          <div className="flex flex-wrap items-center gap-2 border-t border-hair px-4 py-2.5">
            <span dir="auto" className="min-w-0 flex-1 text-xs text-fgdim">
              {setupErr ? <span className="text-err">{setupErr}</span> : t('setup.card.identityHint')}
            </span>
            <Button variant="primary" disabled={busy} onClick={setupDone}>
              {busy ? t('setup.takeover.verifying') : t('setup.takeover.modalDone')}
            </Button>
          </div>
        )}
        {req && (
          <div className="flex flex-wrap items-center gap-2 border-t border-hair px-4 py-2.5">
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !busy && done()}
              placeholder={t('chat.screenRequestNotePlaceholder', { engine })}
              className="min-w-0 flex-1 basis-48"
            />
            <Tip label={t('screen.cancelRequestHint')}>
              <Button disabled={busy} onClick={cancel}>{t('screen.cancelRequest')}</Button>
            </Tip>
            <Tip label={t('screen.doneHint')}>
              <Button variant="primary" disabled={busy} onClick={done}>{t('chat.screenRequestDone')}</Button>
            </Tip>
          </div>
        )}
        {req && doneErr && (
          <div data-screen-done-error dir="auto" className="border-t border-hair px-4 py-2 text-xs font-medium text-err">{doneErr}</div>
        )}
      </DialogContent>
    </Dialog>
  );
}
