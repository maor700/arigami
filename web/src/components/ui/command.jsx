import * as React from 'react';
import { Command as CommandPrimitive } from 'cmdk';
import { SearchIcon } from 'lucide-react';
import { cn } from '../../lib/utils.js';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from './dialog.jsx';
import { menuItem } from './_menu.jsx';

// cmdk list: the palette (⌘K), slash menu, combobox bodies. Group headings,
// fuzzy filtering, ↑↓ + Enter come from cmdk; the look is the menu's.
const Command = React.forwardRef(function Command({ className, ...props }, ref) {
  return <CommandPrimitive ref={ref} data-slot="command" className={cn('flex size-full flex-col overflow-hidden rounded-[inherit] bg-popover text-popover-foreground', className)} {...props} />;
});

function CommandDialog({ title = 'Command palette', description = 'Search for a command to run', children, ...props }) {
  return (
    <Dialog {...props}>
      <DialogHeader className="sr-only">
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      <DialogContent showClose={false} className="top-[16%] translate-y-0 gap-0 overflow-hidden p-0">
        <Command className="[&_[cmdk-input-wrapper]_svg]:size-4">{children}</Command>
      </DialogContent>
    </Dialog>
  );
}

const CommandInput = React.forwardRef(function CommandInput({ className, ...props }, ref) {
  return (
    <div data-slot="command-input-wrapper" cmdk-input-wrapper="" className="flex h-11 items-center gap-2 border-b border-border px-3">
      <SearchIcon className="shrink-0 text-muted-foreground" />
      <CommandPrimitive.Input ref={ref} data-slot="command-input" className={cn('flex h-full w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground disabled:opacity-50', className)} {...props} />
    </div>
  );
});

const CommandList = React.forwardRef(function CommandList({ className, ...props }, ref) {
  return <CommandPrimitive.List ref={ref} data-slot="command-list" className={cn('max-h-80 scroll-py-1 overflow-x-hidden overflow-y-auto p-1', className)} {...props} />;
});

const CommandEmpty = React.forwardRef(function CommandEmpty(props, ref) {
  return <CommandPrimitive.Empty ref={ref} data-slot="command-empty" className="py-6 text-center text-sm text-muted-foreground" {...props} />;
});

const CommandGroup = React.forwardRef(function CommandGroup({ className, ...props }, ref) {
  return (
    <CommandPrimitive.Group
      ref={ref}
      data-slot="command-group"
      className={cn('overflow-hidden text-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground', className)}
      {...props}
    />
  );
});

const CommandSeparator = React.forwardRef(function CommandSeparator({ className, ...props }, ref) {
  return <CommandPrimitive.Separator ref={ref} data-slot="command-separator" className={cn('-mx-1 my-1 h-px bg-border', className)} {...props} />;
});

const CommandItem = React.forwardRef(function CommandItem({ className, ...props }, ref) {
  return <CommandPrimitive.Item ref={ref} data-slot="command-item" className={cn(menuItem, 'data-[selected=true]:bg-muted data-[selected=true]:text-foreground data-[disabled=false]:pointer-events-auto data-[disabled=false]:opacity-100', className)} {...props} />;
});

const CommandShortcut = ({ className, ...props }) => (
  <span dir="ltr" data-slot="command-shortcut" className={cn('ms-auto text-2xs tracking-wide text-muted-foreground tabular-nums', className)} {...props} />
);

export { Command, CommandDialog, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem, CommandShortcut, CommandSeparator };
