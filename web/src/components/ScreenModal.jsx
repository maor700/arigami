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
import { createPortal } from 'react-dom';
import ScreenView from './ScreenView.jsx';
import { SCREEN_PRIORITY } from '../lib/useScreenConnection.js';
import { answerScreenRequest, cancelScreenRequest, openScreenRequest, setScreenModal, useStore } from '../lib/store.js';
import * as setupApi from '../lib/setup-api.js';
import { api } from '../lib/api.js';
import { useT } from '../lib/i18n.js';
import { Icon } from '../lib/icons.js';
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

        {context?.sessionId && (
          <div className="flex items-center gap-2 border-t border-hair px-4 py-2" title={t('screen.typeIntoHint')}>
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !typeBusy && typeIt(true)}
              placeholder={t('screen.typeInto')}
              dir="auto"
              spellCheck={false}
              className="min-w-0 flex-1 rounded-[7px] border-[1.5px] border-border bg-transparent px-2.5 py-1 font-mono text-[11.5px] text-fg outline-none placeholder:font-sans placeholder:text-fgdim"
            />
            <button type="button" disabled={typeBusy || !typed} onClick={() => typeIt(false)} className={btnSecondary}>{t('screen.typeSend')}</button>
            {typeErr && <span className="text-[11px] text-[#9c3b33]">{typeErr}</span>}
          </div>
        )}
        {setupCtx && (
          <div className="flex flex-wrap items-center gap-2 border-t border-hair px-4 py-2.5">
            <span dir="auto" className="min-w-0 flex-1 text-[11.5px] text-fgdim">
              {setupErr ? <span className="text-[#9c3b33]">{setupErr}</span> : t('setup.card.identityHint')}
            </span>
            <button type="button" disabled={busy} onClick={setupDone} title={t('setup.card.identityHint')} className={btnPrimary}>
              {busy ? t('setup.takeover.verifying') : t('setup.takeover.modalDone')}
            </button>
          </div>
        )}
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
        {req && doneErr && (
          <div data-screen-done-error dir="auto" className="border-t border-hair px-4 py-2 text-[11px] font-bold text-[#9c3b33]">{doneErr}</div>
        )}
      </div>
    </div>,
    document.body
  );
}
