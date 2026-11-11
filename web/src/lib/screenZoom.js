// Local pinch-zoom for the live screen on a phone. The zoom is the VIEWER's
// only: the remote desktop keeps its size, nothing is sent to it, and the
// agent's screenshots do not change.
//
// How: the consumer container (the div noVNC's host is reparented into) is
// made `z` times the view's size and offset by (tx, ty). noVNC's own
// ResizeObserver rescales its canvas to the bigger box (scaleViewport), so its
// pointer mapping — the canvas's bounding rect over its display scale — stays
// exact at every zoom. A CSS transform would not: noVNC divides by its own
// scale only, and a transformed rect would put every tap off by `z`.
//
// The math below is pure (no DOM), so it is testable on its own.

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 5;
/** A pinch released this close to 1× snaps back to the plain fit. */
export const SNAP_ZOOM = 1.05;

export const NO_ZOOM = Object.freeze({ z: 1, tx: 0, ty: 0 });

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Keep the desktop's picture inside the view. At zoom z the container is
 * (z·W × z·H) and noVNC centres the fitted frame (cw × ch at 1×) in it, so the
 * frame's left edge is tx + z·(W − cw)/2. Wider than the view → that edge stays
 * in [W − z·cw, 0]; narrower → centred. Same for y.
 * @param {{z:number, tx:number, ty:number}} v
 * @param {{W:number, H:number, fbW:number, fbH:number}} box view size and the remote frame size
 */
export function clampView(v, { W, H, fbW, fbH }) {
  const z = clamp(v.z, MIN_ZOOM, MAX_ZOOM);
  if (!W || !H) return { z, tx: 0, ty: 0 };
  // no frame yet: clamp to the container itself
  const f = fbW && fbH ? Math.min(W / fbW, H / fbH) : 1;
  const cw = fbW && fbH ? fbW * f : W;
  const ch = fbW && fbH ? fbH * f : H;
  const axis = (t, size, content) => {
    const pad = (z * (size - content)) / 2; // the frame's offset inside the container
    const w = z * content;
    const left = w >= size ? clamp(t + pad, size - w, 0) : (size - w) / 2;
    return left - pad;
  };
  return { z, tx: axis(v.tx, W, cw), ty: axis(v.ty, H, ch) };
}

/**
 * A two-finger move from `start` (the view and the fingers when the gesture
 * began) to the fingers now: the point under the starting centroid follows the
 * current centroid, scaled by how far the fingers spread. `pinch: false` (a
 * two-finger drag) only pans.
 * @param {{z:number, tx:number, ty:number}} start
 * @param {{cx:number, cy:number, d:number}} from  centroid + finger distance at the start (view coordinates)
 * @param {{cx:number, cy:number, d:number}} now
 */
export function gestureView(start, from, now, pinch = true) {
  const ratio = pinch && from.d > 0 && now.d > 0 ? now.d / from.d : 1;
  const z = clamp(start.z * ratio, MIN_ZOOM, MAX_ZOOM);
  // the content point under the starting centroid, in 1× container units
  const px = (from.cx - start.tx) / start.z;
  const py = (from.cy - start.ty) / start.z;
  return { z, tx: now.cx - px * z, ty: now.cy - py * z };
}

/** At the end of a gesture: a near-1× zoom is no zoom. */
export function settleView(v) {
  return v.z < SNAP_ZOOM ? NO_ZOOM : v;
}

/** Centroid and spread of the first two touches, in coordinates relative to `rect`. */
export function twoFingers(touches, rect) {
  const a = touches[0];
  const b = touches[1];
  return {
    cx: (a.clientX + b.clientX) / 2 - rect.left,
    cy: (a.clientY + b.clientY) / 2 - rect.top,
    d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
  };
}
