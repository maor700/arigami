// Desktop wallpapers: every X11 desktop gets a photo tinted in its session's color, with the session's title in the
// corner, so a glance at a screenshot (or at two VNC views side by side) says which desktop it is.
//
// The photos are a closed set of CC0 landscapes in server/assets/wallpapers (grayscale, credits in CREDITS.md), plus
// any image the owner drops in <ARIGAMI_DIR>/user/wallpapers. A session's photo is picked from its id, so it stays the
// same across restarts; `metadata.wallpaper` pins one by file name, or `none` for a plain color.
//
// Rendering is one ffmpeg run (scale → gray → duotone in the session color → vignette → title) that writes raw BGRA
// into x11-wallpaper.py, which sets it as the root window's background through libX11. Without ffmpeg the desktop
// still gets the session color, flat. Nothing here may fail a desktop: every error ends as a logged no-op.
// ARIGAMI_DESKTOP_WALLPAPER=0 turns it off.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { resourceRoot } from './resource-root.js';
import { which } from './platform.js';
import { ARIGAMI_DIR } from './instance.js';

export const SCREEN = { w: 1280, h: 800 }; // the Xvfb geometry desktops.ts starts every desktop with
const IMAGE_EXT = /\.(jpe?g|png|webp)$/i;
const DEFAULT_COLOR = '#3D4B5C';
export const SHARED_DESKTOP = { title: 'Shared desktop', color: DEFAULT_COLOR, seed: 'shared-desktop' };

export const builtinWallpaperDir = (): string => path.join(resourceRoot(), 'server', 'assets', 'wallpapers');
export const userWallpaperDir = (): string => path.join(ARIGAMI_DIR, 'user', 'wallpapers');

