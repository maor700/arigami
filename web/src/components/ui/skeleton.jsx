import * as React from 'react';
import { cn } from '../../lib/utils.js';

const Skeleton = React.forwardRef(function Skeleton({ className, ...props }, ref) {
  return <div ref={ref} data-slot="skeleton" aria-hidden="true" className={cn('animate-pulse rounded-md bg-muted', className)} {...props} />;
});

export { Skeleton };
