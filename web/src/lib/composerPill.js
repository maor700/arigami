// The composer's model / effort / permission pill is the ONE place those three
// are changed (decision D10 is open). The header gear shows a single row that
// opens the pill instead of repeating the three pickers; where no composer is
// on screen (e.g. an agent home page) the gear keeps its own pickers.
import { useSyncExternalStore } from 'react';

let mounted = 0;
const subs = new Set();
const emit = () => subs.forEach((f) => f());

export const registerComposerPill = () => {
  mounted += 1;
  emit();
  return () => { mounted -= 1; emit(); };
};
export const openComposerPill = () => window.dispatchEvent(new CustomEvent('arigami:open-composer-pill'));
export const useComposerPillMounted = () =>
  useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => mounted > 0, () => false);
