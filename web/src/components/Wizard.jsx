// B3 — first-run wizard. A LINEAR, mobile-friendly stepper over the one
// onboarding state machine (server/onboarding.ts wizard()):
//   pair → claude → codex → git → profile → integrations → repo → telemetry → health
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
import { serverText } from '../lib/server-text.js';
import { setPrefs } from '../lib/prefs.js';
import { useStore } from '../lib/store.js';
import { OAuthCodeStep, TokenStep, QrStep, ToggleStep, RepoStep, EngineConnect } from './setup/index.js';
import { BTN, BTN2, INPUT, CARD, BODY, Pill, ErrorBox, OkLine, Spinner } from './setup/shared.jsx';
import { Badge } from './ui/badge.jsx';
import { Button } from './ui/button.jsx';
import { Tip } from './ui/tooltip.jsx';
import {
  faCheck,
  faArrowLeft,
  faArrowRight,
  faRotateRight,
  faXmark,
  faMinus,
} from '@fortawesome/free-solid-svg-icons';

// Step status → shared Badge with a status dot (the label keeps the wizard.status.* copy).
function StepPill({ status }) {
  const t = useT();
  return <Pill status={status} label={t(`wizard.status.${status}`)} />;
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
      <p className="text-sm leading-relaxed text-fgdim">{t('wizard.pair.body')}</p>
      {step.status === 'ok' && (
        <div className="mt-3 text-sm font-medium text-ok">
          <Icon icon={faCheck} /> {t('wizard.pair.paired', { email: auth?.user?.email || 'admin' })}
        </div>
      )}
      <div className="mt-4">
        <button type="button" className={BTN2} onClick={issue}>{t('wizard.pair.another')}</button>
        {code && (
          <div className="mt-3">
            <div className="inline-block rounded-md border border-hair bg-muted px-4 py-2.5 font-mono text-xl tracking-[0.2em] select-all" dir="ltr">{code}</div>
            <div className="mt-1.5 text-xs text-fgdim">{t('wizard.pair.codeHint')}</div>
          </div>
        )}
      </div>
      <ErrorBox err={err} />
    </>
  );
}

