// The Arigami mark as a React element: the origami preset from lib/logos.js
// (the folded star by default, or whatever prefs.logo says), painted in the
// current accent via `currentColor` so a custom accent recolours it with the
// rest of the UI. Shadow facets are a darker shade of the accent (see
// logos.facetShadePct) — the same rendering the favicon bakes in. `size` is a
// CSS length; give it rem so the mark scales with the UI-size setting.
import { LOGOS, DEFAULT_LOGO, isLogoId, facetShadePct } from '../lib/logos.js';
import { usePrefs } from '../lib/prefs.js';

export function Logo({ id, size = '1.25rem', className = '', title }) {
  const prefs = usePrefs();
  const want = id ?? prefs.logo;
  const preset = LOGOS[isLogoId(want) ? want : DEFAULT_LOGO];
  return (
    <svg
      viewBox={preset.viewBox || '0 0 32 32'}
      className={`shrink-0 text-brand ${className}`}
      style={{ width: size, height: size }}
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      data-logo={isLogoId(want) ? want : DEFAULT_LOGO}
    >
      {title ? <title>{title}</title> : null}
      {preset.paths.map((p, i) => (
        <path
          key={i}
          d={p.d}
          fill={p.o >= 1 ? 'currentColor' : `color-mix(in srgb, currentColor ${facetShadePct(p.o)}%, #000)`}
        />
      ))}
    </svg>
  );
}
