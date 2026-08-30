// F6 — skills/_lib/connect.sh `open` = "ensure Chrome + navigate". The host's
// browser route only passes the URL to a NEW Chrome; when one is already
// running it answers alreadyRunning:true and the URL would be ignored, so
// `open` must then drive the address bar (the same Ctrl+L / type / Return
// path `nav` uses). Exercised against a copy of the script with a fake
// chrome.sh (logs its argv, flips to "already running" after the first call)
// and a fake xinput.py (logs its argv) — no host, no desktop.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'connect-sh-'));
  fs.copyFileSync(path.join(ROOT, 'skills/_lib/connect.sh'), path.join(dir, 'connect.sh'));
  fs.chmodSync(path.join(dir, 'connect.sh'), 0o755);
  fs.writeFileSync(
    path.join(dir, 'chrome.sh'),
    `#!/usr/bin/env bash
echo "chrome $*" >> "$LOG"
if [ -f "$LOG.running" ]; then echo '{"ok":true,"display":":100","pid":1,"alreadyRunning":true}'; else touch "$LOG.running"; echo '{"ok":true,"display":":100","pid":1,"alreadyRunning":false}'; fi
`,
    { mode: 0o755 }
  );
  fs.writeFileSync(path.join(dir, 'xinput.py'), `import os,sys\nopen(os.environ['LOG'],'a').write('xinput ' + ' '.join(sys.argv[1:]) + '\\n')\n`);
  const log = path.join(dir, 'calls.log');
  const run = (...args) =>
    spawnSync('bash', [path.join(dir, 'connect.sh'), ...args], {
      encoding: 'utf8',
      env: { ...process.env, LOG: log, ARIGAMI_SESSION_ID: 'sess_test', ARIGAMI_DIR: dir, CONNECT_ALLOW: 'google.com composio.dev', CONNECT_NAV_DELAY: '0' },
    });
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []);
  return { run, calls };
}

test('open: first call starts Chrome on the URL, second call navigates the running Chrome', () => {
  const { run, calls } = sandbox();
  const a = run('open', 'https://myaccount.google.com/');
  expect(a.status).toBe(0);
  expect(a.stdout).toContain('"alreadyRunning":false');
  expect(calls()).toEqual(['chrome https://myaccount.google.com/']);

  const b = run('open', 'https://backend.composio.dev/api/v3/connect/x');
  expect(b.status).toBe(0);
  expect(b.stdout).toContain('"alreadyRunning":true');
  expect(calls()).toEqual([
    'chrome https://myaccount.google.com/',
    'chrome https://backend.composio.dev/api/v3/connect/x',
    'xinput key ctrl+l',
    'xinput type https://backend.composio.dev/api/v3/connect/x',
    'xinput key Return',
  ]);
});

test('nav always drives the address bar; open refuses hosts outside the allowlist before touching Chrome', () => {
  const { run, calls } = sandbox();
  const n = run('nav', 'https://accounts.google.com/');
  expect(n.status).toBe(0);
  expect(calls()).toEqual(['chrome ', 'xinput key ctrl+l', 'xinput type https://accounts.google.com/', 'xinput key Return']);

  const bad = run('open', 'https://evil.example/');
  expect(bad.status).toBe(1);
  expect(bad.stderr).toContain('not in allowlist');
  expect(calls().length).toBe(4); // nothing new
});
