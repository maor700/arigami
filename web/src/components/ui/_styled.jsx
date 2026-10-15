// Tiny factory for the shadcn pattern "a Radix part + a class string".
// Every ui/ component is wrapped in React.forwardRef: the CLI emits React-19
// style function components, but on React 18 `asChild`/Slot and Radix Popper
// can't attach a ref to those and menus silently render off-screen.
import * as React from 'react';
import { cn } from '../../lib/utils.js';

export function styled(Primitive, base, slot, defaults) {
  const C = React.forwardRef(function Styled({ className, ...props }, ref) {
    return <Primitive ref={ref} data-slot={slot} className={cn(base, className)} {...defaults} {...props} />;
  });
  C.displayName = slot;
  return C;
}

// A bare re-export of a Radix part (still forwardRef-wrapped, with data-slot).
export function part(Primitive, slot) {
  const C = React.forwardRef(function Part(props, ref) {
    return <Primitive ref={ref} data-slot={slot} {...props} />;
  });
  C.displayName = slot;
  return C;
}
