// Central FontAwesome setup — Pro Solid everywhere, matching the app's chunky
// neubrutalist style. autoAddCss is off because the base CSS is imported in
// index.css inside layer(base), so Tailwind utilities keep beating FA's own
// unlayered rules (Tailwind v4 layering gotcha).
import { config } from '@fortawesome/fontawesome-svg-core';

config.autoAddCss = false;

export { FontAwesomeIcon as Icon } from '@fortawesome/react-fontawesome';
