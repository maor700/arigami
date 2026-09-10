// The screencast transport: an INTERACTIVE live view of a session's browser
// window on a host that has no VNC desktop (the desktop app on Windows or
// macOS — server/lib/screen-driver-native.ts). Speaks the JSON protocol
// documented at the top of server/screencast.ts.
//
// Why it is shaped like noVNC's RFB class rather than like a React component:
// useScreenConnection.js already solves the hard part of this screen — ONE
// connection per desktop, shared by the chat card, the side panel and the
// take-over modal, with the highest-priority visible consumer owning input
// while the others paint mirrors of its canvas. All of that logic is
// transport-agnostic and works by (a) reparenting a detached host <div>, (b)
// reading `host.querySelector('canvas')`, and (c) setting `.viewOnly` on the
// connection. So this class exposes exactly that surface — a canvas inside the
// host div, a settable `viewOnly`, `disconnect()`, and connect/disconnect
// events — and the sharing/mirroring/ownership code above it needed no
// transport-specific branch at all.
//
// What reaches the machine: mouse move/down/up, wheel, and keyboard, relayed
// into the PAGE through CDP. What does not: anything outside the Chrome
// window (the taskbar, a native file dialog, a UAC prompt). That is a property
// of CDP, not of this file — see docs/WINDOWS-REMOTE.md for what closing it
// would take.

/**
 * Map a pointer position on the canvas ELEMENT to a coordinate in the page's
 * own pixel space.
 *
 * The canvas is drawn with `object-fit: contain`, so the image is letterboxed
 * inside the element whenever their aspect ratios differ — the bug this
 * prevents is treating the element box as the image box and landing every
 * click a few dozen pixels off, consistently, in a way that looks like "the
 * remote page ignores clicks" rather than like a coordinate bug.
 *
 * Pure and exported for the unit test; returns null for a point in the
 * letterbox (outside the image), which must not be sent as a page coordinate.
 */
export function canvasToPage({ rectLeft, rectTop, rectW, rectH, bitmapW, bitmapH, clientX, clientY }) {
  if (!rectW || !rectH || !bitmapW || !bitmapH) return null;
  const scale = Math.min(rectW / bitmapW, rectH / bitmapH);
  if (!(scale > 0)) return null;
  const offX = (rectW - bitmapW * scale) / 2;
  const offY = (rectH - bitmapH * scale) / 2;
  const x = (clientX - rectLeft - offX) / scale;
  const y = (clientY - rectTop - offY) / scale;
  if (x < 0 || y < 0 || x > bitmapW || y > bitmapH) return null;
  return { x, y };
}

const BUTTON_NAMES = ['left', 'middle', 'right', 'back', 'forward'];

/** DOM modifier flags → the shape server/screencast.ts's `modifierMask` reads. */
function modsOf(e) {
  return { alt: e.altKey, ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey };
}

/**
 * Keys the cockpit must not swallow while the canvas has focus, and that the
 * browser must not act on either (F5 reloading the COCKPIT while you meant to
 * reload the remote page is the memorable one). Everything else is forwarded
 * too, but without preventDefault, so the human keeps their browser's own
 * shortcuts (Ctrl+W, Ctrl+T…) on their OWN machine — taking those away from a
 * viewer who is not in kiosk mode causes more trouble than it solves.
 */
const SWALLOW = new Set(['Tab', 'F5', 'Backspace', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' ', 'Enter']);

export class ScreencastConnection extends EventTarget {
  /**
   * @param {HTMLElement} host   detached div that useScreenConnection reparents into the owner
   * @param {string} url         ws(s)://…/__screencast?session=<id>
   */
  constructor(host, url) {
    super();
    this._host = host;
    this._closed = false;
    this._viewOnly = true;
    this._pendingFrame = null; // newest undecoded frame; older ones are dropped
    this._decoding = false;

    const canvas = document.createElement('canvas');
    // Sized to the first frame; until then a 1x1 canvas would flash, so start
    // at the screencast's own max so the letterbox math has sane inputs.
    canvas.width = 1280;
    canvas.height = 800;
    canvas.tabIndex = 0; // focusable — a canvas gets no keyboard events otherwise
    canvas.style.cssText = 'width:100%;height:100%;object-fit:contain;outline:none;touch-action:none;';
    host.appendChild(canvas);
    this._canvas = canvas;
    this._ctx = canvas.getContext('2d');

    this._ws = new WebSocket(url);
    this._ws.onopen = () => this.dispatchEvent(new CustomEvent('connect'));
    this._ws.onclose = () => {
      if (this._closed) return;
      this.dispatchEvent(new CustomEvent('disconnect'));
    };
    this._ws.onerror = () => {
      if (this._closed) return;
      this.dispatchEvent(new CustomEvent('disconnect'));
    };
    this._ws.onmessage = (ev) => this._onMessage(ev);

    this._bindInput();
  }

  // noVNC compatibility: useScreenConnection sets this on every RFB it makes.
  // Scaling here is CSS (`object-fit`), so there is nothing to toggle — the
  // setter exists so the shared code needs no `if (transport === …)`.
  set scaleViewport(_v) {}
  get scaleViewport() { return true; }

