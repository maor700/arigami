// Stage 1d web (docs/VOICE.md): the floating voice box. Default spot over the bottom of the rail (start edge —
// right in RTL) on desktop, under the top bar on a phone; a dragged spot is kept per device in its own
// localStorage key and clamped back on screen; arrow keys nudge it, Home resets; the box is rendered with it.
import { test, expect, beforeAll } from 'bun:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolate } from './_isolate.js';
isolate();

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let dock;
const mem = new Map();

beforeAll(async () => {
  globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  dock = await import(path.join(ROOT, 'web/src/lib/voiceDock.js'));
});

const desk = { vw: 1440, vh: 900, w: 248, h: 140, isDesktop: true, railPx: 264 };

test('default: over the bottom of the rail on desktop (LTR left, RTL right), never into the chat', () => {
  const ltr = dock.defaultDockPos({ ...desk, rtl: false });
  expect(ltr.x).toBe(8);
  expect(ltr.x + desk.w).toBeLessThanOrEqual(desk.railPx);
  expect(ltr.y + desk.h).toBeLessThanOrEqual(desk.vh - 8);
  const rtl = dock.defaultDockPos({ ...desk, rtl: true });
  expect(rtl.x).toBe(1440 - 264 + 8);
  expect(rtl.x).toBeGreaterThanOrEqual(desk.vw - desk.railPx);
  expect(rtl.x + desk.w).toBeLessThanOrEqual(desk.vw - 8);
  expect(dock.dockWidth({ vw: 1440, railPx: 264, isDesktop: true })).toBe(248);
  expect(dock.dockWidth({ vw: 1440, railPx: 420, isDesktop: true })).toBe(320);
  expect(dock.dockWidth({ vw: 1440, railPx: 180, isDesktop: true })).toBe(200);
});

test('default on a phone: the top-end corner under the top bar, inside a narrow screen', () => {
  const geo = { vw: 390, vh: 800, w: dock.dockWidth({ vw: 390, isDesktop: false }), h: 140, isDesktop: false, railPx: 0 };
  expect(geo.w).toBe(320);
  const ltr = dock.defaultDockPos({ ...geo, rtl: false });
  expect(ltr).toEqual({ x: 390 - 320 - 8, y: 56 });
  expect(dock.defaultDockPos({ ...geo, rtl: true })).toEqual({ x: 8, y: 56 });
});

test('clamp: a spot off screen (or a smaller window later) is pulled back fully inside', () => {
  expect(dock.clampDockPos({ x: -50, y: -10 }, desk)).toEqual({ x: 8, y: 8 });
  expect(dock.clampDockPos({ x: 5000, y: 5000 }, desk)).toEqual({ x: 1440 - 248 - 8, y: 900 - 140 - 8 });
  expect(dock.dockPlacement({ saved: { x: 1300, y: 700 }, ...desk, vw: 800, vh: 600 })).toEqual({ x: 800 - 248 - 8, y: 600 - 140 - 8 });
  expect(dock.dockPlacement({ saved: null, ...desk, rtl: false })).toEqual(dock.defaultDockPos({ ...desk, rtl: false }));
});

test('per device: a dragged spot is saved under its own key, read back, and null forgets it', () => {
  expect(dock.getDockPos()).toBe(null);
  dock.saveDockPos({ x: 400.4, y: 300.6 });
  expect(dock.getDockPos()).toEqual({ x: 400, y: 301 });
  expect(JSON.parse(mem.get('arigami-voice-dock'))).toEqual({ x: 400, y: 301 });
  expect(mem.has('arigami-prefs')).toBe(false); // not a pref: it does not travel with the rest
  dock.saveDockPos({ x: 'nope' });
  expect(dock.getDockPos()).toBe(null);
  expect(mem.has('arigami-voice-dock')).toBe(false);
});

test('keyboard: arrows nudge by a step (clamped), Home resets, other keys are ignored', () => {
  expect(dock.nudgeDock({ x: 100, y: 100 }, 'ArrowRight', desk)).toEqual({ x: 116, y: 100 });
  expect(dock.nudgeDock({ x: 100, y: 100 }, 'ArrowUp', desk)).toEqual({ x: 100, y: 84 });
  expect(dock.nudgeDock({ x: 8, y: 8 }, 'ArrowLeft', desk)).toEqual({ x: 8, y: 8 });
  expect(dock.nudgeDock({ x: 100, y: 100 }, 'Home', desk)).toBe(null);
  expect(dock.nudgeDock({ x: 100, y: 100 }, 'a', desk)).toBe(undefined);
});
