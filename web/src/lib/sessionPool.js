// Keep-alive pool for session views. Switching sessions used to unmount the
// previous session's SessionView, so every iframe tab in it (Linear, the PR,
// extension pages, proxied sites) re-navigated on the way back, and the Changes
// tab re-fetched — losing scroll, half-typed input and the picked tab. The
// cockpit keeps the last few visited sessions mounted but hidden instead.
//
// Eviction: least-recently-visited first, once the pool is over its cap. The
// cap is small on a phone (the current session + the one you came from — the
// A→B→A case) and on low-memory devices, larger on a desktop. Sessions that no
// longer exist leave the pool on the next render.

export const POOL_CAP_DESKTOP = 5;
export const POOL_CAP_PHONE = 2;

export function poolCap({ isDesktop, deviceMemory } = {}) {
  // navigator.deviceMemory is coarse GB (0.25…8); ≤2 GB keeps the phone budget.
  if (!isDesktop || (typeof deviceMemory === 'number' && deviceMemory <= 2)) return POOL_CAP_PHONE;
  return POOL_CAP_DESKTOP;
}

// Most-recent-first list of session ids after visiting `id`, capped, without
// ids that are not in `alive` (a Set of existing session ids). Returns the SAME
// array when nothing changed, so callers can cheaply skip work.
export function touchPool(pool, id, cap, alive) {
  let next = pool.filter((x) => x !== id && (!alive || alive.has(x)));
  if (id && (!alive || alive.has(id))) next.unshift(id);
  if (next.length > cap) next = next.slice(0, Math.max(1, cap));
  if (next.length === pool.length && next.every((x, i) => x === pool[i])) return pool;
  return next;
}
