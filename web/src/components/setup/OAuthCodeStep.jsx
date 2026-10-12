// S2 — manual.kind 'oauth'. Four flows, chosen by `manual.flow`:
//   pkce     Claude: open the authorize link (any device), paste the code back.
//   device   GitHub: show the device code + link, poll until authorized.
//   redirect Composio: open the provider's consent page in a new tab, poll.
//   mcp      M1, a native remote-MCP vendor: open the vendor's authorize link,
//            approve, and let `claude mcp login` catch the loopback callback —
//            polling notices. That callback is on the HOST, so a cockpit open on
//            a phone can't complete it; hence the same page also takes the final
//            redirect URL pasted back (the CLI's own "paste the redirect URL"
//            path). Both are offered; whichever lands first wins.
//   codex    Codex: `codex login` on the host; same loopback + paste-back as mcp.
// Every flow also offers "paste a token instead" (TokenStep) when
// `manual.token` is true. Links are absolute provider URLs the server hands
// back — never a host-local address — so they work from a phone too.
import { useEffect, useRef, useState } from 'react';
import { useT } from '../../lib/i18n.js';
import { Icon } from '../../lib/icons.js';
import { serverText } from '../../lib/server-text.js';
import * as setupApi from '../../lib/setup-api.js';
import TokenStep from './TokenStep.jsx';
import { BTN, BTN2, INPUT, CARD, ErrorBox, Spinner, useAction } from './shared.jsx';
import { faCheck } from '@fortawesome/free-solid-svg-icons';

const POLL_MS = 2500;

