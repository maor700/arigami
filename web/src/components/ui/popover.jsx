import * as React from 'react';
import { Popover as PopoverPrimitive } from 'radix-ui';
import { cn } from '../../lib/utils.js';
import { part } from './_styled.jsx';

const Popover = PopoverPrimitive.Root;
const PopoverTrigger = part(PopoverPrimitive.Trigger, 'popover-trigger');
const PopoverAnchor = part(PopoverPrimitive.Anchor, 'popover-anchor');
const PopoverClose = part(PopoverPrimitive.Close, 'popover-close');

const PopoverContent = React.forwardRef(function PopoverContent({ className, align = 'center', sideOffset = 6, collisionPadding = 8, ...props }, ref) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        ref={ref}
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cn(
          'z-50 w-72 max-w-[calc(100vw-1rem)] origin-(--radix-popper-transform-origin) rounded-lg bg-popover p-3 text-popover-foreground shadow-pop outline-none duration-150 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95',
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
});

export { Popover, PopoverTrigger, PopoverAnchor, PopoverClose, PopoverContent };
