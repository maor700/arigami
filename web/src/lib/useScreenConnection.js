// ONE VNC connection for the whole app, shared by every place that shows the
// desktop (chat request card, session side panel, enlarge modal). Opening the
// modal over the panel over the card would otherwise mean three RFB sessions
// to the same server — three times the bandwidth and, on servers that only
// allow one client, two black rectangles.
//
// How it works: the manager owns a single noVNC RFB bound to a detached
// "host" <div>. Consumers register a container element with a priority. The
// highest-priority *visible* consumer becomes the OWNER: the host div is
// reparented into its container (noVNC has a ResizeObserver on the host, so
// it rescales by itself) and the owner's viewOnly setting is applied — input
// only ever flows from the owner. Every other consumer gets a mirror: a plain
// <canvas> repainted from the RFB canvas at ~15fps. Hidden consumers (a tab
// kept mounted but display:none) have zero size, so they never win ownership.
// The connection tears down shortly after the last consumer leaves.
import { useEffect, useRef, useState } from 'react';
import RFB from '@novnc/novnc';
import { api } from './api.js';

export const SCREEN_PRIORITY = { panel: 1, card: 2, modal: 3 };

function vncWsUrl() {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${window.location.host}/__vnc`;
}

const TEARDOWN_GRACE_MS = 400; // survive unmount→remount churn (tab/session switch)
const MIRROR_FPS = 15;

let rfb = null;
let host = null; // the element RFB renders into; reparented to the owner
let status = 'idle'; // idle | connecting | connected | disconnected | error
let errorDetail = '';
let errorKind = ''; // 'needs-password' — the consumer translates
let consumers = []; // [{ id, el, priority, viewOnly, visible, mirror }]
let ownerId = null;
let nextId = 1;
let teardownTimer = null;
let mirrorTimer = null;
let ro = null; // ResizeObserver over consumer containers (visibility)
const subs = new Set();

function emit() {
  for (const fn of subs) fn();
}

function setStatus(s, detail = '', kind = '') {
  status = s;
  errorDetail = detail;
  errorKind = kind;
  emit();
}

function connect() {
  if (rfb) return;
  host = document.createElement('div');
  host.style.cssText = 'position:absolute;inset:0;';
  const r = new RFB(host, vncWsUrl(), { wsProtocols: ['binary'] });
  rfb = r;
  r.scaleViewport = true;
  r.viewOnly = true;
  setStatus('connecting');
  r.addEventListener('connect', () => { if (rfb === r) setStatus('connected'); });
  r.addEventListener('disconnect', () => { if (rfb === r) setStatus('disconnected'); });
  // TightVNC & co. send a human-readable reason on security rejection —
  // surface it verbatim rather than leaving a silent black rectangle.
  r.addEventListener('securityfailure', (e) => { if (rfb === r) setStatus('error', e.detail?.reason || ''); });
  // VNC-auth: fetch the password configured in Settings → Screen share.
  r.addEventListener('credentialsrequired', async () => {
    let password = '';
    try { password = (await api.get('/screen/credentials'))?.password || ''; } catch {}
    if (rfb !== r) return;
    if (password) r.sendCredentials({ password });
    else setStatus('error', '', 'needs-password');
  });
  assign();
}

function disconnect() {
  const r = rfb;
  rfb = null;
  try { r?.disconnect(); } catch {}
  host?.remove();
  host = null;
  ownerId = null;
  setStatus('idle');
}

function rfbCanvas() {
  return host?.querySelector('canvas') || null;
}

// Pick the owner and (re)parent the host div; refresh the viewOnly flag.
function assign() {
  if (!rfb) return;
  let best = null;
  for (const c of consumers) {
    if (!c.visible) continue;
    if (!best || c.priority > best.priority) best = c;
  }
  const nextOwner = best?.id ?? null;
  if (nextOwner !== ownerId) {
    ownerId = nextOwner;
    if (best) best.el.appendChild(host);
    else host.remove();
    emit();
  }
  rfb.viewOnly = best ? !!best.viewOnly : true;
  scheduleMirrors();
}

// Mirrors: repaint every non-owner consumer's canvas from the RFB canvas.
function paintMirrors() {
  const src = rfbCanvas();
  if (!src || !src.width || !src.height) return;
  for (const c of consumers) {
    if (c.id === ownerId || !c.mirror || !c.visible) continue;
    const m = c.mirror;
    if (m.width !== src.width || m.height !== src.height) {
      m.width = src.width;
      m.height = src.height;
    }
    const ctx = m.getContext('2d');
    try { ctx.drawImage(src, 0, 0); } catch {}
  }
}

function scheduleMirrors() {
  const need = !!rfb && consumers.some((c) => c.id !== ownerId && c.mirror && c.visible);
  if (need && !mirrorTimer) mirrorTimer = setInterval(paintMirrors, 1000 / MIRROR_FPS);
  else if (!need && mirrorTimer) { clearInterval(mirrorTimer); mirrorTimer = null; }
}

function onResize(entries) {
  let changed = false;
  for (const entry of entries) {
    const c = consumers.find((x) => x.el === entry.target);
    if (!c) continue;
    const visible = entry.contentRect.width > 0 && entry.contentRect.height > 0;
    if (visible !== c.visible) { c.visible = visible; changed = true; }
  }
  if (changed) assign();
}

function register(el, priority, viewOnly, mirror) {
  const c = {
    id: nextId++,
    el,
    priority,
    viewOnly,
    mirror,
    visible: el.clientWidth > 0 && el.clientHeight > 0,
  };
  consumers.push(c);
  if (!ro) ro = new ResizeObserver(onResize);
  ro.observe(el);
  if (teardownTimer) { clearTimeout(teardownTimer); teardownTimer = null; }
  connect();
  assign();
  return c;
}

function unregister(c) {
  consumers = consumers.filter((x) => x !== c);
  ro?.unobserve(c.el);
  if (consumers.length === 0) {
    teardownTimer = setTimeout(() => {
      teardownTimer = null;
      if (consumers.length === 0) disconnect();
    }, TEARDOWN_GRACE_MS);
  }
  assign();
}

function snapshot() {
  return { status, errorDetail, errorKind, ownerId };
}

// Test/debug hook: how many live consumers share the (single) connection.
export function screenConnectionInfo() {
  return { connected: !!rfb, consumers: consumers.length, ownerId, status };
}

/**
 * Attach this component's container to the shared desktop connection.
 * @param {{ containerRef: React.RefObject<HTMLElement>, priority: number, viewOnly?: boolean, mirrorRef?: React.RefObject<HTMLCanvasElement> }} opts
 * @returns {{ status, errorDetail, errorKind, isOwner }}
 */
export function useScreenConnection({ containerRef, priority, viewOnly = true, mirrorRef }) {
  const [snap, setSnap] = useState(snapshot);
  const consumerRef = useRef(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;
    const c = register(el, priority, viewOnly, mirrorRef?.current || null);
    consumerRef.current = c;
    const fn = () => setSnap(snapshot());
    subs.add(fn);
    fn();
    return () => {
      subs.delete(fn);
      consumerRef.current = null;
      unregister(c);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [priority]);

  useEffect(() => {
    const c = consumerRef.current;
    if (c && c.viewOnly !== viewOnly) {
      c.viewOnly = viewOnly;
      assign();
    }
  }, [viewOnly]);

  return { ...snap, isOwner: snap.ownerId != null && snap.ownerId === consumerRef.current?.id };
}
