// ONE VNC connection per DESKTOP, shared by every place that shows it (chat
// request card, session side panel, enlarge modal). Opening the modal over
// the panel over the card would otherwise mean three RFB sessions to the same
// server — three times the bandwidth and, on servers that only allow one
// client, two black rectangles. T8 gave sessions their own desktops, so
// "per desktop" now means "per sessionId (or the global one when there's
// none)" — two sessions' machines never fight over a single RFB either.
//
// How it works: each desktop gets its own manager owning a single noVNC RFB
// bound to a detached "host" <div>. Consumers register a container element
// with a priority, scoped to a sessionId (or none, for the global desktop —
// the rail icon's plain view). The highest-priority *visible* consumer of a
// given desktop becomes its OWNER: the host div is reparented into its
// container (noVNC has a ResizeObserver on the host, so it rescales by
// itself) and the owner's viewOnly setting is applied — input only ever
// flows from the owner. Every other consumer of that SAME desktop gets a
// mirror: a plain <canvas> repainted from the RFB canvas at ~15fps. Hidden
// consumers (a tab kept mounted but display:none) have zero size, so they
// never win ownership. A desktop's connection tears down shortly after its
// last consumer leaves.
//
// TRANSPORT (windows-remote-parity): the connection above is RFB *when the
// host has a VNC desktop to bridge to* — i.e. the x11 driver, which is Linux.
// The desktop app on Windows or macOS runs the native-window driver
// (server/lib/screen-driver-native.ts): no Xvfb, no x11vnc, nothing listening
// on 5900. This file used to open /__vnc regardless, so on those hosts every
// screen view — the chat card, the side panel, and the take-over modal — was
// a black rectangle reading "disconnected", and a request_screen the agent
// raised could not be answered at all. The host now reports which transport it
// speaks (GET /screen/status → {driver, viewer}), and this picks accordingly:
// noVNC for `rfb`, ScreencastConnection for `screencast`. Both expose the same
// small surface (a canvas inside the host div, a settable `viewOnly`,
// `disconnect()`, connect/disconnect events), so everything below —
// ownership, mirroring, teardown, the `data-vnc-input` hotkey guard — is
// shared verbatim and neither transport has a special case in it.
import { useEffect, useRef, useState } from 'react';
import RFB from '@novnc/novnc';
import { api } from './api.js';
import { ScreencastConnection } from './screencastClient.js';

export const SCREEN_PRIORITY = { panel: 1, card: 2, modal: 3 };

