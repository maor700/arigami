// Stage 1d (docs/VOICE.md): keep the screen on while a call or hands-free conversation is live, and pick both back up when
// the page returns to the front. A browser without the Screen Wake Lock API just keeps its normal screen timeout.
import { subscribeCall, getCall, resumeCall } from './call.js';
import { subscribeHandsFree, getHandsFree } from './handsfree.js';

let env = null; // { nav, doc } — replaceable for tests
const E = () => env || { nav: globalThis.navigator, doc: globalThis.document };
export function setWakeLockEnv(e) { env = e; want = false; sentinel = null; pending = null; }

let want = false;
let sentinel = null;
let pending = null;
export const wakeLockHeld = () => !!sentinel;

function acquire() {
  const { nav, doc } = E();
  if (!want || sentinel || pending || typeof nav?.wakeLock?.request !== 'function') return Promise.resolve(!!sentinel);
  if (doc?.visibilityState && doc.visibilityState !== 'visible') return Promise.resolve(false); // only a visible page may ask
  pending = Promise.resolve()
    .then(() => nav.wakeLock.request('screen'))
    .then((s) => {
      pending = null;
      if (!want) { try { s?.release?.(); } catch { /* ignore */ } return false; }
      sentinel = s;
      s?.addEventListener?.('release', () => { if (sentinel === s) sentinel = null; }); // the browser drops it when the page hides
      return true;
    }, () => { pending = null; return false; });
  return pending;
}

/** Ask for the screen lock (kept wanted until release, re-taken on every return to the front). */
export function holdWakeLock() { want = true; return acquire(); }
export function releaseWakeLock() {
  want = false;
  const s = sentinel;
  sentinel = null;
  try { s?.release?.()?.catch?.(() => {}); } catch { /* ignore */ }
}

const voiceLive = () => !!(getCall().active || getHandsFree().active);

/** Wire it once at boot: the lock follows the voice state; back to visible → re-take the lock and resume a dropped call. */
export function installVoiceKeepAlive() {
  const { doc } = E();
  let on = false;
  const sync = () => {
    const now = voiceLive();
    if (now === on) return;
    on = now;
    if (now) holdWakeLock();
    else releaseWakeLock();
  };
  const offCall = subscribeCall(sync);
  const offHf = subscribeHandsFree(sync);
  const onVis = () => {
    if (E().doc?.visibilityState !== 'visible') return;
    if (want) acquire();
    if (getCall().active) resumeCall();
  };
  doc?.addEventListener?.('visibilitychange', onVis);
  sync();
  return () => { offCall(); offHf(); doc?.removeEventListener?.('visibilitychange', onVis); releaseWakeLock(); };
}
