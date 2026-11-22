// holdersOf: which processes hold a background shell's output file open — the bg reaper's liveness check on Linux.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { holdersOf } from '../server/lib/session-procs.ts';
import { tmpDir } from './_tmp.js';

test.skipIf(process.platform !== 'linux')('finds the writer of each file in one pass, and nobody once it exits', async () => {
  const dir = tmpDir('holders-');
  const busy = path.join(dir, 'busy.output');
  const idle = path.join(dir, 'idle.output');
  fs.writeFileSync(idle, 'done\n');
  const child = spawn('sh', ['-c', `exec 3>>'${busy}'; echo started >&3; exec sleep 30`], { stdio: 'ignore' });
  for (let i = 0; i < 50 && !fs.existsSync(busy); i++) await new Promise((r) => setTimeout(r, 20));
  const held = holdersOf([busy, idle]);
  expect(held.get(busy)).toContain(child.pid!);
  expect(held.get(idle)).toEqual([]);
  child.kill('SIGKILL');
  await new Promise((r) => child.once('exit', r));
  expect(holdersOf([busy]).get(busy)).toEqual([]);
});
