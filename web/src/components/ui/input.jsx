import * as React from 'react';
import { cn } from '../../lib/utils.js';
import { fieldDir } from '../../lib/i18n.js';

// dir="auto" on a controlled field: resolve it ourselves (see fieldDir).
const resolveDir = ({ dir, value }) => (dir === 'auto' && value !== undefined ? fieldDir(value) : dir);

const fieldBase =
  'w-full min-w-0 rounded-md border border-input bg-background px-2.5 text-sm text-foreground outline-none transition-[border-color,box-shadow] duration-150 placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/35 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20';

const Input = React.forwardRef(function Input({ className, type = 'text', ...props }, ref) {
  return <input ref={ref} type={type} data-slot="input" className={cn(fieldBase, 'h-8 coarse:h-11', className)} {...props} dir={resolveDir(props)} />;
});

const Textarea = React.forwardRef(function Textarea({ className, ...props }, ref) {
  return <textarea ref={ref} data-slot="textarea" className={cn(fieldBase, 'min-h-16 resize-y py-1.5 leading-relaxed', className)} {...props} dir={resolveDir(props)} />;
});

export { Input, Textarea, fieldBase };
