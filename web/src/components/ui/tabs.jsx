import * as React from 'react';
import { Tabs as P } from 'radix-ui';
import { cn } from '../../lib/utils.js';

// `line` (default): hairline under the row, the active tab gets a 2px INK
// underline. `segmented`: a pill-less segmented control (view switchers).
// Neither uses the accent: tabs are navigation, not the primary action.
const VariantCtx = React.createContext('line');

const Tabs = React.forwardRef(function Tabs({ className, ...props }, ref) {
  return <P.Root ref={ref} data-slot="tabs" className={cn('flex flex-col gap-2', className)} {...props} />;
});

const TabsList = React.forwardRef(function TabsList({ className, variant = 'line', ...props }, ref) {
  return (
    <VariantCtx.Provider value={variant}>
    <P.List
      ref={ref}
      data-slot="tabs-list"
      data-variant={variant}
      className={cn(
        'inline-flex items-center',
        variant === 'line' && 'w-full gap-1 overflow-x-auto border-b border-border',
        variant === 'segmented' && 'gap-0.5 self-start rounded-md bg-muted p-0.5',
        className,
      )}
      {...props}
    />
    </VariantCtx.Provider>
  );
});

const TabsTrigger = React.forwardRef(function TabsTrigger({ className, variant: v, ...props }, ref) {
  const ctx = React.useContext(VariantCtx);
  const variant = v || ctx;
  return (
    <P.Trigger
      ref={ref}
      data-slot="tabs-trigger"
      className={cn(
        'inline-flex shrink-0 items-center justify-center gap-1.5 text-sm font-medium whitespace-nowrap text-muted-foreground outline-none transition-colors duration-150 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 data-active:text-foreground [&_svg:not([class*=size-])]:size-4',
        variant === 'line' &&
          'relative h-9 px-2.5 after:absolute after:inset-x-1.5 after:-bottom-px after:h-0.5 after:rounded-full after:bg-transparent data-active:after:bg-foreground coarse:h-11',
        variant === 'segmented' && 'h-6 rounded-sm px-2.5 text-xs data-active:bg-card data-active:shadow-[0_0_0_1px_var(--hb-hair)] coarse:h-9',
        className,
      )}
      {...props}
    />
  );
});

const TabsContent = React.forwardRef(function TabsContent({ className, ...props }, ref) {
  return <P.Content ref={ref} data-slot="tabs-content" className={cn('flex-1 outline-none', className)} {...props} />;
});

export { Tabs, TabsList, TabsTrigger, TabsContent };
