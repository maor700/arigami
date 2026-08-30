import { useState } from 'react';
import { api } from '../lib/api.js';
import { Icon } from '../lib/icons.js';
import { useT } from '../lib/i18n.js';
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

export default function FirstRun({ config, onCreated, onOpenLauncher }) {
  const t = useT();
  const [val, setVal] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async () => {
    if (busy) return; // guard: Enter can fire while a POST is already in flight
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
      {/* big wave glyph */}
      <span className="mb-4 flex items-end gap-0.5" aria-hidden="true">
        {[14, 22, 17, 26].map((h, i) => (
          <span key={i} className="inline-block w-1 bg-brand" style={{ height: h }} />
        ))}
      </span>
      <div className="mb-1 text-[26px] leading-tight font-bold">{t('launcher.firstRun.heading')}</div>
      <div className="mb-4 max-w-[460px] text-center text-[11.5px] leading-relaxed text-fgdim">{t('launcher.firstRun.sub')}</div>
      <div className="flex w-[460px] max-w-[92%] items-end gap-[9px] rounded-[12px] border-[1.5px] border-ink bg-panel px-[13px] py-2.5 focus-within:shadow-[2px_2px_0_rgba(42,42,42,0.16)]">
        <textarea
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }}
          placeholder={t('launcher.firstRun.placeholder')}
          rows={2}
          autoFocus
          dir="auto"
          data-testid="first-run-prompt"
          className="min-w-0 flex-1 resize-none bg-transparent text-[13px] leading-snug outline-none placeholder:text-fgdim"
        />
        <button
          type="button"
          onClick={submit}
          disabled={busy}
          title={t('launcher.firstRun.createTitle')}
          className="flex h-[28px] w-[28px] shrink-0 cursor-pointer items-center justify-center rounded-[8px] border-[1.5px] border-ink bg-brand text-xs disabled:opacity-50"
        >
          {busy ? '…' : <Icon icon={faArrowUp} />}
        </button>
      </div>
      <div className="mt-3 flex flex-wrap justify-center gap-2">
        {FIRST_RUN_CHIPS.map((c) => (
          <button
            key={c.id}
            type="button"
            data-testid={`first-run-chip-${c.id}`}
            onClick={() => { setVal(t(c.prompt)); setError(null); }}
            className="flex cursor-pointer items-center gap-1.5 rounded-full border-[1.5px] border-border bg-panel px-3 py-1 text-[11.5px] text-fg hover:border-ink"
          >
            <Icon icon={c.icon} /> {t(c.label)}
          </button>
        ))}
      </div>
      {error && <div className="mt-3 text-[11px] text-danger">{error}</div>}
      <button
        type="button"
        onClick={onOpenLauncher}
        className="mt-6 cursor-pointer text-[11px] text-fgdim underline-offset-2 hover:underline"
      >
        {t('launcher.firstRun.advanced')}
      </button>
    </div>
  );
}
