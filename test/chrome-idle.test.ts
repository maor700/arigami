// The idle closer must not close a session Chrome that an agent drives straight over CDP (no browser_* step reaches
// the host), and every start/stop/exit of it is logged with its reason. Real headless Chrome in a child process.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { runInChild } from './_child.js';
import { tmpDir } from './_tmp.js';
import { findChromeBin } from '../server/lib/platform.ts';
import { keepForActivity } from '../server/lib/chrome.ts';

const chrome = findChromeBin();

test('activity: an attached DevTools client or changed tabs keep the browser; nothing new lets it close', () => {
  expect(keepForActivity({ attached: 1, tabs: 'a' }, { attached: 0, tabs: 'a' })).toMatch(/DevTools client attached/);
  expect(keepForActivity({ attached: 0, tabs: 'b' }, { attached: 0, tabs: 'a' })).toMatch(/tabs changed/);
  expect(keepForActivity({ attached: 0, tabs: 'a' }, { attached: 0, tabs: 'a' })).toBeNull();
  expect(keepForActivity({ attached: 0, tabs: 'a' }, undefined)).toBeNull();
  expect(keepForActivity(null, { attached: 1, tabs: 'a' })).toBeNull(); // a Chrome that does not answer is not in use
});

test.skipIf(!chrome)('a CDP-driven session Chrome outlives the idle window; stops, reopens and crashes are logged', () => {
  const dir = tmpDir('arigami-chrome-idle-');
  const bin = path.join(dir, 'chrome-headless');
  fs.writeFileSync(bin, `#!/bin/sh\nexec "${chrome}" --headless=new --no-sandbox "$@"\n`, { mode: 0o755 });
  const r = runInChild("await import('./test/_chrome-idle.ts');", {
    ARIGAMI_DIR: dir,
    ARIGAMI_PORT: '',
    ARIGAMI_SCREEN_DRIVER: 'native-window',
    ARIGAMI_BROWSER_IDLE_MS: '500',
    CHROME_BIN: bin,
  });
  if (!r.ok) throw new Error(r.error);
  const o = r.out[0];
  expect(o.idle.attached).toBe(0); // the host's own probe attaches to no page
  expect(o.busy.attached).toBe(1);
  expect(o.aliveWhileAttached).toBe(true);
  const lines = o.log.trim().split('\n');
  const at = (re: RegExp) => lines.findIndex((l: string) => re.test(l));
  expect(at(/started the browser of .* — first open/)).toBe(0);
  expect(at(/stopping the browser of .* — idle close: no browser step, DevTools client or tab change/)).toBe(1);
  expect(lines[2]).toMatch(/started the browser of .* — reopened after: idle close/);
  expect(lines[3]).toMatch(/exited on its own \(code null, signal SIGKILL\)/);
  expect(lines[4]).toMatch(/reopened after: exited on its own/);
  expect(lines[5]).toMatch(/stopping the browser of .* — session deleted/);
  expect(lines).toHaveLength(6);
});
