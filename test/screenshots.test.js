// T3 screenshots: the dependency-free PNG encoder produces a well-formed file,
// and the retention sweep enforces age + size limits oldest-first.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { encodePng, downscaleRgba, frameDiffRatio } from '../server/lib/png.ts';
import { runInChild } from './_child.js';

test('encodePng writes a valid RGBA8 PNG', () => {
  const w = 3, h = 2;
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) { rgba[i * 4] = i * 40; rgba[i * 4 + 1] = 20; rgba[i * 4 + 2] = 200; rgba[i * 4 + 3] = 0; }
  const png = encodePng(rgba, w, h);
  expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  // IHDR
  expect(png.subarray(12, 16).toString('ascii')).toBe('IHDR');
  expect(png.readUInt32BE(16)).toBe(w);
  expect(png.readUInt32BE(20)).toBe(h);
  expect(png[24]).toBe(8);
  expect(png[25]).toBe(6);
  // IDAT inflates to (w*4+1)*h bytes with filter byte 0 per row and opaque alpha
  const idatLen = png.readUInt32BE(33);
  expect(png.subarray(37, 41).toString('ascii')).toBe('IDAT');
  const raw = zlib.inflateSync(png.subarray(41, 41 + idatLen));
  expect(raw.length).toBe((w * 4 + 1) * h);
  expect(raw[0]).toBe(0);
  expect(raw[4]).toBe(0xff); // alpha of pixel 0
  expect(raw[1]).toBe(0); expect(raw[2]).toBe(20); expect(raw[3]).toBe(200);
  expect(png.subarray(-8, -4).toString('ascii')).toBe('IEND');
});

test('downscaleRgba halves dimensions with nearest-neighbour sampling', () => {
  const rgba = Buffer.alloc(4 * 4 * 4, 7);
  const d = downscaleRgba(rgba, 4, 4, 2);
  expect(d.width).toBe(2); expect(d.height).toBe(2);
  expect(d.rgba.length).toBe(16);
  expect(d.rgba[0]).toBe(7); expect(d.rgba[3]).toBe(0xff);
});

// T9: change detection behind auto-snapshot throttling and capture_screen dedup.
test('frameDiffRatio: identical → 0, cursor-sized change → tiny, half repaint → ~0.5, size mismatch → 1', () => {
  const w = 100, h = 100;
  const a = Buffer.alloc(w * h * 4, 0x40);
  expect(frameDiffRatio(a, a, w, h)).toBe(0);
  const b = Buffer.from(a);
  for (let i = 0; i < 16 * 16; i++) b[i * 4] = 0xff; // a 16x16 cursor-ish blob
  expect(frameDiffRatio(a, b, w, h)).toBeLessThan(0.03);
  const c = Buffer.from(a);
  c.fill(0xc0, 0, (w * h * 4) / 2); // top half repainted
  const r = frameDiffRatio(a, c, w, h);
  expect(r).toBeGreaterThan(0.45); expect(r).toBeLessThan(0.55);
  expect(frameDiffRatio(a, Buffer.alloc(10), w, h)).toBe(1);
  // sub-tolerance noise (compression jitter) does not count
  const d = Buffer.from(a); for (let i = 0; i < d.length; i += 4) d[i] += 3;
  expect(frameDiffRatio(a, d, w, h)).toBe(0);
});

test('judgeFrame: below threshold → duplicate; above but too soon → throttled (auto only); else record', () => {
  const r = runInChild(
    "const {judgeFrame}=await import('./server/screenshots.ts');" +
      "const P={threshold:0.03,minIntervalMs:30000};" +
      'emit({dup:judgeFrame(0.01,60000,P,true),thr:judgeFrame(0.2,5000,P,true),rec:judgeFrame(0.2,60000,P,true),manualSoon:judgeFrame(0.2,5000,P,false),manualDup:judgeFrame(0.0,5000,P,false)});',
    { ARIGAMI_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-judge-')) }
  );
  if (!r.ok) throw new Error(r.error);
  expect(r.out[0]).toEqual({ dup: 'duplicate', thr: 'throttled', rec: 'record', manualSoon: 'record', manualDup: 'duplicate' });
});

// screenshots.ts imports state.js (side effects) → isolate in a child.
function sweep(setup) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-screens-'));
  const root = path.join(dir, 'screens');
  setup(root);
  const r = runInChild(
    "const {sweepScreensDir}=await import('./server/screenshots.ts');" +
      `const r=sweepScreensDir(${JSON.stringify(root)}, 7*86400000, 1000, 1_000_000_000);` +
      "const fs=await import('node:fs');const left=[];for(const s of fs.existsSync(" + JSON.stringify(root) + ")?fs.readdirSync(" + JSON.stringify(root) + "):[]){for(const f of fs.readdirSync(" + JSON.stringify(root) + "+'/'+s))left.push(s+'/'+f)}" +
      'emit({r,left:left.sort()});',
    { ARIGAMI_DIR: dir }
  );
  if (!r.ok) throw new Error(r.error);
  return r.out[0];
}

test('sweepScreensDir drops files past max age and trims oldest-first to the byte cap', () => {
  const NOW = 1_000_000_000;
  const out = sweep((root) => {
    const a = path.join(root, 'sess_a'), b = path.join(root, 'sess_b');
    fs.mkdirSync(a, { recursive: true }); fs.mkdirSync(b, { recursive: true });
    // too old (8 days): removed by age
    fs.writeFileSync(path.join(a, `${NOW - 8 * 86400000}.png`), Buffer.alloc(100));
    // recent, but together over the 1000-byte cap: oldest goes first
    fs.writeFileSync(path.join(a, `${NOW - 3000}.png`), Buffer.alloc(600));
    fs.writeFileSync(path.join(b, `${NOW - 2000}.png`), Buffer.alloc(600));
    fs.writeFileSync(path.join(b, `${NOW - 1000}.png`), Buffer.alloc(300));
    fs.writeFileSync(path.join(b, 'notes.txt'), 'ignored');
  });
  expect(out.r.removed).toBe(2);
  expect(out.r.bytesFreed).toBe(700);
  expect(out.left).toEqual([`sess_b/${NOW - 1000}.png`, `sess_b/${NOW - 2000}.png`, 'sess_b/notes.txt'].sort());
});
