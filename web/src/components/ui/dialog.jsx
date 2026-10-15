import * as React from 'react';
import { Dialog as P } from 'radix-ui';
import { XIcon } from 'lucide-react';
import { cn } from '../../lib/utils.js';
import { part, styled } from './_styled.jsx';
import { Button } from './button.jsx';
import { useT } from '../../lib/i18n.js';

const Dialog = P.Root;
const DialogTrigger = part(P.Trigger, 'dialog-trigger');
const DialogPortal = P.Portal;
const DialogClose = part(P.Close, 'dialog-close');

const overlayClass =
  'fixed inset-0 z-50 bg-black/40 duration-150 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0';
const DialogOverlay = styled(P.Overlay, overlayClass, 'dialog-overlay');

// Centred, 12px radius, hairline + soft shadow. Esc / outside-click close via
// Radix; focus is trapped and restored. `showClose` adds the corner X.
const DialogContent = React.forwardRef(function DialogContent({ className, children, showClose = true, ...props }, ref) {
  const t = useT();
  return (
    <DialogPortal>
      <DialogOverlay />
      <P.Content
        ref={ref}
        data-slot="dialog-content"
        className={cn(
          'fixed start-1/2 top-1/2 z-50 grid max-h-[calc(100dvh-1.5rem)] w-[min(35rem,calc(100vw-1.5rem))] -translate-x-1/2 -translate-y-1/2 gap-4 overflow-y-auto rounded-xl bg-popover p-5 text-popover-foreground shadow-dialog outline-none duration-200 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 rtl:translate-x-1/2',
          className,
        )}
        {...props}
      >
        {children}
        {showClose && (
          <P.Close asChild>
            <Button variant="ghost" size="icon-sm" className="absolute end-3 top-3" aria-label={t('dialogs.dismiss')}>
              <XIcon />
            </Button>
          </P.Close>
        )}
      </P.Content>
    </DialogPortal>
  );
});

const DialogHeader = ({ className, ...props }) => <div data-slot="dialog-header" className={cn('flex flex-col gap-1.5 pe-8', className)} {...props} />;
const DialogFooter = ({ className, ...props }) => (
  <div data-slot="dialog-footer" className={cn('flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)} {...props} />
);
const DialogTitle = styled(P.Title, 'text-base font-semibold text-foreground', 'dialog-title');
const DialogDescription = styled(P.Description, 'text-sm text-muted-foreground', 'dialog-description');

export { Dialog, DialogTrigger, DialogPortal, DialogClose, DialogOverlay, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription, overlayClass };
