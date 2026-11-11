// Subscription usage charts — the same windows Claude Code's `/usage` shows:
// a rolling 5-hour "session" window and a 7-day "week" (with per-model Opus /
// Sonnet sub-limits and monthly extra-usage credits when enabled). Data comes
// from the store (GET /__api/usage + the 'usage-updated' broadcast); see
// server/usage.js. We frame each bar as "tokens left" = 100 − utilization.
import { untilTime } from '../lib/time.js';
import { useT } from '../lib/i18n.js';
import { usePrefs, setPrefs } from '../lib/prefs.js';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { windowLabel } from '../lib/providers.js';
import { useIsDesktop } from '../lib/useMedia.js';

// Remaining-capacity color: green when there's plenty left, amber when getting
// tight, red when nearly exhausted. `left` is a 0–100 percentage.
function leftColor(left) {
  if (left <= 10) return '#B23B30'; // almost out
  if (left <= 30) return '#CE8324'; // getting tight
  return '#3C9A4E'; // healthy
}

// One usage window as a labeled bar. `win` is { pct, resetsAt } where pct is the
// USED percentage; we show what's left and when the window resets.
export function UsageBar({ label, win, sub }) {
  const t = useT();
  if (!win) return null;
  const used = Math.max(0, Math.min(100, win.pct ?? 0));
  const left = 100 - used;
  const reset = untilTime(win.resetsAt);
  return (
    <div className={sub ? 'mt-2.5' : 'mt-3.5 first:mt-0'}>
      <div className="mb-1 flex items-baseline gap-2">
        <span className={`flex-1 ${sub ? 'text-[11.5px] text-fgdim' : 'text-[12.5px] font-bold text-fg'}`}>
          {label}
        </span>
        <span className="font-mono text-[11px] font-bold tabular-nums" style={{ color: leftColor(left) }}>
          {t('dialogs.percentLeft', { pct: left })}
        </span>
        {reset && (
          <span className="font-mono text-[11.5px] md:text-[10px] text-fgdim">{t('dialogs.resetsIn', { t: reset })}</span>
        )}
      </div>
      <div className={`w-full overflow-hidden rounded-full bg-hair ${sub ? 'h-1.5' : 'h-2.5'}`}>
        <div
          className="h-full rounded-full transition-[width] duration-500"
          style={{ width: `${used}%`, background: leftColor(left) }}
        />
      </div>
    </div>
  );
}

// Compact one-line usage chip for the rail footer: smallest "tokens left" of the
// session/week windows, color-coded. Click handling is left to the parent.
export function UsageChip({ usage }) {
  const t = useT();
  if (!usage?.available) return null;
  const wins = [usage.session, usage.week].filter(Boolean);
  if (!wins.length) return null;
  const left = Math.min(...wins.map((w) => 100 - Math.max(0, Math.min(100, w.pct ?? 0))));
  return (
    <span className="flex items-center gap-1" title={t('dialogs.subscriptionUsageTitle')}>
      <span className="h-2 w-2 rounded-full" style={{ background: leftColor(left) }} />
      <span className="font-mono text-[11.5px] md:text-[10px] tabular-nums">{left}%</span>
    </span>
  );
}

// Rail bars are neutral while there is plenty left; they pick up the warning /
// danger tone only when the window is getting tight (<= 30% left).
const barTone = (left) => (left <= 30 ? leftColor(left) : 'var(--hb-faint)');

