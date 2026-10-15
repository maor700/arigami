import * as React from 'react';
import { Tooltip as TooltipPrimitive } from 'radix-ui';
import { cn } from '../../lib/utils.js';
import { part } from './_styled.jsx';
import { Kbd } from './kbd.jsx';

const TooltipProvider = ({ delayDuration = 400, skipDelayDuration = 200, ...props }) => (
  <TooltipPrimitive.Provider delayDuration={delayDuration} skipDelayDuration={skipDelayDuration} {...props} />
);
const Tooltip = TooltipPrimitive.Root;
const TooltipTrigger = part(TooltipPrimitive.Trigger, 'tooltip-trigger');

const TooltipContent = React.forwardRef(function TooltipContent({ className, sideOffset = 6, children, ...props }, ref) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        ref={ref}
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          'z-[90] inline-flex max-w-xs origin-(--radix-tooltip-content-transform-origin) items-center gap-2 rounded-md bg-[var(--hb-ink)] px-2 py-1 text-xs text-[var(--hb-bg)] shadow-pop duration-100 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0',
          className,
        )}
        {...props}
      >
        {children}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
});

/**
 * The one-liner to replace a `title=` attribute:
 *   <Tip label="Archive" shortcut="⌘⌫"><IconButton …/></Tip>
 * The trigger is the child itself (asChild), so no wrapper element appears.
 * Carries its own provider so it also renders outside UiProvider (SSR tests).
 */
function Tip({ label, shortcut, side, children, ...props }) {
  if (!label) return children;
  return (
    <TooltipProvider>
      <Tooltip {...props}>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent side={side}>
          {label}
          {shortcut && <Kbd className="border-transparent bg-[color-mix(in_oklab,var(--hb-bg)_18%,transparent)] text-[var(--hb-bg)]">{shortcut}</Kbd>}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider, Tip };
