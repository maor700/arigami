// windows-remote-parity, client side: the screencast transport that gives a
// Windows/macOS host a take-over that can actually TOUCH the machine instead
// of only watching it (web/src/lib/screencastClient.js).
//
// Everything here runs against stub DOM objects rather than a real canvas:
// the parts worth pinning are the coordinate math (a click landing on the
// wrong element is invisible in a screenshot and looks like "the remote page
// ignores me"), the viewOnly gate, and the frame drop-latest policy.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = (p) => path.join(ROOT, 'web/src', p);

let canvasToPage, ScreencastConnection;
let lastSocket = null;
let lastImage = null;

function makeCanvas() {
  const listeners = new Map();
  return {
    tagName: 'CANVAS',
    width: 0,
    height: 0,
    tabIndex: -1,
    style: { cssText: '' },
    dataset: {},
    _listeners: listeners,
    _rect: { left: 0, top: 0, width: 0, height: 0 },
    getContext: () => ({ drawImage() {} }),
    getBoundingClientRect() { return this._rect; },
    addEventListener(type, fn) { listeners.set(type, [...(listeners.get(type) || []), fn]); },
    removeEventListener() {},
    setPointerCapture() {},
    releasePointerCapture() {},
    focus() {},
    remove() {},
    setAttribute() {},
    removeAttribute() {},
    fire(type, ev) { for (const fn of listeners.get(type) || []) fn(ev); },
  };
}

const STUBBED = ['document', 'WebSocket', 'Image', 'CustomEvent', 'fetch', 'window', 'navigator', 'MutationObserver'];
const saved = {};

beforeAll(async () => {
  for (const k of STUBBED) saved[k] = globalThis[k];
  // useScreenConnection.js imports noVNC, which touches window/navigator at
  // module scope — the rfb branch is never CONSTRUCTED here, but the import
  // still has to succeed.
  globalThis.window = globalThis;
  globalThis.navigator = globalThis.navigator || { language: 'en-US', userAgent: 'test' };
  globalThis.MutationObserver = class { observe() {} disconnect() {} takeRecords() { return []; } };
  globalThis.document = {
    createElement: (tag) => (tag === 'canvas' ? makeCanvas() : { appendChild() {}, style: {} }),
    // noVNC probes these at import time (touch detection, scrollbar/cursor
    // capability sniffing) — enough shape for the import to succeed.
    documentElement: { style: {}, dataset: {} },
    body: { appendChild() {}, removeChild() {}, style: {} },
    addEventListener() {},
    removeEventListener() {},
    querySelector: () => null,
  };
  globalThis.WebSocket = class {
    constructor(url) {
      this.url = url;
      this.readyState = 1;
      this.bufferedAmount = 0;
      this.sent = [];
      lastSocket = this;
    }
    send(s) { this.sent.push(JSON.parse(s)); }
    close() { this.readyState = 3; }
  };
  globalThis.Image = class {
    constructor() { lastImage = this; }
    set src(v) { this._src = v; }
    get src() { return this._src; }
  };
  globalThis.CustomEvent = class extends Event {
    constructor(type, init) { super(type); this.detail = init?.detail; }
  };
  ({ canvasToPage, ScreencastConnection } = await import(web('lib/screencastClient.js')));
});

// bun runs every test FILE in one process, so these stubs are global state
// shared with the rest of the suite. Leaving the WebSocket stub installed made
// windows-remote-parity-host.test.ts hang forever on a socket that can never
// close — a failure that pointed at the code under test and was actually this
// file's fault. Put the real globals back.
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete globalThis[k];
    else globalThis[k] = v;
  }
});

// ---- which transport the cockpit picks -------------------------------------

test('transport pick: a host reporting screencast is believed, scope and all', async () => {
  const { resolveTransport, resetScreenTransportCache } = await import(web('lib/useScreenConnection.js'));
  resetScreenTransportCache();
  globalThis.fetch = async () => new Response(
    JSON.stringify({ driver: 'native-window', viewer: { transport: 'screencast', path: '/__screencast?session=s1', interactive: true, scope: 'browser' } }),
    { headers: { 'content-type': 'application/json' } }
  );
  const t = await resolveTransport('s1', 's1');
  expect(t).toEqual({ transport: 'screencast', path: '/__screencast?session=s1', interactive: true, scope: 'browser' });
});

