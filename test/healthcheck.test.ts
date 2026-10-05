// deploy/systemd/arigami-healthcheck — restarts the host when it is alive but
// not answering. Driven with fake systemctl / curl / logger on PATH, so it runs
// anywhere and restarts nothing real.
//
//   - healthy: nothing happens, no counter left behind
//   - two failures: counted, no restart; the third restarts the unit
//   - a recovery in between resets the count
//   - a unit stopped on purpose is never touched
//   - DRY_RUN logs the restart instead of doing it
import { test, expect, beforeEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'deploy/systemd/arigami-healthcheck');
let dir = '';
let calls = '';
let state = '';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'healthcheck-'));
  calls = path.join(dir, 'systemctl.log');
  state = path.join(dir, 'fails');
  const fake = (name: string, body: string) => fs.writeFileSync(path.join(dir, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  // is-active: FAKE_ACTIVE=0 → active; show: a start long ago; restart: recorded
  fake('systemctl', `echo "$@" >> ${JSON.stringify(calls)}
case "$1" in
  is-active) exit "\${FAKE_ACTIVE:-0}" ;;
  show) echo "Mon 2020-01-06 00:00:00 UTC" ;;
esac
exit 0`);
  fake('curl', 'exit "${FAKE_CURL:-0}"');
  fake('logger', 'exit 0');
});

const run = (env: Record<string, string> = {}) =>
  spawnSync('bash', [SCRIPT], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, ARIGAMI_HEALTH_STATE: state, ...env }, encoding: 'utf8' });
const restarts = () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').split('\n').filter((l) => l.startsWith('restart')) : []);

test('healthy: nothing happens and no counter is left', () => {
  const r = run();
  expect(r.status).toBe(0);
  expect(restarts()).toEqual([]);
  expect(fs.existsSync(state)).toBe(false);
});

test('two failures are counted; the third restarts the unit', () => {
  run({ FAKE_CURL: '7' });
  run({ FAKE_CURL: '7' });
  expect(fs.readFileSync(state, 'utf8').trim()).toBe('2');
  expect(restarts()).toEqual([]);
  const r = run({ FAKE_CURL: '7' });
  expect(r.stdout).toContain('restarting arigami');
  expect(restarts()).toEqual(['restart arigami']);
  expect(fs.existsSync(state)).toBe(false); // the count starts over after a restart
});

test('a recovery in between resets the count', () => {
  run({ FAKE_CURL: '7' });
  run({ FAKE_CURL: '7' });
  expect(run().stdout).toContain('healthy again after 2');
  run({ FAKE_CURL: '7' });
  expect(restarts()).toEqual([]);
});

test('a unit stopped on purpose is never touched', () => {
  for (let i = 0; i < 4; i++) run({ FAKE_ACTIVE: '3', FAKE_CURL: '7' });
  expect(restarts()).toEqual([]);
});

test('DRY_RUN logs the restart instead of doing it; another unit is named as asked', () => {
  for (let i = 0; i < 3; i++) run({ FAKE_CURL: '7', DRY_RUN: '1', ARIGAMI_UNIT: 'arigami@alice' });
  expect(restarts()).toEqual([]);
  expect(fs.readFileSync(calls, 'utf8')).toContain('is-active --quiet arigami@alice');
});
