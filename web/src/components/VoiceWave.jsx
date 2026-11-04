// The live voice animation in the floating box: seven bars that follow the mic (the person) or the playback (the agent).
// Always the same height, so switching states never moves the box; RTL-safe (symmetric); static under reduced motion.
import { useEffect, useState } from 'react';
import { useAudioLevel, useHasAudioSource } from '../lib/audioLevel.js';

export const WEIGHTS = [0.45, 0.7, 0.9, 1, 0.9, 0.7, 0.45];
export const BAR_MIN = 3;
export const BAR_MAX = 20;
const TINT = { mic: 'var(--color-brand, #6eceb7)', out: 'var(--color-info, #4a7fd6)', idle: 'var(--color-fgdim, #888)' };
const RM = '(prefers-reduced-motion: reduce)';

const reducedNow = () => { try { return !!(typeof window !== 'undefined' && window.matchMedia?.(RM)?.matches); } catch { return false; } };
/** True when the OS asks for reduced motion (false without matchMedia). */
export function useReducedMotion() {
  const [reduced, setReduced] = useState(reducedNow);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    let mql;
    try { mql = window.matchMedia(RM); } catch { return; }
    const on = () => setReduced(!!mql.matches);
    on();
    mql.addEventListener?.('change', on);
    return () => mql.removeEventListener?.('change', on);
  }, []);
  return reduced;
}

/** Bar heights (px) for a 0..1 level; reduced motion quantises to quarter steps so the bars do not flicker. */
export function barHeights(level, { reduced = false, weights = WEIGHTS } = {}) {
  let l = Math.min(1, Math.max(0, Number(level) || 0));
  if (reduced) l = Math.round(l * 4) / 4;
  return weights.map((w) => Math.round(BAR_MIN + (BAR_MAX - BAR_MIN) * l * w));
}

/** `who`: 'mic' while the person speaks, 'out' while the agent does, null = resting. */
export default function VoiceWave({ who = null }) {
  const kind = who === 'mic' || who === 'out' ? who : null;
  const reduced = useReducedMotion();
  const measured = useHasAudioSource(kind);
  const level = useAudioLevel(kind, { fps: reduced ? 4 : 30 });
  const synth = kind === 'out' && !measured && !reduced; // playback that cannot be tapped (speechSynthesis, old Safari): a gentle pulse
  const heights = synth ? WEIGHTS.map((w) => Math.round(BAR_MAX * w)) : barHeights(kind ? level : 0, { reduced });
  const motion = reduced ? 'reduced' : synth ? 'synth' : 'live';
  return (
    <div
      className={`flex h-5 items-center justify-center gap-[3px] ${synth ? 'voice-wave-synth' : ''}`}
      style={{ color: TINT[kind || 'idle'], opacity: kind ? 1 : 0.35 }}
      data-voice-wave={kind || 'idle'}
      data-voice-wave-motion={motion}
      data-voice-wave-level={level.toFixed(2)}
      aria-hidden="true"
    >
      {heights.map((h, i) => (
        <span
          key={i}
          className={`w-[3px] shrink-0 rounded-full bg-current ${reduced ? '' : 'transition-[height] duration-75 ease-out'}`}
          style={{ height: h }}
        />
      ))}
    </div>
  );
}
