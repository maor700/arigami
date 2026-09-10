// LADDER1 — "running below its configured model" badge.
//
// Shown on the rail row and in the chat header while the supervisor's model
// ladder has a session on a weaker rung (RES1): "רץ על הייקו · מכסת Fable
// מתאפסת ב-18:50". The state is derived ONCE on the server
// (session.claude.ladder, state.toWireSession → supervisor.ladderBadge) so both
// places agree, and it is null on the top rung — the badge simply disappears on
// the climb back. Quiet by design: no toast, no pulse; the chat gets one system
// line at the switch and one at the climb back.
import { useT } from '../lib/i18n.js';
import { Icon } from '../lib/icons.js';
import { faStairs } from '@fortawesome/free-solid-svg-icons';

const FAMILY_HE = { haiku: 'הייקו', sonnet: 'סונט', opus: 'אופוס', fable: 'פייבל', mythos: 'מיתוס' };

/** 'claude-haiku-4-5-20251001' | 'haiku' → 'haiku' (the model family, lower-case). */
export function modelFamily(v) {
  const s = String(v || '').toLowerCase();
  for (const f of ['haiku', 'sonnet', 'opus', 'fable', 'mythos']) if (s.includes(f)) return f;
  return s.replace(/\[.*?\]/g, '').trim() || 'default';
}

/** Hebrew name for the RUNNING model (the badge reads as a sentence); English for the configured one. */
export function runningName(v, lang) {
  const f = modelFamily(v);
  if (lang === 'he' && FAMILY_HE[f]) return FAMILY_HE[f];
  return f.charAt(0).toUpperCase() + f.slice(1);
}
export function configuredName(v) {
  const f = modelFamily(v);
  return f.charAt(0).toUpperCase() + f.slice(1);
}

/** 'HH:MM' in the viewer's locale, or '' when unknown. */
export function resetTime(iso) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '';
  try {
    return new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
  } catch {
    return '';
  }
}

/** The badge text, split so the rail can show only the first half on narrow rows. */
export function ladderText(ladder, t, lang) {
  if (!ladder) return null;
  const running = t('rail.ladderRunningOn', { model: runningName(ladder.running, lang) });
  const time = resetTime(ladder.resetAt);
  const resets = time ? t('rail.ladderResetsAt', { model: configuredName(ladder.configured), time }) : '';
  return { running, resets, full: resets ? `${running} · ${resets}` : running };
}

/**
 * `compact` — the rail row: just the running model's name (the row is narrow
 * and the title must stay readable), the whole sentence in the tooltip.
 * Default — the chat header: the full sentence.
 */
export default function LadderBadge({ session, compact = false, className = '' }) {
  const t = useT();
  const ladder = session?.claude?.ladder;
  if (!ladder) return null;
  const lang = typeof document !== 'undefined' ? document.documentElement.lang || 'he' : 'he';
  const txt = ladderText(ladder, t, lang);
  const title = [txt.full, t('rail.ladderTitle', { model: configuredName(ladder.configured) }), ladder.compacted ? t('rail.ladderCompacted') : '']
    .filter(Boolean)
    .join(' · ');
  return (
    <span
      data-ladder-badge={ladder.running}
      title={title}
      className={`inline-flex h-[15px] shrink-0 items-center gap-1 rounded-full border border-[#b8860b]/50 bg-[#b8860b]/15 px-1.5 font-mono text-[11px] md:text-[9px] leading-none text-[#d9a521] ${className}`}
    >
      <Icon icon={faStairs} />
      <span className="whitespace-nowrap">{compact ? runningName(ladder.running, lang) : txt.full}</span>
    </span>
  );
}
