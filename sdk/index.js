// @arigami/sdk runtime — types live in index.d.ts; everything here is an
// identity helper so an extension gets editor types with zero runtime weight
// (and zero risk of an extension pulling host internals in through us).
export const EXT_API_VERSION = 1;

export const defineListener = (p) => p;
export const defineHooks = (h) => h;
export const defineTools = (t) => t;
export const defineManifest = (m) => m;
