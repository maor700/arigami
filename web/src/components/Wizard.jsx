// B3 — first-run wizard. A LINEAR, mobile-friendly stepper over the one
// onboarding state machine (server/onboarding.ts wizard()):
//   pair → claude → git → profile → integrations → repo → telemetry → health
// Every step's status/skippability comes from GET /__api/onboarding/wizard.
// S2: the credential steps are a thin list of the shared setup components
// (web/src/components/setup/*) — the same ones the chat's SetupCard and
// Settings → Connections render — so the wizard holds no provisioning UI of
// its own. In minimal mode (S1) the server marks the wizard done right after
// Claude; "Run full setup" from the Setup screen reopens the full list.
import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { Icon } from '../lib/icons.js';
import { useT, currentLang, LANGS } from '../lib/i18n.js';
import { setPrefs } from '../lib/prefs.js';
import { useStore } from '../lib/store.js';
import { OAuthCodeStep, TokenStep, QrStep, ToggleStep, RepoStep } from './setup/index.js';
import { BTN, BTN2, INPUT, CARD, BODY, PILL, ErrorBox, OkLine, Spinner } from './setup/shared.jsx';
import {
  faCheck,
  faArrowLeft,
  faArrowRight,
  faRotateRight,
  faXmark,
} from '@fortawesome/free-solid-svg-icons';

function Pill({ status }) {
  const t = useT();
  return (
    <span className={`shrink-0 rounded-full border px-2 py-px text-[11px] md:text-[9.5px] font-bold uppercase ${PILL[status] || PILL.blocked}`}>
      {t(`wizard.status.${status}`)}
    </span>
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

// ---- step 2: claude / step 3: git — the shared setup components ------------
// (web/src/components/setup/*): the same OAuthCodeStep/TokenStep the chat's
// SetupCard renders. The wizard only adds the step's copy + "done" line.
function ClaudeStep({ step, refresh }) {
  const t = useT();
  if (step.status === 'ok')
    return (
      <>
        <p className={BODY}>{t('wizard.claude.body')}</p>
        <OkLine>{t('wizard.claude.connected')}</OkLine>
      </>
    );
  if (!step.data?.cli)
    return (
      <>
        <p className={BODY}>{t('wizard.claude.noCli')}</p>
        <code className="mt-2 block rounded-[6px] border border-hair bg-bg px-2 py-1.5 font-mono text-[11px] select-all">npm i -g @anthropic-ai/claude-code</code>
        <button type="button" className={`${BTN2} mt-3`} onClick={refresh}><Icon icon={faRotateRight} /> {t('wizard.recheck')}</button>
      </>
    );
  return (
    <>
      <p className={`${BODY} mb-4`}>{t('wizard.claude.body')}</p>
      <OAuthCodeStep capability="claude" manual={{ kind: 'oauth', flow: 'pkce', token: true }} onDone={refresh} />
    </>
  );
}

function GitStep({ step, refresh }) {
  const t = useT();
  return (
    <>
      <p className={`${BODY} mb-4`}>{t('wizard.git.body')}</p>
      {step.status === 'ok' ? (
        <OkLine>{t('wizard.git.connected')}</OkLine>
      ) : (
        <OAuthCodeStep capability="git" manual={{ kind: 'oauth', flow: 'device', token: true }} onDone={refresh} />
      )}
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
                <span className="rounded-full border border-hair px-1.5 text-[11px] md:text-[9px] uppercase text-fgdim">{b.trusted ? t('wizard.profile.trusted') : 'ext'}</span>
                {isPending && <span className="rounded-full border border-[#e7d3a8] bg-[#FBF3E0] px-1.5 text-[11px] md:text-[9px] uppercase text-[#8a6d1f]">{t('wizard.profile.pending')}</span>}
              </div>
              {b.description && <div className="mt-0.5 text-[11px] leading-snug text-fgdim">{b.description}</div>}
              <div className="mt-1 font-mono text-[11.5px] md:text-[10px] text-fgdim">{(b.skills || []).length} skills · {b.cron || 0} cron{b.hasMemorySeed ? ' · memory' : ''}</div>
            </button>
          );
        })}
      </div>
      <div className="mt-3 flex flex-col gap-2">
        <input className={INPUT} value={url} onChange={(e) => { setUrl(e.target.value); if (e.target.value) setSelected(null); }} placeholder={t('wizard.profile.urlPlaceholder')} spellCheck={false} />
        {url && <div className="text-[11.5px] md:text-[10.5px] text-fgdim">{t('wizard.profile.external')}</div>}
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

