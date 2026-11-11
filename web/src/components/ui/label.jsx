import { Label as LabelPrimitive } from 'radix-ui';
import { styled } from './_styled.jsx';

const Label = styled(LabelPrimitive.Root, 'text-xs font-medium text-muted-foreground select-none', 'label');

export { Label };
