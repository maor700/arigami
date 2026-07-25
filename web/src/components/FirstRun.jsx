import { useState } from 'react';
import { api } from '../lib/api.js';
import { extractTicketId, buildTicketPayload } from './Launcher.jsx';
import { Icon } from '../lib/icons.js';
import { faArrowUp } from '@fortawesome/free-solid-svg-icons';

// No sessions yet → full-page launcher: big wave glyph + a single paste field.
export default function FirstRun({ config, sessions, onCreated, onOpenLauncher }) {
  const [val, setVal] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async () => {
    if (busy) return; // guard: Enter can fire while a POST is already in flight
    const id = extractTicketId(val);
    if (!id) {
      setError('Paste a Linear URL or an ID like ENG-16498.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const session = await api.post(
        '/sessions',
        buildTicketPayload({ id, title: '' }, config, sessions),
      );
      onCreated(session);
    } catch (e) {
      setError(`Couldn't create the session — ${String(e.message || e)}`);
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
      <div className="mb-1 text-[26px] leading-tight font-bold">What are we building?</div>
      <div className="mb-3.5 text-[11.5px] text-fgdim">
        Paste a Linear ticket to spin up your first session.
      </div>
      <div className="flex w-[320px] max-w-[90%] items-center gap-[9px] rounded-[10px] border-[1.5px] border-ink px-[13px] py-2.5 focus-within:shadow-[2px_2px_0_rgba(42,42,42,0.16)]">
        <span
          className="h-[13px] w-[13px] shrink-0 rotate-45 rounded-[2px]"
          style={{ background: '#5b62d6' }}
        />
        <input
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder="ENG-_____"
          autoFocus
          className="min-w-0 flex-1 bg-transparent font-mono text-xs outline-none placeholder:text-fgdim"
        />
        <button
          type="button"
          onClick={submit}
          disabled={busy}
          title="Create session"
          className="flex h-[26px] w-[26px] shrink-0 cursor-pointer items-center justify-center rounded-[7px] border-[1.5px] border-ink bg-brand text-xs disabled:opacity-50"
        >
          {busy ? '…' : <Icon icon={faArrowUp} />}
        </button>
      </div>
      {error && <div className="mt-3 text-[11px] text-danger">{error}</div>}
      <button
        type="button"
        onClick={onOpenLauncher}
        className="mt-5 cursor-pointer text-xs text-fgdim underline-offset-2 hover:underline"
      >
        or browse tickets / start an empty session
      </button>
    </div>
  );
}
