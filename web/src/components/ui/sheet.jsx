import * as React from 'react';
import { Dialog as P } from 'radix-ui';
import { XIcon } from 'lucide-react';
import { cva } from 'class-variance-authority';
import { cn } from '../../lib/utils.js';
import { part, styled } from './_styled.jsx';
import { Button } from './button.jsx';
import { overlayClass } from './dialog.jsx';
import { useT } from '../../lib/i18n.js';

// Edge-anchored panel. `bottom` is the phone bottom sheet (rounded top, grab
// handle, max 85dvh, safe-area padding); `start`/`end` are LOGICAL sides (the
// start side is the right edge under RTL), so a drawer slides in from where
// the reader's text begins.
const Sheet = P.Root;
const SheetTrigger = part(P.Trigger, 'sheet-trigger');
const SheetClose = part(P.Close, 'sheet-close');
const SheetPortal = P.Portal;
const SheetOverlay = styled(P.Overlay, overlayClass, 'sheet-overlay');

const sheetVariants = cva(
  'fixed z-50 flex flex-col gap-3 bg-popover text-popover-foreground shadow-dialog outline-none duration-200 data-open:animate-in data-closed:animate-out',
  {
    variants: {
      side: {
        bottom:
          'inset-x-0 bottom-0 max-h-[85dvh] rounded-t-xl border-t border-border pb-[max(1rem,env(safe-area-inset-bottom))] data-open:slide-in-from-bottom data-closed:slide-out-to-bottom',
        top: 'inset-x-0 top-0 max-h-[85dvh] rounded-b-xl border-b border-border data-open:slide-in-from-top data-closed:slide-out-to-top',
        start:
          'inset-y-0 start-0 h-full w-[min(22rem,88vw)] border-e border-border data-open:slide-in-from-left data-closed:slide-out-to-left rtl:data-open:slide-in-from-right rtl:data-closed:slide-out-to-right',
        end: 'inset-y-0 end-0 h-full w-[min(22rem,88vw)] border-s border-border data-open:slide-in-from-right data-closed:slide-out-to-right rtl:data-open:slide-in-from-left rtl:data-closed:slide-out-to-left',
      },
    },
    defaultVariants: { side: 'bottom' },
  },
);

const SheetContent = React.forwardRef(function SheetContent({ className, side = 'bottom', children, showClose = true, ...props }, ref) {
  const t = useT();
  return (
    <SheetPortal>
      <SheetOverlay />
      <P.Content ref={ref} data-slot="sheet-content" data-side={side} className={cn(sheetVariants({ side }), 'p-4', className)} {...props}>
        {side === 'bottom' && <span aria-hidden="true" className="mx-auto -mt-1 mb-1 h-1 w-9 shrink-0 rounded-full bg-[var(--hb-border)]" />}
        {children}
        {showClose && (
          <P.Close asChild>
            <Button variant="ghost" size="icon-sm" className="absolute end-3 top-3" aria-label={t('dialogs.dismiss')}>
              <XIcon />
            </Button>
          </P.Close>
        )}
      </P.Content>
    </SheetPortal>
  );
});

const SheetHeader = ({ className, ...props }) => <div data-slot="sheet-header" className={cn('flex flex-col gap-1 pe-8', className)} {...props} />;
const SheetFooter = ({ className, ...props }) => <div data-slot="sheet-footer" className={cn('mt-auto flex flex-col gap-2', className)} {...props} />;
const SheetTitle = styled(P.Title, 'text-base font-semibold text-foreground', 'sheet-title');
const SheetDescription = styled(P.Description, 'text-sm text-muted-foreground', 'sheet-description');

export { Sheet, SheetTrigger, SheetClose, SheetPortal, SheetOverlay, SheetContent, SheetHeader, SheetFooter, SheetTitle, SheetDescription };
