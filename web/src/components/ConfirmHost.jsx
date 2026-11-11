import { useConfirm, resolveConfirm } from '../lib/confirm.js';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
} from './ui/alert-dialog.jsx';

// Renders the pending confirmDialog() request (if any). Enter confirms (the
// confirm button is auto-focused so it is a one-key flow), Esc cancels — both
// handled by the Radix AlertDialog (focus trap + restore included).
export default function ConfirmHost() {
  const req = useConfirm();
  if (!req) return null;
  return (
    <AlertDialog open onOpenChange={(open) => !open && resolveConfirm(false)}>
      <AlertDialogContent
        className="z-[86]"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          e.currentTarget.querySelector('[data-confirm]')?.focus();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') {
            e.preventDefault();
            resolveConfirm(true);
          }
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{req.title}</AlertDialogTitle>
          {req.body ? <AlertDialogDescription>{req.body}</AlertDialogDescription> : null}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => resolveConfirm(false)}>{req.cancelLabel}</AlertDialogCancel>
          <AlertDialogAction data-confirm variant={req.danger ? 'destructive' : 'primary'} onClick={() => resolveConfirm(true)}>
            {req.confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
