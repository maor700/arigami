// Bare live view of the shared host desktop, with a status overlay for the
// connecting/error/disconnected states. No modal chrome — this is the piece
// shared by the global/enlarge modal (ScreenModal.jsx), the chat-embedded
// request card (ChatPane.jsx's ScreenRequestCard) and the session side panel
// (ScreenSidePanel.jsx). All instances share ONE RFB connection through
// useScreenConnection: the highest-priority visible instance hosts the real
// noVNC canvas (and is the only one whose input reaches the machine); the
// others paint a live mirror of it.
import { useEffect, useRef } from 'react';
import { useT } from '../lib/i18n.js';
import { useScreenConnection, SCREEN_PRIORITY } from '../lib/useScreenConnection.js';

// `viewOnly` — Watch: noVNC drops all keyboard/mouse input (the human can
// look but not touch). The card and the side panel always pass it; only the
// modal is interactive. `priority` — which instance hosts the real canvas
// when several are visible (modal > card > panel).
export default function ScreenView({
  className = '',
  viewOnly = false,
  priority = SCREEN_PRIORITY.card,
  onStatusChange,
}) {
  const t = useT();
  const containerRef = useRef(null); // the owner's host div gets parented here
  const mirrorRef = useRef(null); // non-owner: painted from the shared canvas
  const { status, errorDetail, errorKind, isOwner } = useScreenConnection({
    containerRef,
    mirrorRef,
    priority,
    viewOnly,
  });

  const detail = errorKind === 'needs-password' ? t('rail.screenNeedsPassword') : errorDetail;
  useEffect(() => {
    onStatusChange?.(status, detail);
  }, [status, detail, onStatusChange]);

  const statusLabel = {
    connecting: t('rail.screenConnecting'),
    disconnected: t('rail.screenDisconnected'),
    error: t('rail.screenError'),
  }[status];

  return (
    <div className={`relative overflow-hidden bg-black ${className}`}>
      <div ref={containerRef} className="absolute inset-0" />
      {/* scale-to-fit mirror; hidden (but kept mounted) while we own the canvas */}
      <div className={`absolute inset-0 flex items-center justify-center ${isOwner ? 'hidden' : ''}`}>
        <canvas ref={mirrorRef} className="max-h-full max-w-full" />
      </div>
      {status !== 'connected' && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-6">
          <div className="max-w-[420px] rounded-[10px] border border-white/15 bg-black/70 px-4 py-3 text-center font-mono text-[12px] text-white/80">
            {statusLabel}
            {detail && <div className="mt-1 text-[11px] text-white/60">{detail}</div>}
          </div>
        </div>
      )}
    </div>
  );
}
