// Minimal PNG encoder (RGBA8, non-interlaced) on top of node:zlib — enough to
// turn a raw framebuffer into a file without pulling in an image library.
// Used by the screenshot pipeline (server/vnc.ts → screenshots.ts).
import zlib from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}

// `rgba` is width*height*4 bytes, row-major. Alpha is forced opaque (VNC
// framebuffers carry padding, not alpha, in the 4th byte).
export function encodePng(rgba: Buffer, width: number, height: number): Buffer {
  if (rgba.length < width * height * 4) throw new Error('encodePng: buffer too small');
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const dst = y * (stride + 1);
    raw[dst] = 0; // filter: none
    rgba.copy(raw, dst + 1, y * stride, y * stride + stride);
    for (let x = dst + 4; x <= dst + stride; x += 4) raw[x] = 0xff;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Nearest-neighbour downscale by an integer factor — used to keep the
// periodic Watch-mode snapshots small on disk.
export function downscaleRgba(rgba: Buffer, width: number, height: number, factor: number) {
  if (factor <= 1) return { rgba, width, height };
  const w = Math.max(1, Math.floor(width / factor));
  const h = Math.max(1, Math.floor(height / factor));
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const srcRow = y * factor * width * 4;
    for (let x = 0; x < w; x++) {
      const s = srcRow + x * factor * 4;
      const d = (y * w + x) * 4;
      out[d] = rgba[s]; out[d + 1] = rgba[s + 1]; out[d + 2] = rgba[s + 2]; out[d + 3] = 0xff;
    }
  }
  return { rgba: out, width: w, height: h };
}

// Fraction (0..1) of sampled pixels that differ noticeably between two RGBA
// frames of the same size — the "did the screen actually change?" test behind
// auto-snapshot throttling and capture_screen dedup (T9). Samples a grid of
// ~`samples` pixels rather than every one (a 1280x800 frame is 1M pixels; the
// cursor moving or a blinking caret shouldn't count, a page navigation
// should). Returns 1 when the sizes differ.
export function frameDiffRatio(a: Buffer, b: Buffer, width: number, height: number, samples = 20_000, tolerance = 24): number {
  if (a.length !== b.length || a.length < width * height * 4) return 1;
  const total = width * height;
  const step = Math.max(1, Math.floor(total / samples));
  let n = 0, changed = 0;
  for (let p = 0; p < total; p += step) {
    const o = p * 4;
    const d = Math.abs(a[o] - b[o]) + Math.abs(a[o + 1] - b[o + 1]) + Math.abs(a[o + 2] - b[o + 2]);
    if (d > tolerance) changed++;
    n++;
  }
  return n ? changed / n : 0;
}
