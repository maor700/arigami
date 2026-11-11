import { XIcon } from 'lucide-react';
import { useToasts, dismissToast } from '../../lib/toast.js';
import { useT } from '../../lib/i18n.js';
import { cn } from '../../lib/utils.js';
import { Button } from './button.jsx';
import { StatusDot } from './badge.jsx';

// The toast stack, driven by lib/toast.js (the app's existing store: toast(),
// toastError(), toastSuccess(), copyWithToast() keep working unchanged — no
// second toast system). Same behaviour as before: bottom-left so it clears the
// voice HUD, aria-live, auto-dismiss in the store, manual dismiss, optional
// action. Look: hairline card, soft shadow, tiny status dot, no coloured chrome.
const DOT = { info: 'idle', success: 'ok', error: 'err' };

export function ToastView({ toast, dismissLabel, onDismiss = dismissToast, className }) {
  return (
    <div
      role="status"
      data-slot="toast"
      data-kind={toast.kind}
      className={cn('flex items-start gap-2.5 rounded-lg bg-popover py-2.5 ps-3 pe-2 text-popover-foreground shadow-pop animate-in fade-in-0 slide-in-from-bottom-2 duration-200', className)}
    >
      <StatusDot status={DOT[toast.kind] || 'idle'} className="mt-1.5" />
      <span className="min-w-0 flex-1 py-px text-sm leading-snug break-words">{toast.message}</span>
      {toast.action && (
        <Button
          variant="link"
          size="sm"
          className="shrink-0 py-0.5 text-xs font-semibold"
          onClick={() => {
            try {
              toast.action.onClick?.();
            } finally {
              onDismiss(toast.id);
            }
          }}
        >
          {toast.action.label}
        </Button>
      )}
      <Button variant="ghost" size="icon-xs" className="shrink-0" aria-label={dismissLabel} title={dismissLabel} onClick={() => onDismiss(toast.id)}>
        <XIcon />
      </Button>
    </div>
  );
}

export function Toaster() {
  const t = useT();
  const toasts = useToasts();
  if (!toasts.length) return null;
  const dismissLabel = t('dialogs.dismiss');
  return (
    <div className="fixed bottom-4 left-4 z-[80] flex w-[22rem] max-w-[calc(100vw-2rem)] flex-col gap-2" aria-live="polite" aria-atomic="false">
      {toasts.map((x) => (
        <ToastView key={x.id} toast={x} dismissLabel={dismissLabel} />
      ))}
    </div>
  );
}
