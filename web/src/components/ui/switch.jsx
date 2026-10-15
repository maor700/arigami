import * as React from 'react';
import { Switch as SwitchPrimitive } from 'radix-ui';
import { cn } from '../../lib/utils.js';

// Neutral toggle: ink when on, hairline-grey when off — never the accent.
// The ::after widens the hit area to 44×44 (30+14, 16+28 inner of the border) without growing the control.
const Switch = React.forwardRef(function Switch({ className, ...props }, ref) {
  return (
    <SwitchPrimitive.Root
      ref={ref}
      data-slot="switch"
      className={cn(
        'peer relative inline-flex h-[1.125rem] w-8 shrink-0 items-center rounded-full border border-transparent bg-[var(--hb-border)] transition-colors duration-150 outline-none after:absolute after:-inset-x-[7px] after:-inset-y-[14px] data-checked:bg-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block size-3.5 rounded-full bg-background shadow-sm transition-transform duration-150 ease-out data-[state=checked]:translate-x-[0.875rem] data-[state=unchecked]:translate-x-0.5 rtl:data-[state=checked]:-translate-x-[0.875rem] rtl:data-[state=unchecked]:-translate-x-0.5"
      />
    </SwitchPrimitive.Root>
  );
});

export { Switch };
