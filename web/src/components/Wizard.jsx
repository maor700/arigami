// B3 — first-run wizard. A LINEAR, mobile-friendly stepper over the one
// onboarding state machine (server/onboarding.ts wizard()):
//   pair → claude → git → profile → integrations → repo → health
// Every step's status/skippability comes from GET /__api/onboarding/wizard;
// this component holds no provisioning logic of its own — it calls the same
// endpoints the Accounts / Setup / Settings views use, then re-reads the state.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { Icon } from '../lib/icons.js';
import { useT, currentLang, LANGS } from '../lib/i18n.js';
import { setPrefs } from '../lib/prefs.js';
import { useStore } from '../lib/store.js';
import { AddRepo } from './Setup.jsx';
import {
  faCheck,
  faArrowLeft,
  faArrowRight,
  faRotateRight,
  faXmark,
  faTriangleExclamation,
  faCircleNotch,
} from '@fortawesome/free-solid-svg-icons';

const PILL = {
  ok: 'border-[#bfe3cf] bg-[#EAF6EF] text-[#2f7d4f]',
  todo: 'border-[#e7d3a8] bg-[#FBF3E0] text-[#8a6d1f]',
  error: 'border-[#e2c4c0] bg-[#FBECEA] text-[#9c3b33]',
  blocked: 'border-hair bg-chip text-fgdim',
  skipped: 'border-hair bg-chip text-fgdim',
  running: 'border-[#bcd4ee] bg-[#EAF1FB] text-[#2C6BD6]',
};

const BTN = 'cursor-pointer rounded-[9px] border-[1.5px] border-ink bg-brand px-4 py-2 text-[13px] font-bold text-fg disabled:cursor-default disabled:opacity-50';
const BTN2 = 'cursor-pointer rounded-[9px] border-[1.5px] border-border bg-panel px-4 py-2 text-[12.5px] font-semibold text-fgdim hover:border-ink hover:text-fg disabled:opacity-50';
const INPUT = 'w-full rounded-[8px] border-[1.5px] border-border bg-bg px-3 py-2 text-[12.5px] text-fg outline-none focus:border-ink';
const CARD = 'rounded-[12px] border-[1.5px] border-ink bg-panel';

function Pill({ status }) {
  const t = useT();
  return (
    <span className={`shrink-0 rounded-full border px-2 py-px text-[9.5px] font-bold uppercase ${PILL[status] || PILL.blocked}`}>
      {t(`wizard.status.${status}`)}
    </span>
  );
}

function ErrorBox({ err }) {
  if (!err) return null;
  return (
    <div className="mt-3 rounded-[8px] border border-[#e2c4c0] bg-[#FBECEA] px-3 py-2 text-[11.5px] text-[#9c3b33]">
      <Icon icon={faTriangleExclamation} /> {String(err)}
    </div>
  );
}

// ---- step 1: pair ----------------------------------------------------------
function PairStep({ step }) {
  const t = useT();
  const { auth } = useStore();
  const [code, setCode] = useState(null);
  const [err, setErr] = useState(null);
  const issue = async () => {
    setErr(null);
    try {
      const r = await api.post('/auth/pairing-code', {});
      setCode(r.code);
    } catch (e) {
      setErr(e.message);
    }
  };
  return (
    <>
      <p className="text-[12.5px] leading-relaxed text-fgdim">{t('wizard.pair.body')}</p>
      {step.status === 'ok' && (
        <div className="mt-3 text-[12.5px] font-semibold text-[#2f7d4f]">
          <Icon icon={faCheck} /> {t('wizard.pair.paired', { email: auth?.user?.email || 'admin' })}
        </div>
      )}
      <div className="mt-4">
        <button type="button" className={BTN2} onClick={issue}>{t('wizard.pair.another')}</button>
        {code && (
          <div className="mt-3">
            <div className="inline-block rounded-[10px] border-[1.5px] border-ink bg-bg px-5 py-3 font-mono text-[22px] tracking-[0.2em] select-all">{code}</div>
            <div className="mt-1 text-[11px] text-fgdim">{t('wizard.pair.codeHint')}</div>
          </div>
        )}
      </div>
      <ErrorBox err={err} />
    </>
  );
}

