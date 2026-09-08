// A config.json that parses to a non-object (JSON `null`, an array, or a
// truncated write) must not crash config.js at import — the whole server boots
// through this module, so a throw here bricks the host. Runs in a child process
// so its ARIGAMI_DIR doesn't leak into the shared test registry.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInChild } from './_child.js';

function withConfig(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-cfg-'));
  fs.writeFileSync(path.join(dir, 'config.json'), contents);
  return runInChild(
    "const {cfg,DEFAULTS}=await import('./server/lib/config.js');" +
      'emit({port:cfg.port,defaultPort:DEFAULTS.port,hasConfigDir:typeof cfg.configDir});',
    // ARIGAMI_PORT may be set in the outer env (a host session) — it must not
    // leak into "what does a config-less instance default to".
    { ARIGAMI_DIR: dir, ARIGAMI_PORT: '' }
  );
}

test('null config.json loads defaults instead of crashing', () => {
  const r = withConfig('null');
  expect(r.ok).toBe(true);
  expect(r.out[0].port).toBe(r.out[0].defaultPort);
  expect(r.out[0].hasConfigDir).toBe('string');
});

test('array config.json loads defaults instead of crashing', () => {
  const r = withConfig('[1,2,3]');
  expect(r.ok).toBe(true);
  expect(r.out[0].port).toBe(r.out[0].defaultPort);
});

test('garbage config.json loads defaults instead of crashing', () => {
  const r = withConfig('{not json');
  expect(r.ok).toBe(true);
  expect(r.out[0].port).toBe(r.out[0].defaultPort);
});

// Platform-bugs fix: screen.enabled used to default to `true` everywhere,
// which on macOS/Windows (no Xvfb/x11vnc) sent every browser-opening session
// straight into desktops.ts's ENOENT/timeout loop. defaultScreenEnabled() is
// the pure, platform-injectable gate behind DEFAULTS.screen.enabled.
test('defaultScreenEnabled: only linux defaults to true', () => {
  const r = runInChild(
    "const {defaultScreenEnabled}=await import('./server/lib/config.js');" +
      'emit({linux:defaultScreenEnabled("linux"),darwin:defaultScreenEnabled("darwin"),win32:defaultScreenEnabled("win32")});'
  );
  expect(r.ok).toBe(true);
  expect(r.out[0]).toEqual({ linux: true, darwin: false, win32: false });
});

test('cfg.screen.enabled follows the real process.platform when ARIGAMI_SCREEN_ENABLED is unset', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-cfg-'));
  const r = runInChild(
    "const {cfg}=await import('./server/lib/config.js');emit({enabled:cfg.screen.enabled});",
    { ARIGAMI_DIR: dir, ARIGAMI_PORT: '', ARIGAMI_SCREEN_ENABLED: '' }
  );
  expect(r.ok).toBe(true);
  expect(r.out[0].enabled).toBe(process.platform === 'linux');
});

test('ARIGAMI_SCREEN_ENABLED=1 still forces screen on regardless of platform default', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-cfg-'));
  const r = runInChild(
    "const {cfg}=await import('./server/lib/config.js');emit({enabled:cfg.screen.enabled});",
    { ARIGAMI_DIR: dir, ARIGAMI_PORT: '', ARIGAMI_SCREEN_ENABLED: '1' }
  );
  expect(r.ok).toBe(true);
  expect(r.out[0].enabled).toBe(true);
});

test('ARIGAMI_SCREEN_ENABLED=0 still forces screen off on linux', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-cfg-'));
  const r = runInChild(
    "const {cfg}=await import('./server/lib/config.js');emit({enabled:cfg.screen.enabled});",
    { ARIGAMI_DIR: dir, ARIGAMI_PORT: '', ARIGAMI_SCREEN_ENABLED: '0' }
  );
  expect(r.ok).toBe(true);
  expect(r.out[0].enabled).toBe(false);
});
