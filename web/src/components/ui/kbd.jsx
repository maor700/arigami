import * as React from 'react';
import { cn } from '../../lib/utils.js';

// A keyboard hint. Always LTR (⌘K reads left-to-right inside Hebrew text).
const Kbd = React.forwardRef(function Kbd({ className, ...props }, ref) {
  return (
    <kbd
      ref={ref}
      dir="ltr"
      data-slot="kbd"
      className={cn(
        'inline-flex h-[1.125rem] min-w-[1.125rem] items-center justify-center rounded-sm border border-border bg-muted px-1 font-sans text-2xs leading-none font-medium text-muted-foreground tabular-nums',
        className,
      )}
      {...props}
    />
  );
});

export { Kbd };