/** Every wallpaper image in `dirs`, builtin first, each dir sorted — the order `pickWallpaper` indexes into. */
export function listWallpapers(dirs: string[] = [builtinWallpaperDir(), userWallpaperDir()]): string[] {
  const out: string[] = [];
  for (const d of dirs) {
    let names: string[] = [];
    try { names = fs.readdirSync(d).filter((n) => IMAGE_EXT.test(n)).sort(); } catch { continue; }
    for (const n of names) out.push(path.join(d, n));
  }
  return out;
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

/** The image for `seed`: `override` by file name (with or without extension) when it exists, else stable by hash. `none` → no image. */
export function pickWallpaper(seed: string, list: string[], override?: unknown): string | null {
  if (override === 'none') return null;
  if (typeof override === 'string' && override) {
    const hit = list.find((p) => path.basename(p) === override || path.basename(p).replace(IMAGE_EXT, '') === override);
    if (hit) return hit;
  }
  return list.length ? list[fnv1a(seed) % list.length] : null;
}

export function parseColor(color: unknown): { r: number; g: number; b: number } {
  const m = /^#?([0-9a-f]{6})$/i.exec(typeof color === 'string' ? color.trim() : '') || /^#?([0-9a-f]{6})$/i.exec(DEFAULT_COLOR)!;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** Duotone: black maps to a quarter of the color, white to the color 60% of the way to white. lutrgb expressions over a gray input. */
export function duotone(color: unknown): { r: string; g: string; b: string } {
  const c = parseColor(color);
  const ch = (v: number) => {
    const lo = Math.round(v / 4);
    const hi = Math.round(v + (255 - v) * 0.6);
    return `${lo}+${hi - lo}*val/255`;
  };
  return { r: ch(c.r), g: ch(c.g), b: ch(c.b) };
}

/** The title as drawn: one line, cut at 48 characters, the font shrinking with length so it fits the screen. */
export function fitTitle(title: unknown): { text: string; size: number } {
  let text = String(title ?? '').replace(/\s+/g, ' ').trim();
  if ([...text].length > 48) text = [...text].slice(0, 47).join('').trimEnd() + '…';
  const len = Math.max(1, [...text].length);
  const size = Math.max(32, Math.min(64, Math.round(1100 / (len * 0.56))));
  return { text, size };
}

// ffmpeg parses an option value, then the filtergraph around it: escape for both levels.
const ffEscape = (v: string): string => v.replace(/[\\':]/g, '\\$&').replace(/[\\'[\],;]/g, '\\$&');

let fontCache: string | null | undefined;
/** A bold face that has both Latin and Hebrew (titles mix them); the image ships fonts-liberation. */
function titleFont(): string | null {
  if (fontCache !== undefined) return fontCache;
  fontCache = null;
  try {
    const f = execFileSync('fc-match', ['-f', '%{file}', 'Liberation Sans:bold'], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).toString().trim();
    if (f && fs.existsSync(f)) fontCache = f;
  } catch { /* no fontconfig: drawtext's default face */ }
  return fontCache;
}

export interface FfmpegArgsIn { image: string; color: unknown; titleFile: string; titleSize: number; subtitleFile: string; font: string | null; w?: number; h?: number }

/** ffmpeg arguments for one wallpaper, raw BGRA on stdout. */
export function ffmpegArgs(o: FfmpegArgsIn): string[] {
  const w = o.w ?? SCREEN.w;
  const h = o.h ?? SCREEN.h;
  const lut = duotone(o.color);
  const font = o.font ? `fontfile=${ffEscape(o.font)}:` : '';
  const vf = [
    `scale=${w}:${h}:force_original_aspect_ratio=increase`,
    `crop=${w}:${h}`,
    'format=gray',
    'eq=contrast=1.1',
    'format=rgb24',
    `lutrgb=r=${ffEscape(lut.r)}:g=${ffEscape(lut.g)}:b=${ffEscape(lut.b)}`,
    'vignette=PI/5',
    `drawtext=${font}textfile=${ffEscape(o.titleFile)}:fontcolor=white:shadowcolor=black@0.5:shadowx=2:shadowy=2:fontsize=${o.titleSize}:x=w-tw-48:y=h-th-150`,
    `drawtext=${font}textfile=${ffEscape(o.subtitleFile)}:fontcolor=white@0.85:fontsize=22:x=w-tw-50:y=h-th-112`,
  ].join(',');
  return ['-loglevel', 'error', '-nostdin', '-i', o.image, '-frames:v', '1', '-vf', vf, '-f', 'rawvideo', '-pix_fmt', 'bgra', 'pipe:1'];
}

/** A flat BGRA frame in the color — the wallpaper when there is no ffmpeg or no image. */
export function solidPixels(color: unknown, w = SCREEN.w, h = SCREEN.h): Buffer {
  const c = parseColor(color);
  const px = Buffer.from([c.b, c.g, c.r, 255]);
  const buf = Buffer.allocUnsafe(w * h * 4);
  for (let i = 0; i < buf.length; i += 4) px.copy(buf, i);
  return buf;
}

export interface PaintIn { display: string; color: unknown; title: unknown; subtitle: string; seed: string; override?: unknown }
export type PaintResult = { ok: true; image: string | null } | { ok: false; reason: string };

/** Paint `display`'s background. Resolves, never rejects. */
export async function paintDesktop(p: PaintIn, env: NodeJS.ProcessEnv = process.env): Promise<PaintResult> {
  if (env.ARIGAMI_DESKTOP_WALLPAPER === '0') return { ok: false, reason: 'ARIGAMI_DESKTOP_WALLPAPER=0' };
  if (process.platform !== 'linux') return { ok: false, reason: 'not linux' };
  const python = which('python3');
  if (!python) return { ok: false, reason: 'python3 not installed' };
  const setter = path.join(resourceRoot(), 'server', 'lib', 'x11-wallpaper.py');
  const ffmpeg = which('ffmpeg');
  const image = ffmpeg ? pickWallpaper(p.seed, listWallpapers(), p.override) : null;
  const denv = { ...env, DISPLAY: p.display };
  try {
    if (!ffmpeg || !image) {
      await run(python, [setter, String(SCREEN.w), String(SCREEN.h)], denv, solidPixels(p.color));
      return { ok: true, image: null };
    }
    // drawtext reads the text from files: no escaping of whatever the title holds.
    const dir = path.join(ARIGAMI_DIR, 'desktop', 'wallpaper');
    fs.mkdirSync(dir, { recursive: true });
    const tag = p.display.replace(/[^0-9]/g, '') || 'x';
    const { text, size } = fitTitle(p.title);
    const titleFile = path.join(dir, `${tag}-title.txt`);
    const subtitleFile = path.join(dir, `${tag}-subtitle.txt`);
    fs.writeFileSync(titleFile, text);
    fs.writeFileSync(subtitleFile, p.subtitle);
    const args = ffmpegArgs({ image, color: p.color, titleFile, titleSize: size, subtitleFile, font: titleFont() });
    await pipe(ffmpeg, args, python, [setter, String(SCREEN.w), String(SCREEN.h)], denv);
    return { ok: true, image };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}

function waitExit(proc: ReturnType<typeof spawn>, name: string, stderr: () => string): Promise<void> {
  return new Promise((resolve, reject) => {
    proc.on('error', reject);
    proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${name} exited ${code}: ${stderr().trim().slice(-300)}`))));
  });
}

function collect(proc: ReturnType<typeof spawn>): () => string {
  let err = '';
  proc.stderr?.on('data', (d) => { if (err.length < 4096) err += d; });
  return () => err;
}

const TIMEOUT_MS = 20000;

function withTimeout<T>(p: Promise<T>, procs: ReturnType<typeof spawn>[]): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    t = setTimeout(() => { for (const x of procs) x.kill('SIGKILL'); reject(new Error('wallpaper timed out')); }, TIMEOUT_MS);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv, input: Buffer): Promise<void> {
  const proc = spawn(cmd, args, { env, stdio: ['pipe', 'ignore', 'pipe'] });
  const err = collect(proc);
  proc.stdin!.on('error', () => {}); // a setter that died early surfaces through its exit code
  proc.stdin!.end(input);
  return withTimeout(waitExit(proc, path.basename(args[0] || cmd), err), [proc]);
}

function pipe(cmdA: string, argsA: string[], cmdB: string, argsB: string[], env: NodeJS.ProcessEnv): Promise<void> {
  const a = spawn(cmdA, argsA, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const b = spawn(cmdB, argsB, { env, stdio: ['pipe', 'ignore', 'pipe'] });
  const errA = collect(a);
  const errB = collect(b);
  b.stdin!.on('error', () => {});
  a.stdout!.pipe(b.stdin!);
  return withTimeout(Promise.all([waitExit(a, 'ffmpeg', errA), waitExit(b, path.basename(argsB[0] || cmdB), errB)]).then(() => {}), [a, b]);
}
