// Bare live view of the shared host desktop: noVNC's RFB class talking to the
// /__vnc bridge (server/vnc.ts), with a status overlay for the connecting/
// error/disconnected states. No modal chrome — this is the piece shared by
// the global sidebar modal (ScreenModal.jsx) and the chat-embedded card
// (ChatPane.jsx's ScreenRequestCard), which each wrap it differently.
import { useEffect, useRef, useState } from 'react';
import RFB from '@novnc/novnc';
import { useT } from '../lib/i18n.js';

function vncWsUrl() {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${window.location.host}/__vnc`;
}

export default function ScreenView({ className = '', onStatusChange }) {
  const t = useT();
  const canvasHostRef = useRef(null); // element noVNC renders its canvas into
  const [status, setStatus] = useState('connecting'); // connecting | connected | disconnected | error
  const [errorDetail, setErrorDetail] = useState('');

  useEffect(() => {
    const rfb = new RFB(canvasHostRef.current, vncWsUrl(), { wsProtocols: ['binary'] });
    rfb.scaleViewport = true;
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
    // The server wants real VNC-auth credentials — noVNC has no built-in
    // password prompt; this app doesn't have a screen-share password UI yet
    // either, so surface it clearly rather than hanging silently.
    rfb.addEventListener('credentialsrequired', () => {
      setStatus('error');
      setErrorDetail(t('rail.screenNeedsPassword'));
    });
    return () => {
      try { rfb.disconnect(); } catch {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
