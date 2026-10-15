// The chat cards still name their glyphs with FontAwesome constants
// (`<Icon icon={faCheck} />`). This drop-in resolves each one to the thin
// outline lucide glyph, so the chat shows ONE icon set; an unmapped glyph falls
// back to the FontAwesome one. `spin` → animate-spin. Sized 1em like FA.
import {
  AppWindowIcon, BanIcon, BotIcon, BoxIcon, CameraIcon, CheckIcon, ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon,
  ExternalLinkIcon, HandIcon, ImageIcon, LinkIcon, LoaderCircleIcon, MonitorIcon, RotateCwIcon, SearchIcon, Share2Icon,
  ShieldIcon, SparklesIcon, TriangleAlertIcon, XIcon,
} from 'lucide-react';
import { Icon as FaIcon } from '../lib/icons.js';

const MAP = {
  check: CheckIcon,
  xmark: XIcon,
  cube: BoxIcon,
  'arrow-up-right-from-square': ExternalLinkIcon,
  'window-restore': AppWindowIcon,
  link: LinkIcon,
  'share-nodes': Share2Icon,
  ban: BanIcon,
  'triangle-exclamation': TriangleAlertIcon,
  'chevron-left': ChevronLeftIcon,
  'chevron-right': ChevronRightIcon,
  camera: CameraIcon,
  'user-astronaut': BotIcon,
  'caret-down': ChevronDownIcon,
  'caret-right': ChevronRightIcon,
  'circle-notch': LoaderCircleIcon,
  'rotate-right': RotateCwIcon,
  'shield-halved': ShieldIcon,
  'wand-magic-sparkles': SparklesIcon,
  image: ImageIcon,
  display: MonitorIcon,
  'magnifying-glass': SearchIcon,
  hand: HandIcon,
};
// glyphs that point somewhere mirror in RTL
const DIRECTIONAL = new Set(['chevron-left', 'chevron-right', 'caret-right']);

export function Icon({ icon, spin, className = '', ...rest }) {
  const Glyph = MAP[icon?.iconName];
  if (!Glyph) return <FaIcon icon={icon} spin={spin} className={className} {...rest} />;
  const cls = `inline-block size-[1em] shrink-0 align-[-0.125em] ${spin ? 'animate-spin' : ''} ${DIRECTIONAL.has(icon.iconName) ? 'rtl:-scale-x-100' : ''} ${className}`;
  return <Glyph aria-hidden="true" className={cls} {...rest} />;
}