test('transport pick: an rfb host (Linux today, a Windows box with a VNC service tomorrow) keeps noVNC', async () => {
  const { resolveTransport, resetScreenTransportCache } = await import(web('lib/useScreenConnection.js'));
  resetScreenTransportCache();
  globalThis.fetch = async () => new Response(
    JSON.stringify({ driver: 'winvnc', viewer: { transport: 'rfb', path: '/__vnc', interactive: true, scope: 'desktop' } }),
    { headers: { 'content-type': 'application/json' } }
  );
  const t = await resolveTransport('s2', 's2');
  expect(t.transport).toBe('rfb');
  expect(t.scope).toBe('desktop');
});

test('transport pick: an unreachable or older host falls back to rfb — what every host spoke before this existed', async () => {
  const { resolveTransport, resetScreenTransportCache } = await import(web('lib/useScreenConnection.js'));
  resetScreenTransportCache();
  globalThis.fetch = async () => { throw new Error('offline'); };
  expect((await resolveTransport('s3', 's3')).transport).toBe('rfb');
  resetScreenTransportCache();
  // An older host answers screen/status without a `viewer` at all.
  globalThis.fetch = async () => new Response(JSON.stringify({ available: true, own: true }), { headers: { 'content-type': 'application/json' } });
  expect((await resolveTransport('s4', 's4')).transport).toBe('rfb');
});

test('transport pick: the probe is cached per scope — one round trip, not one per mounted view', async () => {
  const { resolveTransport, resetScreenTransportCache } = await import(web('lib/useScreenConnection.js'));
  resetScreenTransportCache();
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ viewer: { transport: 'screencast', path: '/x', interactive: true, scope: 'browser' } }), { headers: { 'content-type': 'application/json' } });
  };
  // The card, the side panel and the modal all mount against the same desktop.
  await Promise.all([resolveTransport('s5', 's5'), resolveTransport('s5', 's5'), resolveTransport('s5', 's5')]);
  await resolveTransport('s5', 's5');
  expect(calls).toBe(1);
});

// ---- the letterbox math ----------------------------------------------------

test('canvasToPage: an exactly-fitting canvas maps 1:1 after scaling', () => {
  // 1280x800 image shown at 640x400 (same aspect): centre of the element is
  // the centre of the page.
  const p = canvasToPage({ rectLeft: 0, rectTop: 0, rectW: 640, rectH: 400, bitmapW: 1280, bitmapH: 800, clientX: 320, clientY: 200 });
  expect(p).toEqual({ x: 640, y: 400 });
});

test('canvasToPage: letterboxing is accounted for, not ignored', () => {
  // 1280x800 (1.6) inside a 640x600 box → scale 0.5, image is 640x400,
  // vertically centred with 100px bars. A click 100px down the ELEMENT is the
  // very top of the PAGE. Treating the element box as the image box would
  // return y=133 here — off by a third of the viewport.
  const top = canvasToPage({ rectLeft: 0, rectTop: 0, rectW: 640, rectH: 600, bitmapW: 1280, bitmapH: 800, clientX: 0, clientY: 100 });
  expect(top).toEqual({ x: 0, y: 0 });
  const mid = canvasToPage({ rectLeft: 0, rectTop: 0, rectW: 640, rectH: 600, bitmapW: 1280, bitmapH: 800, clientX: 320, clientY: 300 });
  expect(mid).toEqual({ x: 640, y: 400 });
});

test('canvasToPage: the element offset on the page is subtracted', () => {
  const p = canvasToPage({ rectLeft: 50, rectTop: 30, rectW: 640, rectH: 400, bitmapW: 1280, bitmapH: 800, clientX: 370, clientY: 230 });
  expect(p).toEqual({ x: 640, y: 400 });
});

test('canvasToPage: a click in the letterbox bar is null, not a clamped edge coordinate', () => {
  // Sending a clamped (0,0) instead would put a click on the top-left of the
  // remote page for a click that was on nothing at all.
  expect(canvasToPage({ rectLeft: 0, rectTop: 0, rectW: 640, rectH: 600, bitmapW: 1280, bitmapH: 800, clientX: 320, clientY: 20 })).toBeNull();
  expect(canvasToPage({ rectLeft: 0, rectTop: 0, rectW: 640, rectH: 600, bitmapW: 1280, bitmapH: 800, clientX: 320, clientY: 580 })).toBeNull();
});

test('canvasToPage: a zero-sized or unsized canvas returns null instead of dividing by zero', () => {
  expect(canvasToPage({ rectLeft: 0, rectTop: 0, rectW: 0, rectH: 0, bitmapW: 1280, bitmapH: 800, clientX: 1, clientY: 1 })).toBeNull();
  expect(canvasToPage({ rectLeft: 0, rectTop: 0, rectW: 640, rectH: 400, bitmapW: 0, bitmapH: 0, clientX: 1, clientY: 1 })).toBeNull();
});

// ---- the connection --------------------------------------------------------