// ---- step 2: claude --------------------------------------------------------
function ClaudeStep({ step, refresh }) {
  const t = useT();
  const [mode, setMode] = useState(null); // null | 'auth' | 'paste'
  const [flow, setFlow] = useState(null); // {id,url}
  const [code, setCode] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [copied, setCopied] = useState(false);

  const start = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.post('/accounts/oauth/start', { label: 'wizard' });
      if (r?.state === 'error') throw new Error(r.error || 'could not start sign-in');
      setFlow(r);
      setMode('auth');
      try { window.open(r.url, '_blank', 'noopener'); } catch { /* user clicks the link */ }
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  const exchange = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.post('/accounts/oauth/code', { id: flow.id, code: code.trim() });
      if (!r?.ok) throw new Error(r?.error || 'exchange failed');
      setFlow(null);
      setCode('');
      setMode(null);
      await refresh();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  const saveToken = async () => {
    setBusy(true);
    setErr(null);
    try {
      // F3 #2: the server verifies the token with a real `claude -p` probe
      // before storing it — a rejected token comes back as a 400 with the reason.
      await api.post('/onboarding/wizard/claude', { action: 'token', token: token.trim(), label: 'wizard' });
      setToken('');
      setMode(null);
      await refresh();
    } catch (e) {
      setErr(String(e.message || e).replace(/^HTTP \d+ — /, ''));
    } finally {
      setBusy(false);
    }
  };
  const cancel = () => {
    if (flow?.id) api.post('/accounts/oauth/cancel', { id: flow.id }).catch(() => {});
    setFlow(null);
    setMode(null);
    setCode('');
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(flow.url); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* ignore */ }
  };

  if (step.status === 'ok')
    return (
      <>
        <p className="text-[12.5px] leading-relaxed text-fgdim">{t('wizard.claude.body')}</p>
        <div className="mt-3 text-[12.5px] font-semibold text-[#2f7d4f]"><Icon icon={faCheck} /> {t('wizard.claude.connected')}</div>
      </>
    );
  if (!step.data?.cli)
    return (
      <>
        <p className="text-[12.5px] leading-relaxed text-fgdim">{t('wizard.claude.noCli')}</p>
        <code className="mt-2 block rounded-[6px] border border-hair bg-bg px-2 py-1.5 font-mono text-[11px] select-all">npm i -g @anthropic-ai/claude-code</code>
        <button type="button" className={`${BTN2} mt-3`} onClick={refresh}><Icon icon={faRotateRight} /> {t('wizard.recheck')}</button>
      </>
    );
  return (
    <>
      <p className="text-[12.5px] leading-relaxed text-fgdim">{t('wizard.claude.body')}</p>
      {mode === null && (
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" className={BTN} disabled={busy} onClick={start}>{t('wizard.claude.signIn')}</button>
          <button type="button" className={BTN2} onClick={() => setMode('paste')}>{t('wizard.claude.pasteToken')}</button>
        </div>
      )}
      {mode === 'auth' && flow && (
        <div className="mt-4 flex flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            <a href={flow.url} target="_blank" rel="noopener noreferrer" className={BTN}>{t('wizard.claude.openLink')} ↗</a>
            <button type="button" className={BTN2} onClick={copy}>{copied ? '✓' : t('wizard.claude.copyLink')}</button>
          </div>
          <div className="break-all rounded-[6px] border border-hair bg-bg px-2 py-1.5 font-mono text-[10px] text-fgdim select-all">{flow.url}</div>
          <div className="text-[11px] text-fgdim">{t('wizard.claude.linkHint')}</div>
          <input className={INPUT} value={code} onChange={(e) => setCode(e.target.value)} placeholder={t('wizard.claude.codePlaceholder')} spellCheck={false} onKeyDown={(e) => e.key === 'Enter' && code.trim() && exchange()} />
          <div className="flex gap-2">
            <button type="button" className={BTN} disabled={busy || !code.trim()} onClick={exchange}>{t('wizard.claude.exchange')}</button>
            <button type="button" className={BTN2} onClick={cancel}>{t('wizard.claude.cancel')}</button>
          </div>
        </div>
      )}
      {mode === 'paste' && (
        <div className="mt-4 flex flex-col gap-2">
          <input className={INPUT} type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={t('wizard.claude.tokenPlaceholder')} spellCheck={false} autoComplete="off" onKeyDown={(e) => e.key === 'Enter' && token.trim() && saveToken()} />
          <div className="flex gap-2">
            <button type="button" className={BTN} disabled={busy || !token.trim()} onClick={saveToken}>{t('wizard.claude.tokenSave')}</button>
            <button type="button" className={BTN2} onClick={() => setMode(null)}>{t('wizard.claude.cancel')}</button>
          </div>
        </div>
      )}
      <ErrorBox err={err} />
    </>
  );
}

