import * as React from 'react';
import { Select as P } from 'radix-ui';
import { CheckIcon, ChevronDownIcon } from 'lucide-react';
import { cn } from '../../lib/utils.js';
import { part, styled } from './_styled.jsx';
import { fieldBase } from './input.jsx';
import { menuSurface, menuItem } from './_menu.jsx';

const Select = P.Root;
const SelectGroup = part(P.Group, 'select-group');
const SelectValue = part(P.Value, 'select-value');

const SelectTrigger = React.forwardRef(function SelectTrigger({ className, children, ...props }, ref) {
  return (
    <P.Trigger ref={ref} data-slot="select-trigger" className={cn(fieldBase, 'inline-flex h-8 items-center justify-between gap-2 text-start whitespace-nowrap coarse:h-11 data-[placeholder]:text-muted-foreground [&>span]:truncate', className)} {...props}>
      {children}
      <P.Icon asChild>
        <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" />
      </P.Icon>
    </P.Trigger>
  );
});

const SelectContent = React.forwardRef(function SelectContent({ className, children, position = 'popper', sideOffset = 4, ...props }, ref) {
  return (
    <P.Portal>
      <P.Content
        ref={ref}
        data-slot="select-content"
        position={position}
        sideOffset={sideOffset}
        collisionPadding={8}
        className={cn(menuSurface, 'max-h-(--radix-select-content-available-height) min-w-(--radix-select-trigger-width)', className)}
        {...props}
      >
        <P.Viewport className="p-0">{children}</P.Viewport>
      </P.Content>
    </P.Portal>
  );
});

const SelectItem = React.forwardRef(function SelectItem({ className, children, ...props }, ref) {
  return (
    <P.Item ref={ref} data-slot="select-item" className={cn(menuItem, 'ps-8 pe-2', className)} {...props}>
      <span className="pointer-events-none absolute start-2 flex size-4 items-center justify-center">
        <P.ItemIndicator>
          <CheckIcon className="size-4" />
        </P.ItemIndicator>
      </span>
      <P.ItemText>{children}</P.ItemText>
    </P.Item>
  );
});

const SelectLabel = styled(P.Label, 'px-2 pt-1.5 pb-1 text-2xs font-medium text-muted-foreground', 'select-label');
const SelectSeparator = styled(P.Separator, '-mx-1 my-1 h-px bg-border', 'select-separator');

export { Select, SelectGroup, SelectValue, SelectTrigger, SelectContent, SelectItem, SelectLabel, SelectSeparator };
