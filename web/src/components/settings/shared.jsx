// SET — the one set of primitives every Settings category is built from:
// Section (anchored heading), SettingCard (the uniform card), StatusPill,
// Field/Toggle/Segmented/CopyRow (moved here from the old 1300-line
// Settings.jsx) and hostPost (admin-confirmed POST to /__api/host/*).
import { useEffect, useState } from 'react';
import { useT } from '../../lib/i18n.js';
import { Icon } from '../../lib/icons.js';
import { faRotateRight, faChevronDown } from '@fortawesome/free-solid-svg-icons';
import { PILL } from '../setup/shared.jsx';

export const BTN =
  'shrink-0 cursor-pointer rounded-lg border-[1.5px] border-ink bg-panel px-3 py-1.5 text-[0.71875rem] font-bold text-fg hover:bg-brand hover:text-[#1a1a1a] disabled:cursor-default disabled:opacity-50';
export const BTN_SM = 'cursor-pointer rounded-lg border-[1.5px] border-ink bg-panel px-3 py-1 text-[0.6875rem] text-fg hover:bg-brand disabled:opacity-40';
export const BTN_PRIMARY = 'cursor-pointer rounded-lg border border-ink bg-brand px-2.5 py-1 text-[0.65625rem] font-bold text-fg hover:opacity-90 disabled:opacity-50';
export const BTN_DANGER = 'cursor-pointer rounded-lg border border-hair bg-white px-2.5 py-1 text-[0.65625rem] text-[#9c3b33] hover:bg-[#FBECEA] disabled:opacity-50';
export const INPUT = 'rounded-lg border-[1.5px] border-ink bg-panel px-2 py-1 font-mono text-[0.6875rem] text-fg outline-none disabled:opacity-60';
export const ROW = 'flex items-center justify-between gap-2 border-b border-hair py-1.5 text-[0.71875rem] last:border-b-0';
export const LIST = 'mt-2 rounded-lg border border-hair px-3 py-1';

export function Toggle({ on, onChange, disabled }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`relative h-[1.375rem] w-[2.5rem] shrink-0 cursor-pointer rounded-full border-[1.5px] border-ink transition-colors disabled:cursor-default disabled:opacity-40 ${on ? 'bg-brand' : 'bg-white'}`}
    >
      <span
        className="absolute top-[0.125rem] h-[0.9375rem] w-[0.9375rem] rounded-full border border-ink bg-white transition-[left]"
        style={{ left: on ? 21 : 2 }}
      />
    </button>
  );
}

export function Segmented({ value, options, onChange }) {
  return (
    <span className="flex overflow-hidden rounded-lg border-[1.5px] border-ink">
      {options.map((opt, i) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={`cursor-pointer px-3.5 py-1.5 text-[0.71875rem] ${i > 0 ? 'border-s-[1.5px] border-ink' : ''} ${
            value === opt.value ? 'bg-brand font-bold text-[#1a1a1a]' : 'bg-panel text-fgdim'
          }`}
        >
          {opt.label}
        </button>
      ))}
    </span>
  );
}

