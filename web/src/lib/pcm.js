// Raw PCM in and out of the browser (stage 1c, Gemini Live): the mic → 16 kHz int16 chunks, 24 kHz int16 chunks → the
// speaker, played back to back. Pure helpers are exported for tests; the audio-graph pieces accept injected nodes.

/** Float32 samples at `from` Hz → base64 of little-endian int16 at `to` Hz (linear resample). */
export function floatToPcm16Base64(samples, from, to = 16000) {
  const n = from === to ? samples.length : Math.floor((samples.length * to) / from);
  const out = new Int16Array(n);
  const step = from / to;
  for (let i = 0; i < n; i++) {
    const pos = i * step;
    const i0 = Math.floor(pos);
    const i1 = Math.min(samples.length - 1, i0 + 1);
    const frac = pos - i0;
    const v = samples[i0] * (1 - frac) + samples[i1] * frac;
    out[i] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
  }
  return bytesToBase64(new Uint8Array(out.buffer));
}

/** base64 of little-endian int16 → Float32 samples in [-1, 1]. */
export function pcm16Base64ToFloat(b64) {
  const bytes = base64ToBytes(b64);
  const n = bytes.length >> 1;
  const view = new DataView(bytes.buffer, bytes.byteOffset, n * 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = view.getInt16(i * 2, true) / 32768;
  return out;
}

export function bytesToBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function base64ToBytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// The capture node runs off the main thread when AudioWorklet exists; a ScriptProcessor otherwise (old Safari).
const WORKLET = `class P extends AudioWorkletProcessor{process(i){const c=i[0]&&i[0][0];if(c)this.port.postMessage(c.slice(0));return true;}}registerProcessor('arigami-pcm',P);`;

/** Mic → `onChunk(base64)` of 16 kHz int16 every ~chunkMs; returns {stop, mute(bool)}. */
export async function openMicPcm({ ctx, stream, onChunk, rate = 16000, chunkMs = 100 }) {
  const src = ctx.createMediaStreamSource(stream);
  const sr = ctx.sampleRate;
  let muted = false;
  let buf = [];
  let have = 0;
  const want = Math.floor((sr * chunkMs) / 1000);
  const push = (block) => {
    if (muted) return;
    buf.push(block);
    have += block.length;
    if (have < want) return;
    const all = new Float32Array(have);
    let o = 0;
    for (const b of buf) { all.set(b, o); o += b.length; }
    buf = [];
    have = 0;
    onChunk(floatToPcm16Base64(all, sr, rate));
  };
  let node;
  if (ctx.audioWorklet && typeof AudioWorkletNode === 'function') {
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
    try { await ctx.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
    node = new AudioWorkletNode(ctx, 'arigami-pcm', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
    node.port.onmessage = (e) => push(e.data);
  } else {
    node = ctx.createScriptProcessor(4096, 1, 1);
    node.onaudioprocess = (e) => push(e.inputBuffer.getChannelData(0).slice(0));
  }
  src.connect(node);
  node.connect(ctx.destination); // a ScriptProcessor only fires while connected; the worklet outputs silence
  return {
    mute(v) { muted = !!v; },
    stop() { try { src.disconnect(); } catch { /* ignore */ } try { node.disconnect(); } catch { /* ignore */ } if (node.port) node.port.onmessage = null; },
  };
}

/** Plays int16 chunks back to back on `ctx`; stop() drops what is queued (barge-in). */
export function pcmPlayer(ctx, rate = 24000) {
  let at = 0;
  let sources = [];
  let playing = 0;
  const api = {
    get playing() { return playing > 0; },
    play(b64) {
      const samples = pcm16Base64ToFloat(b64);
      if (!samples.length) return;
      const buffer = ctx.createBuffer(1, samples.length, rate);
      buffer.copyToChannel ? buffer.copyToChannel(samples, 0) : buffer.getChannelData(0).set(samples);
      const s = ctx.createBufferSource();
      s.buffer = buffer;
      s.connect(ctx.destination);
      const now = ctx.currentTime;
      if (at < now) at = now + 0.02;
      s.start(at);
      at += buffer.duration;
      playing++;
      sources.push(s);
      s.onended = () => { playing = Math.max(0, playing - 1); sources = sources.filter((x) => x !== s); api.onIdle?.(playing === 0); };
    },
    stop() {
      for (const s of sources) { try { s.onended = null; s.stop(); } catch { /* already done */ } }
      sources = [];
      playing = 0;
      at = 0;
    },
  };
  return api;
}
