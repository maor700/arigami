// Setup — the onboarding surface (decision 8). A global, app-level view (like
// Settings/Skills) driven entirely by /__api/onboarding/status. Three sections:
// Connections (global credential gates), Repos (per-repo groups + Add repo),
// and — later — Profile. Auto-fix buttons call the deterministic server engine
// (server/onboarding.ts); this component holds no provisioning logic itself.
import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { Icon } from '../lib/icons.js';
import { useT } from '../lib/i18n.js';
import { faCheck, faRotateRight, faXmark, faArrowRight, faTriangleExclamation } from '@fortawesome/free-solid-svg-icons';
import { useStore } from '../lib/store.js';
import { OAuthCodeStep } from './setup/index.js';
import * as setupApi from '../lib/setup-api.js';

const PILL = {
  ok: 'border-[#bfe3cf] bg-[#EAF6EF] text-[#2f7d4f]',
  missing: 'border-[#e7d3a8] bg-[#FBF3E0] text-[#8a6d1f]',
  error: 'border-[#e2c4c0] bg-[#FBECEA] text-[#9c3b33]',
  blocked: 'border-hair bg-chip text-fgdim',
  running: 'border-[#bcd4ee] bg-[#EAF1FB] text-[#2C6BD6]',
};

// Steps whose action maps to a real server endpoint get a Fix button.
const ACTION_EP = {
  'onboarding.cloneRepo': 'clone',
  'onboarding.resolveEnv': 'env',
  'onboarding.installDeps': 'install',
};

function StatusPill({ status }) {
  const t = useT();
  const STATUS_KEYS = {
    ok: 'launcher.setup.status.ok',
    missing: 'launcher.setup.status.missing',
    error: 'launcher.setup.status.error',
    blocked: 'launcher.setup.status.blocked',
    running: 'launcher.setup.status.running',
  };
  return (
    <span
      className={`shrink-0 rounded-full border px-2 py-px text-[9.5px] font-bold uppercase ${PILL[status] || PILL.blocked}`}
    >
      {STATUS_KEYS[status] ? t(STATUS_KEYS[status]) : status}
    </span>
  );
}

function StepRow({ step, onFix, busy }) {
  const t = useT();
  const name = step.scope.startsWith('repo:') ? step.scope.slice(5) : null;
  const ep = ACTION_EP[step.action];
  const fixable = name && ep && (step.status === 'missing' || step.status === 'error');
  return (
    <div className="flex items-center gap-2.5 border-b border-hair px-3 py-2 last:border-0">
      <StatusPill status={step.status} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12px] font-semibold text-fg">{step.title}</div>
        {step.detail && (
          <div className="truncate font-mono text-[10px] text-fgdim">{step.detail}</div>
        )}
      </div>
      {fixable && (
        <button
          type="button"
          disabled={busy}
          onClick={() => onFix(name, ep)}
          className="shrink-0 cursor-pointer rounded-[7px] border-[1.5px] border-ink bg-brand px-2.5 py-1 text-[11px] font-bold text-fg disabled:opacity-50"
        >
          {busy ? '…' : t('launcher.setup.fix')}
        </button>
      )}
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div className="mb-4 overflow-hidden rounded-[10px] border border-border bg-panel">
      <div className="border-b border-hair px-3 py-2 text-[9.5px] font-bold tracking-wide text-fgdim uppercase">
        {title}
      </div>
      {children}
    </div>
  );
}

const INPUT = 'rounded-[7px] border border-border bg-panel px-2 py-1 text-[12px] text-fg';
const MONO = 'rounded-[7px] border border-border bg-panel px-2 py-1 font-mono text-[11.5px] text-fg';

