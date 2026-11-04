// Stage 1d (docs/VOICE.md): where the floating voice box sits. Hands-free and call mode show a small box that
// the person can drag anywhere; by default it sits over the bottom of the rail (desktop) or under the top bar
// (phone), so it never covers the chat. A dragged position is kept for THIS device only (its own localStorage
// key — not part of prefs, which travel with exports/resets) and is clamped back on screen on every resize.
import { useSyncExternalStore } from 'react';

const KEY = 'arigami-voice-dock';
export const DOCK_MARGIN = 8; // px between the box and a screen edge / the rail edge
export const DOCK_STEP = 16; // px per arrow-key nudge on the grip
const PHONE_TOP = 56; // px — below the phone top bar / tab bar
export const DOCK_FALLBACK_H = 140; // px — the box height before it has been measured

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function read() {
  try {
    const raw = JSON.parse(globalThis.localStorage?.getItem(KEY) || 'null');
    const x = num(raw?.x), y = num(raw?.y);
    return x == null || y == null ? null : { x, y };
  } catch {
    return null;
  }
}

let saved = read();
const listeners = new Set();
const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
export const getDockPos = () => saved;
export function useDockPos() {
  return useSyncExternalStore(subscribe, getDockPos, getDockPos);
}

/** Keep a dragged position ({x, y} = the box's top-left in px), or forget it with null (back to the default). */
export function saveDockPos(pos) {
  const x = num(pos?.x), y = num(pos?.y);
  saved = x == null || y == null ? null : { x: Math.round(x), y: Math.round(y) };
  try {
    if (saved) globalThis.localStorage?.setItem(KEY, JSON.stringify(saved));
    else globalThis.localStorage?.removeItem(KEY);
  } catch { /* private mode / quota: the position just doesn't survive a reload */ }
  for (const fn of listeners) fn();
}

/** The box width: as wide as the rail allows on desktop (within 200–320px), phone: up to 320px of the screen. */
export function dockWidth({ vw, railPx, isDesktop }) {
  if (isDesktop && railPx > 0) return Math.round(Math.max(200, Math.min(320, railPx - 2 * DOCK_MARGIN)));
  return Math.round(Math.max(180, Math.min(320, (vw || 320) - 2 * DOCK_MARGIN)));
}

/** Pull a position back inside the viewport (the whole box stays visible, a margin from every edge). */
export function clampDockPos(pos, { vw, vh, w, h }) {
  const maxX = Math.max(DOCK_MARGIN, vw - w - DOCK_MARGIN);
  const maxY = Math.max(DOCK_MARGIN, vh - h - DOCK_MARGIN);
  return {
    x: Math.round(Math.min(maxX, Math.max(DOCK_MARGIN, pos.x))),
    y: Math.round(Math.min(maxY, Math.max(DOCK_MARGIN, pos.y))),
  };
}

/** Where the box sits until it is dragged: the bottom of the rail on desktop (the rail is on the start edge — right
 *  in RTL), the top-end corner under the top bar on a phone (the rail is a drawer there). */
export function defaultDockPos({ vw, vh, w, h, rtl, isDesktop, railPx }) {
  let x;
  let y;
  if (isDesktop && railPx > 0) {
    x = rtl ? vw - railPx + DOCK_MARGIN : DOCK_MARGIN;
    y = vh - h - DOCK_MARGIN * 1.5;
  } else {
    x = rtl ? DOCK_MARGIN : vw - w - DOCK_MARGIN;
    y = PHONE_TOP;
  }
  return clampDockPos({ x, y }, { vw, vh, w, h });
}

/** The position to render: the device's dragged spot if any (clamped to this viewport), else the default. */
export function dockPlacement({ saved: s, ...geo }) {
  return s ? clampDockPos(s, geo) : defaultDockPos(geo);
}

/** One arrow-key nudge on the grip (Home = back to the default). Returns the new position or null for "reset". */
export function nudgeDock(pos, key, geo) {
  if (key === 'Home') return null;
  const d = { ArrowLeft: [-DOCK_STEP, 0], ArrowRight: [DOCK_STEP, 0], ArrowUp: [0, -DOCK_STEP], ArrowDown: [0, DOCK_STEP] }[key];
  if (!d) return undefined;
  return clampDockPos({ x: pos.x + d[0], y: pos.y + d[1] }, geo);
}
