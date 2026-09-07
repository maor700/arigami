// Arigami origami logo marks. Each preset is a set of flat triangular facets
// (folded-paper look) drawn in the accent color, with per-facet opacity to
// suggest a fold catching the light. Used inline (Settings picker) and baked
// into a favicon data-URI (prefs.applyBranding).
//
// 'star' is the brand mark (design/logo-final in the site repo — the folded
// four-pointed star, eight facets). It is the default; the older presets stay
// as opt-in alternatives.

// Brand accent — the landing page's orange (arigami-site global.css --accent).
export const DEFAULT_ACCENT = '#f97316';

// viewBox defaults to 0 0 32 32; a preset may override it. `o` = fill-opacity of that facet.
export const LOGOS = {
  star: {
    label: 'Star',
    viewBox: '0 0 64 64',
    paths: [
      { d: 'M32 2 L32 32 L19.98 19.98 Z', o: 1 },
      { d: 'M32 2 L44.02 19.98 L32 32 Z', o: 0.62 },
      { d: 'M62 32 L32 32 L44.02 19.98 Z', o: 0.62 },
      { d: 'M62 32 L44.02 44.02 L32 32 Z', o: 1 },
      { d: 'M32 62 L32 32 L44.02 44.02 Z', o: 1 },
      { d: 'M32 62 L19.98 44.02 L32 32 Z', o: 0.62 },
      { d: 'M2 32 L32 32 L19.98 44.02 Z', o: 0.62 },
      { d: 'M2 32 L19.98 19.98 L32 32 Z', o: 1 },
    ],
  },
  crane: {
    label: 'Crane',
    paths: [
      { d: 'M16 17 L4 26 L16 23 Z', o: 0.55 }, // far wing
      { d: 'M16 17 L28 26 L16 23 Z', o: 1 }, // near wing
      { d: 'M16 17 L6 6 L15 16 Z', o: 0.75 }, // tail (up-left)
      { d: 'M16 17 L27 7 L23 15 Z', o: 0.95 }, // neck (up-right)
      { d: 'M27 7 L31 9 L26 10 Z', o: 1 }, // beak
    ],
  },
  fold: {
    label: 'Fold',
    paths: [
      { d: 'M5 5 H27 V27 Z', o: 1 }, // sheet
      { d: 'M5 5 H27 L5 27 Z', o: 0.5 }, // folded-over corner (lighter facet)
    ],
  },
  plane: {
    label: 'Plane',
    paths: [
      { d: 'M4 6 L28 16 L12 16 Z', o: 1 }, // upper wing
      { d: 'M4 26 L28 16 L12 16 Z', o: 0.55 }, // lower wing (fold shadow)
      { d: 'M12 16 L28 16 L12 22 Z', o: 0.8 }, // inner fold
    ],
  },
  boat: {
    label: 'Boat',
    paths: [
      { d: 'M16 4 L16 18 L7 18 Z', o: 0.8 }, // left sail
      { d: 'M16 4 L16 18 L25 18 Z', o: 0.55 }, // right sail (fold)
      { d: 'M4 19 L28 19 L23 27 L9 27 Z', o: 1 }, // hull
    ],
  },
};

export const LOGO_IDS = ['star', 'crane', 'fold', 'plane', 'boat'];
export const DEFAULT_LOGO = 'star';

export function isLogoId(id) {
  return Object.prototype.hasOwnProperty.call(LOGOS, id);
}

// A facet's `o` (0–1) is how much light it catches: 1 = the flat accent, less
// = a darker shade of it (the landing page's mark paints the shadow facets
// #c2410c on #f97316). Shading with black instead of fill-opacity keeps the
// mark readable on any background — a translucent facet on a light tab strip
// reads as a pale, washed-out star.
export const SHADE_STRENGTH = 0.6;
export function facetShadePct(o) {
  return Math.round(100 - (1 - o) * SHADE_STRENGTH * 100);
}
function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function facetColor(hex, o) {
  const rgb = hexToRgb(hex);
  if (!rgb || o >= 1) return hex;
  const k = facetShadePct(o) / 100;
  return '#' + rgb.map((v) => Math.round(v * k).toString(16).padStart(2, '0')).join('');
}

// Full <svg> string with the accent color baked in (no CSS vars) — used for the
// browser-tab favicon, which can't read stylesheet variables.
export function logoSvg(id, color) {
  const preset = LOGOS[isLogoId(id) ? id : DEFAULT_LOGO];
  const c = color || DEFAULT_ACCENT;
  const facets = preset.paths
    .map((p) => `<path d="${p.d}" fill="${facetColor(c, p.o)}"/>`)
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${preset.viewBox || '0 0 32 32'}">${facets}</svg>`;
}

export function logoDataUri(id, color) {
  return 'data:image/svg+xml,' + encodeURIComponent(logoSvg(id, color));
}
