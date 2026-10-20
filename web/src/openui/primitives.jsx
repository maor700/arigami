// OPENUI phase 2 — the visual building blocks EVERY chat card is made of, host
// cards and agent render_ui blocks alike. Plain React + Tailwind + the cockpit's
// term tokens; no parser, no zod, so it costs nothing to load eagerly.
//   CardFrame   the bordered card with its header row (pulse dot, label, right slot)
//   Btn         one button family: primary / secondary / danger / chip / link
//   ReceiptLine the dashed one-liner (auto-approved, delegated, adopted…)
//   ErrorNote   the "answer failed" line
//   AgentAvatar the emoji-in-a-ring every agent surface uses
import { usePrefs } from '../lib/prefs.js';
import { langDir } from '../lib/langs.js';
import { forwardRef } from 'react';
import { dirOf } from '../lib/i18n.js';
import BidiText from '../components/BidiText.jsx';
import { buttonVariants } from '../components/ui/button.jsx';

// tone → frame colours. Every card is a neutral surface with a hairline; the
// tone only picks the small status dot / icon colour (accent budget: no mint
// fills here — the ONE primary Btn inside a card carries the accent).
// accent = the host's "needs you / did something" cards, panel = neutral (agent
// blocks, extension cards), code = artifacts/screenshots, ok / danger = merge
// outcomes.
export const TONES = {
  accent: 'border-[var(--term-accent-border)] bg-[var(--term-accent-bg)]',
  panel: 'border-[var(--term-border)] bg-[var(--term-accent-bg)]',
  code: 'border-[var(--term-border)] bg-[var(--term-codebg)]',
  ok: 'border-[var(--term-border)] bg-[var(--term-accent-bg)]',
  danger: 'border-[var(--term-border)] bg-[var(--term-accent-bg)]',
};
// status dot per tone (live = waiting for the human → amber, pulsing)
const TONE_DOT = { accent: 'bg-warn', panel: 'bg-faint', code: 'bg-faint', ok: 'bg-ok', danger: 'bg-err' };
// text colours on the accent tone
export const ACCENT = {
  strong: 'text-[var(--term-accent-strong)]',
  fg: 'text-[var(--term-accent-fg)]',
  dim: 'text-[var(--term-accent-dim)]',
};

/**
 * The card. `label` is the header text (an icon may precede it), `live`
 * adds the pulsing amber dot, `right` renders at the header's end, `dense` trims the
 * padding (small cards: ext-card, artifact). Extra `data-*`/`dir` go straight
 * through via ...rest.
 */
export const CardFrame = forwardRef(function CardFrame({ tone = 'accent', live, icon, label, labelClass, meta, right, dense, className = '', children, ...rest }, ref) {
  const pad = dense ? 'px-3 py-2.5' : 'p-3.5';
  const my = dense ? 'my-1.5' : 'my-3';
  const strong = ACCENT.strong;
  // The card shell follows the UI language, not the first words of the conversation
  // (the chat area is dir="auto"): header, dot and buttons keep their order; each
  // text block inside orders itself.
  const uiDir = langDir(usePrefs().language);
  const dot = live ? 'bg-warn pulse-yellow' : TONE_DOT[tone] || TONE_DOT.accent;
  return (
    <div ref={ref} dir={uiDir} data-waiting={live ? '' : undefined} className={`${my} rounded-lg border ${TONES[tone] || TONES.accent} ${pad} font-sans ${className}`} {...rest}>
      {(label || right || live) && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {(live || ((tone === 'ok' || tone === 'danger') && !icon)) && <span aria-hidden="true" data-card-dot className={`size-1.5 shrink-0 rounded-full ${dot}`} />}
          {icon && <span className="text-[var(--term-dim)]">{icon}</span>}
          {label && <span dir="auto" className={`min-w-0 font-medium ${labelClass || strong}`}>{label}</span>}
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
  return <div className="mb-1 text-2xs font-medium tracking-wide text-fgdim uppercase">{children}</div>;
}

// One button family, built on the ui/ Button. primary = THE accent action of a
// card (one per card); secondary/option = neutral bordered; quiet = ghost;
// danger = soft destructive; chip/pill/tag = small inline affordances.
const BTN = {
  primary: buttonVariants({ variant: 'primary', size: 'sm' }),
  secondary: buttonVariants({ variant: 'outline', size: 'sm' }),
  quiet: buttonVariants({ variant: 'ghost', size: 'sm' }),
  danger: buttonVariants({ variant: 'destructive', size: 'sm' }),
  option: buttonVariants({ variant: 'outline', size: 'sm' }),
  chip: 'inline-flex items-center gap-1 rounded-md border border-[var(--term-border)] px-2 py-0.5 text-xs text-[var(--term-fg)] hover:bg-[var(--term-hover)] coarse:min-h-11',
  pill: 'inline-flex items-center gap-1 rounded-md border border-[var(--term-border)] bg-[var(--term-accent-bg)] px-2.5 py-1 text-xs text-[var(--term-fg)] hover:bg-[var(--term-hover)] coarse:min-h-11',
  tag: 'rounded bg-[var(--term-accent-border)] px-1.5 hover:opacity-80',
};
export const btnClass = (variant = 'primary', extra = '') => `cursor-pointer ${BTN[variant] || BTN.primary} ${extra}`;

export const Btn = forwardRef(function Btn({ variant = 'primary', className = '', type = 'button', children, ...rest }, ref) {
  return (
    <button ref={ref} type={type} data-slot="button" data-variant={variant} className={btnClass(variant, className)} {...rest}>
      {children}
    </button>
  );
});

/** Dashed accent one-liner: a receipt of something the host did. */
export function ReceiptLine({ className = '', children, ...rest }) {
  return (
    <div className={`my-1.5 flex flex-wrap items-center gap-1.5 rounded-md border border-[var(--term-border)] px-2.5 py-1.5 text-xs text-[var(--term-accent-dim)] ${className}`} {...rest}>
      {children}
    </div>
  );
}

/** "Answer failed · <reason>" — red, bold prefix, monospace reason. */
export function ErrorNote({ label, children, className = '', ...rest }) {
  return (
    <div dir="auto" className={`mt-2.5 text-xs font-medium text-err ${className}`} {...rest}>
      {label} <span className="font-normal">{children}</span>
    </div>
  );
}

/** Settled-state line under a card ("✓ allowed", "✕ denied (timed out)"). */
export function SettledLine({ children, className = '', ...rest }) {
  return (
    <div className={`text-xs text-[var(--term-accent-dim)] ${className}`} {...rest}>
      {children}
    </div>
  );
}

/** A prose line on an accent card (the prompt / question text). */
export function Prose({ children, className = '', dim, ...rest }) {
  const cls = `text-sm leading-snug ${dim ? 'text-[var(--term-accent-dim)] text-xs' : 'text-[var(--term-accent-fg)]'} ${className}`;
  if (typeof children === 'string') return <BidiText text={children} lines className={cls} {...rest} />;
  return (
    <div dir="auto" className={cls} {...rest}>
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
      style={{ width: size, height: size, fontSize: Math.round(size * 0.58), background: `${color}22`, border: `1px solid ${color}`, lineHeight: 1 }}
      aria-hidden="true"
    >
      {agent?.emoji || '🤖'}
    </span>
  );
}

export { dirOf };
