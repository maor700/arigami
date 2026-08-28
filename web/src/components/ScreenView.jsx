// Bare live view of the shared host desktop: noVNC's RFB class talking to the
// /__vnc bridge (server/vnc.ts), with a status overlay for the connecting/
// error/disconnected states. No modal chrome — this is the piece shared by
// the global sidebar modal (ScreenModal.jsx) and the chat-embedded card
// (ChatPane.jsx's ScreenRequestCard), which each wrap it differently.
import { useEffect, useRef, useState } from 'react';
import RFB from '@novnc/novnc';
import { useT } from '../lib/i18n.js';
import { api } from '../lib/api.js';

function vncWsUrl() {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${window.location.host}/__vnc`;
}

// `viewOnly` — Watch mode: noVNC drops all keyboard/mouse input (the human
// can look but not touch). Toggled live (no reconnect) when the user clicks
// "Take over" on a request card.
export default function ScreenView({ className = '', viewOnly = false, onStatusChange }) {
  const t = useT();
  const canvasHostRef = useRef(null); // element noVNC renders its canvas into
  const [status, setStatus] = useState('connecting'); // connecting | connected | disconnected | error
  const [errorDetail, setErrorDetail] = useState('');

  const rfbRef = useRef(null);

  useEffect(() => {
    const rfb = new RFB(canvasHostRef.current, vncWsUrl(), { wsProtocols: ['binary'] });
    rfbRef.current = rfb;
    rfb.scaleViewport = true;
    rfb.viewOnly = viewOnly;
    rfb.addEventListener('connect', () => setStatus('connected'));
    rfb.addEventListener('disconnect', () => setStatus('disconnected'));
    // TightVNC (and most RFB servers) send a human-readable reason string on
    // security rejection (e.g. "loopback connections are not enabled",
    // "Server is not configured properly") — surface it verbatim instead of
    // leaving the canvas a silent black rectangle, which is impossible to
    // debug from the UI alone.
    rfb.addEventListener('securityfailure', (e) => {
      setStatus('error');
      setErrorDetail(e.detail?.reason || '');
    });
    // The server wants VNC-auth credentials — noVNC has no built-in password
    // prompt, so fetch the one configured in Settings → screen and hand it
    // over. If none is set, fail loudly rather than hanging silently.
    let cancelled = false;
    rfb.addEventListener('credentialsrequired', async () => {
      let password = '';
      try { password = (await api.get('/screen/credentials'))?.password || ''; } catch {}
      if (cancelled) return;
      if (password) {
        rfb.sendCredentials({ password });
      } else {
        setStatus('error');
        setErrorDetail(t('rail.screenNeedsPassword'));
      }
    });
    return () => {
      cancelled = true;
      rfbRef.current = null;
      try { rfb.disconnect(); } catch {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (rfbRef.current) rfbRef.current.viewOnly = viewOnly;
  }, [viewOnly]);

  useEffect(() => {
    onStatusChange?.(status, errorDetail);
  }, [status, errorDetail, onStatusChange]);

  const statusLabel = {
    connecting: t('rail.screenConnecting'),
    disconnected: t('rail.screenDisconnected'),
    error: t('rail.screenError'),
  }[status];

  return (
    <div className={`relative bg-black ${className}`}>
      <div ref={canvasHostRef} className="absolute inset-0" />
      {status !== 'connected' && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-6">
          <div className="max-w-[420px] rounded-[10px] border border-white/15 bg-black/70 px-4 py-3 text-center font-mono text-[12px] text-white/80">
            {statusLabel}
            {errorDetail && <div className="mt-1 text-[11px] text-white/60">{errorDetail}</div>}
          </div>
        </div>
      )}
    </div>
  );
}
