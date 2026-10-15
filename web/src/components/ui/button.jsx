import * as React from 'react';
import { cva } from 'class-variance-authority';
import { Slot } from 'radix-ui';
import { cn } from '../../lib/utils.js';

// One accent per view: only `variant="primary"` carries the brand colour.
// `default` is the neutral button; `ghost` is chrome; `outline` is a bordered
// secondary. Every size has a 44px minimum under a coarse pointer (a finger),
// plus explicit `touch` / `icon-touch` sizes for always-large targets.
const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md border border-transparent text-sm font-medium whitespace-nowrap select-none outline-none transition-[background-color,border-color,color,transform] duration-150 ease-out focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: 'border-input bg-card text-foreground hover:bg-muted aria-expanded:bg-muted',
        primary: 'bg-primary text-primary-foreground hover:bg-[var(--accent-hover)]',
        outline: 'border-input bg-transparent text-foreground hover:bg-muted aria-expanded:bg-muted',
        ghost: 'text-muted-foreground hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground',
        destructive: 'border-[var(--hb-err-line)] bg-[var(--hb-err-bg)] text-destructive hover:bg-[color-mix(in_oklab,var(--hb-err)_18%,var(--hb-bg))]',
        link: 'h-auto min-h-0 px-0 text-foreground underline underline-offset-4 hover:decoration-2 coarse:min-h-0',
      },
      size: {
        default: 'h-8 px-3 coarse:min-h-11 coarse:min-w-11',
        sm: 'h-7 px-2.5 text-xs coarse:min-h-11 coarse:min-w-11',
        xs: 'h-6 gap-1 px-2 text-xs [&_svg:not([class*="size-"])]:size-3.5 coarse:min-h-11 coarse:min-w-11',
        lg: 'h-9 px-4 coarse:min-h-11 coarse:min-w-11',
        touch: 'h-11 px-4',
        icon: 'size-8 coarse:min-h-11 coarse:min-w-11',
        'icon-sm': 'size-7 coarse:min-h-11 coarse:min-w-11',
        'icon-xs': 'size-6 coarse:min-h-11 coarse:min-w-11',
        'icon-lg': 'size-9 coarse:min-h-11 coarse:min-w-11',
        'icon-touch': 'size-11',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

const Button = React.forwardRef(function Button({ className, variant, size, asChild = false, type, ...props }, ref) {
  const Comp = asChild ? Slot.Root : 'button';
  return (
    <Comp
      ref={ref}
      data-slot="button"
      data-variant={variant || 'default'}
      data-size={size || 'default'}
      // a <button> in a <form> would submit; the app never wants that implicitly
      type={asChild ? type : type || 'button'}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
});

export { Button, buttonVariants };
