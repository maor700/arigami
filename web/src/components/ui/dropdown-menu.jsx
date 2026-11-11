import { DropdownMenu as P } from 'radix-ui';
import { createMenu } from './_menu.jsx';

const m = createMenu(P, 'dropdown-menu');

export const DropdownMenu = m.Root;
export const DropdownMenuTrigger = m.Trigger;
export const DropdownMenuPortal = m.Portal;
export const DropdownMenuContent = m.Content;
export const DropdownMenuGroup = m.Group;
export const DropdownMenuItem = m.Item;
export const DropdownMenuCheckboxItem = m.CheckboxItem;
export const DropdownMenuRadioGroup = m.RadioGroup;
export const DropdownMenuRadioItem = m.RadioItem;
export const DropdownMenuLabel = m.Label;
export const DropdownMenuSeparator = m.Separator;
export const DropdownMenuShortcut = m.Shortcut;
export const DropdownMenuSub = m.Sub;
export const DropdownMenuSubTrigger = m.SubTrigger;
export const DropdownMenuSubContent = m.SubContent;
