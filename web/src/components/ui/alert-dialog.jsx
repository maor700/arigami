import * as React from 'react';
import { AlertDialog as P } from 'radix-ui';
import { cn } from '../../lib/utils.js';
import { part, styled } from './_styled.jsx';
import { Button } from './button.jsx';
import { overlayClass, DialogHeader, DialogFooter } from './dialog.jsx';

// A dialog that must be answered (no outside-click dismissal): confirmations,
// destructive actions. Cancel is focused first (Radix default) — pass
// `autoFocus` to the action to flip that for a one-key confirm flow.
const AlertDialog = P.Root;
const AlertDialogTrigger = part(P.Trigger, 'alert-dialog-trigger');
const AlertDialogPortal = P.Portal;
const AlertDialogOverlay = styled(P.Overlay, overlayClass, 'alert-dialog-overlay');

const AlertDialogContent = React.forwardRef(function AlertDialogContent({ className, ...props }, ref) {
  return (
    <AlertDialogPortal>
      <AlertDialogOverlay />
      <P.Content
        ref={ref}
        data-slot="alert-dialog-content"
        className={cn(
          'fixed start-1/2 top-1/2 z-50 grid w-[min(25rem,calc(100vw-1.5rem))] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl bg-popover p-5 text-popover-foreground shadow-dialog outline-none duration-200 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 rtl:translate-x-1/2',
          className,
        )}
        {...props}
      />
    </AlertDialogPortal>
  );
});

const AlertDialogTitle = styled(P.Title, 'text-base font-semibold text-foreground', 'alert-dialog-title');
const AlertDialogDescription = styled(P.Description, 'text-sm text-muted-foreground', 'alert-dialog-description');

const AlertDialogAction = React.forwardRef(function AlertDialogAction({ variant = 'primary', ...props }, ref) {
  return (
    <P.Action asChild>
      <Button ref={ref} variant={variant} {...props} />
    </P.Action>
  );
});
const AlertDialogCancel = React.forwardRef(function AlertDialogCancel({ variant = 'default', ...props }, ref) {
  return (
    <P.Cancel asChild>
      <Button ref={ref} variant={variant} {...props} />
    </P.Cancel>
  );
});

export {
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogPortal,
  AlertDialogOverlay,
  AlertDialogContent,
  DialogHeader as AlertDialogHeader,
  DialogFooter as AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
};