// Add a repo — the host always keeps its OWN copy under reposDir/<name> (it owns
// the .git/worktrees). Two sources: clone from GitHub, or copy an existing local
// working dir (minus node_modules). Either way you can pick env files (.env.local
// etc.) to copy in, so a fresh clone/copy is actually installable.
export function AddRepo({ onAdd, busy }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState('github'); // 'github' | 'local'
  const [name, setName] = useState('');
  const [source, setSource] = useState('');
  const [installCmd, setInstallCmd] = useState('');
  const [envFolder, setEnvFolder] = useState(''); // where to copy env from (github mode)
  const [detect, setDetect] = useState(null); // detect-local result for the env folder
  const [detecting, setDetecting] = useState(false);
  const [picked, setPicked] = useState([]); // selected env filenames
  const [simpleEnv, setSimpleEnv] = useState('none'); // fallback when no files picked

  const reset = () => {
    setKind('github'); setName(''); setSource(''); setInstallCmd('');
    setEnvFolder(''); setDetect(null); setPicked([]); setSimpleEnv('none'); setOpen(false);
  };

  // In local mode the env folder IS the source; in github mode it's a separate path.
  const envBase = (kind === 'local' ? source : envFolder).trim();

  // Probe a local folder → prefill install cmd + list copyable env files.
  const probe = async (path) => {
    const p = path.trim();
    if (!p) { setDetect(null); setPicked([]); return; }
    setDetecting(true);
    try {
      const r = await api.post('/onboarding/detect-local', { path: p });
      setDetect(r);
      if (kind === 'local' && r.exists && r.toolchain?.installCmd)
        setInstallCmd((c) => c || r.toolchain.installCmd);
      // pre-check the obvious ones
      setPicked((r.envCandidates || []).filter((f) => /\.env(\.|$)/.test(f)));
    } catch { setDetect(null); }
    setDetecting(false);
  };

  const toggle = (f) => setPicked((p) => (p.includes(f) ? p.filter((x) => x !== f) : [...p, f]));

  const submit = () => {
    if (!name.trim() || !source.trim()) return;
    const entry = { name: name.trim(), source: source.trim() };
    if (installCmd.trim()) entry.installCmd = installCmd.trim();
    if (picked.length && envBase) {
      const base = envBase.replace(/\/+$/, '');
      entry.envSource = { kind: 'copy', files: picked.map((f) => `${base}/${f}`) };
    } else {
      entry.envSource = { kind: simpleEnv };
    }
    onAdd(entry);
    reset();
  };

  if (!open)
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full cursor-pointer border-t border-hair px-3 py-2 text-left text-[11.5px] font-bold text-brand-ink hover:bg-chip/60"
      >
        {t('launcher.setup.addRepo')}
      </button>
    );

  const candidates = detect?.envCandidates || [];
  return (
    <div className="flex flex-col gap-2.5 border-t border-hair bg-bg px-3 py-3">
      {/* source kind */}
      <div className="flex gap-1 rounded-[8px] border border-border bg-panel p-0.5 text-[11px] font-semibold">
        {[['github', t('launcher.setup.fromGithub')], ['local', t('launcher.setup.fromLocal')]].map(([k, label]) => (
          <button
            key={k} type="button" onClick={() => { setKind(k); setDetect(null); setPicked([]); }}
            className={`flex-1 cursor-pointer rounded-[6px] px-2 py-1 ${kind === k ? 'bg-brand text-fg' : 'text-fgdim hover:text-fg'}`}
          >
            {label}
          </button>
        ))}
      </div>

      <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('launcher.setup.namePlaceholder')} className={INPUT} />
      <input
        value={source}
        onChange={(e) => setSource(e.target.value)}
        onBlur={(e) => { if (kind === 'local') probe(e.target.value); }}
        placeholder={kind === 'github' ? t('launcher.setup.sourceGithubPlaceholder') : '/Users/you/Desktop/repos/app'}
        className={MONO}
      />
      {kind === 'local' && (
        <div className="text-[10px] text-fgdim">
          {detecting ? t('launcher.setup.scanning')
            : detect ? (detect.exists
              ? <><Icon icon={faCheck} /> {detect.isGit ? t('launcher.setup.gitRepo') : t('launcher.setup.folder')}{detect.toolchain?.pm ? ` · ${detect.toolchain.pm}` : ''}{t('launcher.setup.copiedMinus')}</>
              : <><Icon icon={faTriangleExclamation} /> {t('launcher.setup.folderNotFound')}</>)
            : t('launcher.setup.workingTreeHint')}
        </div>
      )}

      <input value={installCmd} onChange={(e) => setInstallCmd(e.target.value)} placeholder={t('launcher.setup.installPlaceholder')} className={MONO} />

      {/* env files to copy */}
      {kind === 'github' && (
        <div className="flex gap-1.5">
          <input
            value={envFolder} onChange={(e) => setEnvFolder(e.target.value)}
            placeholder={t('launcher.setup.copyEnvPlaceholder')} className={`${MONO} flex-1`}
          />
          <button
            type="button" onClick={() => probe(envFolder)} disabled={detecting || !envFolder.trim()}
            className="shrink-0 cursor-pointer rounded-[7px] border border-border bg-panel px-2 py-1 text-[11px] font-semibold text-fg hover:border-ink disabled:opacity-40"
          >
            {detecting ? '…' : t('launcher.setup.scan')}
          </button>
        </div>
      )}
      {candidates.length > 0 ? (
        <div className="rounded-[7px] border border-border bg-panel px-2 py-1.5">
          <div className="mb-1 text-[9.5px] font-bold tracking-wide text-fgdim uppercase">{t('launcher.setup.envFilesToCopy')}</div>
          {candidates.map((f) => (
            <label key={f} className="flex cursor-pointer items-center gap-1.5 py-0.5 text-[11.5px] text-fg">
              <input type="checkbox" checked={picked.includes(f)} onChange={() => toggle(f)} />
              <span className="font-mono">{f}</span>
            </label>
          ))}
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <label className="text-[10.5px] text-fgdim">{t('launcher.setup.envLabel')}</label>
          <select value={simpleEnv} onChange={(e) => setSimpleEnv(e.target.value)} className="rounded-[7px] border border-border bg-panel px-2 py-1 text-[11.5px] text-fg">
            <option value="none">{t('launcher.setup.envNone')}</option>
            <option value="file">{t('launcher.setup.envFile')}</option>
            <option value="command">{t('launcher.setup.envCommand')}</option>
          </select>
        </div>
      )}

      <div className="flex items-center gap-2">
        <button
          type="button" disabled={busy} onClick={submit}
          className="cursor-pointer rounded-[7px] border-[1.5px] border-ink bg-brand px-3 py-1 text-[11.5px] font-bold text-fg disabled:opacity-50"
        >
          {t('launcher.setup.add')}
        </button>
        <button type="button" onClick={reset} className="cursor-pointer px-1 text-[13px] text-fgdim hover:text-fg"><Icon icon={faXmark} /></button>
      </div>
    </div>
  );
}