// ---- step 5: integrations — Composio key (TokenStep), WhatsApp (QrStep),
// remote access (ToggleStep) --------------------------------------------------
function IntegrationsStep({ step, refresh }) {
  const t = useT();
  const Row = ({ title, hint, children }) => (
    <div className={`${CARD} px-4 py-3`}>
      <div className="text-[12.5px] font-bold text-fg">{title}</div>
      <div className="text-[11px] text-fgdim">{hint}</div>
      <div className="mt-2">{children}</div>
    </div>
  );
  const composioSet = !!step.data?.composio;
  return (
    <>
      <p className={BODY}>{t('wizard.integrations.body')}</p>
      <div className="mt-3 flex flex-col gap-3">
        <Row title={t('wizard.integrations.composio')} hint={t('wizard.integrations.composioHint')}>
          {composioSet ? <div className="text-[12px] text-[#2f7d4f]"><Icon icon={faCheck} /> {t('wizard.integrations.composioSet')}</div> : <TokenStep capability="composio" onDone={refresh} />}
        </Row>
        <Row title={t('wizard.integrations.whatsapp')} hint={t('wizard.integrations.whatsappHint')}>
          <QrStep capability="whatsapp" onDone={refresh} />
        </Row>
        <Row title={t('wizard.integrations.tailscale')} hint={t('wizard.integrations.tailscaleHint')}>
          <ToggleStep capability="remote" enabled={!!step.data?.remote} onDone={refresh} />
        </Row>
      </div>
    </>
  );
}

// ---- step 6: repo ----------------------------------------------------------
function WizardRepoStep({ step, refresh }) {
  const t = useT();
  return (
    <>
      <p className={BODY}>{t('wizard.repo.body')}</p>
      <RepoStep capability="repo" have={step.data?.repos || []} onDone={refresh} />
    </>
  );
}

// ---- step 7: telemetry (D3) — ToggleStep + the exact JSON preview --------------
function TelemetryStep({ step, refresh }) {
  const t = useT();
  const [preview, setPreview] = useState(null);
  const [err, setErr] = useState(null);
  const enabled = !!step.data?.enabled;
  const reason = step.data?.reason;
  const pinned = reason === 'dnt' || reason === 'env';
  const show = async () => {
    if (preview) { setPreview(null); return; }
    try { setPreview((await api.get('/telemetry')).preview); } catch (e) { setErr(e.message); }
  };
  return (
    <>
      <p className={BODY}>{t('wizard.telemetry.body')}</p>
      <ul className="mt-2 list-disc ps-5 text-[12px] leading-relaxed text-fgdim">
        <li>{t('wizard.telemetry.sends')}</li>
        <li>{t('wizard.telemetry.never')}</li>
        <li>{t('wizard.telemetry.control')}</li>
      </ul>
      {reason === 'dnt' && <div className="mt-3 text-[12px] text-fgdim">{t('telemetry.dnt')}</div>}
      {reason === 'env' && <div className="mt-3 text-[12px] text-fgdim">{t('telemetry.env', { state: enabled ? 'on' : 'off' })}</div>}
      <div className="mt-3">
        <ToggleStep key={String(enabled)} capability="telemetry" enabled={enabled} pinned={pinned} onDone={refresh} />
      </div>
      <button type="button" className={`${BTN2} mt-2`} onClick={show}>{preview ? t('telemetry.hidePreview') : t('telemetry.preview')}</button>
      {preview && (
        <pre dir="ltr" className="mt-3 max-h-[240px] overflow-auto rounded-[8px] border border-hair bg-bg p-3 font-mono text-[11.5px] md:text-[10.5px] leading-snug text-fg">{JSON.stringify(preview, null, 2)}</pre>
      )}
      <ErrorBox err={err} />
    </>
  );
}

