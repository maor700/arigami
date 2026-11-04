// Live voice level for the floating box: the mic while the person speaks, the playback while the agent does.
// Sources register themselves (voice.js, call-openai.js, call-gemini.js, speak.js); nothing here opens a mic.
import { useEffect, useState, useSyncExternalStore } from 'react';

const sources = { mic: null, out: null }; // MediaStream | HTMLMediaElement | {node, ctx} | null
const subs = new Set();
const notify = () => { for (const fn of subs) fn(); };
export const subscribeAudioSources = (fn) => { subs.add(fn); return () => subs.delete(fn); };
export const getAudioSource = (kind) => sources[kind] || null;

/** Register what plays/records for `kind` ('mic' | 'out'); null clears it. */
export function setAudioSource(kind, src) {
  if (!(kind in sources) || sources[kind] === (src || null)) return;
  sources[kind] = src || null;
  notify();
}
/** Clear `kind` only while it still points at `src` (a later source is never dropped by an earlier owner). */
export function clearAudioSource(kind, src) { if (sources[kind] && sources[kind] === src) setAudioSource(kind, null); }

let ctx = null;
/** The one AudioContext the meters (and unlockAudio) share; null without Web Audio. */
export function audioLevelContext() {
  if (ctx) return ctx;
  const AC = typeof window !== 'undefined' ? window.AudioContext || window.webkitAudioContext : null;
  if (typeof AC !== 'function') return null;
  try { ctx = new AC(); } catch { ctx = null; }
  return ctx;
}

/** RMS of 8-bit time-domain samples → 0..1 (128 = silence). */
export function rmsOf(buf) {
  if (!buf || !buf.length) return 0;
  let sum = 0;
  for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
  return Math.sqrt(sum / buf.length);
}
export const GAIN = 3.2; // speech RMS sits around 0.05–0.3: lift it so talking fills the bars
export const ATTACK = 0.55;
export const RELEASE = 0.18;
/** One smoothing step: quick to rise, slower to fall. */
export function smoothLevel(prev, raw) {
  const target = Math.min(1, Math.max(0, raw * GAIN));
  const next = prev + (target - prev) * (target > prev ? ATTACK : RELEASE);
  return next < 0.005 ? 0 : next;
}

const streamOf = (src) => {
  if (!src) return null;
  if (typeof src.getAudioTracks === 'function') return src;
  if (src.srcObject && typeof src.srcObject.getAudioTracks === 'function') return src.srcObject;
  const cap = src.captureStream || src.mozCaptureStream;
  if (typeof cap === 'function') { try { return cap.call(src); } catch { return null; } }
  return null;
};

/** Analyser on `src`; returns {read() → raw rms, close()} or null when it cannot be measured. */
export function attachAnalyser(src, shared = audioLevelContext()) {
  try {
    let c = shared;
    let input = null;
    if (src && src.node && src.ctx) { c = src.ctx; input = src.node; }
    else {
      const stream = streamOf(src);
      if (!stream || !c) return null;
      if (typeof stream.getAudioTracks === 'function' && stream.getAudioTracks().length === 0) return null;
      input = c.createMediaStreamSource(stream);
    }
    if (!c) return null;
    if (c.state === 'suspended') c.resume?.()?.catch?.(() => {});
    const analyser = c.createAnalyser();
    analyser.fftSize = 512;
    input.connect(analyser);
    const buf = new Uint8Array(analyser.fftSize);
    return {
      read() { analyser.getByteTimeDomainData(buf); return rmsOf(buf); },
      close() {
        try { input.disconnect(analyser); } catch { /* ignore */ }
        try { if (!src.node) input.disconnect(); } catch { /* ignore */ }
      },
    };
  } catch { return null; }
}

const defaultRaf = () => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn) => setTimeout(() => fn(Date.now()), 33));
const defaultCaf = () => (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : clearTimeout);

/** Meter `src` at ~fps via rAF; onLevel gets the smoothed 0..1 level. start()/stop() release the nodes. */
export function createMeter(src, { fps = 30, raf = defaultRaf(), caf = defaultCaf(), now = () => Date.now(), analyser, ctx: c } = {}) {
  let an = null;
  let handle = null;
  let level = 0;
  let last = -Infinity;
  let cb = null;
  const step = (fps > 0 ? 1000 / fps : 0) - 2;
  const frame = () => {
    handle = raf(frame);
    const t = now();
    if (t - last < step) return;
    last = t;
    const next = smoothLevel(level, an.read());
    if (next === level) return;
    level = next;
    cb?.(level);
  };
  return {
    get level() { return level; },
    start(onLevel) {
      cb = onLevel;
      an = analyser || attachAnalyser(src, c);
      if (!an) { cb?.(0); return false; }
      handle = raf(frame);
      return true;
    },
    stop() {
      if (handle != null) caf(handle);
      handle = null;
      an?.close?.();
      an = null;
      level = 0;
      cb = null;
    },
  };
}

const useSource = (kind) => useSyncExternalStore(subscribeAudioSources, () => getAudioSource(kind), () => getAudioSource(kind));
/** True while something measurable is registered for `kind`. */
export function useHasAudioSource(kind) { return !!useSource(kind); }

/** Smoothed 0..1 level of the mic ('mic') or the playback ('out'); 0 when nothing is registered. */
export function useAudioLevel(kind, { fps = 30 } = {}) {
  const src = useSource(kind);
  const [level, setLevel] = useState(0);
  useEffect(() => {
    if (!kind || !src) { setLevel(0); return; }
    const m = createMeter(src, { fps });
    m.start((l) => setLevel(l));
    return () => { m.stop(); setLevel(0); };
  }, [kind, src, fps]);
  return src ? level : 0;
}
