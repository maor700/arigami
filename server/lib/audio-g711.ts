// G.711 μ-law ↔ 16-bit PCM and integer-ratio resampling, pure JS (the phone bridge: Twilio 8 kHz μ-law ↔ the clerk's PCM).
const BIAS = 0x84;
const CLIP = 32635;

const SEG = new Uint8Array(256);
for (let i = 0; i < 256; i++) SEG[i] = i < 2 ? 0 : i < 4 ? 1 : i < 8 ? 2 : i < 16 ? 3 : i < 32 ? 4 : i < 64 ? 5 : i < 128 ? 6 : 7;

export function mulawEncodeSample(s: number): number {
  let sign = (s >> 8) & 0x80;
  if (sign) s = -s;
  if (s > CLIP) s = CLIP;
  s += BIAS;
  const exponent = SEG[(s >> 7) & 0xff];
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

export function mulawDecodeSample(u: number): number {
  u = ~u & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  const s = (((mantissa << 3) + BIAS) << exponent) - BIAS;
  return sign ? -s : s;
}

const DECODE = new Int16Array(256);
for (let i = 0; i < 256; i++) DECODE[i] = mulawDecodeSample(i);

export function mulawDecode(u8: Uint8Array): Int16Array {
  const out = new Int16Array(u8.length);
  for (let i = 0; i < u8.length; i++) out[i] = DECODE[u8[i]];
  return out;
}
export function mulawEncode(pcm: Int16Array): Uint8Array {
  const out = new Uint8Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = mulawEncodeSample(pcm[i]);
  return out;
}

/** Integer-ratio resampling: up = linear interpolation, down = block average (a cheap anti-alias), else linear. */
export function resample(pcm: Int16Array, from: number, to: number): Int16Array {
  if (from === to || !pcm.length) return pcm;
  if (from % to === 0) {
    const f = from / to;
    const out = new Int16Array(Math.floor(pcm.length / f));
    for (let i = 0; i < out.length; i++) {
      let acc = 0;
      for (let j = 0; j < f; j++) acc += pcm[i * f + j];
      out[i] = Math.round(acc / f);
    }
    return out;
  }
  const ratio = from / to;
  const out = new Int16Array(Math.floor(pcm.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(pcm.length - 1, i0 + 1);
    const t = pos - i0;
    out[i] = Math.round(pcm[i0] * (1 - t) + pcm[i1] * t);
  }
  return out;
}

export const pcmToBuffer = (pcm: Int16Array): Buffer => Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
export function bufferToPcm(b: Buffer): Int16Array {
  const even = b.length - (b.length % 2);
  const copy = new Uint8Array(even);
  copy.set(b.subarray(0, even)); // realign: a Buffer slice may start at an odd offset
  return new Int16Array(copy.buffer);
}

/** Twilio μ-law 8 kHz (base64) → PCM16 at `rate` (base64). */
export function mulawB64ToPcmB64(b64: string, rate: number): string {
  const pcm8 = mulawDecode(new Uint8Array(Buffer.from(b64, 'base64')));
  return pcmToBuffer(resample(pcm8, 8000, rate)).toString('base64');
}
/** PCM16 at `rate` (base64) → Twilio μ-law 8 kHz (base64). */
export function pcmB64ToMulawB64(b64: string, rate: number): string {
  const pcm = bufferToPcm(Buffer.from(b64, 'base64'));
  return Buffer.from(mulawEncode(resample(pcm, rate, 8000))).toString('base64');
}
