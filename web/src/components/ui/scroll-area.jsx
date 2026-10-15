import * as React from 'react';
import { ScrollArea as P } from 'radix-ui';
import { cn } from '../../lib/utils.js';

// Note: it inherits `dir` — a block of code inside needs dir="ltr" on itself,
// or the horizontal scroll starts at the wrong edge.
const ScrollBar = React.forwardRef(function ScrollBar({ className, orientation = 'vertical', ...props }, ref) {
  return (
    <P.ScrollAreaScrollbar
      ref={ref}
      orientation={orientation}
      data-slot="scroll-area-scrollbar"
      className={cn(
        'flex touch-none p-px transition-colors select-none',
        orientation === 'vertical' && 'h-full w-2 border-s border-s-transparent',
        orientation === 'horizontal' && 'h-2 flex-col border-t border-t-transparent',
        className,
      )}
      {...props}
    >
      <P.ScrollAreaThumb data-slot="scroll-area-thumb" className="relative flex-1 rounded-full bg-[var(--hb-border)] hover:bg-[var(--hb-faint)]" />
    </P.ScrollAreaScrollbar>
  );
});

const ScrollArea = React.forwardRef(function ScrollArea({ className, children, viewportClassName, horizontal = false, ...props }, ref) {
  return (
    <P.Root ref={ref} data-slot="scroll-area" className={cn('relative overflow-hidden', className)} {...props}>
      <P.Viewport data-slot="scroll-area-viewport" className={cn('size-full rounded-[inherit] outline-none focus-visible:outline-2 focus-visible:outline-ring', viewportClassName)}>
        {children}
      </P.Viewport>
      <ScrollBar />
      {horizontal && <ScrollBar orientation="horizontal" />}
      <P.Corner />
    </P.Root>
  );
});

export { ScrollArea, ScrollBar };