// ---- claude / codex / git — the shared setup components ------------
// (web/src/components/setup/*): the same EngineConnect the chat's SetupCard and
// the Setup screen render. Claude and Codex are two equal choices side by side;
// either one satisfies both wizard steps (the server marks the other 'skipped').
function EngineStep({ steps, refresh }) {
  const engines = {};
  for (const id of ['claude', 'codex']) {
    const s = steps.find((x) => x.id === id);
    engines[id] = { ok: !!(s?.data?.cli && s?.data?.authed), data: { cli: s?.data?.cli !== false } };
  }
  return <EngineConnect engines={engines} onChanged={refresh} />;
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
      <p className="text-sm leading-relaxed text-fgdim">{t('wizard.profile.body')}</p>
      {step.status === 'ok' && <div className="mt-3 text-sm font-medium text-ok"><Icon icon={faCheck} /> {t('wizard.profile.applied', { name: step.data?.applied })}</div>}
      {bundles === null && <div className="mt-3 text-xs text-fgdim">{t('wizard.loading')}</div>}
      {bundles && bundles.length === 0 && <div className="mt-3 text-xs text-fgdim">{t('wizard.profile.none')}</div>}
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {(bundles || []).map((b) => {
          const isPending = pending && (pending.name === b.name || pending.source === b.name);
          const sel = selected === b.name;
          return (
            <button
              key={b.name}
              type="button"
              onClick={() => setSelected(b.name)}
              aria-pressed={sel}
              className={`cursor-pointer rounded-lg border px-3 py-2.5 text-start outline-none transition-colors focus-visible:outline-2 focus-visible:outline-ring ${sel ? 'border-foreground/50 bg-muted' : 'border-hair bg-panel hover:bg-muted'}`}
            >
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-fg">{b.title || b.name}</span>
                <Badge status={b.trusted ? 'ok' : 'idle'}>{b.trusted ? t('wizard.profile.trusted') : 'ext'}</Badge>
                {isPending && <Badge status="warn">{t('wizard.profile.pending')}</Badge>}
              </div>
              {b.description && <div className="mt-0.5 text-xs leading-snug text-fgdim">{b.description}</div>}
              <div dir="ltr" className="mt-1 text-xs text-fgdim tabular-nums">{(b.skills || []).length} skills · {b.cron || 0} cron{b.hasMemorySeed ? ' · memory' : ''}</div>
            </button>
          );
        })}
      </div>
      <div className="mt-3 flex flex-col gap-2">
        <input className={INPUT} value={url} onChange={(e) => { setUrl(e.target.value); if (e.target.value) setSelected(null); }} placeholder={t('wizard.profile.urlPlaceholder')} dir="ltr" spellCheck={false} />
        {url && <div className="text-xs text-fgdim">{t('wizard.profile.external')}</div>}
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
      <div className="text-sm font-medium text-fg">{title}</div>
      <div className="mt-0.5 text-xs text-fgdim">{hint}</div>
      <div className="mt-2">{children}</div>
    </div>
  );
  const composioSet = !!step.data?.composio;
  return (
    <>
      <p className={BODY}>{t('wizard.integrations.body')}</p>
      <div className="mt-3 flex flex-col gap-3">
        <Row title={t('wizard.integrations.composio')} hint={t('wizard.integrations.composioHint')}>
          {composioSet ? <div className="text-xs text-ok"><Icon icon={faCheck} /> {t('wizard.integrations.composioSet')}</div> : <TokenStep capability="composio" onDone={refresh} />}
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
      <RepoStep capability="repo" onDone={refresh} />
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
      <ul className="mt-2 list-disc ps-5 text-xs leading-relaxed text-fgdim">
        <li>{t('wizard.telemetry.sends')}</li>
        <li>{t('wizard.telemetry.never')}</li>
        <li>{t('wizard.telemetry.control')}</li>
      </ul>
      {reason === 'dnt' && <div className="mt-3 text-xs text-fgdim">{t('telemetry.dnt')}</div>}
      {reason === 'env' && <div className="mt-3 text-xs text-fgdim">{t('telemetry.env', { state: enabled ? 'on' : 'off' })}</div>}
      <div className="mt-3">
        <ToggleStep key={String(enabled)} capability="telemetry" enabled={enabled} pinned={pinned} onDone={refresh} />
      </div>
      <button type="button" className={`${BTN2} mt-2`} onClick={show}>{preview ? t('telemetry.hidePreview') : t('telemetry.preview')}</button>
      {preview && (
        <pre dir="ltr" className="mt-3 max-h-[240px] overflow-auto rounded-md border border-hair bg-muted p-3 font-mono text-xs leading-snug text-fg">{JSON.stringify(preview, null, 2)}</pre>
      )}
      <ErrorBox err={err} />
    </>
  );
}

// ---- step 8: health --------------------------------------------------------
function HealthStep({ step, refresh }) {
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
      <p className="text-sm leading-relaxed text-fgdim">{t('wizard.health.body')}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className={BTN2} disabled={running} onClick={run}>
          {running ? <Spinner>{t('wizard.health.running')}</Spinner> : <><Icon icon={faRotateRight} /> {t('wizard.health.run')}</>}
        </button>
      </div>
      {health && (
        <div className={`${CARD} mt-3 overflow-hidden`}>
          {health.checks.map((c) => (
            <div key={c.id} className="flex items-center gap-2.5 border-b border-hair px-3 py-2 last:border-0">
              <Badge status={c.ok ? 'ok' : c.required ? 'err' : 'idle'} className="min-w-[4.5rem] shrink-0 justify-start">
                {c.ok ? t('wizard.health.pass') : c.required ? t('wizard.health.fail') : t('wizard.health.optional')}
              </Badge>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-fg">{t(`wizard.health.check.${c.id}`)}</div>
                <div dir="auto" className="truncate text-start font-mono text-xs text-fgdim">{serverText(c.detail)}</div>
              </div>
            </div>
          ))}
          <div className={`px-3 py-2 text-xs ${health.ok ? 'text-ok' : 'text-warn'}`}>
            {health.ok ? t('wizard.health.allGood') : t('wizard.health.someFailed')}
          </div>
        </div>
      )}
      <ErrorBox err={err} />
    </>
  );
}

