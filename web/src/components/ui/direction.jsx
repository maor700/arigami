// Radix does NOT read `dir` from the DOM: without a Direction.Provider menus
// align to the wrong edge under RTL and ArrowRight opens a submenu the wrong
// way. This provider feeds Radix from the app's language preference (the same
// source prefs.js uses to set <html dir>), and also mounts the tooltip
// provider every <Tip> needs.
import * as React from 'react';
import { Direction } from 'radix-ui';
import { usePrefs } from '../../lib/prefs.js';
import { langDir } from '../../lib/langs.js';
import { TooltipProvider } from './tooltip.jsx';

export function AppDirection({ dir, children }) {
  const prefs = usePrefs();
  const d = dir || langDir(prefs.language);
  return <Direction.Provider dir={d}>{children}</Direction.Provider>;
}

/** Wrap the app root once: direction + tooltips. */
export function UiProvider({ children, dir }) {
  return (
    <AppDirection dir={dir}>
      <TooltipProvider>{children}</TooltipProvider>
    </AppDirection>
  );
}

export const useDirection = Direction.useDirection;
