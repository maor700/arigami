// Regression for the duplicate "imported from .env" account: after a
// ARIGAMI_SECRET rotation, previously-sealed tokens can no longer be
// decrypted (open() → ''), so a token-only dedup would append a fresh env
// account on every boot. The dedup must also honor the importedFromEnv marker.
// Runs in a child so its dir/secret/env-token don't leak into other test files.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInChild } from './_child.js';

test('seed does not duplicate the env-imported account after a secret rotation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-acct-'));
  // A pre-seeded env account whose sealed token was encrypted with a DIFFERENT
  // key — so open() fails to decrypt it under the current secret.
  fs.writeFileSync(
    path.join(dir, 'accounts.json'),
    JSON.stringify({
      activeId: 'acc_old',
      accounts: [
        {
          id: 'acc_old',
          label: 'Work (imported from .env)',
          type: 'oauth-token',
          pool: true,
          addedAt: '2026-01-01T00:00:00.000Z',
          token: { v: 1, iv: 'AAAAAAAAAAAAAAAA', tag: 'AAAAAAAAAAAAAAAAAAAAAA', t: 'AAAA' },
          importedFromEnv: true,
        },
      ],
    })
  );
  const r = runInChild(
    "const a=await import('./server/accounts.js');a.initAccounts();" +
      "const {accounts}=a.listAccounts();" +
      "emit({oauth:accounts.filter(x=>x.type==='oauth-token').map(x=>x.id)});",
    {
      ARIGAMI_DIR: dir,
      ARIGAMI_SECRET: 'rotated-secret',
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-env-token',
    }
  );
  expect(r.ok).toBe(true);
  expect(r.out[0].oauth).toEqual(['acc_old']); // exactly one, not duplicated
});
