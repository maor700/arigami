// SET — the one set of primitives every Settings category is built from:
// Section (anchored heading), SettingCard (the uniform card), StatusPill,
// Field/Toggle/Segmented/CopyRow (moved here from the old 1300-line
// Settings.jsx) and hostPost (admin-confirmed POST to /__api/host/*).
import { useEffect, useState } from 'react';
import { useT } from '../../lib/i18n.js';
import { Icon } from '../../lib/icons.js';
import { faRotateRight, faChevronDown } from '@fortawesome/free-solid-svg-icons';
import { Switch } from '../ui/switch.jsx';
import { Badge } from '../ui/badge.jsx';

const BTN_BASE = 'inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-md border text-sm font-medium whitespace-nowrap outline-none transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-50 coarse:min-h-11';
export const BTN = `${BTN_BASE} h-8 border-input bg-card px-3 text-foreground hover:bg-muted`;
export const BTN_SM = `${BTN_BASE} h-7 border-input bg-card px-2.5 text-xs text-foreground hover:bg-muted`;
export const BTN_PRIMARY = `${BTN_BASE} h-7 border-transparent bg-primary px-2.5 text-xs text-primary-foreground hover:bg-[var(--accent-hover)]`;
export const BTN_DANGER = `${BTN_BASE} h-7 border-input bg-card px-2.5 text-xs text-err hover:bg-err-bg`;
export const INPUT = 'h-8 min-w-0 rounded-md border border-input bg-background px-2.5 text-sm text-foreground outline-none transition-[border-color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/35 disabled:opacity-60 coarse:h-11';
export const ROW = 'flex items-center justify-between gap-2 border-b border-hair py-2 text-sm last:border-b-0';
export const LIST = 'mt-2 rounded-lg border border-hair px-3 py-1';

// Neutral switch (ink when on) — behaviour unchanged: onChange(!on).
export function Toggle({ on, onChange, disabled, ...rest }) {
  return <Switch checked={!!on} onCheckedChange={(v) => onChange(v)} disabled={disabled} {...rest} />;
}

// Neutral segmented control: a quiet track, the selected option a raised
// neutral chip. Same props as before; radio semantics for a11y.
export function Segmented({ value, options, onChange }) {
  return (
    <span role="radiogroup" className="inline-flex gap-0.5 rounded-md bg-muted p-0.5">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          role="radio"
          aria-checked={value === opt.value}
          onClick={() => onChange(opt.value)}
          className={`inline-flex h-7 cursor-pointer items-center rounded-sm px-3 text-xs font-medium whitespace-nowrap outline-none transition-colors focus-visible:outline-2 focus-visible:outline-ring coarse:h-10 ${
            value === opt.value ? 'bg-card text-foreground shadow-[0_0_0_1px_var(--hb-hair)]' : 'text-muted-foreground hover:text-foreground'
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
    <div className={`flex items-center gap-4 border-b border-hair py-3 last:border-b-0${wrap ? ' flex-wrap' : ''}`}>
      <div className="min-w-[9rem] flex-1">
        <div className="text-sm font-medium text-fg">{label}</div>
        {hint && <div className="mt-0.5 text-xs text-fgdim">{hint}</div>}
      </div>
      {/* VER1: max-w-full so a wide control that wrapped under the label can't run past the viewport (mobile) */}
      <div className="max-w-full shrink-0">{children}</div>
    </div>
  );
}

// ok | todo | pending | error | running | off — neutral chip, colour in the dot only.
const PILL_DOT = { ok: 'ok', done: 'ok', todo: 'warn', pending: 'warn', error: 'err', failed: 'err', running: 'info', auto: 'info', off: 'idle' };
export function StatusPill({ status, label }) {
  return <Badge status={PILL_DOT[status] || 'idle'}>{label}</Badge>;
}

// Anchored section heading. `id` is the deep-link segment
// (#/settings/<category>/<id>) and the scroll target.
export function Section({ id, title, onRefresh, children, first = false }) {
  const t = useT();
  return (
    <section id={id ? `settings-${id}` : undefined} className={first ? '' : 'mt-8'}>
      <div className="mb-2 flex items-center text-xs font-medium text-fgdim">
        {title}
        {onRefresh && (
          <button type="button" onClick={onRefresh} className="ms-auto cursor-pointer text-xs font-normal hover:text-fg">
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
  const border = tone === 'danger' ? 'border-err-line' : 'border-hair';
  return (
    <div className={`mb-2 rounded-lg border ${border} bg-panel px-3 py-2.5`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-fg">{title}</span>
        {pill}
        {actions && <span className="ms-auto flex flex-wrap items-center gap-1.5">{actions}</span>}
      </div>
      {hint && <div className="mt-0.5 text-xs text-fgdim">{hint}</div>}
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
      <code dir="ltr" className="min-w-0 flex-1 truncate rounded-md border border-hair bg-bg px-2 py-1.5 font-mono text-xs text-fg">{url}</code>
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
  return <div className="mt-2 rounded-md border border-err-line bg-err-bg px-3 py-2 text-xs text-err">{children}</div>;
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
      if (Array.isArray(b?.dirty)) e.dirty = b.dirty; // VER1: the dirty-checkout refusal names the files
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
      className="mt-8 rounded-lg border border-hair"
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-xs font-medium text-fgdim select-none hover:text-fg [&::-webkit-details-marker]:hidden">
        <span className={`text-xs transition-transform ${open ? '' : 'rtl:rotate-90 ltr:-rotate-90'}`}><Icon icon={faChevronDown} /></span>
        {t('settings.advanced')}
        {hint && <span className="ms-auto text-xs font-normal">{hint}</span>}
      </summary>
      <div className="border-t border-hair px-3 pb-4 [&>section:first-child]:mt-3">{children}</div>
    </details>
  );
}