// ---- step 3: git -----------------------------------------------------------
function GitStep({ step, ghLogin, refresh }) {
  const t = useT();
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const active = ghLogin && (ghLogin.state === 'starting' || ghLogin.state === 'awaiting');

  // Poll the wizard while a gh login is in flight (device-code flow).
  useEffect(() => {
    if (!active) return undefined;
    const id = setInterval(refresh, 2500);
    return () => clearInterval(id);
  }, [active, refresh]);

  const startGh = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.post('/onboarding/wizard/git', { action: 'gh-login' });
      if (r?.ghLogin?.state === 'error') setErr(r.ghLogin.error);
      await refresh();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  const saveToken = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.post('/onboarding/wizard/git', { action: 'token', token: token.trim() });
      setToken('');
      await refresh();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <p className="text-[12.5px] leading-relaxed text-fgdim">{t('wizard.git.body')}</p>
      {step.status === 'ok' && <div className="mt-3 text-[12.5px] font-semibold text-[#2f7d4f]"><Icon icon={faCheck} /> {t('wizard.git.connected')}</div>}
      {step.status !== 'ok' && (
        <div className="mt-4 flex flex-col gap-3">
          {step.data?.gh && !active && (
            <button type="button" className={BTN} disabled={busy} onClick={startGh}>{t('wizard.git.ghWeb')}</button>
          )}
          {active && (
            <div className={`${CARD} px-4 py-3`}>
              {ghLogin.code ? (
                <>
                  <div className="text-[11.5px] text-fgdim">{t('wizard.git.ghCode')} <a className="underline" href={ghLogin.url} target="_blank" rel="noopener noreferrer">{ghLogin.url}</a></div>
                  <div className="mt-2 inline-block rounded-[10px] border-[1.5px] border-ink bg-bg px-5 py-3 font-mono text-[22px] tracking-[0.2em] select-all">{ghLogin.code}</div>
                </>
              ) : null}
              <div className="mt-2 text-[11px] text-fgdim"><Icon icon={faCircleNotch} /> {t('wizard.git.ghWaiting')}</div>
            </div>
          )}
          {ghLogin?.state === 'done' && <div className="text-[12px] text-[#2f7d4f]">{t('wizard.git.ghDone')}</div>}
          {ghLogin?.state === 'error' && <ErrorBox err={ghLogin.error} />}
          <div className="text-[11px] text-fgdim">{t('wizard.git.orToken')}</div>
          <input className={INPUT} type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={t('wizard.git.tokenPlaceholder')} spellCheck={false} autoComplete="off" onKeyDown={(e) => e.key === 'Enter' && token.trim() && saveToken()} />
          <div><button type="button" className={BTN} disabled={busy || !token.trim()} onClick={saveToken}>{t('wizard.git.tokenSave')}</button></div>
        </div>
      )}
      <ErrorBox err={err} />
    </>
  );
}

