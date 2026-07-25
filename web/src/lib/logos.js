// Arigami origami logo marks. Each preset is a set of flat triangular facets
// (folded-paper look) drawn in the accent color, with per-facet opacity to
// suggest a fold catching the light. Used inline (Settings picker) and baked
// into a favicon data-URI (prefs.applyBranding).

export const DEFAULT_ACCENT = '#12A594';

// viewBox is 0 0 32 32 for every preset. `o` = fill-opacity of that facet.
export const LOGOS = {
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

export const LOGO_IDS = ['crane', 'fold', 'plane', 'boat'];

export function isLogoId(id) {
  return Object.prototype.hasOwnProperty.call(LOGOS, id);
}

// Full <svg> string with the accent color baked in (no CSS vars) — used for the
// browser-tab favicon, which can't read stylesheet variables.
export function logoSvg(id, color) {
  const preset = LOGOS[isLogoId(id) ? id : 'crane'];
  const c = color || DEFAULT_ACCENT;
  const facets = preset.paths
    .map((p) => `<path d="${p.d}" fill="${c}" fill-opacity="${p.o}"/>`)
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${facets}</svg>`;
}

export function logoDataUri(id, color) {
  return 'data:image/svg+xml,' + encodeURIComponent(logoSvg(id, color));
}
