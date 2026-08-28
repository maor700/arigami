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