  get viewOnly() { return this._viewOnly; }
  set viewOnly(v) { this._viewOnly = !!v; }

  disconnect() {
    if (this._closed) return;
    this._closed = true;
    try { this._ws.close(); } catch {}
    try { this._canvas.remove(); } catch {}
  }

  _onMessage(ev) {
    let msg;
    try { msg = JSON.parse(String(ev.data)); } catch { return; }
    if (msg.type === 'error') {
      this.dispatchEvent(new CustomEvent('screencasterror', { detail: { message: msg.message || '' } }));
      return;
    }
    if (msg.type !== 'frame' || !msg.data) return;
    // Keep only the newest frame: decoding is async, and a viewer that cannot
    // keep up must fall behind by dropping frames, never by queueing them —
    // a growing backlog turns into seconds of latency on the input side too,
    // which is what makes a remote desktop feel broken rather than slow.
    this._pendingFrame = msg;
    this._drainFrames();
  }

  _drainFrames() {
    if (this._decoding || !this._pendingFrame || this._closed) return;
    const frame = this._pendingFrame;
    this._pendingFrame = null;
    this._decoding = true;
    const img = new Image();
    img.onload = () => {
      this._decoding = false;
      if (this._closed) return;
      const w = frame.width || img.naturalWidth;
      const h = frame.height || img.naturalHeight;
      if (this._canvas.width !== w || this._canvas.height !== h) {
        this._canvas.width = w;
        this._canvas.height = h;
      }
      try { this._ctx.drawImage(img, 0, 0, w, h); } catch {}
      this._drainFrames();
    };
    img.onerror = () => { this._decoding = false; this._drainFrames(); };
    img.src = `data:image/jpeg;base64,${frame.data}`;
  }

  _send(msg) {
    if (this._closed || this._viewOnly) return;
    if (this._ws.readyState !== 1) return;
    // bufferedAmount is the only honest backpressure signal a WebSocket gives
    // (send() is synchronous — it queues internally and tells you nothing), and
    // without this a stalled uplink turns pointermove spam into unbounded
    // memory. Dropping moves is the right failure: the next one is a better
    // description of where the pointer is than the one we skipped.
    if (this._ws.bufferedAmount > 1 << 20) return;
    try { this._ws.send(JSON.stringify(msg)); } catch {}
  }

  _point(e) {
    const r = this._canvas.getBoundingClientRect();
    return canvasToPage({
      rectLeft: r.left,
      rectTop: r.top,
      rectW: r.width,
      rectH: r.height,
      bitmapW: this._canvas.width,
      bitmapH: this._canvas.height,
      clientX: e.clientX,
      clientY: e.clientY,
    });
  }

  _bindInput() {
    const c = this._canvas;

    const mouse = (action, e, extra = {}) => {
      if (this._viewOnly) return;
      const p = this._point(e);
      if (!p) return;
      this._send({
        type: 'mouse',
        action,
        x: p.x,
        y: p.y,
        button: BUTTON_NAMES[e.button] || 'left',
        buttons: e.buttons || 0,
        modifiers: modsOf(e),
        ...extra,
      });
    };

    c.addEventListener('pointerdown', (e) => {
      if (this._viewOnly) return;
      c.focus(); // so the following keystrokes go to the machine, not the page behind it
      // Capture keeps a drag alive when the pointer leaves the canvas — the
      // matching pointerup would otherwise never arrive and the remote page
      // would be left with a button held down forever.
      try { c.setPointerCapture(e.pointerId); } catch {}
      e.preventDefault();
      mouse('down', e, { clickCount: e.detail || 1 });
    });
    c.addEventListener('pointerup', (e) => {
      if (this._viewOnly) return;
      try { c.releasePointerCapture(e.pointerId); } catch {}
      e.preventDefault();
      mouse('up', e, { clickCount: e.detail || 1 });
    });
    c.addEventListener('pointermove', (e) => mouse('move', e));
    c.addEventListener('contextmenu', (e) => { if (!this._viewOnly) e.preventDefault(); });

    c.addEventListener(
      'wheel',
      (e) => {
        if (this._viewOnly) return;
        const p = this._point(e);
        if (!p) return;
        e.preventDefault();
        this._send({ type: 'mouse', action: 'wheel', x: p.x, y: p.y, deltaX: e.deltaX, deltaY: e.deltaY, modifiers: modsOf(e) });
      },
      { passive: false }
    );

    const key = (action) => (e) => {
      if (this._viewOnly) return;
      if (SWALLOW.has(e.key)) e.preventDefault();
      this._send({
        type: 'key',
        action,
        key: e.key,
        code: e.code,
        keyCode: e.keyCode,
        repeat: e.repeat,
        modifiers: modsOf(e),
      });
    };
    c.addEventListener('keydown', key('down'));
    c.addEventListener('keyup', key('up'));

    // Paste: a clipboard never crosses this transport (same as VNC), but a
    // real paste event on the focused canvas carries the text, and insertText
    // puts it into the remote page in one call instead of 40 keystrokes.
    c.addEventListener('paste', (e) => {
      if (this._viewOnly) return;
      const text = e.clipboardData?.getData('text') || '';
      if (!text) return;
      e.preventDefault();
      this._send({ type: 'text', text });
    });
  }
}
