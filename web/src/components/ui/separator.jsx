import { Separator as SeparatorPrimitive } from 'radix-ui';
import { styled } from './_styled.jsx';

const Separator = styled(
  SeparatorPrimitive.Root,
  'shrink-0 bg-border data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-px',
  'separator',
  { decorative: true },
);

export { Separator };
