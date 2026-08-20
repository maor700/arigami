// Global screen-share modal: a live, interactive view of the ONE shared host
// desktop (same view regardless of which session tab is open). Modeled on the
// Listeners modal shell (SessionView.jsx) for sizing/chrome, but adds a real
// Fullscreen API toggle — the canvas benefits from true fullscreen (and, in
// supporting browsers, pointer lock) in a way the CSS-only overlay used
// elsewhere (ChangesTab.jsx) isn't built for. The actual RFB connection lives
// in ScreenView.jsx, shared with the chat-embedded request card.
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import ScreenView from './ScreenView.jsx';
import { useT } from '../lib/i18n.js';
import { Icon } from '../lib/icons.js';
import { faXmark, faExpand, faCompress, faDisplay } from '@fortawesome/free-solid-svg-icons';

export default function ScreenModal({ onClose }) {
  const t = useT();
  const shellRef = useRef(null); // modal panel — target of the Fullscreen API
  const [status, setStatus] = useState('connecting');
  const [fullscreen, setFullscreen] = useState(false);
  const onStatusChange = useCallback((s) => setStatus(s), []);

  useEffect(() => {
    const onFsChange = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  useEffect(() => {
    // Esc closes the modal — but while fullscreen, the browser's own Esc
    // handling exits fullscreen first; only close on a second Esc after that.
    const onKey = (e) => { if (e.key === 'Escape' && !document.fullscreenElement) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else shellRef.current?.requestFullscreen().catch(() => {});
  };

  const statusLabel = {
    connecting: t('rail.screenConnecting'),
    disconnected: t('rail.screenDisconnected'),
    error: t('rail.screenError'),
  }[status];

  // Portaled to <body>: mounted from Rail.jsx, whose transform/overflow makes
  // a containing block for position:fixed descendants — without this, the
  // modal is clipped to the rail's own box instead of covering the viewport.
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-3 md:p-6" onMouseDown={onClose}>
      <div
        ref={shellRef}
        className="flex h-[86vh] w-[1100px] max-w-full flex-col overflow-hidden rounded-[12px] border-[1.5px] border-ink bg-panel shadow-[4px_4px_0_rgba(0,0,0,0.25)]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 border-b border-hair px-4 py-3">
          <span className="text-[13px] leading-none"><Icon icon={faDisplay} /></span>
          <span className="font-mono text-[13px] font-bold text-fg">{t('rail.screen')}</span>
          {statusLabel && status !== 'connected' && <span className="font-mono text-[10.5px] text-fgdim">{statusLabel}</span>}
          <button
            type="button"
            onClick={toggleFullscreen}
            title={fullscreen ? t('chat.exitFullscreen') : t('chat.fullscreen')}
            aria-label={fullscreen ? t('chat.exitFullscreen') : t('chat.fullscreen')}
            className="ms-auto flex h-7 w-7 cursor-pointer items-center justify-center rounded-md border border-hair text-fgdim hover:border-ink hover:text-fg"
          >
            <Icon icon={fullscreen ? faCompress : faExpand} />
          </button>
          <button
            type="button"
            onClick={onClose}
            title={t('dialogs.close')}
            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md border border-hair text-fgdim hover:border-ink hover:text-fg"
          >
            <Icon icon={faXmark} />
          </button>
        </div>
        <ScreenView className="min-h-0 flex-1" onStatusChange={onStatusChange} />
      </div>
    </div>,
    document.body
  );
}
