// The argv the control plane hands to `kubectl exec` for everything it does inside a tenant pod (backup, restore,
// the busy check before an upgrade, post-upgrade health). Run for real with `sh` here: the wrapper must run the
// command as-is for a non-root pod (arigami-tenant 0.2.0's default) and only drop privileges through gosu as root.
import { test, expect } from 'bun:test';
import { tenantExecArgv } from '../src/provisioner.js';

test('kubectl exec targets the ordinal-0 pod and wraps the command', () => {
  const argv = tenantExecArgv('u-abc', ['curl', '-fsS', 'http://127.0.0.1:3099/__health']);
  expect(argv.slice(0, 6)).toEqual(['kubectl', '-n', 'u-abc', 'exec', 'arigami-abc-0', '--']);
  expect(argv.slice(-3)).toEqual(['curl', '-fsS', 'http://127.0.0.1:3099/__health']);
});

test('the wrapper runs the command unchanged as a non-root user (no gosu), arguments intact', async () => {
  if (process.getuid?.() === 0) return; // this half is about the non-root path
  const argv = tenantExecArgv('u-abc', ['printf', '%s|', 'a b', '$HOME', "it's"]);
  const inPod = argv.slice(argv.indexOf('--') + 1);
  const p = Bun.spawnSync(inPod, { env: { PATH: process.env.PATH } });
  expect(p.exitCode).toBe(0);
  expect(p.stdout.toString()).toBe("a b|$HOME|it's|");
});