// ---- step 4: profile -------------------------------------------------------
function ProfileStep({ step, refresh, onSkip }) {
  const t = useT();
  const [bundles, setBundles] = useState(null);
  const [pending, setPending] = useState(null);
  const [selected, setSelected] = useState(null);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    api.get('/profiles').then((r) => {
      setBundles(r.bundles || []);
      setPending(r.pending || null);
      const pre = r.pending?.name || r.pending?.source || step.data?.pending;
      if (pre) setSelected(String(pre));
    }).catch((e) => { setBundles([]); setErr(e.message); });
  }, [step.data?.pending]);

  const apply = async (source) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.post('/profiles/apply', { source });
      if (r?.report?.errors?.length) setErr(r.report.errors.join('; '));
      await refresh();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <p className="text-[12.5px] leading-relaxed text-fgdim">{t('wizard.profile.body')}</p>
      {step.status === 'ok' && <div className="mt-3 text-[12.5px] font-semibold text-[#2f7d4f]"><Icon icon={faCheck} /> {t('wizard.profile.applied', { name: step.data?.applied })}</div>}
      {bundles === null && <div className="mt-3 text-[12px] text-fgdim">{t('wizard.loading')}</div>}
      {bundles && bundles.length === 0 && <div className="mt-3 text-[12px] text-fgdim">{t('wizard.profile.none')}</div>}
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {(bundles || []).map((b) => {
          const isPending = pending && (pending.name === b.name || pending.source === b.name);
          const sel = selected === b.name;
          return (
            <button
              key={b.name}
              type="button"
              onClick={() => setSelected(b.name)}
              className={`text-start rounded-[12px] border-[1.5px] px-3 py-2.5 ${sel ? 'border-ink bg-brand/40' : 'border-border bg-panel hover:border-ink'}`}
            >
              <div className="flex items-center gap-2">
                <span className="text-[12.5px] font-bold text-fg">{b.title || b.name}</span>
                <span className="rounded-full border border-hair px-1.5 text-[9px] uppercase text-fgdim">{b.trusted ? t('wizard.profile.trusted') : 'ext'}</span>
                {isPending && <span className="rounded-full border border-[#e7d3a8] bg-[#FBF3E0] px-1.5 text-[9px] uppercase text-[#8a6d1f]">{t('wizard.profile.pending')}</span>}
              </div>
              {b.description && <div className="mt-0.5 text-[11px] leading-snug text-fgdim">{b.description}</div>}
              <div className="mt-1 font-mono text-[10px] text-fgdim">{(b.skills || []).length} skills · {b.cron || 0} cron{b.hasMemorySeed ? ' · memory' : ''}</div>
            </button>
          );
        })}
      </div>
      <div className="mt-3 flex flex-col gap-2">
        <input className={INPUT} value={url} onChange={(e) => { setUrl(e.target.value); if (e.target.value) setSelected(null); }} placeholder={t('wizard.profile.urlPlaceholder')} spellCheck={false} />
        {url && <div className="text-[10.5px] text-fgdim">{t('wizard.profile.external')}</div>}
        <div className="flex flex-wrap gap-2">
          <button type="button" className={BTN} disabled={busy || !(selected || url.trim())} onClick={() => apply(url.trim() || selected)}>
            {busy ? t('wizard.profile.applying') : t('wizard.profile.apply')}
          </button>
          {step.status !== 'ok' && <button type="button" className={BTN2} disabled={busy} onClick={onSkip}>{t('wizard.profile.blank')}</button>}
        </div>
      </div>
      <ErrorBox err={err} />
    </>
  );
}

