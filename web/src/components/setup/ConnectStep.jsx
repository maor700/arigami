// ONE way to connect a service (mcp:<service>), wherever it is asked for: the
// chat card, Settings, the session's MCP view. A single button; the host first
// tries on its own in the browser where you are signed in (server
// lib/consent-runner.ts) and asks you only at the point it stops — a password,
// 2FA, a choice it cannot make. No Automatic/Manual choice, no engine choice.
//
//   idle          Connect
//   running       the host is on the vendor's page by itself
//   needs you     why, and a button that opens the vendor's page for you;
//                 a paste field only if the page cannot come back by itself
//   done          onDone(result)
import { useEffect, useRef, useState } from 'react';
import { useT } from '../../lib/i18n.js';
import { Icon } from '../../lib/icons.js';
import * as setupApi from '../../lib/setup-api.js';
import { faCircleNotch, faArrowUpRightFromSquare } from '@fortawesome/free-solid-svg-icons';
import { BTN, BTN2, INPUT, ErrorBox } from './shared.jsx';

const POLL_MS = 2000;

export default function ConnectStep({ capability, owner, sessionId, title, onDone, onCancel }) {
  const t = useT();
  const own = owner ? { owner } : {};
  const [phase, setPhase] = useState('idle'); // idle | running | person | manual
  const [link, setLink] = useState(null);
  const [reason, setReason] = useState('');
  const [opened, setOpened] = useState(false);
  const [paste, setPaste] = useState('');
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  // a fresh onDone per parent render must not restart the poll (it dropped replies before)
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  const doneRef = useRef(false);

  useEffect(() => {
    if (phase === 'idle') return undefined;
    let cancelled = false;
    const id = setInterval(async () => {
      try {
        const r = await setupApi.connect(capability, { action: 'poll', ...own });
        if (cancelled || doneRef.current) return;
        if (r?.ok || r?.state === 'done') {
          doneRef.current = true;
          clearInterval(id);
          onDoneRef.current?.(r);
          return;
        }
        if (r?.state === 'error') setErr(r.error || t('setup.connect.failed'));
        const a = r?.auto;
        if (a?.status === 'needs-person' || a?.status === 'failed') {
          setReason(a.reason || '');
          setPhase((p) => (p === 'running' ? 'person' : p));
        }
      } catch (e) {
        if (!cancelled) setErr(e.message);
      }
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [phase === 'idle', capability, owner]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await setupApi.connect(capability, { action: 'start', ...(sessionId ? { sessionId } : {}), ...own });
      if (r?.ok || r?.state === 'done') {
        doneRef.current = true;
        onDoneRef.current?.(r);
        return;
      }
      if (r?.state === 'error') throw new Error(r.error || t('setup.connect.failed'));
      setLink(r?.url || null);
      if (r?.auto) setPhase('running');
      else {
        // the host cannot run it itself here: open the vendor's page right away
        setPhase('manual');
        openVendor(r?.url);
      }
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  const openVendor = (u = link) => {
    if (!u) return;
    setOpened(true);
    try {
      window.open(u, '_blank', 'noopener');
    } catch {
      /* the link below still works */
    }
  };
  const finish = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await setupApi.connect(capability, { action: 'paste', code: paste.trim(), ...own });
      if (r?.ok || r?.state === 'done') {
        doneRef.current = true;
        onDoneRef.current?.(r);
      }
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  const cancel = () => {
    setupApi.connect(capability, { action: 'cancel', ...own }).catch(() => {});
    setPhase('idle');
    onCancel?.();
  };

  const name = title || capability.replace(/^mcp:/, '');
  return (
    <div className="flex flex-col gap-2 text-[12px]" data-connect-phase={phase}>
      {phase === 'idle' && (
        <>
          <p className="text-[11.5px] leading-snug text-fgdim">{t('setup.connect.intro', { name })}</p>
          <div className="flex items-center gap-2">
            <button type="button" className={BTN} disabled={busy} onClick={start} data-connect-start>{t('setup.connect.go')}</button>
          </div>
        </>
      )}
      {phase === 'running' && (
        <div className="flex flex-wrap items-center gap-2 text-fgdim" data-connect-running>
          <Icon icon={faCircleNotch} spin />
          <span>{t('setup.connect.running', { name })}</span>
          <button type="button" className="ms-auto cursor-pointer text-[11px] underline" onClick={() => { setPhase('person'); openVendor(); }}>{t('setup.connect.myself')}</button>
        </div>
      )}
      {(phase === 'person' || phase === 'manual') && (
        <>
          {phase === 'person' && (
            <div className="rounded-[8px] border border-warn-line bg-warn-bg px-2.5 py-2 text-[11.5px] leading-snug text-warn" data-connect-needs-you>
              <b>{t('setup.connect.needsYou', { name })}</b>
              {reason ? ` ${reason}.` : ''}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className={BTN} onClick={() => openVendor()}>
              {t('setup.connect.open', { name })} <Icon icon={faArrowUpRightFromSquare} />
            </button>
            {opened && <span className="flex items-center gap-1.5 text-fgdim"><Icon icon={faCircleNotch} spin /> {t('setup.connect.waiting')}</span>}
            <button type="button" className={BTN2} onClick={cancel}>{t('setup.cancel')}</button>
          </div>
          {opened && (
            <details className="text-[11px] text-fgdim">
              <summary className="cursor-pointer">{t('setup.connect.pasteSummary')}</summary>
              <div className="mt-1.5 flex gap-2">
                <input className={INPUT} value={paste} onChange={(e) => setPaste(e.target.value)} placeholder={t('setup.oauth.redirectPlaceholder')} spellCheck={false} />
                <button type="button" className={BTN2} disabled={busy || !paste.trim()} onClick={finish}>{t('setup.connect.finish')}</button>
              </div>
            </details>
          )}
        </>
      )}
      <ErrorBox err={err} />
    </div>
  );
}
