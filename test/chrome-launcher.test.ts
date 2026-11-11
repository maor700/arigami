import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withChromeFlags, ensureChromeLauncherFlags } from '../server/lib/chrome-launcher.ts';
import { tmpDir } from './_tmp.js';

const DESKTOP = ['[Desktop Entry]', 'Name=Google Chrome', 'Exec=/usr/bin/google-chrome-stable %U', '', '[Desktop Action new-window]', 'Exec=/usr/bin/google-chrome-stable', '[Desktop Action incognito]', 'Exec=/usr/bin/google-chrome-stable --incognito', 'TryExec=/usr/bin/google-chrome-stable'].join('\n');

test('every Chrome Exec line gets the flag once; other lines are untouched', () => {
  const out = withChromeFlags(DESKTOP, ['--no-sandbox']);
  expect(out).toContain('Exec=/usr/bin/google-chrome-stable --no-sandbox %U');
  expect(out).toContain('Exec=/usr/bin/google-chrome-stable --no-sandbox --incognito');
  expect(out).toContain('TryExec=/usr/bin/google-chrome-stable');
  expect(withChromeFlags(out, ['--no-sandbox'])).toBe(out); // idempotent
});

test('in a pod the launcher is shadowed in the user data dir; on a native host nothing is written', () => {
  const root = tmpDir('cl-');
  const sys = path.join(root, 'google-chrome.desktop');
  fs.writeFileSync(sys, DESKTOP);
  const home = path.join(root, 'home');

  expect(ensureChromeLauncherFlags({ env: {}, home, dockerenv: false, systemLaunchers: [sys] })).toEqual([]);
  expect(fs.existsSync(path.join(home, '.local/share/applications'))).toBe(false);

  const written = ensureChromeLauncherFlags({ env: { KUBERNETES_SERVICE_HOST: 'kubernetes.example.test' }, home, dockerenv: false, systemLaunchers: [sys] });
  expect(written).toEqual([path.join(home, '.local/share/applications/google-chrome.desktop')]);
  expect(fs.readFileSync(written[0], 'utf8')).toContain('google-chrome-stable --no-sandbox %U');
  // second run: nothing to do
  expect(ensureChromeLauncherFlags({ env: { KUBERNETES_SERVICE_HOST: 'kubernetes.example.test' }, home, dockerenv: false, systemLaunchers: [sys] })).toEqual([]);
  // CHROME_NO_SANDBOX=0 forces the sandbox: leave the icon alone
  expect(ensureChromeLauncherFlags({ env: { KUBERNETES_SERVICE_HOST: 'kubernetes.example.test', CHROME_NO_SANDBOX: '0' }, home: path.join(root, 'h2'), dockerenv: false, systemLaunchers: [sys] })).toEqual([]);
  fs.rmSync(root, { recursive: true, force: true });
});