// ---- step 5: integrations --------------------------------------------------
function IntegrationsStep({ step, refresh }) {
  const t = useT();
  const [key, setKey] = useState('');
  const [wa, setWa] = useState(null);
  const [remote, setRemote] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const pollRef = useRef(null);

  const loadWa = useCallback(() => api.get('/whatsapp/status').then(setWa).catch(() => setWa({ status: 'disconnected' })), []);
  useEffect(() => {
    loadWa();
    api.get('/remote').then(setRemote).catch(() => setRemote({ available: false }));
  }, [loadWa]);
  useEffect(() => {
    clearInterval(pollRef.current);
    if (wa?.status === 'qr' || wa?.status === 'starting') pollRef.current = setInterval(loadWa, 3000);
    return () => clearInterval(pollRef.current);
  }, [wa?.status, loadWa]);

  const saveKey = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.post('/onboarding/wizard/integrations', { action: 'composio-key', key: key.trim() });
      setKey('');
      await refresh();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  const connectWa = async () => {
    setBusy(true);
    setErr(null);
    try { setWa(await api.post('/whatsapp/connect', {})); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const toggleRemote = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.post('/remote', { enable: !remote?.serving });
      if (r?.ok === false) setErr(r.error);
      setRemote(r);
      await refresh();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const Row = ({ title, hint, children }) => (
    <div className={`${CARD} px-4 py-3`}>
      <div className="text-[12.5px] font-bold text-fg">{title}</div>
      <div className="text-[11px] text-fgdim">{hint}</div>
      <div className="mt-2">{children}</div>
    </div>
  );

  const composioSet = !!step.data?.composio;
  const qr = wa?.qr || wa?.qrUrl;
  return (
    <>
      <p className="text-[12.5px] leading-relaxed text-fgdim">{t('wizard.integrations.body')}</p>
      <div className="mt-3 flex flex-col gap-3">
        <Row title={t('wizard.integrations.composio')} hint={t('wizard.integrations.composioHint')}>
          {composioSet ? (
            <div className="text-[12px] text-[#2f7d4f]"><Icon icon={faCheck} /> {t('wizard.integrations.composioSet')}</div>
          ) : (
            <div className="flex gap-2">
              <input className={INPUT} type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={t('wizard.integrations.composioPlaceholder')} autoComplete="off" spellCheck={false} />
              <button type="button" className={BTN} disabled={busy || !key.trim()} onClick={saveKey}>{t('wizard.integrations.save')}</button>
            </div>
          )}
        </Row>
        <Row title={t('wizard.integrations.whatsapp')} hint={t('wizard.integrations.whatsappHint')}>
          {wa?.status === 'connected' ? (
            <div className="text-[12px] text-[#2f7d4f]"><Icon icon={faCheck} /> {t('wizard.integrations.whatsappConnected', { user: wa.user || '…' })}</div>
          ) : wa?.status === 'qr' && qr ? (
            <img src={qr} alt="WhatsApp QR" className="h-[200px] w-[200px] rounded-[8px] border border-hair bg-white" />
          ) : wa?.status === 'starting' || (wa?.status === 'qr' && !qr) ? (
            <div className="text-[12px] text-fgdim"><Icon icon={faCircleNotch} /> {t('wizard.integrations.whatsappStarting')}</div>
          ) : (
            <button type="button" className={BTN2} disabled={busy} onClick={connectWa}>{t('wizard.integrations.whatsappConnect')}</button>
          )}
        </Row>
        <Row title={t('wizard.integrations.tailscale')} hint={t('wizard.integrations.tailscaleHint')}>
          {remote === null ? (
            <div className="text-[12px] text-fgdim">{t('wizard.loading')}</div>
          ) : !remote.available ? (
            <div className="text-[12px] text-fgdim">{t('wizard.integrations.tailscaleMissing')}</div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" className={remote.serving ? BTN : BTN2} disabled={busy || remote.loggedIn === false} onClick={toggleRemote}>
                {remote.serving ? t('wizard.integrations.tailscaleOn') : t('wizard.integrations.tailscaleOff')}
              </button>
              {remote.reason && <span className="text-[11px] text-fgdim">{remote.reason}</span>}
              {remote.httpsUrl && <span className="font-mono text-[10.5px] text-fgdim">{remote.httpsUrl}</span>}
            </div>
          )}
        </Row>
      </div>
      <ErrorBox err={err} />
    </>
  );
}

// ---- step 6: repo ----------------------------------------------------------
function RepoStep({ step, refresh }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const add = async (entry) => {
    setBusy(true);
    setErr(null);
    try {
      await api.post('/onboarding/repos', entry);
      await refresh();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  const names = step.data?.repos || [];
  return (
    <>
      <p className="text-[12.5px] leading-relaxed text-fgdim">{t('wizard.repo.body')}</p>
      {names.length > 0 && <div className="mt-3 text-[12.5px] font-semibold text-[#2f7d4f]"><Icon icon={faCheck} /> {t('wizard.repo.have', { names: names.join(', ') })}</div>}
      <div className={`${CARD} mt-3 overflow-hidden`}>
        <AddRepo onAdd={add} busy={busy} />
      </div>
      <ErrorBox err={err} />
    </>
  );
}

// ---- step 7: health --------------------------------------------------------
function HealthStep({ step, refresh, onOpen }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const health = step.data?.health;
  const run = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.post('/onboarding/health', {});
      await refresh();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  const running = busy || step.status === 'running';
  return (
    <>
      <p className="text-[12.5px] leading-relaxed text-fgdim">{t('wizard.health.body')}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className={BTN2} disabled={running} onClick={run}>
          {running ? <><Icon icon={faCircleNotch} /> {t('wizard.health.running')}</> : <><Icon icon={faRotateRight} /> {t('wizard.health.run')}</>}
        </button>
      </div>
      {health && (
        <div className={`${CARD} mt-3 overflow-hidden`}>
          {health.checks.map((c) => (
            <div key={c.id} className="flex items-center gap-2.5 border-b border-hair px-3 py-2 last:border-0">
              <span className={`w-[52px] shrink-0 rounded-full border px-2 py-px text-center text-[9.5px] font-bold uppercase ${c.ok ? PILL.ok : c.required ? PILL.error : PILL.blocked}`}>
                {c.ok ? t('wizard.health.pass') : c.required ? t('wizard.health.fail') : t('wizard.health.optional')}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-[12px] font-semibold text-fg">{t(`wizard.health.check.${c.id}`)}</div>
                <div className="truncate font-mono text-[10px] text-fgdim">{c.detail}</div>
              </div>
            </div>
          ))}
          <div className={`px-3 py-2 text-[11.5px] ${health.ok ? 'text-[#2f7d4f]' : 'text-[#8a6d1f]'}`}>
            {health.ok ? t('wizard.health.allGood') : t('wizard.health.someFailed')}
          </div>
        </div>
      )}
      <ErrorBox err={err} />
      {health && (
        <button type="button" className={`${BTN} mt-4`} onClick={onOpen}>{t('wizard.openCockpit')} <Icon icon={faArrowRight} /></button>
      )}
    </>
  );
}

const STEP_TITLE = {
  pair: 'wizard.pair.title',
  claude: 'wizard.claude.title',
  git: 'wizard.git.title',
  profile: 'wizard.profile.title',
  integrations: 'wizard.integrations.title',
  repo: 'wizard.repo.title',
  health: 'wizard.health.title',
};

// ---- the stepper -----------------------------------------------------------
export default function Wizard({ onDone, onExit }) {
  const t = useT();
  const lang = currentLang();
  const [view, setView] = useState(null);
  const [idx, setIdx] = useState(null); // null = follow `current`
  const [err, setErr] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const v = await api.get('/onboarding/wizard');
      setView(v);
      setErr(null);
      return v;
    } catch (e) {
      setErr(e.message);
      return null;
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Live updates: the server broadcasts every step transition on the ws bus.
  const { wizardTick } = useStore();
  useEffect(() => {
    if (wizardTick) refresh();
  }, [wizardTick, refresh]);

  const steps = view?.steps || [];
  const cur = idx ?? Math.max(0, steps.findIndex((s) => s.id === view?.current));
  const step = steps[cur];

  const act = async (action) => {
    try {
      const v = await api.post(`/onboarding/wizard/${step.id}`, { action });
      setView(v);
      if (action === 'skip') setIdx(Math.min(cur + 1, steps.length - 1));
    } catch (e) {
      setErr(e.message);
    }
  };
  const next = async () => {
    // Manual-decision steps become 'complete' when the user continues.
    if (step.id === 'integrations' && step.status !== 'ok') await act('complete');
    if (cur < steps.length - 1) setIdx(cur + 1);
  };
  const finish = async () => {
    if (step.id === 'health' && step.status !== 'ok') await act('complete');
    onDone?.();
  };
  const toggleLang = () => setPrefs({ language: lang === 'he' ? 'en' : 'he' });

  const settled = step && (step.status === 'ok' || step.status === 'skipped');
  const canNext = step && (settled || step.id === 'integrations');

  return (
    <div dir={LANGS[lang]?.dir || 'ltr'} className="flex min-h-screen flex-col items-center bg-bg p-4 text-fg sm:p-8">
      <div className="w-full max-w-[640px]">
        <div className="mb-4 flex items-center gap-2">
          <span className="flex items-end gap-0.5" aria-hidden="true">
            {[10, 16, 12, 19].map((h, i) => <span key={i} className="inline-block w-1 bg-brand" style={{ height: h }} />)}
          </span>
          <span className="text-[18px] font-bold">{t('wizard.title')}</span>
          <button type="button" onClick={toggleLang} className="ms-auto rounded-[6px] border border-border px-2 py-0.5 text-[11px] text-fgdim hover:border-ink hover:text-fg">{t('wizard.lang')}</button>
          <button type="button" onClick={onExit} title={t('wizard.exitHint')} className="cursor-pointer px-1 text-[15px] text-fgdim hover:text-fg"><Icon icon={faXmark} /></button>
        </div>
        <p className="mb-4 text-[12px] text-fgdim">{t('wizard.subtitle')}</p>

        {/* stepper rail */}
        <ol className="mb-4 flex flex-wrap gap-1.5">
          {steps.map((s, i) => (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => setIdx(i)}
                className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] ${i === cur ? 'border-ink bg-brand font-bold' : 'border-border bg-panel text-fgdim hover:border-ink'}`}
              >
                <span className={`inline-flex h-4 w-4 items-center justify-center rounded-full text-[9px] ${s.status === 'ok' ? 'bg-[#2f7d4f] text-white' : s.status === 'skipped' ? 'bg-chip text-fgdim' : 'bg-bg text-fg border border-border'}`}>
                  {s.status === 'ok' ? <Icon icon={faCheck} /> : i + 1}
                </span>
                <span className="hidden sm:inline">{t(STEP_TITLE[s.id])}</span>
              </button>
            </li>
          ))}
        </ol>

        {err && <ErrorBox err={err} />}
        {!view && !err && <div className="text-[12px] text-fgdim">{t('wizard.loading')}</div>}

        {step && (
          <div className={`${CARD} px-5 py-5`}>
            <div className="mb-1 flex items-center gap-2">
              <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-fgdim">{t('wizard.stepOf', { n: cur + 1, total: steps.length })}</span>
              <Pill status={step.status} />
            </div>
            <h2 className="mb-2 text-[16px] font-bold">{t(STEP_TITLE[step.id])}</h2>

            {step.id === 'pair' && <PairStep step={step} />}
            {step.id === 'claude' && <ClaudeStep step={step} refresh={refresh} />}
            {step.id === 'git' && <GitStep step={step} ghLogin={view?.ghLogin} refresh={refresh} />}
            {step.id === 'profile' && <ProfileStep step={step} refresh={refresh} onSkip={() => act('skip')} />}
            {step.id === 'integrations' && <IntegrationsStep step={step} refresh={refresh} />}
            {step.id === 'repo' && <RepoStep step={step} refresh={refresh} />}
            {step.id === 'health' && <HealthStep step={step} refresh={refresh} onOpen={finish} />}

            <div className="mt-6 flex flex-wrap items-center gap-2 border-t border-hair pt-4">
              <button type="button" className={BTN2} disabled={cur === 0} onClick={() => setIdx(cur - 1)}><Icon icon={faArrowLeft} /> {t('wizard.back')}</button>
              <span className="ms-auto" />
              {step.skippable && !settled && step.id !== 'profile' && (
                <button type="button" className={BTN2} onClick={() => act('skip')}>{t('wizard.skip')}</button>
              )}
              {cur < steps.length - 1 ? (
                <button type="button" className={BTN} disabled={!canNext} onClick={next}>
                  {step.id === 'integrations' && !settled ? t('wizard.integrations.continue') : t('wizard.next')} <Icon icon={faArrowRight} />
                </button>
              ) : (
                <button type="button" className={BTN} onClick={finish}>{t('wizard.openCockpit')} <Icon icon={faArrowRight} /></button>
              )}
            </div>
          </div>
        )}
        {view?.done && (
          <div className="mt-3 text-center text-[12px] text-[#2f7d4f]"><Icon icon={faCheck} /> {t('wizard.done')}</div>
        )}
      </div>
    </div>
  );
}
