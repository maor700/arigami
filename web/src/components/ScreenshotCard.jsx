// `screenshot` chat events (T3): the agent's capture_screen calls and the
// Watch-mode auto-snapshots taken while a request_screen card is open.
// ChatPane groups consecutive screenshot events into one card — a single
// image shows thumbnail + caption + time; a run collapses to a strip with a
// count ("12 screenshots") that expands on click. Auto-snapshots look the
// same as agent captures (no "recording" badge, by design). Clicking any thumbnail
// opens it full size in a lightbox (portaled, like ScreenModal).
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../lib/i18n.js';
import { Icon } from '../lib/icons.js';
import { faCamera, faXmark, faChevronLeft, faChevronRight } from '@fortawesome/free-solid-svg-icons';

function clock(ts) {
  try {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return '';
  }
}

function Lightbox({ shots, index, onClose, onStep }) {
  const t = useT();
  const shot = shots[index];
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowRight') onStep(1);
      else if (e.key === 'ArrowLeft') onStep(-1);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, onStep]);
  if (!shot) return null;
  const btn = 'flex h-8 w-8 cursor-pointer items-center justify-center rounded-full border-[1.5px] border-ink bg-panel text-fg hover:bg-chip disabled:opacity-30';
  return createPortal(
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/70 p-3 md:p-6" onMouseDown={onClose}>
      <div className="flex max-h-full max-w-full flex-col items-center gap-2" onMouseDown={(e) => e.stopPropagation()}>
        <img
          src={shot.url}
          alt={shot.caption || t('chat.screenshot')}
          className="max-h-[82vh] max-w-full rounded-[10px] border-[1.5px] border-ink bg-black object-contain shadow-[4px_4px_0_rgba(0,0,0,0.35)]"
        />
        <div className="flex w-full items-center gap-2 font-mono text-[11px] text-white">
          {shots.length > 1 && (
            <button type="button" className={btn} disabled={index === 0} onClick={() => onStep(-1)} aria-label="previous">
              <Icon icon={faChevronLeft} />
            </button>
          )}
          <span dir="auto" className="min-w-0 flex-1 truncate">
            {shot.caption || t('chat.screenshotNoCaption')} · {clock(shot.ts)}
            {shots.length > 1 ? ` · ${index + 1}/${shots.length}` : ''}
          </span>
          {shots.length > 1 && (
            <button type="button" className={btn} disabled={index === shots.length - 1} onClick={() => onStep(1)} aria-label="next">
              <Icon icon={faChevronRight} />
            </button>
          )}
          <button type="button" className={btn} onClick={onClose} aria-label="close">
            <Icon icon={faXmark} />
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

function Thumb({ shot, onClick, className = '' }) {
  const t = useT();
  return (
    <button
      type="button"
      onClick={onClick}
      title={t('chat.screenshotOpen')}
      className={`block cursor-zoom-in overflow-hidden rounded-[7px] border border-[var(--term-border)] bg-black ${className}`}
    >
      <img src={shot.url} alt={shot.caption || t('chat.screenshot')} loading="lazy" className="block h-full w-full object-cover" />
    </button>
  );
}

// `shots` — one or more consecutive screenshot events (oldest first).
export default function ScreenshotCard({ shots }) {
  const t = useT();
  const [open, setOpen] = useState(-1); // lightbox index
  const [expanded, setExpanded] = useState(false);
  if (!shots?.length) return null;
  const last = shots[shots.length - 1];
  const step = (d) => setOpen((i) => Math.min(shots.length - 1, Math.max(0, i + d)));

  const header = (
    <div className="flex items-center gap-2 font-mono text-[11px]">
      <span className="text-[var(--term-dim)]"><Icon icon={faCamera} /></span>
      <span className="font-bold text-[var(--term-fg)]">
        {shots.length > 1 ? t('chat.screenshotsN', { n: shots.length }) : t('chat.screenshot')}
      </span>
      <span className="ms-auto text-[10px] text-[var(--term-faint)]">
        {shots.length > 1 ? `${clock(shots[0].ts)} – ${clock(last.ts)}` : clock(last.ts)}
      </span>
    </div>
  );

  let body;
  if (shots.length === 1) {
    body = (
      <div className="mt-1.5 flex gap-3">
        <Thumb shot={last} onClick={() => setOpen(0)} className="h-[110px] w-[176px] shrink-0" />
        {last.caption && <div dir="auto" className="min-w-0 self-center text-[12px] leading-snug text-[var(--term-fg)]">{last.caption}</div>}
      </div>
    );
  } else if (!expanded) {
    // Collapsed strip: the last few frames, oldest fading behind.
    const tail = shots.slice(-4);
    body = (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="mt-1.5 flex w-full cursor-pointer items-end gap-1.5 text-left"
        title={t('chat.more')}
      >
        {tail.map((s, i) => (
          <div key={s.id || s.url} className="h-[64px] w-[102px] shrink-0 overflow-hidden rounded-[6px] border border-[var(--term-border)] bg-black" style={{ opacity: 0.55 + (0.45 * (i + 1)) / tail.length }}>
            <img src={s.url} alt="" loading="lazy" className="block h-full w-full object-cover" />
          </div>
        ))}
        {last.caption && <span dir="auto" className="ms-1 min-w-0 truncate self-center text-[11.5px] text-[var(--term-dim)]">{last.caption}</span>}
        <span className="ms-auto shrink-0 self-center text-[10px] text-[var(--term-faint)]">{t('chat.more')} ›</span>
      </button>
    );
  } else {
    body = (
      <div className="mt-1.5">
        <div className="flex flex-wrap gap-1.5">
          {shots.map((s, i) => (
            <div key={s.id || s.url} className="w-[102px]">
              <Thumb shot={s} onClick={() => setOpen(i)} className="h-[64px] w-full" />
              <div dir="auto" className="mt-0.5 truncate font-mono text-[9.5px] text-[var(--term-faint)]" title={s.caption || ''}>
                {clock(s.ts)}{s.caption ? ` · ${s.caption}` : ''}
              </div>
            </div>
          ))}
        </div>
        <button type="button" onClick={() => setExpanded(false)} className="mt-1 cursor-pointer font-mono text-[10px] text-[var(--term-faint)] hover:text-[var(--term-fg)]">
          ‹ {t('chat.less')}
        </button>
      </div>
    );
  }

  return (
    <div className="my-2 rounded-[10px] border border-[var(--term-border)] bg-[var(--term-codebg)] p-2.5">
      {header}
      {body}
      {open >= 0 && <Lightbox shots={shots} index={open} onClose={() => setOpen(-1)} onStep={step} />}
    </div>
  );
}
