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
import { EngineConnect } from './setup/index.js';
import RepoPicker from './setup/RepoPicker.jsx';
import { RepoRow } from './setup/RepoList.jsx';
import { addOutcome } from '../lib/repo-status.js';
import { entryFromRepo, repoNameFromSource } from '../lib/repo-picker.js';
import { anyEngineConnected } from './setup/EngineConnect.jsx';
import * as setupApi from '../lib/setup-api.js';
import { BTN, BTN2, BTN2_SM, INPUT as FIELD } from './setup/shared.jsx';
import { Badge } from './ui/badge.jsx';
import { Tip } from './ui/tooltip.jsx';
import { Checkbox } from './ui/checkbox.jsx';
import { Label } from './ui/label.jsx';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select.jsx';
import { ChevronRight } from 'lucide-react';
import { Segmented } from './settings/shared.jsx';

// status → the dot colour of the neutral Badge
const PILL_DOT = { ok: 'ok', missing: 'warn', error: 'err', blocked: 'idle', running: 'info' };

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
    <Badge status={PILL_DOT[status] || 'idle'}>
      {STATUS_KEYS[status] ? t(STATUS_KEYS[status]) : status}
    </Badge>
  );
}

// Backend detail strings for the "nothing to do here" cases, said in task language.
export function stepDetail(detail, t) {
  if (/^envSource: none$/.test(detail)) return t('launcher.setup.detail.envNone');
  if (detail === 'no install step') return t('launcher.setup.detail.noInstall');
  return detail;
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
        <div className="truncate text-sm font-medium text-fg">{step.title}</div>
        {step.detail && (
          <div dir="auto" className="truncate text-start font-mono text-xs text-fgdim">{stepDetail(step.detail, t)}</div>
        )}
      </div>
      {fixable && (
        <button type="button" disabled={busy} onClick={() => onFix(name, ep)} className={BTN2_SM}>
          {busy ? '…' : t('launcher.setup.fix')}
        </button>
      )}
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div className="mb-4 overflow-hidden rounded-lg border border-hair bg-panel">
      <div className="border-b border-hair px-3 py-2 text-xs font-medium text-fgdim">
        {title}
      </div>
      {children}
    </div>
  );
}

const INPUT = FIELD;
const MONO = `${FIELD} font-mono`;

