// Mobile on-screen keyboard vs. the app's height.
//
// The cockpit is a fixed-height flex column with the composer pinned at the
// bottom. iOS Safari keeps the *layout* viewport (what 100vh/100dvh measure)
// at full height when the keyboard opens and only shrinks the *visual*
// viewport — so a 100vh column keeps its composer exactly where the keyboard
// now is. Android Chrome resizes the layout viewport instead (we ask for that
// explicitly via `interactive-widget=resizes-content` in index.html), which
// the flex layout already handles.
//
// This tracks the visual viewport into `--app-height` (see index.css for the
// stylesheet fallback the app root uses when the var isn't set). It only
// engages while the visual viewport is shorter than the layout viewport at
// 1:1 scale — i.e. a keyboard is up — so desktop browsers and pinch-zoom are
// left alone.
export function installViewportTracking() {
  const vv = typeof window !== 'undefined' ? window.visualViewport : null;
  if (!vv) return () => {};
  const root = document.documentElement;
  let raf = 0;

  const apply = () => {
    raf = 0;
    const keyboard = window.innerHeight - vv.height;
    if (keyboard > 1 && Math.abs(vv.scale - 1) < 0.01) {
      root.style.setProperty('--app-height', `${Math.round(vv.height)}px`);
      // iOS also scrolls the focused field into view *before* firing resize;
      // once the app is sized to the visual viewport that offset only hides
      // the top of the app behind the browser chrome — undo it.
      if (vv.offsetTop > 0 || window.scrollY > 0) window.scrollTo(0, 0);
    } else {
      root.style.removeProperty('--app-height');
    }
  };
  const schedule = () => {
    if (!raf) raf = requestAnimationFrame(apply);
  };

  vv.addEventListener('resize', schedule);
  vv.addEventListener('scroll', schedule);
  apply();
  return () => {
    vv.removeEventListener('resize', schedule);
    vv.removeEventListener('scroll', schedule);
    if (raf) cancelAnimationFrame(raf);
    root.style.removeProperty('--app-height');
  };
}