// One tiny labeled bar for the rail panel: title at the start, reset time at the
// end, then a thin track with the "% used" after it. Direction follows the app
// (RTL in Hebrew, LTR in English); numeric tokens (the % and the reset duration)
// are LTR runs the bidi algorithm isolates automatically, so they read correctly
// inside RTL labels instead of being mangled by a forced dir.
function MiniBar({ title, win }) {
  const t = useT();
  if (!win) return null;
  const used = Math.max(0, Math.min(100, win.pct ?? 0));
  const left = 100 - used;
  const reset = untilTime(win.resetsAt);
  return (
    <div title={`${t('dialogs.spentPct', { title, pct: used })}${reset ? ` · ${t('dialogs.resetsIn', { t: reset })}` : ''}`}>
      <div className="flex items-baseline justify-between gap-2 text-2xs text-muted-foreground">
        <span className="min-w-0 truncate">{title}</span>
        {reset && <span className="shrink-0 tabular-nums">{t('dialogs.resetsIn', { t: reset })}</span>}
      </div>
      <div className="mt-1 flex items-center gap-1.5">
        <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${used}%`, background: barTone(left) }} />
        </div>
        <span className="shrink-0 text-2xs font-medium tabular-nums" style={{ color: left <= 30 ? leftColor(left) : undefined }}>
          {used}%
        </span>
      </div>
    </div>
  );
}

// Compact session + week charts for the rail (above the footer). Collapses to
// nothing when usage isn't available so the rail stays clean. Collapsible:
// collapsed (default) shows only the 5h session line; expanded adds the 7d
// week window too. State persists across sessions via prefs.
export function UsageMini({ usage, provider = 'claude', chip = false }) {
  const t = useT();
  const prefs = usePrefs();
  const desktop = useIsDesktop();
  if (!usage?.available || (!usage.session && !usage.week)) return null;
  const expanded = prefs.usageExpanded;
  // codex windows are labelled by length (a free plan has one 30-day window)
  const label = (which) => provider === 'codex' ? windowLabel(t, provider, which, usage[which]) : t(which === 'session' ? 'dialogs.sessionWindow5h' : 'dialogs.weekWindow7d');
  const toggle = () => setPrefs({ usageExpanded: !expanded });
  if (!desktop) {
    // Phone: the rail is for sessions — usage is a small "N%" chip in the footer row (`chip`), and the bars open
    // above the footer (the default render) only while expanded.
    const win = usage.session || usage.week;
    const used = Math.max(0, Math.min(100, win.pct ?? 0));
    if (chip) {
      return (
        <button type="button" onClick={toggle} aria-expanded={expanded} aria-label={`${provider === 'codex' ? 'Codex' : 'Claude'} ${t('dialogs.usageShort')} ${used}%`} data-usage-mini-phone title={label(usage.session ? 'session' : 'week')} className="flex min-h-11 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-1.5 text-2xs text-muted-foreground hover:bg-muted hover:text-foreground">
          <span className="h-1 w-8 overflow-hidden rounded-full bg-muted">
            <span className="block h-full rounded-full" style={{ width: `${used}%`, background: barTone(100 - used) }} />
          </span>
          <span className="font-medium tabular-nums" style={{ color: 100 - used <= 30 ? leftColor(100 - used) : undefined }}>{used}%</span>
        </button>
      );
    }
    if (!expanded) return null;
    return (
      <div className="flex flex-col gap-2 border-t border-border px-3 py-2" data-usage-mini-phone-bars>
        {usage.session && <MiniBar title={label('session')} win={usage.session} />}
        <MiniBar title={label('week')} win={usage.week} />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2 border-t border-border px-3 py-2">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={expanded}
        className="flex cursor-pointer items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        <span className="flex-1 text-start">{t('dialogs.usageSpent')}</span>
        {expanded ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
      </button>
      <MiniBar title={label('session')} win={usage.session} />
      {(expanded || !usage.session) && <MiniBar title={label('week')} win={usage.week} />}
    </div>
  );
}

export default function Usage({ usage }) {
  const t = useT();
  if (!usage) {
    return <div className="py-4 font-mono text-[11px] text-fgdim">{t('dialogs.checkingUsage')}</div>;
  }
  if (!usage.available) {
    const why =
      usage.reason === 'no-credentials'
        ? t('dialogs.signInForUsage')
        : t('dialogs.usageUnavailable');
    return <div className="py-4 text-[11.5px] text-fgdim">{why}</div>;
  }
  const extra = usage.extra;
  return (
    <div className="py-1">
      <UsageBar label={t('dialogs.currentSession5h')} win={usage.session} />
      <UsageBar label={t('dialogs.currentWeekAllModels')} win={usage.week} />
      <UsageBar label={t('dialogs.weekSonnet')} win={usage.weekSonnet} sub />
      <UsageBar label={t('dialogs.weekOpus')} win={usage.weekOpus} sub />
      {extra && extra.limit > 0 && (
        <div className="mt-3.5 border-t border-hair pt-3">
          <div className="flex items-baseline gap-2">
            <span className="flex-1 text-[12.5px] font-bold text-fg">{t('dialogs.extraUsageThisMonth')}</span>
            <span className="font-mono text-[11px] text-fgdim tabular-nums">
              {extra.currency === 'USD' ? '$' : ''}{(extra.used / 100).toFixed(2)} / {extra.currency === 'USD' ? '$' : ''}{(extra.limit / 100).toFixed(2)}
            </span>
          </div>
          <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-hair">
            <div
              className="h-full rounded-full"
              style={{ width: `${Math.max(0, Math.min(100, extra.pct ?? 0))}%`, background: leftColor(100 - (extra.pct ?? 0)) }}
            />
          </div>
        </div>
      )}
      {usage.fetchedAt && (
        <div className="mt-3 font-mono text-[11px] md:text-[9.5px] text-fgdim">
          {untilTime(usage.fetchedAt + 60000) === 'now' ? t('dialogs.updatedJustNow') : t('dialogs.updatedRecently')}
        </div>
      )}
    </div>
  );
}
