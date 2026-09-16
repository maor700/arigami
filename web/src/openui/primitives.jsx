// OPENUI phase 2 — the visual building blocks EVERY chat card is made of, host
// cards and agent render_ui blocks alike. Plain React + Tailwind + the cockpit's
// term tokens; no parser, no zod, so it costs nothing to load eagerly.
//   CardFrame   the bordered card with its header row (pulse dot, label, right slot)
//   Btn         one button family: primary / secondary / danger / chip / link
//   ReceiptLine the dashed one-liner (auto-approved, delegated, adopted…)
//   ErrorNote   the "answer failed" line
//   AgentAvatar the emoji-in-a-ring every agent surface uses
import { forwardRef } from 'react';
import { dirOf } from '../lib/i18n.js';

// tone → frame colours. accent = the host's "needs you / did something" cards,
// panel = neutral (agent blocks, extension cards), code = artifacts/screenshots,
// ok / danger = merge outcomes.
export const TONES = {
  accent: 'border-[var(--term-accent-border)] bg-[var(--term-accent-bg)]',
  panel: 'border-hair bg-panel',
  code: 'border-[var(--term-border)] bg-[var(--term-codebg)]',
  ok: 'border-[#8fcf9a] bg-[#e8f6ea] text-[#2a6b35]',
  danger: 'border-[#d98078] bg-danger/10 text-danger',
};
// text colours on the accent tone
export const ACCENT = {
  strong: 'text-[var(--term-accent-strong)]',
  fg: 'text-[var(--term-accent-fg)]',
  dim: 'text-[var(--term-accent-dim)]',
};

/**
 * The card. `label` is the bold header text (an icon may precede it), `live`
 * adds the pulsing dot, `right` renders at the header's end, `dense` trims the
 * padding (small cards: ext-card, artifact). Extra `data-*`/`dir` go straight
 * through via ...rest.
 */
export const CardFrame = forwardRef(function CardFrame({ tone = 'accent', live, icon, label, labelClass, meta, right, dense, className = '', children, ...rest }, ref) {
  const pad = dense ? 'px-3 py-2.5' : 'p-3';
  const my = dense ? 'my-1.5' : tone === 'ok' || tone === 'danger' ? 'my-2' : 'my-2.5';
  const strong = tone === 'accent' ? ACCENT.strong : tone === 'ok' || tone === 'danger' ? '' : 'text-[var(--term-fg)]';
  return (
    <div ref={ref} className={`${my} rounded-[10px] border ${TONES[tone] || TONES.accent} ${pad} ${className}`} {...rest}>
      {(label || right || live) && (
        <div className="flex flex-wrap items-center gap-2 font-mono text-[11px]">
          {live && <span className="pulse-yellow h-[7px] w-[7px] shrink-0 rounded-full bg-brand" />}
          {icon && <span className={tone === 'code' ? 'text-[var(--term-dim)]' : ''}>{icon}</span>}
          {label && <span dir="auto" className={`min-w-0 font-bold ${labelClass || strong}`}>{label}</span>}
          {meta}
          {right && <span className="ms-auto flex shrink-0 items-center gap-1.5">{right}</span>}
        </div>
      )}
      {children}
    </div>
  );
});

// Small uppercase eyebrow ("EXTENSION · hello", "UI BLOCK") — the light cards' header.
export function Eyebrow({ children }) {
  return <div className="mb-1 font-mono text-[11px] md:text-[9px] tracking-[0.08em] text-fgdim uppercase">{children}</div>;
}

const BTN = {
  primary: 'rounded-[7px] border-[1.5px] border-ink bg-brand px-3.5 py-1.5 text-[11.5px] font-bold text-[#1a1a1a] shadow-[2px_2px_0_#2a2a2a]',
  secondary: 'rounded-[7px] border-[1.5px] border-[var(--term-accent-border)] bg-transparent px-3 py-1.5 text-[11.5px] font-bold text-[var(--term-accent-fg)] hover:bg-[var(--term-accent-border)]',
  quiet: 'rounded-[7px] border-[1.5px] border-[var(--term-accent-border)] bg-transparent px-3.5 py-1.5 text-[11.5px] text-[var(--term-accent-dim)] hover:bg-[var(--term-accent-bg)]',
  danger: 'rounded-[7px] border-[1.5px] border-danger bg-danger px-3.5 py-1.5 text-[11.5px] font-bold text-white',
  option: 'rounded-[7px] border-[1.5px] border-[var(--term-accent-border)] bg-[var(--term-accent-bg)] px-3.5 py-1.5 text-[11.5px] font-bold text-[var(--term-accent-strong)] hover:border-brand',
  chip: 'inline-flex items-center gap-1 rounded-[6px] border border-[var(--term-border)] px-2 py-0.5 font-mono text-[11.5px] md:text-[10.5px] text-[var(--term-fg)] hover:bg-[var(--term-hover,rgba(127,127,127,0.15))]',
  pill: 'rounded-lg border-[1.5px] border-ink bg-panel px-2.5 py-1 text-[11px] text-fg hover:bg-brand',
  tag: 'rounded bg-[var(--term-accent-border)] px-1.5 hover:opacity-80',
};
export const btnClass = (variant = 'primary', extra = '') => `cursor-pointer ${BTN[variant] || BTN.primary} disabled:opacity-50 ${extra}`;

export const Btn = forwardRef(function Btn({ variant = 'primary', className = '', type = 'button', children, ...rest }, ref) {
  return (
    <button ref={ref} type={type} className={btnClass(variant, className)} {...rest}>
      {children}
    </button>
  );
});

/** Dashed accent one-liner: a receipt of something the host did. */
export function ReceiptLine({ className = '', children, ...rest }) {
  return (
    <div className={`my-1.5 flex flex-wrap items-center gap-1.5 rounded-[8px] border border-dashed border-[var(--term-accent-border)] px-2.5 py-1.5 font-mono text-[11.5px] md:text-[10.5px] text-[var(--term-accent-fg)] ${className}`} {...rest}>
      {children}
    </div>
  );
}

/** "Answer failed · <reason>" — red, bold prefix, monospace reason. */
export function ErrorNote({ label, children, className = '', ...rest }) {
  return (
    <div dir="auto" className={`mt-2.5 text-[11px] font-bold text-[#9c3b33] ${className}`} {...rest}>
      {label} <span className="font-mono font-normal">{children}</span>
    </div>
  );
}

/** Settled-state line under a card ("✓ allowed", "✕ denied (timed out)"). */
export function SettledLine({ children, className = '', ...rest }) {
  return (
    <div className={`font-mono text-[11.5px] md:text-[10.5px] text-[var(--term-accent-dim)] ${className}`} {...rest}>
      {children}
    </div>
  );
}

/** A prose line on an accent card (the prompt / question text). */
export function Prose({ children, className = '', dim, ...rest }) {
  return (
    <div dir="auto" className={`text-[12px] leading-snug ${dim ? 'text-[var(--term-accent-dim)] text-[11.5px]' : 'text-[var(--term-accent-fg)]'} ${className}`} {...rest}>
      {children}
    </div>
  );
}

// The emoji-in-a-ring avatar every agent surface uses (rail row, card, page).
export function AgentAvatar({ agent, size = 22, className = '' }) {
  const color = agent?.color || '#c4c4c4';
  return (
    <span
      data-agent-avatar={agent?.slug}
      className={`inline-flex shrink-0 items-center justify-center rounded-full ${className}`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.58), background: `${color}22`, border: `1.5px solid ${color}`, lineHeight: 1 }}
      aria-hidden="true"
    >
      {agent?.emoji || '🤖'}
    </span>
  );
}

export { dirOf };
