import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { Icon } from '../lib/icons.js';
import { useT, fieldDir } from '../lib/i18n.js';
import { Logo } from './Logo.jsx';
import { Button } from './ui/button.jsx';
import { Tip } from './ui/tooltip.jsx';
import * as setupApi from '../lib/setup-api.js';
import { anyEngineConnected } from './setup/EngineConnect.jsx';
import { faArrowUp, faCamera, faComment, faCodeBranch } from '@fortawesome/free-solid-svg-icons';

// F8: no sessions yet → one question ("What would you like me to do?"), three
// suggestion chips, and a small "Advanced" link to the full launcher. The
// text becomes the first session's opening prompt; the session starts in the
// default workspace with the host's default permission mode. No Linear, no
// permission-mode jargon on the very first screen.
export const FIRST_RUN_CHIPS = [
  { id: 'screenshot', icon: faCamera, label: 'launcher.firstRun.chip.screenshot', prompt: 'launcher.firstRun.chip.screenshot.prompt' },
  { id: 'whatsapp', icon: faComment, label: 'launcher.firstRun.chip.whatsapp', prompt: 'launcher.firstRun.chip.whatsapp.prompt' },
  { id: 'clone', icon: faCodeBranch, label: 'launcher.firstRun.chip.clone', prompt: 'launcher.firstRun.chip.clone.prompt' },
];

export default function FirstRun({ config, onCreated, onOpenLauncher, onNeedsSetup }) {
  const t = useT();
  const [val, setVal] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // Is an engine (Claude or Codex) connected? null = not known yet (never blocks; the host's own card still catches it).
  const [connected, setConnected] = useState(null);
  useEffect(() => {
    let live = true;
    const check = () => setupApi.overview().then((ov) => {
      if (!live) return;
      const cap = (id) => ov?.capabilities?.find((c) => c.id === id) || null;
      setConnected(anyEngineConnected({ claude: cap('claude'), codex: cap('codex') }));
    }).catch(() => {});
    check();
    const id = setInterval(check, 4000); // a sign-in finished in another tab/window lifts the gate by itself
    return () => { live = false; clearInterval(id); };
  }, []);
  const needsEngine = connected === false;

  const submit = async () => {
    if (busy) return; // guard: Enter can fire while a POST is already in flight
    if (needsEngine) { onNeedsSetup?.(); return; } // an unanswerable first message would only fail with "Not logged in"
    const prompt = val.trim();
    if (!prompt) {
      setError(t('launcher.firstRun.emptyError'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const session = await api.post('/sessions', {
        prompt,
        cwd: config?.defaultCwd || undefined,
        permissionMode: 'bypassPermissions',
      });
      onCreated(session);
    } catch (e) {
      setError(t('launcher.firstRun.createError', { msg: String(e.message || e) }));
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-1 flex-col items-center justify-center bg-bg p-6 text-fg">
      <Logo size="3rem" className="mb-4" />
      <div className="mb-1 text-2xl leading-tight font-semibold tracking-tight">{t('launcher.firstRun.heading')}</div>
      <div className="mb-5 max-w-[28.75rem] text-center text-sm leading-relaxed text-fgdim">{t('launcher.firstRun.sub')}</div>
      {needsEngine && (
        <div role="status" data-testid="first-run-connect" className="mb-3 flex w-[28.75rem] max-w-[92%] flex-col gap-2 rounded-lg border border-hair bg-panel px-4 py-3">
          <div className="text-sm font-medium text-fg">{t('launcher.firstRun.needEngineTitle')}</div>
          <div className="text-xs leading-snug text-fgdim">{t('launcher.firstRun.needEngineBody')}</div>
          <Button variant="primary" onClick={onNeedsSetup} className="self-start">
            {t('launcher.firstRun.needEngineBtn')}
          </Button>
        </div>
      )}
      <div className="flex w-[28.75rem] max-w-[92%] items-end gap-2 rounded-lg border border-input bg-panel px-3 py-2.5 transition-[border-color,box-shadow] focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/35">
        <textarea
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }}
          placeholder={t('launcher.firstRun.placeholder')}
          rows={2}
          autoFocus
          dir={fieldDir(val)}
          data-testid="first-run-prompt"
          className="min-w-0 flex-1 resize-none bg-transparent text-sm leading-snug outline-none placeholder:text-muted-foreground"
        />
        <Tip label={t('launcher.firstRun.createTitle')}>
          <Button variant={needsEngine ? 'default' : 'primary'} size="icon" onClick={submit} disabled={busy} aria-label={t('launcher.firstRun.createTitle')}>
            {busy ? '…' : <Icon icon={faArrowUp} />}
          </Button>
        </Tip>
      </div>
      <div className="mt-3 flex flex-wrap justify-center gap-2">
        {FIRST_RUN_CHIPS.map((c) => (
          <Button
            key={c.id}
            variant="outline"
            size="sm"
            data-testid={`first-run-chip-${c.id}`}
            onClick={() => { setVal(t(c.prompt)); setError(null); }}
          >
            <Icon icon={c.icon} /> {t(c.label)}
          </Button>
        ))}
      </div>
      {error && <div role="alert" className="mt-3 text-xs text-err">{error}</div>}
      <button
        type="button"
        onClick={onOpenLauncher}
        className="mt-6 cursor-pointer text-xs text-fgdim underline-offset-2 outline-none hover:underline focus-visible:outline-2 focus-visible:outline-ring coarse:min-h-11"
      >
        {t('launcher.firstRun.advanced')}
      </button>
    </div>
  );
}
