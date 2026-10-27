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

test('chromeEnv: a TMPDIR too long for Chrome\'s singleton socket (measured: 66 bytes start, 67 abort) becomes /tmp', async () => {
  const { chromeEnv, CHROME_TMPDIR_MAX } = await import('../server/lib/chrome.ts');
  expect(CHROME_TMPDIR_MAX).toBe(66);
  const ok = '/x'.padEnd(66, 'x');
  const long = '/x'.padEnd(67, 'x');
  expect(chromeEnv({ TMPDIR: ok, A: '1' }, 'linux')).toEqual({ TMPDIR: ok, A: '1' });
  expect(chromeEnv({ TMPDIR: long, A: '1' }, 'linux')).toEqual({ TMPDIR: '/tmp', A: '1' });
  expect(chromeEnv({ A: '1' }, 'linux')).toEqual({ A: '1' });
  expect(chromeEnv({ TMPDIR: long }, 'win32')).toEqual({ TMPDIR: long });
});
