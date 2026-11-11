// Engine CLIs on first need (server/lib/engine-install.ts): when the host may install them, and the codex install.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { autoInstallAllowed, inContainerEnv, codexNpmArgs, isUserInstall, ensureCodexCli } from '../server/lib/engine-install.ts';
import { tmpDir } from './_tmp.js';

test('autoInstallAllowed: on in a container, off on a bare host, knobs override both ways', () => {
  expect(autoInstallAllowed('claude', {}, true)).toBe(true);
  expect(autoInstallAllowed('codex', {}, false)).toBe(false);
  expect(autoInstallAllowed('codex', { ARIGAMI_CODEX_AUTOINSTALL: '1' }, false)).toBe(true);
  expect(autoInstallAllowed('claude', { ARIGAMI_CLAUDE_AUTOINSTALL: '0' }, true)).toBe(false);
  expect(inContainerEnv({ ARIGAMI_SUPERVISOR: 'docker' }, false)).toBe(true);
  expect(inContainerEnv({ KUBERNETES_SERVICE_HOST: 'kubernetes.default.svc' }, false)).toBe(true);
  expect(inContainerEnv({}, false)).toBe(false);
});

test('codex installs/updates into the user prefix; isUserInstall follows symlinks into it', () => {
  const root = tmpDir('arigami-engine-');
  const prefix = path.join(root, '.local');
  expect(codexNpmArgs(prefix)).toEqual(['install', '-g', '--prefix', prefix, '@openai/codex@latest']);
  const real = path.join(prefix, 'lib', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  fs.mkdirSync(path.dirname(real), { recursive: true });
  fs.writeFileSync(real, '');
  fs.mkdirSync(path.join(prefix, 'bin'));
  fs.symlinkSync(real, path.join(prefix, 'bin', 'codex'));
  expect(isUserInstall(path.join(prefix, 'bin', 'codex'), prefix)).toBe(true);
  expect(isUserInstall('/usr/local/bin/codex', prefix)).toBe(false);
  expect(isUserInstall(null, prefix)).toBe(false);
});

test('ensureCodexCli: found → no install; missing+allowed → one shared install with started/done events', async () => {
  const events: any[] = [];
  expect(await ensureCodexCli({ find: () => '/x/codex', run: async () => { throw new Error('must not run'); } })).toBe('/x/codex');
  let installed = false;
  let runs = 0;
  const deps = {
    find: () => (installed ? '/home/u/.local/bin/codex' : null),
    allowed: () => true,
    run: async (args: string[]) => { runs++; expect(args).toContain('@openai/codex@latest'); installed = true; return { code: 0, output: 'added 1 package' }; },
    emit: (e: any) => events.push(e),
  };
  const [a, b] = await Promise.all([ensureCodexCli(deps), ensureCodexCli(deps)]);
  expect(a).toBe('/home/u/.local/bin/codex');
  expect(b).toBe(a);
  expect(runs).toBe(1);
  expect(events.map((e) => e.kind)).toEqual(['codex-update-started', 'codex-update-done']);
  expect(events.every((e) => e.reason === 'install')).toBe(true);
});

test('ensureCodexCli: not allowed → clear error, no install; a failed install reports its output', async () => {
  await expect(ensureCodexCli({ find: () => null, allowed: () => false, run: async () => { throw new Error('no'); } })).rejects.toThrow(/not installed/);
  const events: any[] = [];
  await expect(
    ensureCodexCli({ find: () => null, allowed: () => true, run: async () => ({ code: 1, output: 'npm ERR! code EACCES\nnpm ERR! permission denied' }), emit: (e) => events.push(e) })
  ).rejects.toThrow(/permission denied/);
  expect(events.at(-1)).toMatchObject({ kind: 'codex-update-failed', reason: 'install' });
});
