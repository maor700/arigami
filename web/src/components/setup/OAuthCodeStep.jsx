// S2 — manual.kind 'oauth'. Three flows, chosen by `manual.flow`:
//   pkce     Claude: open the authorize link (any device), paste the code back.
//   device   GitHub: show the device code + link, poll until authorized.
//   redirect Composio: open the provider's consent page in a new tab, poll.
// Every flow also offers "paste a token instead" (TokenStep) when
// `manual.token` is true. Links are absolute provider URLs the server hands
// back — never a host-local address — so they work from a phone too.
import { useEffect, useRef, useState } from 'react';
import { useT } from '../../lib/i18n.js';
import { Icon } from '../../lib/icons.js';
import * as setupApi from '../../lib/setup-api.js';
import TokenStep from './TokenStep.jsx';
import { BTN, BTN2, INPUT, CARD, ErrorBox, Spinner, useAction } from './shared.jsx';
import { faCheck } from '@fortawesome/free-solid-svg-icons';

const POLL_MS = 2500;

export default function OAuthCodeStep({ capability, manual = {}, onDone, onCancel, sessionId }) {
  const t = useT();
  const flow = manual.flow || 'pkce';
  const [mode, setMode] = useState(null); // null | 'link' | 'token'
  const [link, setLink] = useState(null); // {id?, url, code?}
  const [code, setCode] = useState('');
  const [copied, setCopied] = useState(false);
  const { busy, err, run, setErr } = useAction();
  const pollRef = useRef(null);
  const doneRef = useRef(false);

  // device/redirect flows: poll the server until it reports the credential.
  // F8: pkce too when the consent runs in a session desktop — the host reads
  // the callback URL out of that Chrome and finishes the exchange by itself.
  useEffect(() => {
    if (mode !== 'link' || (flow === 'pkce' && !sessionId) || !link) return undefined;
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await setupApi.connect(capability, { action: 'poll', id: link.id });
        if (cancelled) return;
        if (r?.device?.state === 'error') { setErr(r.device.error || 'failed'); return; }
        if (r?.device?.code && !link.code) setLink((l) => ({ ...l, code: r.device.code, url: r.device.url || l.url }));
        if ((r?.ok || r?.state === 'done' || r?.device?.state === 'done') && !doneRef.current) {
          doneRef.current = true;
          onDone?.(r);
        }
      } catch (e) {
        if (!cancelled) setErr(e.message);
      }
    };
    pollRef.current = setInterval(tick, POLL_MS);
    return () => { cancelled = true; clearInterval(pollRef.current); };
  }, [mode, flow, link, capability, onDone, setErr, sessionId]);

  const start = () =>
    run(async () => {
      const r = await setupApi.connect(capability, { action: flow === 'device' ? 'device' : 'start', ...(sessionId ? { sessionId } : {}) });
      if (r?.state === 'error' || r?.device?.state === 'error') throw new Error(r.error || r.device?.error || 'could not start sign-in');
      const l = flow === 'device'
        ? { url: r?.device?.url || r?.url, code: r?.device?.code || r?.code, id: r?.id }
        : { url: r?.url, id: r?.id };
      if (!l.url && flow !== 'device') throw new Error(t('setup.oauth.noUrl'));
      setLink(l);
      setMode('link');
      if (l.url) { try { window.open(l.url, '_blank', 'noopener'); } catch { /* user clicks the link */ } }
    });

  const exchange = () =>
    run(async () => {
      const r = await setupApi.connect(capability, { action: 'code', id: link?.id, code: code.trim() });
      if (r && r.ok === false) throw new Error(r.error || 'exchange failed');
      setCode('');
      setLink(null);
      setMode(null);
      onDone?.(r);
    });

  // F8: "can't paste? read the code from the browser" — for the take-over case
  // where the human's clipboard never reaches the VNC desktop.
  const readFromBrowser = () =>
    run(async () => {
      const r = await setupApi.connect(capability, { action: 'read-browser', id: link?.id, sessionId });
      if (r && r.ok === false) throw new Error(r.error || t('setup.oauth.readBrowserMissing'));
      setCode('');
      setLink(null);
      setMode(null);
      onDone?.(r);
    });

  const cancel = () => {
    if (flow === 'pkce' && link?.id) setupApi.connect(capability, { action: 'cancel', id: link.id }).catch(() => {});
    setLink(null);
    setMode(null);
    setCode('');
    onCancel?.();
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(link.url); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* ignore */ }
  };

  if (mode === 'token')
    return <TokenStep capability={capability} onDone={onDone} onCancel={() => setMode(null)} autoFocus />;

  if (mode === 'link' && link)
    return (
      <div className="flex flex-col gap-2">
        {link.url && (
          <div className="flex flex-wrap gap-2">
            <a href={link.url} target="_blank" rel="noopener noreferrer" className={BTN}>{t('setup.oauth.openLink')} ↗</a>
            <button type="button" className={BTN2} onClick={copy}>{copied ? <Icon icon={faCheck} /> : t('setup.oauth.copyLink')}</button>
          </div>
        )}
        {link.url && <div dir="ltr" className="break-all rounded-[6px] border border-hair bg-bg px-2 py-1.5 font-mono text-[10px] text-fgdim select-all">{link.url}</div>}
        {flow === 'device' && (
          <div className={`${CARD} px-4 py-3`}>
            <div className="text-[11.5px] text-fgdim">{t('setup.oauth.deviceCode')}</div>
            {link.code ? (
              <div dir="ltr" className="mt-2 inline-block rounded-[10px] border-[1.5px] border-ink bg-bg px-5 py-3 font-mono text-[22px] tracking-[0.2em] select-all">{link.code}</div>
            ) : null}
            <div className="mt-2"><Spinner>{t('setup.oauth.waiting')}</Spinner></div>
          </div>
        )}
        {flow === 'redirect' && <Spinner>{t('setup.oauth.waitingConsent')}</Spinner>}
        {flow === 'pkce' && (
          <>
            <div className="text-[11px] text-fgdim">{t('setup.oauth.linkHint')}</div>
            <input className={INPUT} value={code} onChange={(e) => setCode(e.target.value)} placeholder={t('setup.oauth.codePlaceholder')} spellCheck={false} onKeyDown={(e) => e.key === 'Enter' && code.trim() && exchange()} />
          </>
        )}
        <div className="flex gap-2">
          {flow === 'pkce' && <button type="button" className={BTN} disabled={busy || !code.trim()} onClick={exchange}>{t('setup.oauth.exchange')}</button>}
          {flow === 'pkce' && sessionId && <button type="button" className={BTN2} disabled={busy} onClick={readFromBrowser} title={t('setup.oauth.readBrowserHint')}>{t('setup.oauth.readBrowser')}</button>}
          <button type="button" className={BTN2} onClick={cancel}>{t('setup.cancel')}</button>
        </div>
        <ErrorBox err={err} />
      </div>
    );

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        <button type="button" className={BTN} disabled={busy} onClick={start}>
          {t(flow === 'device' ? 'setup.oauth.signInDevice' : flow === 'redirect' ? 'setup.oauth.signInRedirect' : 'setup.oauth.signIn')}
        </button>
        {manual.token !== false && <button type="button" className={BTN2} onClick={() => setMode('token')}>{t('setup.oauth.pasteToken')}</button>}
        {onCancel && <button type="button" className={BTN2} onClick={onCancel}>{t('setup.cancel')}</button>}
      </div>
      <ErrorBox err={err} />
    </div>
  );
}
