// The native-window ScreenDriver, plus pickDriver()'s platform/override
// branch — its acceptance bar is "unchanged on Linux, native-window
// everywhere else". screen-driver.ts pulls in chrome.ts/chrome-cdp.ts/
// screencast.ts, which pull in state.js (side effects at import) — isolate
// in a child with its own tmp ARIGAMI_DIR, same as desktops.test.js.
// No real Chrome is spawned here (that's covered by a live check, not a
// unit test) — every case below either needs no Chrome at all, or exercises
// the "no Chrome tab for this session" error path on purpose.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInChild } from './_child.js';

function inChild(body: string, env: Record<string, string> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-nwd-'));
  const r = runInChild(body, {
    ARIGAMI_DIR: dir,
    ARIGAMI_PORT: '',
    ARIGAMI_WA_AUTOSTART: '0',
    ARIGAMI_WA_DATA_DIR: path.join(dir, 'wa'),
    ...env,
  });
  if (!r.ok) throw new Error(r.error);
  return r.out[0];
}

test('pickDriver: linux + not a compiled binary → x11, exactly like before this driver existed', () => {
  const out = inChild(
    "const {pickDriver}=await import('./server/lib/screen-driver.ts');" +
    "emit({id: pickDriver(process.env, 'linux').id});"
  );
  expect(out.id).toBe('x11');
});

test('pickDriver: any non-linux platform → native-window', () => {
  const out = inChild(
    "const {pickDriver}=await import('./server/lib/screen-driver.ts');" +
    "emit({darwin: pickDriver(process.env, 'darwin').id, win32: pickDriver(process.env, 'win32').id});"
  );
  expect(out.darwin).toBe('native-window');
  expect(out.win32).toBe('native-window');
});

test('pickDriver: ARIGAMI_SCREEN_DRIVER overrides the platform decision either way', () => {
  const out = inChild(
    "const {pickDriver}=await import('./server/lib/screen-driver.ts');" +
    "emit({" +
    "forcedNative: pickDriver({ARIGAMI_SCREEN_DRIVER:'native-window'}, 'linux').id," +
    "forcedX11: pickDriver({ARIGAMI_SCREEN_DRIVER:'x11'}, 'darwin').id" +
    "});"
  );
  expect(out.forcedNative).toBe('native-window');
  expect(out.forcedX11).toBe('x11');
});

test('native driver: browserLaunch never adds DISPLAY and never maximizes', () => {
  const out = inChild(
    "const {createNativeDriver}=await import('./server/lib/screen-driver-native.ts');" +
    "const d=createNativeDriver();" +
    "const {env,extraArgs}=await d.browserLaunch('s1');" +
    "emit({displayUnset: env.DISPLAY===undefined, extraArgs});"
  );
  expect(out.displayUnset).toBe(true);
  expect(out.extraArgs).not.toContain('--start-maximized');
  expect(out.extraArgs.some((a: string) => a.startsWith('--window-size='))).toBe(true);
  expect(out.extraArgs.some((a: string) => a.startsWith('--window-position='))).toBe(true);
});

test('native driver: peek/childEnv/viewer carry no per-session display state', () => {
  const out = inChild(
    "const {createNativeDriver}=await import('./server/lib/screen-driver-native.ts');" +
    "const d=createNativeDriver();" +
    "emit({" +
    "peek: d.peek('s1')," +
    "peekNull: d.peek(null)," +
    "childEnv: await d.childEnv('s1')," +
    "viewer: await d.viewer('s1')," +
    "viewerNoSession: await d.viewer(null)" +
    "});"
  );
  expect(out.peek).toEqual({ kind: 'native-window' });
  expect(out.peekNull).toBeNull();
  expect(out.childEnv).toEqual({});
  expect(out.viewer).toEqual({ transport: 'screencast', path: '/__screencast?session=s1' });
  expect(out.viewerNoSession).toEqual({ transport: 'screencast', path: '/__screencast' });
});

test('native driver: ensure/release/handBack are no-ops that never throw', () => {
  const out = inChild(
    "const {createNativeDriver}=await import('./server/lib/screen-driver-native.ts');" +
    "const d=createNativeDriver();" +
    "const h=await d.ensure('s1');" +
    "d.release('s1');" +
    "const hb=await d.handBack('s1');" +
    "emit({h, hbUndefined: hb===undefined});"
  );
  expect(out.h).toEqual({ kind: 'native-window' });
  expect(out.hbUndefined).toBe(true);
});

test('native driver: typeText rejects empty text before touching CDP', () => {
  const out = inChild(
    "const {createNativeDriver}=await import('./server/lib/screen-driver-native.ts');" +
    "const d=createNativeDriver();" +
    "let err=null; try{await d.typeText('s1','');}catch(e){err=String(e.message||e);}" +
    "emit({err});"
  );
  expect(out.err).toMatch(/empty text/);
});

test('native driver: capture/typeText/handOver surface a clear error with no Chrome tab (no XTEST-style fallback)', () => {
  const out = inChild(
    "const {createNativeDriver}=await import('./server/lib/screen-driver-native.ts');" +
    "const d=createNativeDriver();" +
    "let captureErr=null, typeErr=null;" +
    "try{await d.capture('no-such-session');}catch(e){captureErr=String(e.message||e);}" +
    "try{await d.typeText('no-such-session','hi');}catch(e){typeErr=String(e.message||e);}" +
    "const handOver=await d.handOver('no-such-session');" +
    "emit({captureErr, typeErr, handOver});"
  );
  expect(out.captureErr).toMatch(/browser_open/);
  expect(out.typeErr).toMatch(/browser_open/);
  expect(out.handOver.focused).toBe(false);
  expect(out.handOver.note).toMatch(/browser_open/);
});