// label + hint on the left, control on the right. `wrap`: a wide control
// (several buttons) drops under the label instead of squeezing it (F4 #6).
export function Field({ label, hint, children, wrap = false }) {
  return (
    <div className={`flex items-center gap-4 border-b border-hair py-3.5 last:border-b-0${wrap ? ' flex-wrap' : ''}`}>
      <div className="min-w-[9rem] flex-1">
        <div className="text-[0.8125rem] font-bold text-fg">{label}</div>
        {hint && <div className="mt-0.5 text-[0.71875rem] text-fgdim">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

// ok | todo | pending | error | running | off — same palette as the setup cards.
export function StatusPill({ status, label }) {
  const cls = PILL[status === 'off' ? 'blocked' : status] || PILL.blocked;
  return <span className={`shrink-0 rounded-full border px-2 py-px text-[0.59375rem] font-bold uppercase ${cls}`}>{label}</span>;
}

// Anchored section heading. `id` is the deep-link segment
// (#/settings/<category>/<id>) and the scroll target.
export function Section({ id, title, onRefresh, children, first = false }) {
  const t = useT();
  return (
    <section id={id ? `settings-${id}` : undefined} className={first ? '' : 'mt-7'}>
      <div className="mb-2 flex items-center font-mono text-[0.625rem] tracking-[0.08em] text-fgdim uppercase">
        {title}
        {onRefresh && (
          <button type="button" onClick={onRefresh} className="ms-auto cursor-pointer text-[0.65625rem] font-normal normal-case hover:text-fg">
            <Icon icon={faRotateRight} /> {t('settings.refresh')}
          </button>
        )}
      </div>
      {children}
    </section>
  );
}

// The one card every connection/host block renders in: title + optional
// pill + actions on the first row, hint under it, body below.
export function SettingCard({ title, hint, pill, actions, children, tone = 'default' }) {
  const border = tone === 'danger' ? 'border-[#e2c4c0]' : 'border-hair';
  return (
    <div className={`mb-2 rounded-xl border ${border} bg-panel px-3 py-2.5`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[0.78125rem] font-bold text-fg">{title}</span>
        {pill}
        {actions && <span className="ms-auto flex flex-wrap items-center gap-1.5">{actions}</span>}
      </div>
      {hint && <div className="mt-0.5 text-[0.6875rem] text-fgdim">{hint}</div>}
      {children}
    </div>
  );
}

export function CopyRow({ url, compact = false }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  // compact: just the button (the caller already shows the URL) — list rows.
  if (compact) {
    return (
      <button
        type="button"
        onClick={() => { navigator.clipboard?.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
        className={BTN_SM}
      >
        {copied ? t('chrome.copy.copied') : t('chrome.copy.copy')}
      </button>
    );
  }
  return (
    <div className="flex items-center gap-2 py-2">
      <code dir="ltr" className="min-w-0 flex-1 truncate rounded-md border border-hair bg-bg px-2 py-1.5 font-mono text-[0.6875rem] text-fg">{url}</code>
      <button
        type="button"
        onClick={() => { navigator.clipboard?.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
        className={BTN}
      >
        {copied ? t('chrome.copy.copied') : t('chrome.copy.copy')}
      </button>
    </div>
  );
}

export function ErrorLine({ children }) {
  if (!children) return null;
  return <div className="mt-2 rounded-lg border border-[#e2c4c0] bg-[#FBECEA] px-3 py-2 text-[0.6875rem] text-[#9c3b33]">{children}</div>;
}

// Admin-confirmed mutation on /__api/host/* (server/host-control.ts).
export function hostPost(path, method = 'POST', body) {
  const raw = body instanceof Blob;
  return fetch(`/__api${path}`, {
    method,
    headers: { 'Content-Type': raw ? 'application/gzip' : 'application/json', 'X-Arigami-Confirm': 'yes' },
    body: method === 'POST' ? (raw ? body : JSON.stringify(body ?? {})) : undefined,
  }).then(async (r) => {
    const b = await r.json().catch(() => ({}));
    if (!r.ok) {
      const e = new Error(b?.error || `HTTP ${r.status}`);
      e.status = r.status;
      throw e;
    }
    return b;
  });
}

export function fmtWhen(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }); } catch { return String(iso); }
}

// AUDIT2 — the collapsed "Advanced" drawer at the bottom of every category.
// Everything classified ADV/MOVE lives inside; it is a native <details> so the
// content stays in the DOM (deep links, tests) but is not on screen until the
// human opens it. `ids` are the section ids inside — arriving at one of them
// via #/settings/<cat>/<id> opens the drawer so the scroll-to-section lands.
export function Advanced({ section, ids = [], children, hint }) {
  const t = useT();
  const wanted = !!section && ids.includes(section);
  const [open, setOpen] = useState(wanted);
  useEffect(() => { if (wanted) setOpen(true); }, [wanted]);
  return (
    <details
      id="settings-advanced"
      data-settings-advanced
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
      className="mt-8 rounded-xl border border-dashed border-hair"
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 font-mono text-[0.625rem] tracking-[0.08em] text-fgdim uppercase select-none hover:text-fg [&::-webkit-details-marker]:hidden">
        <span className={`text-[0.625rem] transition-transform ${open ? '' : 'rtl:rotate-90 ltr:-rotate-90'}`}><Icon icon={faChevronDown} /></span>
        {t('settings.advanced')}
        {hint && <span className="ms-auto text-[0.625rem] font-normal normal-case tracking-normal">{hint}</span>}
      </summary>
      <div className="border-t border-dashed border-hair px-3 pb-4 [&>section:first-child]:mt-3">{children}</div>
    </details>
  );
}
