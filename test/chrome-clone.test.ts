// A session's Chrome profile stays small. Cloning an agent's profile: the login comes along,
// the hundreds of MB Chrome can rebuild do not, and the seed is never written.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { cloneProfile, CLONE_EXCLUDE, sessionChromeArgs, LEAN_PROFILE_FEATURES_OFF } from '../server/lib/chrome.ts';
import { tmpDir } from './_tmp.js';

const LOGIN = [
  'Local State',
  'Default/Cookies',
  'Default/Login Data',
  'Default/Web Data',
  'Default/Preferences',
  'Default/Local Storage/leveldb/CURRENT',
  'Default/Session Storage/CURRENT',
  'Default/IndexedDB/https_app.example.com_0.indexeddb.leveldb/CURRENT',
  'Default/Storage/ext/abc/def/Local Storage/leveldb/CURRENT',
  'Default/Extensions/abc/1.0/manifest.json',
];
const REBUILT = [
  'Default/Cache/Cache_Data/data_0',
  'Default/Code Cache/js/index',
  'Default/GPUCache/data_1',
  'Default/DawnWebGPUCache/data_0',
  'Default/Service Worker/CacheStorage/x/index',
  'Default/Service Worker/ScriptCache/1',
  'Default/WebStorage/13/CacheStorage/y/index',
  'Default/Storage/ext/abc/def/Code Cache/js/index',
  'optimization_guide_model_store/43/E6/model.tflite',
  'component_crx_cache/abc',
  'WasmTtsEngine/20260917.1/engine.wasm',
  'OnDeviceHeadSuggestModel/1/model',
  'Safe Browsing/UrlMalware.store',
  'BrowserMetrics-spare.pma',
];

function files(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(path.relative(dir, p));
    }
  };
  walk(dir);
  return out.sort();
}

test('a cloned profile keeps every login file and drops what Chrome rebuilds', () => {
  const root = tmpDir('chrome-clone-');
  const seed = path.join(root, 'seed');
  for (const rel of [...LOGIN, ...REBUILT]) {
    fs.mkdirSync(path.dirname(path.join(seed, rel)), { recursive: true });
    fs.writeFileSync(path.join(seed, rel), rel);
  }
  // a running Chrome's lock is a dangling symlink; copying it must not throw
  fs.symlinkSync('host-1234', path.join(seed, 'SingletonLock'));
  const before = files(seed);

  const dest = path.join(root, 'session');
  cloneProfile(seed, dest);

  expect(files(dest)).toEqual([...LOGIN].sort());
  for (const rel of LOGIN) expect(fs.readFileSync(path.join(dest, rel), 'utf8')).toBe(rel);
  expect(fs.existsSync(path.join(dest, 'SingletonLock'))).toBe(false);
  expect(files(seed)).toEqual(before); // the seed is read, never written
});

test('nothing a login lives in is ever on the exclude list', () => {
  for (const name of ['Cookies', 'Login Data', 'Web Data', 'Local Storage', 'Session Storage', 'IndexedDB', 'Preferences', 'Local State', 'Default', 'Storage', 'WebStorage', 'Extensions'])
    expect(CLONE_EXCLUDE.has(name)).toBe(false);
});

test("a session's Chrome is told not to download on-device models — with ONE --disable-features", () => {
  const args = sessionChromeArgs('/p', 'https://example.com');
  const off = args.filter((a) => a.startsWith('--disable-features='));
  expect(off).toEqual([`--disable-features=${LEAN_PROFILE_FEATURES_OFF.join(',')}`]);
  expect(off[0]).toContain('OptimizationTargetPrediction');
  expect(args[0]).toBe('--user-data-dir=/p');
  expect(args.at(-1)).toBe('https://example.com');
  expect(sessionChromeArgs('/p').some((a) => !a.startsWith('--'))).toBe(false);
});