// The front door: a hero that starts the guided (chat) onboarding. But the
// onboarding skill runs INSIDE a claude session — so if the Claude Code CLI is
// missing (or unauthenticated) there's no session to open. Those two global
// steps therefore hard-gate the "Go!" button: we surface the fix (install
// command / token) + a Recheck, and only enable Go once both are ok.
// S2 — minimal first screen: Connect Claude → Start. Nothing else blocks;
// every other capability connects just-in-time from the chat (SetupCard).
// "Run full setup" reopens the B3 wizard for people who want all the steps.
function MinimalHero({ claude, onStart, onRecheck, onRunWizard, busy }) {
  const t = useT();
  const cli = claude?.data?.cli !== false;
  return (
    <div className="mb-4 overflow-hidden rounded-[12px] border-[1.5px] border-ink bg-panel">
      <div className="px-4 py-4">
        <div className="text-[15px] font-bold text-fg">{t('setup.minimal.title')}</div>
        <p className="mt-1 text-[12px] leading-relaxed text-fgdim">{t('setup.minimal.body')}</p>
        <ol className="mt-3 flex flex-col gap-3">
          <li className={`rounded-[9px] border px-3 py-2.5 ${claude?.ok ? 'border-[#bfe3cf] bg-[#EAF6EF]' : 'border-[#e7d3a8] bg-[#FBF3E0]'}`}>
            <div className="flex items-center gap-2 text-[12px] font-bold text-fg">
              <span className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-ink bg-bg text-[10px]">{claude?.ok ? <Icon icon={faCheck} /> : '1'}</span>
              {t('setup.minimal.connectClaude')}
            </div>
            {claude?.ok ? (
              <div className="mt-1 text-[11.5px] text-[#2f7d4f]">{t('wizard.claude.connected')}</div>
            ) : !cli ? (
              <div className="mt-2">
                <p className="text-[11px] leading-snug text-[#8a6d1f]">{t('wizard.claude.noCli')}</p>
                <code className="mt-1 block rounded-[6px] border border-[#e7d3a8] bg-[#fff9ec] px-2 py-1.5 font-mono text-[10.5px] select-all">npm i -g @anthropic-ai/claude-code</code>
                <button type="button" onClick={onRecheck} className="mt-2 cursor-pointer rounded-[7px] border-[1.5px] border-ink bg-brand px-3 py-1 text-[11.5px] font-bold text-fg"><Icon icon={faRotateRight} /> {t('launcher.setup.recheck')}</button>
              </div>
            ) : (
              <div className="mt-2"><OAuthCodeStep capability="claude" manual={{ kind: 'oauth', flow: 'pkce', token: true }} onDone={onRecheck} /></div>
            )}
          </li>
          <li className={`rounded-[9px] border px-3 py-2.5 ${claude?.ok ? 'border-border bg-bg' : 'border-hair bg-chip/40 opacity-70'}`}>
            <div className="flex items-center gap-2 text-[12px] font-bold text-fg">
              <span className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-ink bg-bg text-[10px]">2</span>
              {t('setup.minimal.start')}
            </div>
            <p className="mt-1 text-[11px] leading-snug text-fgdim">{t('setup.minimal.startBody')}</p>
            <button
              type="button" disabled={busy || !claude?.ok} onClick={onStart}
              className="mt-2 cursor-pointer rounded-[9px] border-[1.5px] border-ink bg-brand px-5 py-2 text-[13px] font-bold text-fg disabled:opacity-50"
            >
              {busy ? t('launcher.setup.starting') : t('setup.minimal.startBtn')} <Icon icon={faArrowRight} />
            </button>
          </li>
        </ol>
        {onRunWizard && (
          <button type="button" onClick={onRunWizard} className="mt-3 cursor-pointer text-[11px] text-fgdim underline hover:text-fg">{t('setup.minimal.runFull')}</button>
        )}
      </div>
    </div>
  );
}

