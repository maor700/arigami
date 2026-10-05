// server/remote.js — a tailscale command that never returns must not freeze the
// host. `tailscale funnel --bg …` on a tailnet where Funnel is not enabled
// prints a link and waits for an admin forever; called synchronously with no
// deadline it stopped the whole host twice (no connections accepted, SIGTERM
// unanswered). Driven with a stub CLI that behaves exactly like that.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('enabling Funnel on a tailnet that never answers gives up at the deadline, with the reason', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-timeout-'));
  const stub = path.join(dir, 'tailscale');
  fs.writeFileSync(
    stub,
    `#!/bin/bash
case "$1 $2" in
  "version "*) echo 1.90.0; exit 0 ;;
  "status --json") echo '{"BackendState":"Running","Self":{"DNSName":"box.example.ts.net."}}'; exit 0 ;;
  "serve status") exit 0 ;;
  "funnel status") exit 0 ;;
  "funnel --bg") printf '\\nFunnel is not enabled on your tailnet.\\nTo enable, visit:\\n\\n  https://login.tailscale.com/f/funnel?node=x\\n'; exec sleep 1000 ;;
esac
exit 0`,
    { mode: 0o755 }
  );
  const t0 = Date.now();
  // In a child: remote.js resolves its CLI once per process, from the env.
  const r = spawnSync(
    'bun',
    ['-e', `const m = await import(${JSON.stringify(path.join(ROOT, 'server/remote.js'))}); console.log(JSON.stringify(await m.setFunnel(true)));`],
    { env: { ...process.env, ARIGAMI_TAILSCALE_BIN: stub, ARIGAMI_TAILSCALE_TIMEOUT_MS: '1500', ARIGAMI_DIR: dir }, encoding: 'utf8', timeout: 60_000 }
  );
  const took = Date.now() - t0;
  const out = JSON.parse(r.stdout.trim().split('\n').pop() || '{}');
  expect(r.status).toBe(0);
  expect(took).toBeLessThan(20_000); // two attempts at 1.5 s each, plus the rest — not forever
  expect(out.ok).toBe(false);
  expect(out.error).toContain('Funnel is not enabled');
  expect(out.error).toContain('did not finish within 2s');
  expect(out.error).toContain('nodeAttrs'); // the admin hint
  // and the stub's waiting children were killed, not left behind
  const left = spawnSync('pgrep', ['-f', `${stub} funnel`], { encoding: 'utf8' }).stdout.trim();
  expect(left).toBe('');
}, 70_000);
