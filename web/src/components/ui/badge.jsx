import * as React from 'react';
import { cva } from 'class-variance-authority';
import { cn } from '../../lib/utils.js';

// Neutral chip + (optionally) a tiny status dot. Colour is carried by the dot
// only; the text is never coloured (accent budget). `mono` for branch names.
const badgeVariants = cva(
  'inline-flex h-[1.125rem] max-w-full shrink-0 items-center gap-1.5 rounded-sm px-1.5 text-xs font-medium whitespace-nowrap text-muted-foreground [&_svg]:size-3 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'bg-muted',
        outline: 'border border-border bg-transparent',
        solid: 'bg-foreground text-background',
      },
      mono: { true: 'font-mono text-2xs', false: '' },
    },
    defaultVariants: { variant: 'default', mono: false },
  },
);

const DOT = {
  ok: 'bg-ok',
  warn: 'bg-warn',
  err: 'bg-err',
  info: 'bg-info',
  violet: 'bg-violet',
  idle: 'bg-faint',
};

/** A tiny status dot on its own (rail rows, tab titles). `status` ∈ ok|warn|err|info|violet|idle. */
const StatusDot = React.forwardRef(function StatusDot({ status = 'idle', pulse = false, className, ...props }, ref) {
  return (
    <span
      ref={ref}
      aria-hidden="true"
      data-slot="status-dot"
      data-status={status}
      className={cn('inline-block size-1.5 shrink-0 rounded-full', DOT[status] || DOT.idle, pulse && 'pulse-yellow', className)}
      {...props}
    />
  );
});

const Badge = React.forwardRef(function Badge({ className, variant, mono, status, children, ...props }, ref) {
  return (
    <span ref={ref} data-slot="badge" data-status={status} className={cn(badgeVariants({ variant, mono }), className)} {...props}>
      {status && <StatusDot status={status} />}
      {children}
    </span>
  );
});

export { Badge, StatusDot, badgeVariants };
