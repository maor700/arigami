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
import { useEffect, useRef, useState } from 'react';
import RFB from '@novnc/novnc';
import { api } from './api.js';

export const SCREEN_PRIORITY = { panel: 1, card: 2, modal: 3 };

function vncWsUrl(sessionId) {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const q = sessionId ? `?session=${encodeURIComponent(sessionId)}` : '';
  return `${proto}://${window.location.host}/__vnc${q}`;
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
    rfb: null,
    host: null, // the element RFB renders into; reparented to the owner
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
  if (c.rfb) return;
  c.host = document.createElement('div');
  c.host.style.cssText = 'position:absolute;inset:0;';
  const url = vncWsUrl(sessionId);
  // Cheap diagnostic (T8b): a tab that's been open since before a deploy
  // keeps running its old bundle indefinitely — no HTTP caching involved, so
  // no cache fix would touch it — which looks IDENTICAL from the outside to
  // an actual per-session-scope regression. This line makes the two instantly
  // distinguishable from the console without re-deriving the whole call chain.
  console.info('[screen] connecting to', sessionId ? `session ${sessionId}` : 'the global desktop', url);
  const r = new RFB(c.host, url, { wsProtocols: ['binary'] });
  c.rfb = r;
  r.scaleViewport = true;
  r.viewOnly = true;
  setStatus(c, 'connecting');
  r.addEventListener('connect', () => { if (c.rfb === r) setStatus(c, 'connected'); });
  r.addEventListener('disconnect', () => { if (c.rfb === r) setStatus(c, 'disconnected'); });
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
}

function disconnect(c) {
  const r = c.rfb;
  c.rfb = null;
  try { r?.disconnect(); } catch {}
  c.host?.remove();
  c.host = null;
  c.ownerId = null;
  setStatus(c, 'idle');
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
  c.rfb.viewOnly = best ? !!best.viewOnly : true;
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
    ? { status: c.status, errorDetail: c.errorDetail, errorKind: c.errorKind, ownerId: c.ownerId }
    : { status: 'idle', errorDetail: '', errorKind: '', ownerId: null };
}

// Test/debug hook: how many live consumers share a desktop's (single)
// connection. `sessionId` omitted = the global desktop.
export function screenConnectionInfo(sessionId) {
  const c = conns.get(scopeKey(sessionId));
  return { connected: !!c?.rfb, consumers: c?.consumers.length || 0, ownerId: c?.ownerId ?? null, status: c?.status || 'idle' };
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