function wsUrl(path) {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${window.location.host}${path}`;
}

function vncWsUrl(sessionId) {
  const q = sessionId ? `?session=${encodeURIComponent(sessionId)}` : '';
  return wsUrl(`/__vnc${q}`);
}

/**
 * Which transport this host speaks for this desktop. Cached per scope for the
 * lifetime of the tab: the driver is a property of the HOST process, so it
 * cannot change without a restart, and re-asking on every card/panel/modal
 * mount would put a round trip in front of every connection.
 */
const transports = new Map();
/** Exported for the unit test — this is the whole transport decision, and it has to degrade safely on an older host. */
export async function resolveTransport(scope, sessionId) {
  if (transports.has(scope)) return transports.get(scope);
  const p = (async () => {
    try {
      const q = sessionId ? `?session=${encodeURIComponent(sessionId)}` : '';
      const st = await api.get(`/screen/status${q}`);
      return st?.viewer?.transport === 'screencast'
        ? { transport: 'screencast', path: st.viewer.path, interactive: st.viewer.interactive !== false, scope: st.viewer.scope || 'browser' }
        : { transport: 'rfb', path: st?.viewer?.path || null, interactive: true, scope: st?.viewer?.scope || 'desktop' };
    } catch {
      // An unreachable/older host answers nothing useful — RFB is what every
      // host before this change spoke, so it is the safe default.
      return { transport: 'rfb', path: null, interactive: true, scope: 'desktop' };
    }
  })();
  transports.set(scope, p);
  return p;
}

/** Test hook: forget the cached probes (a tab has no other way to re-probe, by design — the driver cannot change without a host restart). */
export function resetScreenTransportCache() {
  transports.clear();
}

const TEARDOWN_GRACE_MS = 400; // survive unmount→remount churn (tab/session switch)
const MIRROR_FPS = 15;
const GLOBAL_SCOPE = ''; // no sessionId → the global :99/5900 desktop

// scope → connection state. Each entry mirrors what used to be module-level
// singletons before T8; see the file header for why it's now keyed.
const conns = new Map();

function scopeKey(sessionId) {
  return sessionId || GLOBAL_SCOPE;
}

function newConn() {
  return {
    rfb: null, // RFB (x11 hosts) or ScreencastConnection (native-window hosts)
    connecting: false, // a transport probe is in flight — don't start a second
    generation: 0, // bumped per connect attempt; a stale probe resolving is dropped
    transport: null, // 'rfb' | 'screencast', once known
    scope: null, // 'desktop' | 'browser' — how much of the machine this shows
    interactive: true, // whether input reaches the machine over this transport
    host: null, // the element the transport renders into; reparented to the owner
    status: 'idle', // idle | connecting | connected | disconnected | error
    errorDetail: '',
    errorKind: '', // 'needs-password' — the consumer translates
    consumers: [], // [{ id, el, priority, viewOnly, visible, mirror }]
    ownerId: null,
    nextId: 1,
    teardownTimer: null,
    mirrorTimer: null,
    ro: null, // ResizeObserver over consumer containers (visibility)
    subs: new Set(),
  };
}

function emit(c) {
  for (const fn of c.subs) fn();
}

function setStatus(c, s, detail = '', kind = '') {
  c.status = s;
  c.errorDetail = detail;
  c.errorKind = kind;
  emit(c);
}

function connect(c, sessionId) {
  if (c.rfb || c.connecting) return;
  c.connecting = true;
  setStatus(c, 'connecting');
  // The transport probe is one awaited round trip (cached per scope), so the
  // connection is built asynchronously from here. `assign()` is a no-op while
  // `c.rfb` is null and runs again below once it isn't, so ownership settles
  // the same way it always did — just one tick later on the very first mount.
  const gen = ++c.generation;
  void resolveTransport(scopeKey(sessionId), sessionId).then((t) => {
    // Everything left while we were probing (fast tab switch): the teardown
    // already ran, and connecting now would leak a socket nobody closes.
    if (c.generation !== gen || c.consumers.length === 0) { c.connecting = false; return; }
    // A screencast transport with no session has nothing to show: the "shared
    // machine" of the x11 world is the global :99 desktop, and a host running
    // the native-window driver simply has no such thing — a session's Chrome
    // window is the only surface there. Opening the socket anyway would get a
    // raw "requires ?session=" back from the bridge and show it as a
    // connection error, which reads like a fault rather than an absence.
    if (t.transport === 'screencast' && !sessionId) {
      c.connecting = false;
      c.transport = t.transport;
      c.scope = t.scope;
      c.interactive = false;
      setStatus(c, 'error', '', 'no-shared-machine');
      return;
    }
    c.host = document.createElement('div');
    c.host.style.cssText = 'position:absolute;inset:0;';
    c.transport = t.transport;
    c.scope = t.scope;
    c.interactive = t.interactive;
    const url = t.transport === 'screencast' ? wsUrl(t.path) : vncWsUrl(sessionId);
    // Cheap diagnostic (T8b): a tab that's been open since before a deploy
    // keeps running its old bundle indefinitely — no HTTP caching involved, so
    // no cache fix would touch it — which looks IDENTICAL from the outside to
    // an actual per-session-scope regression. This line makes the two instantly
    // distinguishable from the console without re-deriving the whole call chain.
    // The transport name is here for the same reason: "which one did this tab
    // pick" is the first question when a screen is black on a desktop-app host.
    console.info('[screen] connecting to', sessionId ? `session ${sessionId}` : 'the global desktop', url, `(${t.transport})`);
    const r = t.transport === 'screencast'
      ? new ScreencastConnection(c.host, url)
      : new RFB(c.host, url, { wsProtocols: ['binary'] });
    c.rfb = r;
    attachClipboard(c, sessionId, t.transport);
    c.connecting = false;
    r.scaleViewport = true;
    r.viewOnly = true;
    r.addEventListener('connect', () => { if (c.rfb === r) setStatus(c, 'connected'); });
    r.addEventListener('disconnect', () => { if (c.rfb === r) setStatus(c, 'disconnected'); });
    // The screencast bridge reports its own failures in-band (no Chrome tab
    // for this session, CDP unreachable) and then closes — without this the
    // close alone would show a bare "disconnected" and hide the actual reason,
    // which is usually the actionable one ("call browser_open first").
    r.addEventListener('screencasterror', (e) => { if (c.rfb === r) setStatus(c, 'error', e.detail?.message || ''); });
    // TightVNC & co. send a human-readable reason on security rejection —
    // surface it verbatim rather than leaving a silent black rectangle.
    r.addEventListener('securityfailure', (e) => { if (c.rfb === r) setStatus(c, 'error', e.detail?.reason || ''); });
    // VNC-auth: fetch the password configured in Settings → Screen share (one
    // password, shared by the global desktop and every per-session one).
    r.addEventListener('credentialsrequired', async () => {
      let password = '';
      try { password = (await api.get('/screen/credentials'))?.password || ''; } catch {}
      if (c.rfb !== r) return;
      if (password) r.sendCredentials({ password });
      else setStatus(c, 'error', '', 'needs-password');
    });
    assign(c);
  });
}

function disconnect(c) {
  const r = c.rfb;
  c.rfb = null;
  c.connecting = false;
  c.generation++; // a transport probe still in flight must not build a connection now
  try { r?.disconnect(); } catch {}
  c.host?.remove();
  c.host = null;
  c.ownerId = null;
  setStatus(c, 'idle');
}

// ---- copy / paste across machines ----------------------------------------------
//
// The owner's clipboard does not cross either transport on its own, so the
// viewer does it through the host (server/lib/desktop-clipboard.ts):
//
//   Cmd/Ctrl+V  read the local clipboard, insert the text at the remote cursor
//   Cmd/Ctrl+C  read what is selected in the remote page, put it on the local
//               clipboard (Cmd/Ctrl+X does the same, then cuts remotely)
//
// Caught in the CAPTURE phase on the host div: noVNC preventDefault()s every
// keydown it forwards, which would kill the browser's own paste event. On a
// Mac, Cmd+A / Cmd+Z are sent as Ctrl+A / Ctrl+Z — the remote is Linux, where
// Cmd reaches the page as a Super key nobody listens to. The screencast
// transport already inserts on a native paste event, so V is left to it there.

const XK = { Control_L: 0xffe3, a: 0x61, x: 0x78, z: 0x7a };

function sendCtrl(rfb, key, code) {
  if (typeof rfb.sendKey !== 'function') return;
  rfb.sendKey(XK.Control_L, 'ControlLeft', true);
  rfb.sendKey(XK[key], code, true);
  rfb.sendKey(XK[key], code, false);
  rfb.sendKey(XK.Control_L, 'ControlLeft', false);
}

// Loaded on first use, not at import: i18n pulls in prefs, which touches the DOM
// at module load — and this module is imported by DOM-less tests.
function reportError(key, err) {
  void Promise.all([import('./toast.js'), import('./i18n.js')]).then(([toast, i18n]) =>
    toast.toastError(i18n.t(key, { error: err?.message || err }))
  );
}

/** Put text on the local clipboard; the promise form keeps Safari's user-activation. */
function writeLocal(textPromise) {
  if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
    const blob = textPromise.then((txt) => new Blob([txt], { type: 'text/plain' }));
    return navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob })]);
  }
  return textPromise.then((txt) => navigator.clipboard.writeText(txt));
}

/**
 * What a keydown on the live screen means for the clipboard bridge. Pure, so
 * the mapping is testable without a VNC server:
 *   'copy' | 'cut' | 'paste' | 'ctrl-a' | 'ctrl-z' | null (not ours — pass it on)
 */
export function clipboardKey(e, transport) {
  const mod = e.metaKey || e.ctrlKey;
  if (!mod || e.altKey) return null;
  const k = String(e.key || '').toLowerCase();
  if (k === 'c') return 'copy';
  if (k === 'x') return 'cut';
  // screencast inserts on the browser's own paste event; only VNC needs us
  if (k === 'v') return transport === 'rfb' ? 'paste' : null;
  if (transport === 'rfb' && e.metaKey && !e.ctrlKey && (k === 'a' || k === 'z')) return k === 'a' ? 'ctrl-a' : 'ctrl-z';
  return null;
}

function attachClipboard(c, sessionId, transport) {
  const base = sessionId ? `/sessions/${encodeURIComponent(sessionId)}/desktop` : '/desktop';
  c.host.addEventListener(
    'keydown',
    (e) => {
      if (!c.rfb || c.rfb.viewOnly) return;
      const what = clipboardKey(e, transport);
      if (!what) return;
      if (what === 'copy' || what === 'cut') {
        e.preventDefault();
        e.stopImmediatePropagation();
        const text = api.post(`${base}/selection`, {}).then((r) => {
          if (!r?.ok) throw new Error(r?.error || 'nothing selected');
          return String(r.text || '');
        });
        writeLocal(text).catch((err) => reportError('screen.copyFailed', err));
        if (what === 'cut' && transport === 'rfb') text.then(() => sendCtrl(c.rfb, 'x', 'KeyX')).catch(() => {});
        return;
      }
      if (what === 'paste') {
        e.preventDefault();
        e.stopImmediatePropagation();
        const read = navigator.clipboard?.readText ? navigator.clipboard.readText() : Promise.reject(new Error('clipboard unavailable'));
        read
          .then((txt) => (txt ? api.post(`${base}/type`, { text: txt }) : null))
          .then((r) => {
            if (r && r.ok === false) throw new Error(r.error || 'paste failed');
          })
          .catch((err) => reportError('screen.pasteFailed', err));
        return;
      }
      // Mac Cmd shortcuts the Linux page understands only as Ctrl.
      e.preventDefault();
      e.stopImmediatePropagation();
      if (what === 'ctrl-a') sendCtrl(c.rfb, 'a', 'KeyA');
      else sendCtrl(c.rfb, 'z', 'KeyZ');
    },
    true
  );
}

function rfbCanvas(c) {
  return c.host?.querySelector('canvas') || null;
}

// Pick the owner and (re)parent the host div; refresh the viewOnly flag.
function assign(c) {
  if (!c.rfb) return;
  let best = null;
  for (const x of c.consumers) {
    if (!x.visible) continue;
    if (!best || x.priority > best.priority) best = x;
  }
  const nextOwner = best?.id ?? null;
  if (nextOwner !== c.ownerId) {
    c.ownerId = nextOwner;
    if (best) best.el.appendChild(c.host);
    else c.host.remove();
    emit(c);
  }
  // `interactive === false` means the TRANSPORT carries no input at all (a
  // screencast with no session behind it has no page to aim CDP at). Forcing
  // viewOnly there keeps the canvas from silently swallowing clicks that were
  // never going to arrive anywhere.
  c.rfb.viewOnly = c.interactive === false ? true : best ? !!best.viewOnly : true;
  // Flag the live canvas while it's actually accepting input, so app-wide
  // keyboard shortcuts (App.jsx, ChatPane.jsx) can tell "typing into the
  // remote machine" apart from "nothing focused" and back off instead of
  // hijacking the keystroke (e.g. "/" jumping to search mid-password).
  const canvas = rfbCanvas(c);
  if (canvas) {
    if (c.rfb.viewOnly) canvas.removeAttribute('data-vnc-input');
    else canvas.setAttribute('data-vnc-input', 'true');
  }
  scheduleMirrors(c);
}

// App-wide keydown handlers use this to exclude the live VNC canvas from
// their own hotkeys while it's the one receiving keyboard input.
export function isVncInputTarget(el) {
  return !!el && el.dataset?.vncInput === 'true';
}

// Mirrors: repaint every non-owner consumer's canvas from the RFB canvas.
function paintMirrors(c) {
  const src = rfbCanvas(c);
  if (!src || !src.width || !src.height) return;
  for (const x of c.consumers) {
    if (x.id === c.ownerId || !x.mirror || !x.visible) continue;
    const m = x.mirror;
    if (m.width !== src.width || m.height !== src.height) {
      m.width = src.width;
      m.height = src.height;
    }
    const ctx = m.getContext('2d');
    try { ctx.drawImage(src, 0, 0); } catch {}
  }
}

function scheduleMirrors(c) {
  const need = !!c.rfb && c.consumers.some((x) => x.id !== c.ownerId && x.mirror && x.visible);
  if (need && !c.mirrorTimer) c.mirrorTimer = setInterval(() => paintMirrors(c), 1000 / MIRROR_FPS);
  else if (!need && c.mirrorTimer) { clearInterval(c.mirrorTimer); c.mirrorTimer = null; }
}

function onResize(c, entries) {
  let changed = false;
  for (const entry of entries) {
    const x = c.consumers.find((y) => y.el === entry.target);
    if (!x) continue;
    const visible = entry.contentRect.width > 0 && entry.contentRect.height > 0;
    if (visible !== x.visible) { x.visible = visible; changed = true; }
  }
  if (changed) assign(c);
}

function register(scope, sessionId, el, priority, viewOnly, mirror) {
  let c = conns.get(scope);
  if (!c) { c = newConn(); conns.set(scope, c); }
  const x = {
    id: c.nextId++,
    el,
    priority,
    viewOnly,
    mirror,
    visible: el.clientWidth > 0 && el.clientHeight > 0,
  };
  c.consumers.push(x);
  if (!c.ro) c.ro = new ResizeObserver((entries) => onResize(c, entries));
  c.ro.observe(el);
  if (c.teardownTimer) { clearTimeout(c.teardownTimer); c.teardownTimer = null; }
  connect(c, sessionId);
  assign(c);
  return x;
}

function unregister(scope, x) {
  const c = conns.get(scope);
  if (!c) return;
  c.consumers = c.consumers.filter((y) => y !== x);
  c.ro?.unobserve(x.el);
  if (c.consumers.length === 0) {
    c.teardownTimer = setTimeout(() => {
      c.teardownTimer = null;
      if (c.consumers.length === 0) { disconnect(c); conns.delete(scope); }
    }, TEARDOWN_GRACE_MS);
  }
  assign(c);
}

function snapshot(c) {
  return c
    ? {
        status: c.status,
        errorDetail: c.errorDetail,
        errorKind: c.errorKind,
        ownerId: c.ownerId,
        transport: c.transport,
        // 'browser' tells the take-over UI to say what it is NOT showing (a
        // native dialog outside the Chrome window) instead of leaving the
        // human to discover it when a file picker never appears.
        viewScope: c.scope,
        interactive: c.interactive,
      }
    : { status: 'idle', errorDetail: '', errorKind: '', ownerId: null, transport: null, viewScope: null, interactive: true };
}

// Test/debug hook: how many live consumers share a desktop's (single)
// connection. `sessionId` omitted = the global desktop.
export function screenConnectionInfo(sessionId) {
  const c = conns.get(scopeKey(sessionId));
  return {
    connected: !!c?.rfb,
    consumers: c?.consumers.length || 0,
    ownerId: c?.ownerId ?? null,
    status: c?.status || 'idle',
    transport: c?.transport || null,
  };
}

/**
 * Attach this component's container to a desktop's shared connection.
 * @param {{ containerRef: React.RefObject<HTMLElement>, priority: number, viewOnly?: boolean, mirrorRef?: React.RefObject<HTMLCanvasElement>, sessionId?: string|null }} opts
 *   `sessionId` — that session's own desktop, or the global one (rail icon's
 *   plain view / a session with none allocated yet) when omitted/null.
 * @returns {{ status, errorDetail, errorKind, isOwner }}
 */
export function useScreenConnection({ containerRef, priority, viewOnly = true, mirrorRef, sessionId = null }) {
  const scope = scopeKey(sessionId);
  const [snap, setSnap] = useState(() => snapshot(conns.get(scope)));
  const consumerRef = useRef(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;
    const x = register(scope, sessionId, el, priority, viewOnly, mirrorRef?.current || null);
    consumerRef.current = x;
    const c = conns.get(scope);
    const fn = () => setSnap(snapshot(conns.get(scope)));
    c.subs.add(fn);
    fn();
    return () => {
      c.subs.delete(fn);
      consumerRef.current = null;
      unregister(scope, x);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, priority]);

  useEffect(() => {
    const x = consumerRef.current;
    if (x && x.viewOnly !== viewOnly) {
      x.viewOnly = viewOnly;
      assign(conns.get(scope));
    }
  }, [viewOnly, scope]);

  return { ...snap, isOwner: snap.ownerId != null && snap.ownerId === consumerRef.current?.id };
}