const STEP_TITLE = {
  pair: 'wizard.pair.title',
  claude: 'setup.engine.title', // one step for both engines (Claude and Codex are equal choices)
  codex: 'wizard.codex.title',
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

  // F8: in minimal mode only the required steps (pair, claude, codex) are listed;
  // once done we show a Start panel instead of jumping back to step 1.
  // Claude and Codex are ONE step ("connect an engine", both cards side by side): either one connected settles it.
  const rawSteps = view?.steps || [];
  const engineOk = rawSteps.some((s) => (s.id === 'claude' || s.id === 'codex') && s.status === 'ok');
  const steps = rawSteps
    .filter((s) => s.id !== 'codex')
    .filter((s) => view?.mode === 'full' || !Array.isArray(view?.required) || view.required.includes(s.id) || s.id === 'claude')
    .map((s) => (s.id === 'claude' ? { ...s, status: engineOk ? 'ok' : s.status === 'skipped' ? 'todo' : s.status, skippable: false } : s));
  const finished = !!view?.done && idx === null;
  const curId = view?.current === 'codex' ? 'claude' : view?.current;
  const cur = idx ?? Math.max(0, steps.findIndex((s) => s.id === curId));
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
  // The first step that must be finished (not skippable, not done): nothing after it can be jumped to.
  const gateIdx = steps.findIndex((s) => !s.skippable && s.status !== 'ok' && s.status !== 'skipped');
  const locked = (i) => gateIdx !== -1 && i > gateIdx;
  const gateHint = step && !canNext ? t(step.id === 'claude' ? 'wizard.gate.engine' : step.id === 'profile' ? 'wizard.gate.profile' : step.skippable ? 'wizard.gate.skip' : 'wizard.gate.required') : '';
  const healthFailed = step?.id === 'health' && step.data?.health && !step.data.health.ok;
  const toEngine = () => { const i = steps.findIndex((x) => x.id === 'claude'); if (i >= 0) setIdx(i); };

  return (
    <div dir={LANGS[lang]?.dir || 'ltr'} className="flex min-h-screen flex-col items-center bg-bg p-4 text-fg sm:p-8">
      <div className="w-full max-w-[640px]">
        <div className="mb-4 flex items-center gap-2">
          <span className="flex items-end gap-0.5" aria-hidden="true">
            {[10, 16, 12, 19].map((h, i) => <span key={i} className="inline-block w-1 bg-brand" style={{ height: h }} />)}
          </span>
          <span className="text-base font-medium">{t('wizard.title')}</span>
          <Button variant="outline" size="sm" onClick={toggleLang} className="ms-auto">{t('wizard.lang')}</Button>
          <Tip label={t('wizard.exitHint')}>
            <Button variant="ghost" size="icon" onClick={onExit} aria-label={t('wizard.exit')}><Icon icon={faXmark} /></Button>
          </Tip>
        </div>
        <p className="mb-4 text-xs text-fgdim">{t('wizard.subtitle', { n: steps.length })}</p>

        {/* stepper: a segmented progress bar on a phone (nothing to mis-tap), numbered pills with names from sm up.
            A pill past the first unfinished required step is disabled — the gate is the same everywhere. */}
        <div className="mb-4 flex gap-1 sm:hidden" role="progressbar" aria-valuemin={1} aria-valuemax={steps.length} aria-valuenow={cur + 1}>
          {steps.map((s, i) => (
            <span key={s.id} className={`h-1 flex-1 rounded-full ${i === cur ? 'bg-foreground' : s.status === 'ok' ? 'bg-ok' : 'bg-chip'}`} />
          ))}
        </div>
        <ol className="mb-4 hidden flex-wrap gap-1.5 sm:flex">
          {steps.map((s, i) => (
            <li key={s.id}>
              <Tip label={locked(i) ? t(steps[gateIdx]?.id === 'claude' ? 'wizard.gate.engine' : 'wizard.gate.required') : undefined}>
              <button
                type="button"
                disabled={locked(i)}
                aria-current={i === cur ? 'step' : undefined}
                onClick={() => setIdx(i)}
                className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs outline-none focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50 coarse:min-h-11 ${i === cur ? 'border-input bg-muted font-medium text-foreground' : s.status === 'skipped' ? 'border-dashed border-input text-fgdim' : 'border-hair text-fgdim hover:bg-muted hover:text-foreground'}`}
              >
                <span className={`inline-flex size-4 items-center justify-center rounded-full text-2xs ${s.status === 'ok' ? 'bg-ok text-white' : s.status === 'skipped' ? 'bg-chip text-fgdim' : 'border border-input bg-bg text-fg'}`}>
                  {s.status === 'ok' ? <Icon icon={faCheck} /> : s.status === 'skipped' ? <Icon icon={faMinus} /> : i + 1}
                </span>
                <span>{t(STEP_TITLE[s.id])}</span>
              </button>
              </Tip>
            </li>
          ))}
        </ol>

        {err && <ErrorBox err={err} />}
        {!view && !err && <div className="text-xs text-fgdim">{t('wizard.loading')}</div>}

        {step && (
          <div className={`${CARD} px-5 py-5`}>
            <div className="mb-1 flex items-center gap-2">
              <span className="text-xs text-fgdim tabular-nums">{t('wizard.stepOf', { n: cur + 1, total: steps.length })}</span>
              <StepPill status={step.status} />
            </div>
            <h2 className="mb-3 text-base font-medium">{t(STEP_TITLE[step.id])}</h2>

            {step.id === 'pair' && <PairStep step={step} />}
            {(step.id === 'claude' || step.id === 'codex') && <EngineStep steps={view.steps} refresh={refresh} />}
            {step.id === 'git' && <GitStep step={step} refresh={refresh} />}
            {step.id === 'profile' && <ProfileStep step={step} refresh={refresh} onSkip={() => act('skip')} />}
            {step.id === 'integrations' && <IntegrationsStep step={step} refresh={refresh} />}
            {step.id === 'repo' && <WizardRepoStep step={step} refresh={refresh} />}
            {step.id === 'telemetry' && <TelemetryStep step={step} refresh={refresh} />}
            {step.id === 'health' && <HealthStep step={step} refresh={refresh} />}

            <div className="mt-6 flex flex-wrap items-center gap-2 border-t border-hair pt-4">
              <button type="button" className={BTN2} disabled={cur === 0} onClick={() => setIdx(cur - 1)}><Icon icon={faArrowLeft} className="mirror-rtl" /> {t('wizard.back')}</button>
              <span className="ms-auto" />
              {step.skippable && !settled && step.id !== 'profile' && !healthFailed && (
                <button type="button" className={BTN2} onClick={() => act('skip')}>{t('wizard.skip')}</button>
              )}
              {cur < steps.length - 1 ? (
                <button type="button" className={BTN} disabled={!canNext} onClick={next}>
                  {step.id === 'integrations' && !settled ? t('wizard.integrations.continue') : t('wizard.next')} <Icon icon={faArrowRight} className="mirror-rtl" />
                </button>
              ) : healthFailed ? (
                <>
                  <button type="button" className={BTN2} onClick={finish}>{t('wizard.health.openAnyway')}</button>
                  <button type="button" className={BTN} onClick={toEngine}>{t('wizard.health.fix')}</button>
                </>
              ) : (
                <button type="button" className={BTN} disabled={!step.skippable && !settled} onClick={finish}>{t('wizard.openCockpit')} <Icon icon={faArrowRight} className="mirror-rtl" /></button>
              )}
            </div>
            {gateHint && <p role="status" className="mt-2 text-end text-xs text-warn">{gateHint}</p>}
          </div>
        )}
        {finished && (
          <div className={`${CARD} px-5 py-5 text-center`}>
            <div className="text-sm font-medium text-ok"><Icon icon={faCheck} /> {t('wizard.done')}</div>
            <p className="mt-1 text-xs text-fgdim">{t('setup.minimal.startBody')}</p>
            <button type="button" className={`${BTN} mt-3`} disabled={starting || !onStart} onClick={start}>
              {starting ? t('launcher.setup.starting') : t('setup.minimal.startBtn')} <Icon icon={faArrowRight} className="mirror-rtl" />
            </button>
            <div className="mt-3"><button type="button" onClick={() => setIdx(0)} className="cursor-pointer text-xs text-fgdim underline hover:text-fg">{t('wizard.reviewSteps')}</button></div>
          </div>
        )}
        {view?.done && !finished && (
          <div className="mt-3 text-center text-xs text-ok"><Icon icon={faCheck} /> {t('wizard.done')} · <button type="button" onClick={() => setIdx(null)} className="cursor-pointer underline">{t('setup.minimal.startBtn')}</button></div>
        )}
      </div>
    </div>
  );
}
