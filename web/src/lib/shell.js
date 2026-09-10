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

// Ask the shell to sign this window in (a fresh single-use handoff token —
// server/handoff.ts). Only meaningful on the local machine: the token is
// signed with the secret the shell handed its OWN sidecar.
//
// AUTO_KEY stops a handoff that cannot succeed — no secret, a clock far
// enough off that `exp` is already past — from bouncing between the login
// screen and the sentinel forever. It is cleared the moment a session
// actually exists (clearShellSignInGuard(), called from loadAuth), NOT once
// per tab: sessionStorage survives reloads, so a per-tab latch meant the
// SECOND thing to invalidate the cookie in one window — a second import —
// silently skipped the automatic sign-in and dropped the user back on the
// pairing screen. Reported live, after the first fix.
const AUTO_KEY = 'arigami-shell-signin-tried';

export function canShellSignIn() {
  return !!shellInfo()?.canSignIn;
}

export function shellSignIn() {
  const s = shellInfo();
  return !!(s && typeof s.signIn === 'function' && s.signIn());
}

/**
 * Forget the last automatic attempt. Called when the cockpit finds a live
 * session: whatever the shell did worked, so the next time the cookie dies
 * the window may sign itself in again without the user doing anything.
 */
export function clearShellSignInGuard() {
  try { sessionStorage.removeItem(AUTO_KEY); } catch { /* private mode */ }
}

/** One automatic attempt per failure. Returns true if it navigated. */
export function shellSignInOnce() {
  if (!canShellSignIn()) return false;
  try {
    if (sessionStorage.getItem(AUTO_KEY)) return false;
    sessionStorage.setItem(AUTO_KEY, '1');
  } catch { /* private mode: fall through and try once */ }
  return shellSignIn();
}
