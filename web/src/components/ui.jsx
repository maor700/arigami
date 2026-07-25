// Tiny shared primitives for the host chrome.

// The Acme "wave" brand glyph — 4 ascending yellow bars.
export function Wave({ scale = 1 }) {
  const heights = [8, 13, 10, 15];
  return (
    <span
      className="inline-flex items-end"
      style={{ gap: Math.max(1.5 * scale, 1.5) }}
      aria-hidden="true"
    >
      {heights.map((h, i) => (
        <span
          key={i}
          className="inline-block bg-brand"
          style={{ width: 2.5 * scale, height: h * scale }}
        />
      ))}
    </span>
  );
}

// Session color dot.
export function Dot({ color, size = 12, className = '' }) {
  return (
    <span
      className={`inline-block shrink-0 rounded-full ${className}`}
      style={{
        width: size,
        height: size,
        background: color || '#c4c4c4',
        border: '1.5px solid rgba(0,0,0,0.25)',
      }}
    />
  );
}

// Primary host button: yellow, 2px ink border, hard shadow.
export function YellowButton({ children, className = '', ...rest }) {
  return (
    <button
      type="button"
      className={`cursor-pointer rounded-lg border-2 border-ink bg-brand px-4 py-2 text-[13px] font-bold text-[#1a1a1a] shadow-[2px_2px_0_#2a2a2a] transition-transform active:translate-x-[1px] active:translate-y-[1px] active:shadow-[1px_1px_0_#2a2a2a] disabled:cursor-default disabled:opacity-50 ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

export function GhostButton({ children, className = '', ...rest }) {
  return (
    <button
      type="button"
      className={`cursor-pointer rounded-lg border-[1.5px] border-border bg-panel px-3.5 py-2 text-[12.5px] text-fgdim hover:bg-hair ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

// Small solid bolt — marks a session that a trigger started. Muted by default;
// pass a className to size/recolor. `name` is the trigger's name.
export function TriggerTag({ name, className = '', showName = true }) {
  if (!name) return null;
  return (
    <span
      className={`inline-flex min-w-0 items-center gap-1 text-fgdim ${className}`}
      title={`Started by trigger: ${name}`}
    >
      <svg viewBox="0 0 24 24" width="10" height="10" fill="currentColor" aria-hidden="true" className="shrink-0">
        <path d="M13 2 4 13h6l-1 9 9-12h-6z" />
      </svg>
      {showName && <span className="min-w-0 truncate">{name}</span>}
    </span>
  );
}

// ~10% tint of a session color over white (rail selected row, etc).
export function tint(color, alpha = '1f') {
  if (typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color)) return color + alpha;
  return 'rgba(0,0,0,0.04)';
}

export function sessionLabel(session) {
  return session?.metadata?.ticket || session?.title || session?.id || '';
}

export function fmtTokens(n) {
  if (typeof n !== 'number' || n < 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

export function contextColor(percent) {
  if (typeof percent !== 'number') return '#999';
  if (percent < 50) return '#3C9A4E'; // green: low usage
  if (percent < 75) return '#CE8324'; // orange: moderate usage
  if (percent < 90) return '#D9534F'; // red-orange: high usage
  return '#B23B30'; // dark red: critical usage
}
