import { useToasts, dismissToast } from '../lib/toast.js';
import { useT } from '../lib/i18n.js';
import { Icon } from '../lib/icons.js';
import { faXmark } from '@fortawesome/free-solid-svg-icons';

// Bottom-left, non-blocking toast stack. Sits above the voice HUD's corner by
// living on the left; auto-dismisses (see toast.js) but each is manually
// dismissable too. aria-live so screen readers announce them.
const KIND = {
  info: 'border-ink bg-panel text-fg',
  success: 'border-[#3C9A4E] bg-panel text-fg',
  error: 'border-danger bg-panel text-fg',
};
const DOT = {
  info: 'bg-fgdim',
  success: 'bg-[#3C9A4E]',
  error: 'bg-danger',
};

export default function Toaster() {
  const tr = useT();
  const toasts = useToasts();
  if (!toasts.length) return null;
  const dismissLabel = tr('dialogs.dismiss');
  return (
    <div
      className="fixed bottom-4 left-4 z-[80] flex w-[320px] max-w-[92vw] flex-col gap-2"
      aria-live="polite"
      aria-atomic="false"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          role="status"
          className={`flex items-start gap-2.5 rounded-[10px] border-2 px-3 py-2.5 shadow-[3px_3px_0_rgba(42,42,42,0.2)] ${KIND[t.kind] || KIND.info}`}
        >
          <span className={`mt-[5px] h-2 w-2 shrink-0 rounded-full ${DOT[t.kind] || DOT.info}`} />
          <span className="min-w-0 flex-1 text-[12px] leading-snug break-words">{t.message}</span>
          {t.action && (
            <button
              type="button"
              onClick={() => {
                try {
                  t.action.onClick?.();
                } finally {
                  dismissToast(t.id);
                }
              }}
              className="shrink-0 text-[11px] font-bold text-brand underline-offset-2 hover:underline"
            >
              {t.action.label}
            </button>
          )}
          <button
            type="button"
            aria-label={dismissLabel}
            title={dismissLabel}
            onClick={() => dismissToast(t.id)}
            className="shrink-0 text-[13px] leading-none text-fgdim hover:text-fg"
          >
            <Icon icon={faXmark} />
          </button>
        </div>
      ))}
    </div>
  );
}