// ---- step 8: health --------------------------------------------------------
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
          {running ? <Spinner>{t('wizard.health.running')}</Spinner> : <><Icon icon={faRotateRight} /> {t('wizard.health.run')}</>}
        </button>
      </div>
      {health && (
        <div className={`${CARD} mt-3 overflow-hidden`}>
          {health.checks.map((c) => (
            <div key={c.id} className="flex items-center gap-2.5 border-b border-hair px-3 py-2 last:border-0">
              <span className={`w-[52px] shrink-0 rounded-full border px-2 py-px text-center text-[11px] md:text-[9.5px] font-bold uppercase ${c.ok ? PILL.ok : c.required ? PILL.error : PILL.blocked}`}>
                {c.ok ? t('wizard.health.pass') : c.required ? t('wizard.health.fail') : t('wizard.health.optional')}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-[12px] font-semibold text-fg">{t(`wizard.health.check.${c.id}`)}</div>
                <div className="truncate font-mono text-[11.5px] md:text-[10px] text-fgdim">{c.detail}</div>
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
  telemetry: 'wizard.telemetry.title',
  health: 'wizard.health.title',
};

// ---- the stepper -----------------------------------------------------------
export default function Wizard({ onDone, onExit, onStart }) {
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

  // F8: in minimal mode only the required steps (pair, claude) are listed;
  // once done we show a Start panel instead of jumping back to step 1.
  const steps = (view?.steps || []).filter((s) => view?.mode === 'full' || !Array.isArray(view?.required) || view.required.includes(s.id));
  const finished = !!view?.done && idx === null;
  const cur = idx ?? Math.max(0, steps.findIndex((s) => s.id === view?.current));
  const step = finished ? null : steps[cur];
  const [starting, setStarting] = useState(false);
  const start = async () => {
    setStarting(true);
    try { await onStart?.(); } catch (e) { setErr(e.message); setStarting(false); }
  };

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
        <p className="mb-4 text-[12px] text-fgdim">{t('wizard.subtitle', { n: steps.length })}</p>

        {/* stepper rail */}
        <ol className="mb-4 flex flex-wrap gap-1.5">
          {steps.map((s, i) => (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => setIdx(i)}
                className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] ${i === cur ? 'border-ink bg-brand font-bold' : 'border-border bg-panel text-fgdim hover:border-ink'}`}
              >
                <span className={`inline-flex h-4 w-4 items-center justify-center rounded-full text-[11px] md:text-[9px] ${s.status === 'ok' ? 'bg-[#2f7d4f] text-white' : s.status === 'skipped' ? 'bg-chip text-fgdim' : 'bg-bg text-fg border border-border'}`}>
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
              <span className="font-mono text-[11.5px] md:text-[10px] uppercase tracking-[0.08em] text-fgdim">{t('wizard.stepOf', { n: cur + 1, total: steps.length })}</span>
              <Pill status={step.status} />
            </div>
            <h2 className="mb-2 text-[16px] font-bold">{t(STEP_TITLE[step.id])}</h2>

            {step.id === 'pair' && <PairStep step={step} />}
            {step.id === 'claude' && <ClaudeStep step={step} refresh={refresh} />}
            {step.id === 'git' && <GitStep step={step} refresh={refresh} />}
            {step.id === 'profile' && <ProfileStep step={step} refresh={refresh} onSkip={() => act('skip')} />}
            {step.id === 'integrations' && <IntegrationsStep step={step} refresh={refresh} />}
            {step.id === 'repo' && <WizardRepoStep step={step} refresh={refresh} />}
            {step.id === 'telemetry' && <TelemetryStep step={step} refresh={refresh} />}
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
        {finished && (
          <div className={`${CARD} px-5 py-5 text-center`}>
            <div className="text-[13px] font-bold text-[#2f7d4f]"><Icon icon={faCheck} /> {t('wizard.done')}</div>
            <p className="mt-1 text-[12px] text-fgdim">{t('setup.minimal.startBody')}</p>
            <button type="button" className={`${BTN} mt-3`} disabled={starting || !onStart} onClick={start}>
              {starting ? t('launcher.setup.starting') : t('setup.minimal.startBtn')} <Icon icon={faArrowRight} />
            </button>
            <div className="mt-3"><button type="button" onClick={() => setIdx(0)} className="cursor-pointer text-[11px] text-fgdim underline hover:text-fg">{t('wizard.reviewSteps')}</button></div>
          </div>
        )}
        {view?.done && !finished && (
          <div className="mt-3 text-center text-[12px] text-[#2f7d4f]"><Icon icon={faCheck} /> {t('wizard.done')} · <button type="button" onClick={() => setIdx(null)} className="cursor-pointer underline">{t('setup.minimal.startBtn')}</button></div>
        )}
      </div>
    </div>
  );
}
