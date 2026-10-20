// Bare live view of the shared host desktop, with a status overlay for the
// connecting/error/disconnected states. No modal chrome — this is the piece
// shared by the global/enlarge modal (ScreenModal.jsx), the chat-embedded
// request card (ChatPane.jsx's ScreenRequestCard) and the session side panel
// (ScreenSidePanel.jsx). All instances share ONE RFB connection through
// useScreenConnection: the highest-priority visible instance hosts the real
// noVNC canvas (and is the only one whose input reaches the machine); the
// others paint a live mirror of it.
import { useEffect, useRef, useState } from 'react';
import { useT } from '../lib/i18n.js';
import { useScreenConnection, SCREEN_PRIORITY } from '../lib/useScreenConnection.js';

// A connected desktop with nothing on it (a fresh Xvfb, no window open yet)
// is a solid black frame — indistinguishable from a broken view. Sample the
// frame now and then and, while it is uniformly dark, say so in words.
const BLANK_SAMPLE_W = 32;
const BLANK_SAMPLE_H = 20;
const BLANK_CHECK_MS = 1000;

/**
 * Whether an RGBA pixel buffer is an "idle desktop" frame: every pixel dark
 * and (near) the same colour. Pure, so it is testable without a canvas.
 * An empty buffer (no frame yet) counts as blank.
 */
export function isBlankFrame(data, { maxLuma = 24, maxSpread = 6 } = {}) {
  if (!data || data.length < 4) return true;
  let lo = 255;
  let hi = 0;
  for (let i = 0; i + 3 < data.length; i += 4) {
    const y = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
    if (y > maxLuma) return false;
    if (y < lo) lo = y;
    if (y > hi) hi = y;
    if (hi - lo > maxSpread) return false;
  }
  return true;
}

function frameIsBlank(src, probe) {
  if (!src || !src.width || !src.height) return true;
  probe.width = BLANK_SAMPLE_W;
  probe.height = BLANK_SAMPLE_H;
  const ctx = probe.getContext('2d', { willReadFrequently: true });
  if (!ctx) return false;
  try {
    ctx.drawImage(src, 0, 0, BLANK_SAMPLE_W, BLANK_SAMPLE_H);
    return isBlankFrame(ctx.getImageData(0, 0, BLANK_SAMPLE_W, BLANK_SAMPLE_H).data);
  } catch {
    return false; // unreadable frame — never claim "idle" on a guess
  }
}

// `viewOnly` — Watch: noVNC drops all keyboard/mouse input (the human can
// look but not touch). The card and the side panel always pass it; only the
// modal is interactive. `priority` — which instance hosts the real canvas
// when several are visible (modal > card > panel). `sessionId` — that
// session's own desktop (T8); omitted = the global one (rail icon's plain
// view).
export default function ScreenView({
  className = '',
  viewOnly = false,
  priority = SCREEN_PRIORITY.card,
  sessionId = null,
  onStatusChange,
}) {
  const t = useT();
  const containerRef = useRef(null); // the owner's host div gets parented here
  const mirrorRef = useRef(null); // non-owner: painted from the shared canvas
  const { status, errorDetail, errorKind, isOwner, viewScope } = useScreenConnection({
    containerRef,
    mirrorRef,
    priority,
    viewOnly,
    sessionId,
  });

  const detail =
    errorKind === 'needs-password' ? t('rail.screenNeedsPassword')
    : errorKind === 'no-shared-machine' ? t('rail.screenNoSharedMachine')
    : errorDetail;
  useEffect(() => {
    onStatusChange?.(status, detail);
  }, [status, detail, onStatusChange]);

  // `blank` — connected, but the frame is uniformly dark (see isBlankFrame).
  const [blank, setBlank] = useState(false);
  useEffect(() => {
    if (status !== 'connected') { setBlank(false); return undefined; }
    const probe = document.createElement('canvas');
    const check = () => {
      const src = isOwner ? containerRef.current?.querySelector('canvas') : mirrorRef.current;
      setBlank(frameIsBlank(src, probe));
    };
    check();
    const id = setInterval(check, BLANK_CHECK_MS);
    return () => clearInterval(id);
  }, [status, isOwner]);

  const statusLabel = {
    // 'idle' is the instant before the first connect attempt — still "connecting" to a human
    idle: t('rail.screenConnecting'),
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
      {/* On a host with no desktop server the view IS the browser window —
          badge it, in the interactive view only (the card and the panel are
          small enough that a chip over them is noise). */}
      {status === 'connected' && viewScope === 'browser' && !viewOnly && (
        <div
          title={t('rail.screenBrowserScopeHint')}
          className="pointer-events-none absolute end-2 top-2 rounded-sm border border-white/20 bg-black/60 px-1.5 py-0.5 text-2xs font-medium text-white/70"
        >
          {t('rail.screenBrowserScope')}
        </div>
      )}
      {status !== 'connected' && (
        <div data-screen-overlay={status} className="pointer-events-none absolute inset-0 flex items-center justify-center p-6">
          <div className="max-w-[420px] rounded-lg border border-white/15 bg-black/70 px-4 py-3 text-center text-sm text-white/80">
            {(status === 'idle' || status === 'connecting') && (
              <span aria-hidden="true" className="me-2 inline-block size-2 animate-pulse rounded-full bg-white/60 align-middle" />
            )}
            {statusLabel}
            {detail && <div className="mt-1 text-xs text-white/60">{detail}</div>}
          </div>
        </div>
      )}
      {/* Connected to an empty desktop: say it is idle rather than leave a
          black box that reads as broken. Click-through, so a human in
          control can still click the empty desktop. */}
      {status === 'connected' && blank && (
        <div data-screen-overlay="idle-desktop" className="pointer-events-none absolute inset-0 flex items-center justify-center p-4">
          <div className="max-w-[420px] rounded-lg border border-white/15 bg-black/70 px-4 py-3 text-center text-sm text-white/80">
            {t('rail.screenIdle')}
            <div className="mt-1 text-xs text-white/60">{t('rail.screenIdleDetail')}</div>
          </div>
        </div>
      )}
    </div>
  );
}
