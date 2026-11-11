import { Collapsible as P } from 'radix-ui';
import { part } from './_styled.jsx';

const Collapsible = part(P.Root, 'collapsible');
const CollapsibleTrigger = part(P.CollapsibleTrigger, 'collapsible-trigger');
const CollapsibleContent = part(P.CollapsibleContent, 'collapsible-content');

export { Collapsible, CollapsibleTrigger, CollapsibleContent };
