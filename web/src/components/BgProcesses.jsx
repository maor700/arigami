// Background shells the agent started with `run_in_background` (parsed from the
// session's stream-json). A header chip shows the running count; clicking opens
// a split panel — a selectable process list on the left, the selected shell's
// live output as a terminal on the right — with a kill control.
import { useState, useEffect, useRef } from 'react';
import { api } from '../lib/api.js';
import { Truncate } from './Truncate.jsx';
import { Icon } from '../lib/icons.js';
import { useT } from '../lib/i18n.js';
import { faStop, faXmark } from '@fortawesome/free-solid-svg-icons';
import { Button } from './ui/button.jsx';
import { Tip } from './ui/tooltip.jsx';
import { Dialog, DialogContent, DialogTitle } from './ui/dialog.jsx';

const STATUS_COLOR = { running: 'var(--hb-ok)', exited: 'var(--color-fgdim)', killed: 'var(--hb-err)' };
const fmtAgo = (ts) => {
  if (!ts) return '';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
};

export const bgRunningCount = (session) => (session.bg || []).filter((b) => b.status === 'running').length;

/* ---------- header chip --------------------------------------------------- */

export function ProcessChip({ session, onClick }) {
  const t = useT();
  const procs = session.bg || [];
  if (!procs.length) return null;
  const running = bgRunningCount(session);
  return (
    <Tip label={t('chat.bgChipTitle', { running, total: procs.length })}>
      <button
        type="button"
        onClick={onClick}
        className="flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-input bg-card px-2 text-xs text-fg outline-none hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring coarse:min-h-11"
      >
        <span className="text-xs leading-none">❯_</span>
        <span className="font-medium tabular-nums">{running}</span>
        {running > 0 && <span className="size-1.5 rounded-full pulse-green" style={{ background: 'var(--hb-ok)' }} />}
      </button>
    </Tip>
  );
}

/* ---------- split panel --------------------------------------------------- */

export function BgProcessesPanel({ session, onClose }) {
  const t = useT();
  const statusLabel = (st) =>
    st === 'running' ? t('chat.bgRunning') : st === 'exited' ? t('chat.bgExited') : st === 'killed' ? t('chat.bgKilled') : st;
  const procs = session.bg || [];
  const [selId, setSelId] = useState(procs[0]?.id || null);
  const sel = procs.find((p) => p.id === selId) || procs[0] || null;
  const [detail, setDetail] = useState(null); // {output, status}
  const outRef = useRef(null);

  // Poll the selected shell's output (and live status).
  useEffect(() => {
    if (!sel) return;
    let stop = false;
    setDetail(null);
    const tick = async () => {
      try {
        const d = await api.get(`/sessions/${session.id}/bg/${sel.id}/output`);
        if (!stop) setDetail(d);
      } catch { /* shell may have been reaped */ }
    };
    tick();
    const iv = setInterval(tick, 1500);
    return () => { stop = true; clearInterval(iv); };
  }, [sel?.id, session.id]);

  // Keep the terminal pinned to the bottom as output streams.
  useEffect(() => {
    const el = outRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [detail?.output]);

  const kill = async (id) => {
    try { await api.post(`/sessions/${session.id}/bg/${id}/kill`); } catch { /* WS echo updates state */ }
  };

  const liveStatus = (p) => (p.id === sel?.id && detail ? detail.status : p.status);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        showClose={false}
        aria-describedby={undefined}
        className="flex h-[78vh] w-[min(57.5rem,calc(100vw-1.5rem))] max-w-full flex-col gap-0 overflow-hidden p-0"
      >
        <div className="flex items-center gap-2.5 border-b border-hair px-4 py-3">
          <span className="text-sm leading-none">❯_</span>
          <DialogTitle className="text-sm">{t('chat.backgroundProcesses')}</DialogTitle>
          <span className="text-xs text-fgdim tabular-nums">
            {t('chat.bgRunningTotal', { running: bgRunningCount(session), total: procs.length })}
          </span>
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label={t('dialogs.close')} className="ms-auto">
            <Icon icon={faXmark} />
          </Button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          {/* left: process list — stacks on top of the terminal on phones */}
          <div className="thin-scroll max-h-[30vh] shrink-0 overflow-y-auto border-b border-hair bg-bg md:max-h-none md:w-[320px] md:border-e md:border-b-0">
            {procs.map((p) => {
              const st = liveStatus(p);
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setSelId(p.id)}
                  className={`flex w-full cursor-pointer flex-col gap-1 border-b border-hair px-3 py-2.5 text-start ${
                    p.id === sel?.id ? 'bg-muted' : 'hover:bg-panel'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className="size-2 shrink-0 rounded-full" style={{ background: STATUS_COLOR[st] || 'var(--color-fgdim)' }} />
                    <span className="font-mono text-xs text-fgdim" dir="ltr">{p.id}</span>
                    <span className="ms-auto text-xs text-fgdim">{statusLabel(st)}</span>
                  </div>
                  <Truncate
                    text={p.description || p.command}
                    className="font-mono text-xs text-fg"
                  />
                  <span className="text-xs text-fgdim">{t('chat.startedAgo', { ago: fmtAgo(p.startedAt) })}</span>
                </button>
              );
            })}
          </div>

          {/* right: terminal output of the selected shell */}
          <div className="flex min-w-0 flex-1 flex-col bg-term">
            {sel ? (
              <>
                <div className="flex items-center gap-2 border-b border-white/10 px-3.5 py-2">
                  <span className="size-2 shrink-0 rounded-full" style={{ background: STATUS_COLOR[liveStatus(sel)] || 'var(--color-fgdim)' }} />
                  <Truncate text={sel.command} className="font-mono text-xs text-[#d4d4d4]" />
                  {liveStatus(sel) === 'running' && (
                    <Button variant="destructive" size="sm" onClick={() => kill(sel.id)} className="ms-auto">
                      <Icon icon={faStop} /> {t('chat.killLower')}
                    </Button>
                  )}
                </div>
                <pre
                  ref={outRef}
                  dir="ltr"
                  className="thin-scroll min-h-0 flex-1 overflow-auto px-3.5 py-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words text-[#cfcfcf]"
                >
                  {detail ? detail.output || t('chat.noOutput') : t('chat.loading')}
                </pre>
              </>
            ) : (
              <div className="flex flex-1 items-center justify-center text-sm text-[#888]">
                {t('chat.noBgProcesses')}
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