function connect() {
  const host = { appendChild(el) { this.canvas = el; }, style: {}, canvas: null };
  const conn = new ScreencastConnection(host, 'ws://host.test/__screencast?session=s1');
  const canvas = host.canvas;
  canvas._rect = { left: 0, top: 0, width: 640, height: 400 };
  canvas.width = 1280;
  canvas.height = 800;
  return { conn, canvas, ws: lastSocket };
}

const pointer = (over) => ({ clientX: 320, clientY: 200, button: 0, buttons: 1, detail: 1, pointerId: 1, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, preventDefault() {}, ...over });

test('a click on the canvas is sent in PAGE coordinates once the view is interactive', () => {
  const { conn, canvas, ws } = connect();
  conn.viewOnly = false;
  canvas.fire('pointerdown', pointer());
  canvas.fire('pointerup', pointer({ buttons: 0 }));
  expect(ws.sent.map((m) => [m.type, m.action])).toEqual([['mouse', 'down'], ['mouse', 'up']]);
  // 320,200 on a 640x400 element showing a 1280x800 page → 640,400.
  expect(ws.sent[0]).toMatchObject({ x: 640, y: 400, button: 'left', buttons: 1 });
});

test('viewOnly means nothing at all reaches the machine — the whole point of the card/panel views', () => {
  const { conn, canvas, ws } = connect();
  expect(conn.viewOnly).toBe(true); // default until an owner claims it
  canvas.fire('pointerdown', pointer());
  canvas.fire('keydown', { key: 'a', code: 'KeyA', keyCode: 65, repeat: false, preventDefault() {} });
  canvas.fire('wheel', { clientX: 320, clientY: 200, deltaX: 0, deltaY: -120, preventDefault() {} });
  expect(ws.sent).toEqual([]);
});

test('keyboard and wheel reach the machine, with modifiers, when interactive', () => {
  const { conn, canvas, ws } = connect();
  conn.viewOnly = false;
  canvas.fire('keydown', { key: 'c', code: 'KeyC', keyCode: 67, repeat: false, ctrlKey: true, altKey: false, metaKey: false, shiftKey: false, preventDefault() {} });
  canvas.fire('wheel', { clientX: 320, clientY: 200, deltaX: 0, deltaY: -120, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, preventDefault() {} });
  expect(ws.sent[0]).toMatchObject({ type: 'key', action: 'down', key: 'c', code: 'KeyC', keyCode: 67, modifiers: { ctrl: true } });
  expect(ws.sent[1]).toMatchObject({ type: 'mouse', action: 'wheel', x: 640, y: 400, deltaY: -120 });
});

test('a paste is one insertText instead of a keystroke storm', () => {
  const { conn, canvas, ws } = connect();
  conn.viewOnly = false;
  canvas.fire('paste', { clipboardData: { getData: () => 'one-time-code-123' }, preventDefault() {} });
  expect(ws.sent).toEqual([{ type: 'text', text: 'one-time-code-123' }]);
});

test('a stalled uplink drops input instead of buffering it without limit', () => {
  const { conn, canvas, ws } = connect();
  conn.viewOnly = false;
  ws.bufferedAmount = 4 << 20; // the socket is not draining
  canvas.fire('pointermove', pointer());
  expect(ws.sent).toEqual([]);
});

test('frames: only the newest undecoded frame is kept, so a slow viewer falls behind by dropping, not by queueing', () => {
  const { conn, ws } = connect();
  // Three frames arrive while the first is still decoding.
  ws.onmessage({ data: JSON.stringify({ type: 'frame', data: 'AAA', width: 800, height: 600 }) });
  const firstImg = lastImage;
  ws.onmessage({ data: JSON.stringify({ type: 'frame', data: 'BBB', width: 800, height: 600 }) });
  ws.onmessage({ data: JSON.stringify({ type: 'frame', data: 'CCC', width: 800, height: 600 }) });
  expect(firstImg.src).toContain('AAA');
  // Finish decoding the first: the NEXT one decoded is the newest (CCC), not
  // the queued-up BBB — B is dropped on purpose.
  firstImg.onload();
  expect(lastImage.src).toContain('CCC');
  conn.disconnect();
});

test('an in-band server error is surfaced as its own event, not as a bare disconnect', () => {
  // "no open page for this session — call browser_open first" is the
  // actionable message; a plain "disconnected" hides it.
  const { conn, ws } = connect();
  let detail = null;
  conn.addEventListener('screencasterror', (e) => { detail = e.detail; });
  ws.onmessage({ data: JSON.stringify({ type: 'error', message: 'no open page for this session — call browser_open first' }) });
  expect(detail.message).toContain('browser_open');
});
