// P4-6: server/lib/codex-sandbox.ts — the boot probe against a stub runner (the real codex is never run here).
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { probeCodexSandbox, readCodexSandbox, failureDetail } from '../server/lib/codex-sandbox.ts';

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-sandbox-probe-')), 'codex-sandbox.json');
const now = new Date('2026-09-15T10:00:00.000Z');

test('bwrap failure → unavailable with the bwrap line, cached, logged as keeping bypass', async () => {
  const file = tmpFile();
  const logs: string[] = [];
  const st = await probeCodexSandbox({
    file, now, log: (l) => logs.push(l),
    run: async () => ({ code: 1, output: 'bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted\n' }),
  });
  expect(st).toEqual({ available: false, detail: 'bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted', checkedAt: now.toISOString() });
  expect(readCodexSandbox(file)).toEqual(st);
  expect(logs.join('\n')).toMatch(/unavailable .*keeps --dangerously-bypass-approvals-and-sandbox/);
});

test('exit 0 → available, logs that a sandboxed mode is possible', async () => {
  const file = tmpFile();
  const logs: string[] = [];
  const st = await probeCodexSandbox({ file, now, log: (l) => logs.push(l), run: async () => ({ code: 0, output: '' }) });
  expect(st.available).toBe(true);
  expect(readCodexSandbox(file)?.available).toBe(true);
  expect(logs.join('\n')).toMatch(/sandboxed codex mode is possible/);
});

test('codex missing / runner throws → null or unavailable, never a crash', async () => {
  const a = await probeCodexSandbox({ file: tmpFile(), now, log: () => {}, run: async () => ({ code: 127, output: '', missing: true }) });
  expect(a).toMatchObject({ available: null, detail: 'codex not installed' });
  const b = await probeCodexSandbox({ file: tmpFile(), now, log: () => {}, run: async () => { throw new Error('boom'); } });
  expect(b).toMatchObject({ available: false, detail: 'boom' });
  expect(readCodexSandbox(path.join(os.tmpdir(), 'nope-codex-sandbox', 'x.json'))).toBeNull();
});

test('failureDetail picks the sandbox line, else the last line, capped at 160', () => {
  expect(failureDetail('warn: x\nbwrap: setting up uid map: Permission denied\ntrailer')).toBe('bwrap: setting up uid map: Permission denied');
  expect(failureDetail('one\ntwo')).toBe('two');
  expect(failureDetail('')).toBe('exit non-zero');
  expect(failureDetail('x'.repeat(300)).length).toBe(160);
});

test('the spawn flags are untouched by the probe: codex.ts still forces bypass', () => {
  const src = fs.readFileSync(path.join(import.meta.dir, '..', 'server', 'codex.ts'), 'utf8');
  expect(src).toContain("'--dangerously-bypass-approvals-and-sandbox'");
  expect(src).not.toContain('codex-sandbox');
});
