import { useEffect, useRef } from 'react';
import { useConfirm, resolveConfirm } from '../lib/confirm.js';

// Renders the pending confirmDialog() request (if any). Enter confirms, Esc
// cancels; the confirm button is auto-focused so it's a one-key flow.
export default function ConfirmHost() {
  const req = useConfirm();
  const confirmRef = useRef(null);

  useEffect(() => {
    if (!req) return;
    confirmRef.current?.focus();
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        resolveConfirm(false);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        resolveConfirm(true);
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [req]);

  if (!req) return null;
  return (
    <div
      className="fixed inset-0 z-[85] flex items-center justify-center bg-[rgba(20,20,22,0.5)] p-5"
      onClick={() => resolveConfirm(false)}
      role="dialog"
      aria-modal="true"
      aria-label={req.title}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[400px] max-w-full overflow-hidden rounded-xl border-2 border-ink bg-panel text-fg shadow-[5px_6px_0_rgba(42,42,42,0.25)]"
      >
        <div className="px-[18px] pt-4 pb-1 text-[14px] font-bold">{req.title}</div>
        {req.body && (
          <div className="px-[18px] pb-3 text-[12px] leading-relaxed text-fgdim">{req.body}</div>
        )}
        <div className="flex justify-end gap-2 border-t border-hair px-[18px] py-3">
          <button
            type="button"
            onClick={() => resolveConfirm(false)}
            className="cursor-pointer rounded-lg border-[1.5px] border-border bg-panel px-3.5 py-1.5 text-[12.5px] text-fgdim hover:bg-hair"
          >
            {req.cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={() => resolveConfirm(true)}
            className={`cursor-pointer rounded-lg border-2 border-ink px-3.5 py-1.5 text-[12.5px] font-bold shadow-[2px_2px_0_#2a2a2a] transition-transform active:translate-x-[1px] active:translate-y-[1px] active:shadow-[1px_1px_0_#2a2a2a] ${
              req.danger ? 'bg-danger text-white' : 'bg-brand text-[#1a1a1a]'
            }`}
          >
            {req.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
