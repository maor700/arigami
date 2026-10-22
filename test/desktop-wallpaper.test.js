// Desktop wallpapers (server/lib/desktop-wallpaper.ts): the photo pick, the duotone and the title fit are pure; the
// paint itself runs against a real throwaway Xvfb when the machine has Xvfb, ffmpeg and python3, and checks the
// pixels that ended up on the root window. The module reads ARIGAMI_DIR at import → isolate in a child.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { runInChild } from './_child.js';
import { tmpDir } from './_tmp.js';

function inChild(body, env = {}) {
  const dir = tmpDir('arigami-wallpaper-');
  const r = runInChild("const w=await import('./server/lib/desktop-wallpaper.ts');" + body, { ARIGAMI_DIR: dir, ARIGAMI_PORT: '', ...env });
  if (!r.ok) throw new Error(r.error);
  return r.out[0];
}

test('the builtin set is there, credited, and every session gets a stable pick from it', () => {
  const o = inChild(
    "const list=w.listWallpapers([w.builtinWallpaperDir()]);" +
      "emit({n:list.length,credits:require('node:fs').readFileSync(require('node:path').join(w.builtinWallpaperDir(),'CREDITS.md'),'utf8')," +
      "a1:w.pickWallpaper('sess_a',list),a2:w.pickWallpaper('sess_a',list),picks:new Set(['sess_a','sess_b','sess_c','sess_d','sess_e','sess_f'].map(s=>w.pickWallpaper(s,list))).size," +
      "pinned:w.pickWallpaper('sess_a',list,'desert-dunes'),pinnedExt:w.pickWallpaper('sess_a',list,'desert-dunes.jpg'),missing:w.pickWallpaper('sess_a',list,'nope')," +
      "none:w.pickWallpaper('sess_a',list,'none'),empty:w.pickWallpaper('sess_a',[])});"
  );
  expect(o.n).toBeGreaterThanOrEqual(10);
  for (const f of fs.readdirSync(path.join(import.meta.dir, '..', 'server', 'assets', 'wallpapers')).filter((n) => n.endsWith('.jpg')))
    expect(o.credits).toContain('`' + f + '`'); // every shipped photo has its source and license listed
  expect(o.a1).toBe(o.a2);
  expect(o.picks).toBeGreaterThan(1);
  expect(path.basename(o.pinned)).toBe('desert-dunes.jpg');
  expect(o.pinnedExt).toBe(o.pinned);
  expect(o.missing).toBe(o.a1); // an unknown pin falls back to the hashed pick
  expect(o.none).toBeNull();
  expect(o.empty).toBeNull();
});

test("the owner's own images join the builtin set", () => {
  const dir = tmpDir('arigami-wallpaper-user-');
  fs.writeFileSync(path.join(dir, 'mine.png'), 'x');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
  const o = inChild(`const list=w.listWallpapers([w.builtinWallpaperDir(), ${JSON.stringify(dir)}]);emit({names:list.map(p=>require('node:path').basename(p)),pin:w.pickWallpaper('s',list,'mine')});`);
  expect(o.names).toContain('mine.png');
  expect(o.names).not.toContain('notes.txt');
  expect(path.basename(o.pin)).toBe('mine.png');
});

test('duotone, color parsing, title fit and the flat fallback', () => {
  const o = inChild(
    "emit({lut:w.duotone('#1F9C82'),bad:w.parseColor('teal'),c:w.parseColor('1f9c82'),short:w.fitTitle('  Linear   UI '),long:w.fitTitle('x'.repeat(80)),heb:w.fitTitle('שיפורים אריגמי'),empty:w.fitTitle(undefined)," +
      "px:[...w.solidPixels('#1F9C82',2,1)],args:w.ffmpegArgs({image:'/a b/p.jpg',color:'#1F9C82',titleFile:'/t/x:1.txt',titleSize:50,subtitleFile:'/t/s.txt',font:null})});"
  );
  expect(o.lut).toEqual({ r: '8+157*val/255', g: '39+176*val/255', b: '33+172*val/255' });
  expect(o.bad).toEqual({ r: 0x3d, g: 0x4b, b: 0x5c }); // an unparseable color → the neutral default
  expect(o.c).toEqual({ r: 31, g: 156, b: 130 });
  expect(o.short).toEqual({ text: 'Linear UI', size: 64 });
  expect([...o.long.text].length).toBe(48);
  expect(o.long.text.endsWith('…')).toBe(true);
  expect(o.long.size).toBe(41);
  expect(o.heb.size).toBe(64);
  expect(o.empty.text).toBe('');
  expect(o.px).toEqual([130, 156, 31, 255, 130, 156, 31, 255]); // BGRA
  const vf = o.args[o.args.indexOf('-vf') + 1];
  expect(vf).toContain('textfile=/t/x\\\\:1.txt'); // ':' escaped for the option level, then its '\\' for the graph level
  expect(vf).toContain('lutrgb=r=8+157*val/255');
  expect(o.args.slice(-5)).toEqual(['-f', 'rawvideo', '-pix_fmt', 'bgra', 'pipe:1']);
});

test('ARIGAMI_DESKTOP_WALLPAPER=0 turns it off', () => {
  const o = inChild("emit(await w.paintDesktop({display:':1',color:'#000000',title:'t',subtitle:'s',seed:'s'},{ARIGAMI_DESKTOP_WALLPAPER:'0'}));");
  expect(o).toEqual({ ok: false, reason: 'ARIGAMI_DESKTOP_WALLPAPER=0' });
});

const has = (bin) => spawnSync('sh', ['-c', `command -v ${bin}`]).status === 0;
const canPaint = process.platform === 'linux' && ['Xvfb', 'ffmpeg', 'python3'].every(has);

// The root window's pixel at (x, y), read back through ffmpeg's x11grab.
function pixel(display, x, y) {
  const r = spawnSync('ffmpeg', ['-loglevel', 'error', '-f', 'x11grab', '-video_size', '1x1', '-i', `${display}+${x},${y}`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']);
  return [...r.stdout];
}

test.if(canPaint)('paints a real Xvfb: a tinted photo, a flat color for `none`', async () => {
  let n = 230;
  while (fs.existsSync(`/tmp/.X${n}-lock`) && n < 260) n++;
  const display = `:${n}`;
  const xvfb = spawn('Xvfb', [display, '-screen', '0', '1280x800x24', '-nolisten', 'tcp'], { stdio: 'ignore' });
  try {
    for (let i = 0; i < 50 && !fs.existsSync(`/tmp/.X11-unix/X${n}`); i++) await new Promise((r) => setTimeout(r, 100));
    expect(pixel(display, 640, 300)).toEqual([0, 0, 0]); // a fresh Xvfb root is black

    const photo = inChild(`emit(await w.paintDesktop({display:'${display}',color:'#1F9C82',title:'שיפורים · Arigami',subtitle:'s · ${display}',seed:'sess_test'}));`);
    expect(photo.ok).toBe(true);
    expect(path.basename(photo.image)).toMatch(/\.jpg$/);
    const [r, g, b] = pixel(display, 640, 300);
    expect(g).toBeGreaterThan(r); // green-teal tint: G and B lead R, as in #1F9C82
    expect(b).toBeGreaterThan(r);

    const flat = inChild(`emit(await w.paintDesktop({display:'${display}',color:'#C2459E',title:'t',subtitle:'s',seed:'x',override:'none'}));`);
    expect(flat).toEqual({ ok: true, image: null });
    expect(pixel(display, 640, 300)).toEqual([0xc2, 0x45, 0x9e]);
  } finally {
    xvfb.kill('SIGKILL');
  }
}, 30000);