// `signInLabel` overrides the primary button's text (the engine cards say "Connect Claude" / "Connect Codex");
// `onPhase('idle'|'waiting'|'error')` lets a wrapper highlight which numbered step the person is on.
export default function OAuthCodeStep({ capability, manual = {}, onDone, onCancel, sessionId, owner, signInLabel, onPhase }) {
  const own = owner ? { owner } : {}; // A2: an agent's OAuth account is keyed by its owner
  const t = useT();
  const flow = manual.flow || 'pkce';
  // Flows where the human can finish by pasting something back from the browser.
  const pasteBack = flow === 'pkce' || flow === 'mcp' || flow === 'codex';
  const loopback = flow === 'mcp' || flow === 'codex'; // paste the redirect URL, then keep polling
  const [mode, setMode] = useState(null); // null | 'link' | 'token'
  const [link, setLink] = useState(null); // {id?, url, code?}
  const [code, setCode] = useState('');
  const [copied, setCopied] = useState(false);
  const [blocked, setBlocked] = useState(false); // the browser swallowed window.open
  const [slow, setSlow] = useState(false); // waiting for a long time — offer a fresh start
  const { busy, err, run, setErr } = useAction();
  const pollRef = useRef(null);
  const doneRef = useRef(false);
  // The parent passes a fresh onDone on every render (and it re-renders on every
  // live update). As an effect dependency that restarted the poll each time and
  // dropped the reply already in flight, so a finished sign-in never closed the
  // dialog. Read it through a ref instead.
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  const onPhaseRef = useRef(onPhase);
  onPhaseRef.current = onPhase;
  useEffect(() => {
    onPhaseRef.current?.(err ? 'error' : mode === 'link' ? 'waiting' : 'idle');
  }, [err, mode]);
  useEffect(() => {
    setSlow(false);
    if (mode !== 'link') return undefined;
    const id = setTimeout(() => setSlow(true), 120_000);
    return () => clearTimeout(id);
  }, [mode, link]);

  // device/redirect flows: poll the server until it reports the credential.
  // F8: pkce too when the consent runs in a session desktop — the host reads
  // the callback URL out of that Chrome and finishes the exchange by itself.
  useEffect(() => {
    if (mode !== 'link' || (flow === 'pkce' && !sessionId) || !link) return undefined;
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await setupApi.connect(capability, { action: 'poll', id: link.id, ...own });
        if (cancelled) return;
        // github reports under `device`, codex/claude at the top level
        if (r?.device?.state === 'error') { setErr(r.device.error || 'failed'); return; }
        if (r?.state === 'error') { setErr(r.error || 'failed'); return; }
        if (r?.device?.code && !link.code) setLink((l) => ({ ...l, code: r.device.code, url: r.device.url || l.url }));
        if ((r?.ok || r?.state === 'done' || r?.device?.state === 'done') && !doneRef.current) {
          doneRef.current = true;
          clearInterval(pollRef.current);
          onDoneRef.current?.(r);
        }
      } catch (e) {
        if (!cancelled) setErr(e.message);
      }
    };
    pollRef.current = setInterval(tick, POLL_MS);
    return () => { cancelled = true; clearInterval(pollRef.current); };
  }, [mode, flow, link, capability, setErr, sessionId]);

  const start = () =>
    run(async () => {
      const r = await setupApi.connect(capability, { action: flow === 'device' ? 'device' : 'start', ...(sessionId ? { sessionId } : {}), ...own });
      if (r?.state === 'error' || r?.device?.state === 'error') throw new Error(r.error || r.device?.error || 'could not start sign-in');
      const l = flow === 'device'
        ? { url: r?.device?.url || r?.url, code: r?.device?.code || r?.code, id: r?.id }
        : { url: r?.url, id: r?.id };
      if (!l.url && flow !== 'device') throw new Error(t('setup.oauth.noUrl'));
      setLink(l);
      setMode('link');
      setBlocked(false);
      if (l.url) {
        // window.open after an await can be blocked as an unsolicited popup — then the button below is the way in.
        // (no 'noopener' feature: it makes window.open return null even on success, hiding a block)
        try { const w = window.open(l.url, '_blank'); if (w) w.opener = null; else setBlocked(true); } catch { setBlocked(true); }
      }
    });

  const exchange = () =>
    run(async () => {
      const r = await setupApi.connect(capability, { action: 'code', id: link?.id, code: code.trim(), ...own });
      if (r && r.ok === false && r.state !== 'awaiting') throw new Error(r.error || 'exchange failed');
      setCode('');
      // M1: handing the redirect URL to `claude mcp login` is not the end — the
      // token exchange happens after it, so stay on the card and let the poll
      // report success (the pkce flow, by contrast, is done at this point).
      if (loopback) return;
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

  const cancel = (restarting = false) => {
    if (link?.id || flow === 'device') setupApi.connect(capability, { action: 'cancel', id: link?.id, ...own }).catch(() => {});
    setLink(null);
    setMode(null);
    setCode('');
    setErr(null); // a stale failure must not follow the person into the next attempt
    if (!restarting) onCancel?.();
  };
  const pasteClip = async () => {
    try { const v = await navigator.clipboard.readText(); if (v) setCode(v.trim()); } catch { /* permission denied: the field is right there */ }
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(link.url); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* ignore */ }
  };

  if (mode === 'token')
    return <TokenStep capability={capability} onDone={onDone} onCancel={() => setMode(null)} autoFocus />;

  if (mode === 'link' && link)
    return (
      <div className="flex flex-col gap-2">
        {/* live state: what is happening now and what the person does next */}
        {err ? (
          <div role="alert" dir="auto" className="rounded-[8px] border border-err-line bg-err-bg px-3 py-2 text-[12px] text-err">
            <div className="font-bold">{t('setup.oauth.failed')}</div>
            <div className="mt-0.5 text-[11.5px]">{serverText(String(err).replace(/^HTTP \d+ — /, ''))}</div>
          </div>
        ) : (
          <div role="status" dir="auto" className="rounded-[8px] border border-info-line bg-info-bg px-3 py-2 text-[12px] font-semibold text-info">
            <Spinner>{t(flow === 'device' ? 'setup.oauth.waiting' : 'setup.oauth.waitingSignIn')}</Spinner>
          </div>
        )}
        {blocked && !err && <div className="text-[11.5px] text-warn">{t('setup.oauth.popupBlocked')}</div>}
        {link.url && (
          <div className="flex flex-wrap gap-2">
            <a href={link.url} target="_blank" rel="noopener noreferrer" className={`${err ? BTN2 : BTN} inline-flex items-center`}>{t('setup.oauth.openLink')} ↗</a>
            <button type="button" className={BTN2} onClick={copy}>{copied ? <Icon icon={faCheck} /> : t('setup.oauth.copyLink')}</button>
          </div>
        )}
        {link.url && (
          <details className="text-[11.5px] text-fgdim">
            <summary className="cursor-pointer select-none py-1">{t('setup.oauth.showLink')}</summary>
            <div dir="ltr" className="mt-1 max-h-[4.5rem] overflow-auto break-all rounded-[6px] border border-hair bg-bg px-2 py-1.5 font-mono text-[11.5px] md:text-[10px] select-all">{link.url}</div>
          </details>
        )}
        {flow === 'device' && (
          <div className={`${CARD} px-4 py-3`}>
            <div className="text-[11.5px] text-fgdim">{t('setup.oauth.deviceCode')}</div>
            {link.code ? (
              <div dir="ltr" className="mt-2 inline-block rounded-[10px] border-[1.5px] border-ink bg-bg px-5 py-3 font-mono text-[22px] tracking-[0.2em] select-all">{link.code}</div>
            ) : (
              <div className="mt-2"><Spinner>{t('setup.oauth.gettingCode')}</Spinner></div>
            )}
          </div>
        )}
        {pasteBack && (
          <>
            <div className="text-[11.5px] leading-snug text-fgdim">{t(flow === 'codex' ? 'setup.oauth.codexHint' : loopback ? 'setup.oauth.mcpHint' : 'setup.oauth.linkHint')}</div>
            <div className="flex gap-2">
              <input className={`${INPUT} min-w-0 flex-1`} dir="auto" value={code} onChange={(e) => setCode(e.target.value)} placeholder={t(loopback ? 'setup.oauth.redirectPlaceholder' : 'setup.oauth.codePlaceholder')} spellCheck={false} autoCapitalize="off" autoCorrect="off" onKeyDown={(e) => e.key === 'Enter' && code.trim() && exchange()} />
              {navigator.clipboard?.readText && <button type="button" className={BTN2} onClick={pasteClip}>{t('setup.oauth.paste')}</button>}
            </div>
          </>
        )}
        {slow && !err && <div className="text-[11.5px] text-fgdim">{t('setup.oauth.slow')}</div>}
        <div className="flex flex-wrap gap-2">
          {pasteBack && <button type="button" className={BTN} disabled={busy || !code.trim()} onClick={exchange}>{t(loopback ? 'setup.oauth.submitRedirect' : 'setup.oauth.exchange')}</button>}
          {(err || slow) && <button type="button" className={BTN} disabled={busy} onClick={() => { cancel(true); start(); }}>{t('setup.oauth.tryAgain')}</button>}
          <button type="button" className={BTN2} onClick={() => cancel()}>{t('setup.cancel')}</button>
        </div>
        {flow === 'pkce' && sessionId && <button type="button" className="cursor-pointer self-start py-1 text-[11.5px] text-fgdim underline hover:text-fg disabled:opacity-50" disabled={busy} onClick={readFromBrowser} title={t('setup.oauth.readBrowserHint')}>{t('setup.oauth.readBrowser')}</button>}
      </div>
    );

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        <button type="button" className={BTN} disabled={busy} onClick={start}>
          {signInLabel || t(flow === 'device' ? 'setup.oauth.signInDevice' : flow === 'redirect' ? 'setup.oauth.signInRedirect' : flow === 'mcp' ? 'setup.oauth.signInMcp' : flow === 'codex' ? 'setup.oauth.signInCodex' : 'setup.oauth.signIn')}
        </button>
        {manual.token !== false && <button type="button" className={BTN2} onClick={() => setMode('token')}>{t('setup.oauth.pasteToken')}</button>}
        {onCancel && <button type="button" className={BTN2} onClick={onCancel}>{t('setup.cancel')}</button>}
      </div>
      {err && (
        <div role="alert" dir="auto" className="rounded-[8px] border border-err-line bg-err-bg px-3 py-2 text-[12px] text-err">
          <div className="font-bold">{t('setup.oauth.failed')}</div>
          <div className="mt-0.5 text-[11.5px]">{serverText(String(err).replace(/^HTTP \d+ — /, ''))}</div>
          <div className="mt-1 text-fgdim">{t('setup.oauth.retryHint')}</div>
        </div>
      )}
    </div>
  );
}
