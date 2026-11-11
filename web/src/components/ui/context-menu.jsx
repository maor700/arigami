import { ContextMenu as P } from 'radix-ui';
import { createMenu } from './_menu.jsx';

const m = createMenu(P, 'context-menu');

export const ContextMenu = m.Root;
export const ContextMenuTrigger = m.Trigger;
export const ContextMenuPortal = m.Portal;
export const ContextMenuContent = m.Content;
export const ContextMenuGroup = m.Group;
export const ContextMenuItem = m.Item;
export const ContextMenuCheckboxItem = m.CheckboxItem;
export const ContextMenuRadioGroup = m.RadioGroup;
export const ContextMenuRadioItem = m.RadioItem;
export const ContextMenuLabel = m.Label;
export const ContextMenuSeparator = m.Separator;
export const ContextMenuShortcut = m.Shortcut;
export const ContextMenuSub = m.Sub;
export const ContextMenuSubTrigger = m.SubTrigger;
export const ContextMenuSubContent = m.SubContent;
