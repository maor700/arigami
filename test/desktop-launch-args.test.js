// desktop_launch: Chrome started on a pod's desktop gets the container flags (its sandbox can't start there).
import { test, expect } from 'bun:test';
import { launchArgs } from '../server/lib/desktop-control.ts';

const FLAGS = ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'];

test('chrome/chromium get the container flags first, without duplicates', () => {
  for (const cmd of ['google-chrome', 'google-chrome-stable', '/usr/bin/chromium', 'chromium-browser', '/usr/local/bin/arigami-chrome'])
    expect(launchArgs(cmd, ['--user-data-dir=/p', 'https://x'], FLAGS)).toEqual([...FLAGS, '--user-data-dir=/p', 'https://x']);
  expect(launchArgs('google-chrome', ['--no-sandbox', 'https://x'], FLAGS)).toEqual(['--disable-dev-shm-usage', '--disable-gpu', '--no-sandbox', 'https://x']);
});

test('other programs and a native host (no flags) are untouched', () => {
  expect(launchArgs('lxterminal', ['-e', 'top'], FLAGS)).toEqual(['-e', 'top']);
  expect(launchArgs('chrome-sandbox-tool', [], FLAGS)).toEqual([]);
  expect(launchArgs('google-chrome', ['https://x'], [])).toEqual(['https://x']);
});
