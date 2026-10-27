// Local pinch-zoom of the live screen (web/src/lib/screenZoom.js): the picture
// stays inside the view, the point under the fingers follows them, and a
// near-1× release snaps back to the plain fit.
import { test, expect } from 'bun:test';
import { MAX_ZOOM, NO_ZOOM, clampView, gestureView, settleView, twoFingers } from '../web/src/lib/screenZoom.js';

// a phone in portrait showing a 1280×800 desktop: fitted to 390×244, letterboxed top and bottom
const phone = { W: 390, H: 700, fbW: 1280, fbH: 800 };

test('clampView: 1× is the plain fit, whatever the pan', () => {
  expect(clampView({ z: 1, tx: 120, ty: -80 }, phone)).toEqual({ z: 1, tx: 0, ty: 0 });
  expect(clampView({ z: 0.4, tx: 0, ty: 0 }, phone).z).toBe(1);
  expect(clampView({ z: 99, tx: 0, ty: 0 }, phone).z).toBe(MAX_ZOOM);
});

test('clampView: zoomed in, the frame edges never come inside the view', () => {
  const z = 2;
  const cw = 390; // fitted width at 1×
  const pad = (z * (phone.W - cw)) / 2; // 0: the frame fills the width
  // far to the right: the frame's left edge would leave a gap → pinned at 0
  expect(clampView({ z, tx: 500, ty: 0 }, phone).tx).toBeCloseTo(-pad, 6);
  // far to the left: the right edge pinned to the view's right edge
  expect(clampView({ z, tx: -5000, ty: 0 }, phone).tx).toBeCloseTo(phone.W - z * cw - pad, 6);
  // vertically the frame (2 × 243.75 = 487.5) is still shorter than the view → centred
  const v = clampView({ z, tx: 0, ty: -400 }, phone);
  const frameTop = v.ty + (z * (phone.H - 243.75)) / 2;
  expect(frameTop).toBeCloseTo((phone.H - z * 243.75) / 2, 6);
});

test('gestureView: the point under the fingers stays under them', () => {
  const start = { z: 1, tx: 0, ty: 0 };
  const from = { cx: 100, cy: 300, d: 100 };
  // spread to 2× without moving: the centroid's content point is fixed
  const v = gestureView(start, from, { cx: 100, cy: 300, d: 200 });
  expect(v.z).toBe(2);
  expect((100 - v.tx) / v.z).toBeCloseTo(100, 6);
  expect((300 - v.ty) / v.z).toBeCloseTo(300, 6);
  // a two-finger drag while zoomed pans by the finger movement and keeps the zoom
  const p = gestureView({ z: 2, tx: -100, ty: -300 }, from, { cx: 140, cy: 280, d: 999 }, false);
  expect(p).toEqual({ z: 2, tx: -60, ty: -320 });
});

test('settleView: a release just above 1× is no zoom', () => {
  expect(settleView({ z: 1.03, tx: -4, ty: 2 })).toBe(NO_ZOOM);
  expect(settleView({ z: 1.5, tx: -4, ty: 2 })).toEqual({ z: 1.5, tx: -4, ty: 2 });
});

test('twoFingers: centroid relative to the view, and the spread', () => {
  const f = twoFingers([{ clientX: 10, clientY: 110 }, { clientX: 40, clientY: 150 }], { left: 0, top: 100 });
  expect(f).toEqual({ cx: 25, cy: 30, d: 50 });
});
