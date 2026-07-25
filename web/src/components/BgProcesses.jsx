// Background shells the agent started with `run_in_background` (parsed from the
// session's stream-json). A header chip shows the running count; clicking opens
// a split panel — a selectable process list on the left, the selected shell's
// live output as a terminal on the right — with a kill control.
import { useState, useEffect, useRef } from 'react';
import { api } from '../lib/api.js';
import { Truncate } from './Truncate.jsx';
import { Icon } from '../lib/icons.js';
import { faStop, faXmark } from '@fortawesome/free-solid-svg-icons';

const STATUS_COLOR = { running: '#3C9A4E', exited: '#9a9a9a', killed: '#B23B30' };
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
  const procs = session.bg || [];
  if (!procs.length) return null;
  const running = bgRunningCount(session);
  return (
    <button
      type="button"
      onClick={onClick}
      title={`${running} running · ${procs.length} background process${procs.length === 1 ? '' : 'es'}`}
      className="flex shrink-0 items-center gap-1.5 rounded-full border-[1.5px] border-ink bg-bg px-2.5 py-[3px] font-mono text-[10.5px] text-fg hover:bg-chip"
    >
      <span className="text-[11px] leading-none">❯_</span>
      <span className="font-bold">{running}</span>
      {running > 0 && <span className="h-[6px] w-[6px] rounded-full bg-[#3C9A4E] pulse-green" />}
    </button>
  );
}

/* ---------- split panel --------------------------------------------------- */

export function BgProcessesPanel({ session, onClose }) {
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

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const kill = async (id) => {
    try { await api.post(`/sessions/${session.id}/bg/${id}/kill`); } catch { /* WS echo updates state */ }
  };

  const liveStatus = (p) => (p.id === sel?.id && detail ? detail.status : p.status);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-3 md:p-6" onMouseDown={onClose}>
      <div
        className="flex h-[78vh] w-[920px] max-w-full flex-col overflow-hidden rounded-[12px] border-[1.5px] border-ink bg-panel shadow-[4px_4px_0_rgba(0,0,0,0.25)]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 border-b border-hair px-4 py-3">
          <span className="text-[13px] leading-none">❯_</span>
          <span className="font-mono text-[13px] font-bold text-fg">Background processes</span>
          <span className="font-mono text-[10.5px] text-fgdim">
            {bgRunningCount(session)} running · {procs.length} total
          </span>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto flex h-7 w-7 cursor-pointer items-center justify-center rounded-md border border-hair text-fgdim hover:border-ink hover:text-fg"
          >
            <Icon icon={faXmark} />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          {/* left: process list — stacks on top of the terminal on phones */}
          <div className="thin-scroll max-h-[30vh] shrink-0 overflow-y-auto border-b border-hair bg-bg md:max-h-none md:w-[320px] md:border-r md:border-b-0">
            {procs.map((p) => {
              const st = liveStatus(p);
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setSelId(p.id)}
                  className={`flex w-full flex-col gap-1 border-b border-hair px-3 py-2.5 text-left ${
                    p.id === sel?.id ? 'bg-chip' : 'hover:bg-panel'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: STATUS_COLOR[st] || '#9a9a9a' }} />
                    <span className="font-mono text-[10px] text-fgdim">{p.id}</span>
                    <span className="ml-auto font-mono text-[9.5px] text-fgdim">{st}</span>
                  </div>
                  <Truncate
                    text={p.description || p.command}
                    className="font-mono text-[11px] text-fg"
                  />
                  <span className="font-mono text-[9.5px] text-fgdim">started {fmtAgo(p.startedAt)} ago</span>
                </button>
              );
            })}
          </div>

          {/* right: terminal output of the selected shell */}
          <div className="flex min-w-0 flex-1 flex-col bg-term">
            {sel ? (
              <>
                <div className="flex items-center gap-2 border-b border-white/10 px-3.5 py-2">
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: STATUS_COLOR[liveStatus(sel)] || '#9a9a9a' }} />
                  <Truncate text={sel.command} className="font-mono text-[11px] text-[#d4d4d4]" />
                  {liveStatus(sel) === 'running' && (
                    <button
                      type="button"
                      onClick={() => kill(sel.id)}
                      className="ml-auto flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md border-[1.5px] border-danger bg-transparent px-2.5 py-1 text-[10.5px] font-bold text-danger hover:bg-danger/10"
                    >
                      <Icon icon={faStop} className="text-[9px]" /> kill
                    </button>
                  )}
                </div>
                <pre
                  ref={outRef}
                  dir="ltr"
                  className="thin-scroll min-h-0 flex-1 overflow-auto px-3.5 py-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words text-[#cfcfcf]"
                >
                  {detail ? detail.output || '(no output)' : 'loading…'}
                </pre>
              </>
            ) : (
              <div className="flex flex-1 items-center justify-center text-[12px] text-[#888]">
                No background processes.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
