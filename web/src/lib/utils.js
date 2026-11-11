// shadcn's `cn`: merge class lists, last Tailwind utility wins.
import { clsx } from 'clsx';
import { twMerge, extendTailwindMerge } from 'tailwind-merge';

// Teach tailwind-merge our custom type step (text-2xs, index.css @theme) so it
// is merged as a font SIZE and never swallows a text-<colour> class.
const merge = extendTailwindMerge({
  extend: { classGroups: { 'font-size': [{ text: ['2xs'] }] } },
});

export function cn(...inputs) {
  return merge(clsx(inputs));
}
export { twMerge };
