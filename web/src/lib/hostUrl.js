// Device-independent URL building for tabs. The host serves the shell AND the
// reverse proxy, so `window.location.origin` is reachable from whatever device
// is looking at the UI (laptop, phone over VPN). A stored tab.url like
// http://localhost:3021/… is only meaningful ON the host box — the proxy dials
// it server-side — so anything shown to / opened by the browser must go through
// tabSrc(), never the raw tab.url.
// In production the shell is served BY the host (/__host/), so its own origin is
// the proxy origin. Only the Vite dev server (:5173) needs the fallback.
export const HOST_ORIGIN =
  window.location.port === '5173' ? 'http://localhost:3099' : window.location.origin;

// Host-internal pages (/__ticket/…, /__compare, anything already on the host
// origin) load directly; only external targets go through the ?__target= proxy.
export function tabSrc(url) {
  // An empty url must NOT become `/?__target=` — that makes the host serve its
  // "starting host proxy" bootstrap, which reloads, can't resolve the empty
  // target, and loops forever (a flickering tab). Render nothing instead.
  if (!url) return 'about:blank';
  if (url.startsWith('/')) return `${HOST_ORIGIN}${url}`;
  if (url.startsWith(HOST_ORIGIN)) return url;
  // Carry the target's DEEP path/search/hash as the iframe's real location, and
  // pin only the target ORIGIN via __target. This is what lets client-side
  // routers land deep: a SPA (React Router) reads location.pathname, and
  // Storybook reads the ?path= query — if everything hid behind /?__target=<full>
  // they'd both see "/" and bounce to home. __keep=1 keeps the pin in place
  // instead of 302ing to a clean URL (no address bar inside a tab).
  let u;
  try {
    u = new URL(url);
  } catch {
    return `${HOST_ORIGIN}/?__target=${encodeURIComponent(url)}&__keep=1`;
  }
  const sp = new URLSearchParams(u.search);
  sp.set('__target', u.origin);
  sp.set('__keep', '1');
  return `${HOST_ORIGIN}${u.pathname}?${sp.toString()}${u.hash}`;
}
