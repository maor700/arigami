// Platform-bugs fix: Chrome/Chromium binary lookup (server/lib/platform.ts),
// shared by lib/chrome.ts's chromeBin() (the actual launch) and
// onboarding.ts's chromeVersionSync() (the health-check probe). Before this,
// chromeBin() was a hardcoded `CHROME_BIN || 'google-chrome'` — nonexistent on
// macOS/Windows — and onboarding.ts had its own separate (Linux-only) probe
// list. Pure functions, no side effects: safe to import directly (no
// runInChild isolation needed, unlike config.js/state.js).
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromeCandidates, findChromeBin } from '../server/lib/platform.ts';

test('chromeCandidates: CHROME_BIN then ARIGAMI_CHROME_BIN always come first, on every platform', () => {
  const env = { CHROME_BIN: '/custom/chrome', ARIGAMI_CHROME_BIN: '/other/chrome' };
  for (const platform of ['linux', 'darwin', 'win32'] as const) {
    const c = chromeCandidates(env, platform);
    expect(c[0]).toBe('/custom/chrome');
    expect(c[1]).toBe('/other/chrome');
  }
});

test('chromeCandidates: linux keeps the exact pre-existing order (google-chrome before the rest)', () => {
  expect(chromeCandidates({}, 'linux')).toEqual(['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']);
});

test('chromeCandidates: darwin tries the /Applications bundle, then falls back to PATH names', () => {
  const c = chromeCandidates({}, 'darwin');
  expect(c[0]).toBe('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  expect(c).toContain('google-chrome');
  expect(c).toContain('chromium');
});

test('chromeCandidates: win32 tries Program Files locations, then bare "chrome"/"chromium"', () => {
  const c = chromeCandidates({}, 'win32');
  expect(c).toContain('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
  expect(c).toContain('C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe');
  expect(c[c.length - 2]).toBe('chrome');
  expect(c[c.length - 1]).toBe('chromium');
});

test('findChromeBin: resolves an absolute CHROME_BIN override that exists on disk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-chrome-'));
  const fake = path.join(dir, 'my-chrome');
  fs.writeFileSync(fake, '#!/bin/sh\n');
  expect(findChromeBin({ CHROME_BIN: fake }, 'linux')).toBe(fake);
});

test('findChromeBin: an absolute candidate that does not exist is skipped, not returned', () => {
  const missing = '/definitely/does/not/exist/chrome-binary';
  // No PATH names will match a random nonsense platform's list either, once
  // the absolute override is confirmed skipped.
  expect(findChromeBin({ CHROME_BIN: missing, PATH: '' }, 'darwin')).not.toBe(missing);
});

test('findChromeBin: falls through in order — a missing CHROME_BIN does not block ARIGAMI_CHROME_BIN', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-chrome-'));
  const fake = path.join(dir, 'fallback-chrome');
  fs.writeFileSync(fake, '#!/bin/sh\n');
  const found = findChromeBin({ CHROME_BIN: '/nope/nope/nope', ARIGAMI_CHROME_BIN: fake }, 'linux');
  expect(found).toBe(fake);
});

test('findChromeBin: returns null when nothing on the platform matches and PATH is empty', () => {
  expect(findChromeBin({ PATH: '' }, 'win32')).toBeNull();
});
