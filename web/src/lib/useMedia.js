import { useEffect, useState } from 'react';

// True at >= Tailwind's `md` breakpoint (768px). Drives the desktop side-rail vs
// the mobile slide-in drawer.
export function useIsDesktop() {
  const q = '(min-width: 768px)';
  const [desktop, setDesktop] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(q).matches : true
  );
  useEffect(() => {
    if (!window.matchMedia) return;
    const mql = window.matchMedia(q);
    const on = () => setDesktop(mql.matches);
    on(); // sync now — a flip between first render and this subscription would otherwise stick forever
    mql.addEventListener('change', on);
    return () => mql.removeEventListener('change', on);
  }, []);
  return desktop;
}