// Add a repo — the host always keeps its OWN copy under reposDir/<name> (it owns
// the .git/worktrees). Two sources: clone from GitHub, or copy an existing local
// working dir (minus node_modules). Either way you can pick env files (.env.local
// etc.) to copy in, so a fresh clone/copy is actually installable.
export function AddRepo({ onAdd, busy, defaultOpen = false }) {
  const t = useT();
  const [open, setOpen] = useState(defaultOpen);
  const [kind, setKind] = useState('github'); // 'github' | 'local'
  const [name, setName] = useState('');
  const [source, setSource] = useState('');
  const [missing, setMissing] = useState(false); // tried to add with the source empty
  const [showAdv, setShowAdv] = useState(false); // install command, env files, a custom name: rarely needed
  const [installCmd, setInstallCmd] = useState('');
  const [envFolder, setEnvFolder] = useState(''); // where to copy env from (github mode)
  const [detect, setDetect] = useState(null); // detect-local result for the env folder
  const [detecting, setDetecting] = useState(false);
  const [picked, setPicked] = useState([]); // selected env filenames
  const [simpleEnv, setSimpleEnv] = useState('none'); // fallback when no files picked

  const reset = () => {
    setKind('github'); setName(''); setSource(''); setInstallCmd(''); setShowAdv(false);
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
    const finalName = name.trim() || repoNameFromSource(source);
    if (!finalName || !source.trim()) { setMissing(true); return; }
    setMissing(false);
    const entry = { name: finalName, source: source.trim() };
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
        className="w-full cursor-pointer border-t border-hair px-3 py-2 text-start text-xs font-medium text-fg outline-none hover:bg-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring coarse:min-h-11"
      >
        {t('launcher.setup.addRepo')}
      </button>
    );

  const candidates = detect?.envCandidates || [];
  return (
    <div className="flex flex-col gap-3 border-t border-hair bg-bg px-3 py-3">
      {/* source kind */}
      <Segmented
        value={kind}
        onChange={(k) => { setKind(k); setDetect(null); setPicked([]); }}
        options={[{ value: 'github', label: t('launcher.setup.fromGithub') }, { value: 'local', label: t('launcher.setup.fromLocal') }]}
      />

      {kind === 'github' && (
        <>
          <RepoPicker onPick={(r) => setSource(entryFromRepo(r).source)} />
          <div className="text-xs text-fgdim">{t('setup.repo.pick.orPaste')}</div>
        </>
      )}
      <input
        value={source}
        onChange={(e) => setSource(e.target.value)}
        onBlur={(e) => { if (kind === 'local') probe(e.target.value); }}
        placeholder={kind === 'github' ? t('launcher.setup.sourceGithubPlaceholder') : '/Users/you/Desktop/repos/app'}
        dir="ltr"
        spellCheck={false}
        className={MONO}
      />
      {kind === 'local' && (
        <div className="text-xs text-fgdim">
          {detecting ? t('launcher.setup.scanning')
            : detect ? (detect.exists
              ? <><Icon icon={faCheck} /> {detect.isGit ? t('launcher.setup.gitRepo') : t('launcher.setup.folder')}{detect.toolchain?.pm ? ` · ${detect.toolchain.pm}` : ''}{t('launcher.setup.copiedMinus')}</>
              : <><Icon icon={faTriangleExclamation} /> {t('launcher.setup.folderNotFound')}</>)
            : t('launcher.setup.workingTreeHint')}
        </div>
      )}

      <button
        type="button" onClick={() => setShowAdv((v) => !v)} aria-expanded={showAdv}
        className="inline-flex cursor-pointer items-center gap-1 self-start text-xs font-medium text-fgdim outline-none hover:text-fg focus-visible:outline-2 focus-visible:outline-ring coarse:min-h-11"
      >
        <ChevronRight className={`size-3.5 transition-transform rtl:rotate-180 ${showAdv ? 'rotate-90 rtl:rotate-90' : ''}`} aria-hidden="true" /> {t('setup.repo.advanced')}
      </button>
      {showAdv && (
        <div className="flex flex-col gap-3 rounded-md border border-hair bg-panel px-3 py-3">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={source.trim() ? repoNameFromSource(source) || t('launcher.setup.namePlaceholder') : t('launcher.setup.namePlaceholder')} className={INPUT} />
          <input value={installCmd} onChange={(e) => setInstallCmd(e.target.value)} placeholder={t('launcher.setup.installPlaceholder')} dir="ltr" className={MONO} />

          {/* env files to copy */}
          {kind === 'github' && (
            <div className="flex gap-2">
              <input
                value={envFolder} onChange={(e) => setEnvFolder(e.target.value)}
                placeholder={t('launcher.setup.copyEnvPlaceholder')} dir="ltr" className={`${MONO} flex-1`}
              />
              <button type="button" onClick={() => probe(envFolder)} disabled={detecting || !envFolder.trim()} className={BTN2}>
                {detecting ? '…' : t('launcher.setup.scan')}
              </button>
            </div>
          )}
          {candidates.length > 0 ? (
            <div className="rounded-md border border-hair px-2.5 py-2">
              <div className="mb-1 text-xs font-medium text-fgdim">{t('launcher.setup.envFilesToCopy')}</div>
              {candidates.map((f) => (
                <label key={f} className="flex cursor-pointer items-center gap-2 py-1 text-xs text-fg coarse:min-h-11">
                  <Checkbox checked={picked.includes(f)} onCheckedChange={() => toggle(f)} />
                  <span dir="ltr" className="font-mono">{f}</span>
                </label>
              ))}
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <Label>{t('launcher.setup.envLabel')}</Label>
              <Select value={simpleEnv} onValueChange={setSimpleEnv}>
                <SelectTrigger className="w-auto min-w-32" aria-label={t('launcher.setup.envLabel')}><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t('launcher.setup.envNone')}</SelectItem>
                  <SelectItem value="file">{t('launcher.setup.envFile')}</SelectItem>
                  <SelectItem value="command">{t('launcher.setup.envCommand')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
      )}

      {missing && !source.trim() && <div role="alert" className="text-xs text-warn">{t('setup.repo.needSource')}</div>}
      <div className="flex items-center gap-2">
        <button type="button" disabled={busy} onClick={submit} className={BTN}>
          {t('launcher.setup.add')}
        </button>
        <button type="button" onClick={reset} aria-label={t('setup.cancel')} className="inline-flex size-8 cursor-pointer items-center justify-center rounded-md text-fgdim outline-none hover:bg-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-ring coarse:size-11"><Icon icon={faXmark} /></button>
      </div>
    </div>
  );
}

// The front door: a hero that starts the guided (chat) onboarding. The skill
// runs INSIDE an engine session, so Start needs one connected engine.
// S2 — minimal first screen: Connect Claude / Connect Codex → Start. Nothing else blocks;
// every other capability connects just-in-time from the chat (SetupCard).
// "Run full setup" reopens the B3 wizard for people who want all the steps.
function MinimalHero({ engines, onStart, onRecheck, onRunWizard, busy }) {
  const t = useT();
  const anyOk = anyEngineConnected(engines);
  return (
    <div className="mb-4 overflow-hidden rounded-lg border border-hair bg-panel">
      <div className="px-4 py-4">
        <div className="text-base font-medium text-fg">{t('setup.minimal.title')}</div>
        <p className="mt-1 text-xs leading-relaxed text-fgdim">{t('setup.minimal.body')}</p>
        <ol className="mt-3 flex flex-col gap-3">
          <li className="rounded-md border border-hair bg-bg px-3 py-3">
            <div className="flex items-center gap-2 text-xs font-medium text-fg">
              <span className={`inline-flex size-5 items-center justify-center rounded-full text-xs tabular-nums ${anyOk ? 'bg-ok text-white' : 'border border-input bg-bg'}`}>{anyOk ? <Icon icon={faCheck} /> : '1'}</span>
              {t('setup.minimal.connectEngine')}
            </div>
            <div className="mt-2"><EngineConnect engines={engines} onChanged={onRecheck} intro={false} /></div>
          </li>
          <li className={`rounded-md border border-hair px-3 py-3 ${anyOk ? 'bg-bg' : 'bg-muted/40 opacity-70'}`}>
            <div className="flex items-center gap-2 text-xs font-medium text-fg">
              <span className="inline-flex size-5 items-center justify-center rounded-full border border-input bg-bg text-xs tabular-nums">2</span>
              {t('setup.minimal.start')}
            </div>
            <p className="mt-1 text-xs leading-snug text-fgdim">{t('setup.minimal.startBody')}</p>
            <button
              type="button" disabled={busy || !anyOk} onClick={onStart}
              className={`${BTN} mt-3`}
            >
              {busy ? t('launcher.setup.starting') : t('setup.minimal.startBtn')} <Icon icon={faArrowRight} className="mirror-rtl" />
            </button>
            {!anyOk && <p role="status" className="mt-2 text-xs text-fgdim">{t('setup.minimal.needEngine')}</p>}
          </li>
        </ol>
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
  const [repoList, setRepoList] = useState([]); // GET /onboarding/repos — real per-repo clone state
  const [repoNote, setRepoNote] = useState(null);
  const [engines, setEngines] = useState(null); // {claude, codex}: {ok, detail, data} from setup-api.overview()
  const [more, setMore] = useState(false);
  const { setupTick, wizardTick } = useStore();

  const refresh = useCallback(async () => {
    try {
      const [st, ov, rl] = await Promise.all([api.get('/onboarding/status'), setupApi.overview().catch(() => null), api.get('/onboarding/repos').catch(() => null)]);
      setData(st);
      if (Array.isArray(rl)) setRepoList(rl);
      const cap = (id) => ov?.capabilities?.find((c) => c.id === id) || null;
      setEngines({ claude: cap('claude'), codex: cap('codex') });
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
    const running = (data?.steps || []).some((s) => s.status === 'running') || repoList.some((r) => r.state === 'cloning');
    if (!running) return undefined;
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, [data, repoList, refresh]);

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
      const r = await setupApi.addRepoAndFetch(entry);
      setRepoNote({ key: addOutcome(r, entry.source), name: r?.name || entry.name });
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
    // F8: flip onboarding.json to mode:'full' so the wizard lists every step;
    // a reset would forget the pair/claude decisions already made.
    try { await api.post('/onboarding/wizard/mode', { mode: 'full' }); } catch { /* not admin — the wizard still opens read-only */ }
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
  const globalsOk = global.length > 0 && global.every((s) => s.status === 'ok' || s.required === false);
  const anyRepoReady = repoNames.some((n) =>
    steps.filter((s) => s.scope === `repo:${n}`).every((s) => s.status === 'ok')
  );
  const workspaceReady = globalsOk && anyRepoReady;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-bg text-fg">
      <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-x-2.5 gap-y-1 border-b border-hair px-4 py-1">
        <span className="text-sm font-medium">{t('launcher.setup.title')}</span>
        {env && more && (
          <Badge mono variant="outline">
            {env.container ? t('launcher.setup.container') : t('launcher.setup.native')} · {env.strategy}
          </Badge>
        )}
        <button
          type="button" onClick={refresh}
          className="ms-auto inline-flex cursor-pointer items-center gap-1 px-1 text-xs text-fgdim outline-none hover:text-fg focus-visible:outline-2 focus-visible:outline-ring coarse:min-h-11"
        >
          <Icon icon={faRotateRight} /> {t('launcher.setup.refresh')}
        </button>
        {onRunWizard && (
          <Tip label={t('launcher.setup.runWizardHint')}>
            <button type="button" onClick={runWizard} className={BTN2_SM}>
              {t('launcher.setup.runWizard')}
            </button>
          </Tip>
        )}
        <button
          type="button" onClick={onClose} aria-label={t('wizard.exit')}
          className="inline-flex size-8 cursor-pointer items-center justify-center rounded-md text-sm text-fgdim outline-none hover:bg-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-ring coarse:size-11"
        >
          <Icon icon={faXmark} />
        </button>
      </div>

      <div className="thin-scroll min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {err && (
          <div role="alert" className="mb-4 rounded-md border border-err-line bg-err-bg px-3 py-2 text-xs text-err">
            {err}
          </div>
        )}
        {!data && !err && <div className="text-xs text-fgdim">{t('launcher.setup.loading')}</div>}

        {data && (
          <>
            <MinimalHero engines={engines} onStart={startSession} onRecheck={refresh} onRunWizard={onRunWizard ? runWizard : null} busy={busy} />

            <button type="button" onClick={() => setMore((v) => !v)} aria-expanded={more} className="mb-3 inline-flex cursor-pointer items-center gap-1 text-xs font-medium text-fgdim outline-none hover:text-fg focus-visible:outline-2 focus-visible:outline-ring coarse:min-h-11">
              <ChevronRight className={`size-3.5 transition-transform rtl:rotate-180 ${more ? 'rotate-90 rtl:rotate-90' : ''}`} aria-hidden="true" /> {t('setup.minimal.more')}{workspaceReady ? '' : ` · ${t('setup.minimal.moreHint')}`}
            </button>
            {more && (
            <>
            {!workspaceReady && (
              <div className="mb-4 rounded-lg border border-hair bg-panel px-4 py-3">
                <div className="text-sm font-medium text-fg">{t('launcher.setup.welcomeTitle')}</div>
                <p className="mt-1 text-xs leading-relaxed text-fgdim">{t('launcher.setup.welcomeBody')}</p>
                <button type="button" disabled={busy} onClick={startOnboarding} className={`${BTN2} mt-3`}>
                  {busy ? t('launcher.setup.starting') : t('launcher.setup.startOnboarding')}
                </button>
              </div>
            )}
            <a href="#/settings/connections" className="mb-4 flex items-center gap-2 rounded-lg border border-hair bg-panel px-4 py-3 text-sm text-fg outline-none hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring">
              <span className="font-medium">{t('launcher.setup.connections')}</span>
              <span className="text-xs text-fgdim">{t('setup.minimal.moreConnections')}</span>
              <Icon icon={faArrowRight} className="mirror-rtl ms-auto text-fgdim" />
            </a>

            <Section title={`${t('launcher.setup.repos')}${repoNames.length ? ` · ${repoNames.length}` : ''}`}>
              {repoNames.length === 0 && (
                <div className="px-3 py-3 text-xs text-fgdim">
                  {t('launcher.setup.noRepos')}
                </div>
              )}
              {repoNames.map((name) => (
                <div key={name} className="border-b border-hair last:border-0">
                  <div className="flex items-center gap-2 bg-muted/40 px-3 py-1.5">
                    <span dir="ltr" className="font-mono text-xs font-medium text-fg">{name}</span>
                    <Tip label={t('launcher.setup.removeTitle')}>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => removeRepo(name)}
                        className="ms-auto inline-flex cursor-pointer items-center text-xs text-fgdim outline-none hover:text-err focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50 coarse:min-h-11"
                      >
                        {t('launcher.setup.remove')}
                      </button>
                    </Tip>
                  </div>
                  {repoList.find((r) => r.name === name) && (
                    <RepoRow repo={repoList.find((r) => r.name === name)} onClone={(n) => fix(n, 'clone')} busy={busy} />
                  )}
                  {steps
                    .filter((s) => s.scope === `repo:${name}` && !(repoList.length && s.action === 'onboarding.cloneRepo'))
                    .map((s) => (
                      <StepRow key={s.id} step={s} onFix={fix} busy={busy} />
                    ))}
                </div>
              ))}
              {repoNote && (
                <div className="border-t border-hair px-3 py-2 text-xs font-medium text-ok">
                  {t({ already: 'setup.repo.already', 'cloning-existing': 'setup.repo.alreadyCloning', added: 'setup.repo.added', 'added-local': 'setup.repo.addedLocal' }[repoNote.key], { name: repoNote.name })}
                </div>
              )}
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
                      <div className="text-sm font-medium text-fg">
                        {prof.title || prof.name}
                      </div>
                      {prof.description && (
                        <div className="mt-0.5 text-xs leading-snug text-fgdim">
                          {prof.description}
                        </div>
                      )}
                    </div>
                    <Tip label={t('launcher.setup.profileApplyTitle')}>
                      <button type="button" disabled={busy} onClick={() => applyProfile(prof.name)} className={BTN2_SM}>
                        {t('launcher.setup.apply')}
                      </button>
                    </Tip>
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
