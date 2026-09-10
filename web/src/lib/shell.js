// The desktop shell's facts, as seen from inside the cockpit.
//
// desktop/src-tauri/src/main.rs evaluates a small script into every machine
// window on page load (and again whenever the machine list changes), which
// sets `window.__arigami` and fires an `arigami:shell` event. In an ordinary
// browser that global never exists, so everything gated on this hook simply
// does not render — the cockpit stays one product.
//
// It is a global rather than an IPC call on purpose: docs/DESKTOP.md decision
// #2 gives a machine origin no `invoke()` at all, because on Windows every
// same-origin iframe (i.e. every extension tab) would inherit it. The one
// callback that goes the other way, `openPicker()`, is a navigation the shell
// cancels — no capability is granted to reach it.
import { useEffect, useState } from 'react';

export function shellInfo() {
  return typeof window !== 'undefined' ? window.__arigami || null : null;
}

/** The shell payload, or null in a browser. Re-renders when the shell resends. */
export function useShell() {
  const [info, setInfo] = useState(shellInfo);
  useEffect(() => {
    const on = (e) => setInfo(e.detail || shellInfo());
    window.addEventListener('arigami:shell', on);
    // The script may have landed between the initial read and this effect.
    if (!info && shellInfo()) setInfo(shellInfo());
    return () => window.removeEventListener('arigami:shell', on);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return info;
}

/** Open the shell's machines window. No-op outside the shell. */
export function openMachines() {
  const s = shellInfo();
  if (s && typeof s.openPicker === 'function') s.openPicker();
}