export default function Setup({ onClose, onCreated, onRunWizard }) {
  const t = useT();
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [profiles, setProfiles] = useState([]);
  const [claude, setClaude] = useState(null); // {ok, detail, data} from setup-api.overview()
  const [more, setMore] = useState(false);
  const { setupTick, wizardTick } = useStore();

  const refresh = useCallback(async () => {
    try {
      const [st, ov] = await Promise.all([api.get('/onboarding/status'), setupApi.overview().catch(() => null)]);
      setData(st);
      setClaude(ov?.capabilities?.find((c) => c.id === 'claude') || null);
      setErr(null);
    } catch (e) {
      setErr(e.message);
    }
  }, []);
  useEffect(() => { if (setupTick || wizardTick) refresh(); }, [setupTick, wizardTick, refresh]);

  useEffect(() => {
    refresh();
    api.get('/onboarding/profiles').then(setProfiles).catch(() => setProfiles([]));
  }, [refresh]);

  // While any step is running a background job, poll status until it settles.
  useEffect(() => {
    const running = (data?.steps || []).some((s) => s.status === 'running');
    if (!running) return undefined;
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, [data, refresh]);

  const fix = async (name, ep) => {
    setBusy(true);
    try {
      await api.post(`/onboarding/repos/${encodeURIComponent(name)}/${ep}`);
    } catch (e) {
      setErr(e.message);
    }
    await refresh();
    setBusy(false);
  };

  const addRepo = async (entry) => {
    setBusy(true);
    try {
      await api.post('/onboarding/repos', entry);
    } catch (e) {
      setErr(e.message);
    }
    await refresh();
    setBusy(false);
  };

  const removeRepo = async (name) => {
    setBusy(true);
    try {
      await api.del(`/onboarding/repos/${encodeURIComponent(name)}`);
    } catch (e) {
      setErr(e.message);
    }
    await refresh();
    setBusy(false);
  };

  // Go! — spawn a session that runs the onboarding skill (drives the same engine
  // conversationally). Mirrors the launcher gate's chat path.
  const startOnboarding = async () => {
    setBusy(true);
    setErr(null);
    try {
      const s = await api.post('/sessions', {
        title: 'Onboarding',
        prompt:
          'Run the arigami:onboarding skill to provision a workspace so I can work on tickets. Follow that skill exactly — ask me which repo to add if it is not obvious.',
        permissionMode: 'bypassPermissions',
      });
      onCreated?.(s);
    } catch (e) {
      setErr(e.message);
      setBusy(false);
    }
  };

  // S2 Start — a plain first session (S1 minimal mode gives it the empty
  // workspace cwd). Everything else is connected just-in-time from the chat.
  const startSession = async () => {
    setBusy(true);
    setErr(null);
    try {
      const s = await api.post('/sessions', { title: t('setup.minimal.sessionTitle'), permissionMode: 'bypassPermissions' });
      onCreated?.(s);
    } catch (e) {
      setErr(e.message);
      setBusy(false);
    }
  };
  const runWizard = async () => {
    try { await api.post('/onboarding/wizard/reset'); } catch { /* not admin — the wizard still opens read-only */ }
    onRunWizard?.();
  };

  const applyProfile = async (name) => {
    setBusy(true);
    try {
      await api.post(`/onboarding/profiles/${encodeURIComponent(name)}/apply`);
    } catch (e) {
      setErr(e.message);
    }
    await refresh();
    setBusy(false);
  };

  const env = data?.environment;
  const steps = data?.steps || [];
  const global = steps.filter((s) => s.scope === 'global');
  const repoNames = [...new Set(steps.filter((s) => s.scope.startsWith('repo:')).map((s) => s.scope.slice(5)))];
  // Workspace ready = all globals ok AND some repo's steps all ok. Hero fronts
  // only while it's NOT ready (fresh workspace); quiet once a repo is usable.
  const globalsOk = global.length > 0 && global.every((s) => s.status === 'ok');
  const anyRepoReady = repoNames.some((n) =>
    steps.filter((s) => s.scope === `repo:${n}`).every((s) => s.status === 'ok')
  );
  const workspaceReady = globalsOk && anyRepoReady;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-bg text-fg">
      <div className="flex h-11 shrink-0 items-center gap-2.5 border-b border-hair px-4">
        <span className="text-[13px] font-bold">{t('launcher.setup.title')}</span>
        {env && (
          <span className="rounded-[5px] border border-border px-[7px] py-px font-mono text-[10px] text-fgdim">
            {env.container ? t('launcher.setup.container') : t('launcher.setup.native')} · {env.strategy}
          </span>
        )}
        <button
          type="button" onClick={refresh}
          className="ml-auto cursor-pointer text-[11px] text-fgdim hover:text-fg"
        >
          <Icon icon={faRotateRight} /> {t('launcher.setup.refresh')}
        </button>
        {onRunWizard && (
          <button
            type="button"
            title={t('launcher.setup.runWizardHint')}
            onClick={runWizard}
            className="cursor-pointer rounded-[7px] border-[1.5px] border-ink bg-brand px-2.5 py-1 text-[11px] font-bold text-fg"
          >
            {t('launcher.setup.runWizard')}
          </button>
        )}
        <button
          type="button" onClick={onClose}
          className="cursor-pointer px-1 text-[15px] text-fgdim hover:text-fg"
        >
          <Icon icon={faXmark} />
        </button>
      </div>

      <div className="thin-scroll min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {err && (
          <div className="mb-4 rounded-[8px] border border-[#e2c4c0] bg-[#FBECEA] px-3 py-2 text-[11.5px] text-[#9c3b33]">
            {err}
          </div>
        )}
        {!data && !err && <div className="text-[12px] text-fgdim">{t('launcher.setup.loading')}</div>}

        {data && (
          <>
            <MinimalHero claude={claude} onStart={startSession} onRecheck={refresh} onRunWizard={onRunWizard ? runWizard : null} busy={busy} />

            <button type="button" onClick={() => setMore((v) => !v)} aria-expanded={more} className="mb-3 cursor-pointer text-[11.5px] font-semibold text-fgdim hover:text-fg">
              {more ? '▾' : '▸'} {t('setup.minimal.more')}{workspaceReady ? '' : ` · ${t('setup.minimal.moreHint')}`}
            </button>
            {more && (
            <>
            {!workspaceReady && (
              <div className="mb-4 rounded-[10px] border border-border bg-panel px-4 py-3">
                <div className="text-[12px] font-bold text-fg">{t('launcher.setup.welcomeTitle')}</div>
                <p className="mt-1 text-[11.5px] leading-relaxed text-fgdim">{t('launcher.setup.welcomeBody')}</p>
                <button type="button" disabled={busy} onClick={startOnboarding} className="mt-2 cursor-pointer rounded-[9px] border-[1.5px] border-ink bg-panel px-4 py-1.5 text-[12px] font-bold text-fg hover:bg-brand disabled:opacity-50">
                  {busy ? t('launcher.setup.starting') : t('launcher.setup.startOnboarding')}
                </button>
              </div>
            )}
            <Section title={t('launcher.setup.connections')}>
              {global.map((s) => (
                <StepRow key={s.id} step={s} onFix={fix} busy={busy} />
              ))}
            </Section>

            <Section title={`${t('launcher.setup.repos')}${repoNames.length ? ` · ${repoNames.length}` : ''}`}>
              {repoNames.length === 0 && (
                <div className="px-3 py-3 text-[11.5px] text-fgdim">
                  {t('launcher.setup.noRepos')}
                </div>
              )}
              {repoNames.map((name) => (
                <div key={name} className="border-b border-hair last:border-0">
                  <div className="flex items-center gap-2 bg-chip/40 px-3 py-1.5">
                    <span className="font-mono text-[11px] font-bold text-fg">{name}</span>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => removeRepo(name)}
                      title={t('launcher.setup.removeTitle')}
                      className="ml-auto cursor-pointer text-[10.5px] text-fgdim hover:text-[#9c3b33] disabled:opacity-50"
                    >
                      {t('launcher.setup.remove')}
                    </button>
                  </div>
                  {steps
                    .filter((s) => s.scope === `repo:${name}`)
                    .map((s) => (
                      <StepRow key={s.id} step={s} onFix={fix} busy={busy} />
                    ))}
                </div>
              ))}
              <AddRepo onAdd={addRepo} busy={busy} />
            </Section>

            {profiles.length > 0 && (
              <Section title={t('launcher.setup.profiles')}>
                {profiles.map((prof) => (
                  <div
                    key={prof.name}
                    className="flex items-start gap-2.5 border-b border-hair px-3 py-2.5 last:border-0"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-[12px] font-semibold text-fg">
                        {prof.title || prof.name}
                      </div>
                      {prof.description && (
                        <div className="mt-0.5 text-[10.5px] leading-snug text-fgdim">
                          {prof.description}
                        </div>
                      )}
                    </div>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => applyProfile(prof.name)}
                      title={t('launcher.setup.profileApplyTitle')}
                      className="shrink-0 cursor-pointer rounded-[7px] border-[1.5px] border-ink bg-brand px-2.5 py-1 text-[11px] font-bold text-fg disabled:opacity-50"
                    >
                      {t('launcher.setup.apply')}
                    </button>
                  </div>
                ))}
              </Section>
            )}
            </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
