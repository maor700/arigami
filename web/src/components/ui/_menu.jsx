// One implementation of the menu surface for DropdownMenu and ContextMenu:
// both Radix primitives expose the same parts, so the look (and its RTL and
// 44px-touch behaviour) is defined once here.
import * as React from 'react';
import { CheckIcon, ChevronRightIcon, CircleIcon } from 'lucide-react';
import { cn } from '../../lib/utils.js';

export const menuSurface =
  'z-50 min-w-40 max-w-[min(22rem,calc(100vw-1rem))] origin-(--radix-popper-transform-origin) overflow-x-hidden overflow-y-auto rounded-lg bg-popover p-1 text-popover-foreground shadow-pop outline-none duration-150 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 data-[side=bottom]:slide-in-from-top-1 data-[side=top]:slide-in-from-bottom-1 data-[side=left]:slide-in-from-right-1 data-[side=right]:slide-in-from-left-1';

export const menuItem =
  'relative flex min-h-7 cursor-default items-center gap-2 rounded-md px-2 py-1 text-sm outline-none select-none coarse:min-h-11 data-[highlighted]:bg-muted data-[highlighted]:text-foreground data-[variant=destructive]:text-destructive data-[variant=destructive]:data-[highlighted]:bg-[var(--hb-err-bg)] data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[inset]:ps-8 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*=size-])]:size-4 [&_svg:not([class*=text-])]:text-muted-foreground';

export function createMenu(P, name) {
  const slot = (s) => `${name}-${s}`;
  const fwd = (displayName, render) => {
    const C = React.forwardRef(render);
    C.displayName = displayName;
    return C;
  };

  const Content = fwd('Content', ({ className, sideOffset = 4, collisionPadding = 8, ...props }, ref) => (
    <P.Portal>
      <P.Content ref={ref} data-slot={slot('content')} sideOffset={sideOffset} collisionPadding={collisionPadding} className={cn(menuSurface, 'max-h-(--radix-popper-available-height)', className)} {...props} />
    </P.Portal>
  ));
  const SubContent = fwd('SubContent', ({ className, ...props }, ref) => (
    <P.Portal>
      <P.SubContent ref={ref} data-slot={slot('sub-content')} collisionPadding={8} className={cn(menuSurface, className)} {...props} />
    </P.Portal>
  ));
  const Item = fwd('Item', ({ className, inset, variant = 'default', ...props }, ref) => (
    <P.Item ref={ref} data-slot={slot('item')} data-inset={inset ? '' : undefined} data-variant={variant} className={cn(menuItem, className)} {...props} />
  ));
  const CheckboxItem = fwd('CheckboxItem', ({ className, children, checked, ...props }, ref) => (
    <P.CheckboxItem ref={ref} data-slot={slot('checkbox-item')} checked={checked} className={cn(menuItem, 'ps-8 pe-2', className)} {...props}>
      <span className="pointer-events-none absolute start-2 flex size-4 items-center justify-center">
        <P.ItemIndicator>
          <CheckIcon className="size-4" />
        </P.ItemIndicator>
      </span>
      {children}
    </P.CheckboxItem>
  ));
  const RadioItem = fwd('RadioItem', ({ className, children, ...props }, ref) => (
    <P.RadioItem ref={ref} data-slot={slot('radio-item')} className={cn(menuItem, 'ps-8 pe-2', className)} {...props}>
      <span className="pointer-events-none absolute start-2 flex size-4 items-center justify-center">
        <P.ItemIndicator>
          <CircleIcon className="size-1.5 fill-current" />
        </P.ItemIndicator>
      </span>
      {children}
    </P.RadioItem>
  ));
  const SubTrigger = fwd('SubTrigger', ({ className, inset, children, ...props }, ref) => (
    <P.SubTrigger ref={ref} data-slot={slot('sub-trigger')} data-inset={inset ? '' : undefined} className={cn(menuItem, 'data-[state=open]:bg-muted', className)} {...props}>
      {children}
      <ChevronRightIcon className="ms-auto size-4 rtl:rotate-180" />
    </P.SubTrigger>
  ));
  const Label = fwd('Label', ({ className, inset, ...props }, ref) => (
    <P.Label ref={ref} data-slot={slot('label')} data-inset={inset ? '' : undefined} className={cn('px-2 pt-1.5 pb-1 text-2xs font-medium text-muted-foreground data-[inset]:ps-8', className)} {...props} />
  ));
  const Separator = fwd('Separator', ({ className, ...props }, ref) => (
    <P.Separator ref={ref} data-slot={slot('separator')} className={cn('-mx-1 my-1 h-px bg-border', className)} {...props} />
  ));
  const Shortcut = fwd('Shortcut', ({ className, ...props }, ref) => (
    <span ref={ref} dir="ltr" data-slot={slot('shortcut')} className={cn('ms-auto ps-4 text-2xs tracking-wide text-muted-foreground tabular-nums', className)} {...props} />
  ));
  const wrap = (displayName, Prim, s) => {
    const C = fwd(displayName, (props, ref) => <Prim ref={ref} data-slot={slot(s)} {...props} />);
    return C;
  };
  return {
    Root: P.Root,
    Trigger: wrap('Trigger', P.Trigger, 'trigger'),
    Portal: P.Portal,
    Group: wrap('Group', P.Group, 'group'),
    RadioGroup: wrap('RadioGroup', P.RadioGroup, 'radio-group'),
    Sub: P.Sub,
    Content,
    SubContent,
    SubTrigger,
    Item,
    CheckboxItem,
    RadioItem,
    Label,
    Separator,
    Shortcut,
  };
}
