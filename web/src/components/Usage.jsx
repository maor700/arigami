// Subscription usage charts — the same windows Claude Code's `/usage` shows:
// a rolling 5-hour "session" window and a 7-day "week" (with per-model Opus /
// Sonnet sub-limits and monthly extra-usage credits when enabled). Data comes
// from the store (GET /__api/usage + the 'usage-updated' broadcast); see
// server/usage.js. We frame each bar as "tokens left" = 100 − utilization.
import { untilTime } from '../lib/time.js';
import { useT } from '../lib/i18n.js';
import { usePrefs, setPrefs } from '../lib/prefs.js';
import { Icon } from '../lib/icons.js';
import { faChevronDown, faChevronUp } from '@fortawesome/free-solid-svg-icons';

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
          <span className="font-mono text-[10px] text-fgdim">{t('dialogs.resetsIn', { t: reset })}</span>
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
      <span className="font-mono text-[10px] tabular-nums">{left}%</span>
    </span>
  );
}

// One tiny labeled bar for the rail panel: title at the start, reset time at the
// end, then a thin track with the "% left" after it. Direction follows the app
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
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 truncate font-mono text-[9.5px] tracking-[0.04em] text-fgdim uppercase">
          {title}
        </span>
        {reset && (
          <span className="shrink-0 font-mono text-[9px] text-fgdim">{t('dialogs.resetsIn', { t: reset })}</span>
        )}
      </div>
      <div className="mt-[3px] flex items-center gap-1.5">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-hair">
          <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${used}%`, background: leftColor(left) }} />
        </div>
        <span className="shrink-0 font-mono text-[9.5px] font-bold tabular-nums" style={{ color: leftColor(left) }}>
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
export function UsageMini({ usage }) {
  const t = useT();
  const prefs = usePrefs();
  if (!usage?.available || (!usage.session && !usage.week)) return null;
  const expanded = prefs.usageExpanded;
  return (
    <div className="flex flex-col gap-2 border-t border-hair px-[13px] py-2.5">
      <button
        type="button"
        onClick={() => setPrefs({ usageExpanded: !expanded })}
        className="flex cursor-pointer items-center gap-1.5 font-mono text-[9px] tracking-[0.08em] text-fgdim uppercase hover:text-fg"
      >
        <span className="flex-1 text-start">{t('dialogs.usageSpent')}</span>
        <Icon icon={expanded ? faChevronUp : faChevronDown} />
      </button>
      <MiniBar title={t('dialogs.sessionWindow5h')} win={usage.session} />
      {expanded && <MiniBar title={t('dialogs.weekWindow7d')} win={usage.week} />}
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
        <div className="mt-3 font-mono text-[9.5px] text-fgdim">
          {untilTime(usage.fetchedAt + 60000) === 'now' ? t('dialogs.updatedJustNow') : t('dialogs.updatedRecently')}
        </div>
      )}
    </div>
  );
}
