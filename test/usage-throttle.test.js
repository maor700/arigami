// A throttled usage endpoint (429) must not erase the last known reading: after a
// host restart getUsage() falls back to the accounts.json snapshot, and the poller
// never overwrites a good snapshot with a transient reason. Runs out of process
// (accounts.js binds ARIGAMI_DIR at import; see test/_child.js).
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInChild } from './_child.js';

test('getUsage keeps the persisted snapshot when the endpoint throttles, and a throttle is not persisted', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-usage-throttle-'));
  fs.writeFileSync(
    path.join(dir, 'accounts.json'),
    JSON.stringify({
      activeId: 'acc_tok',
      accounts: [
        {
          id: 'acc_tok', label: 'Work', provider: 'claude', type: 'oauth-token', pool: true,
          token: { v: 0, t: 'sk-ant-oat01-x' },
          lastUsage: { session: 33, week: 84, at: 1700000000000 },
        },
      ],
    })
  );
  const r = runInChild(
    "globalThis.fetch = async () => new Response('', { status: 429 });" +
      "const a = await import('./server/accounts.js'); a.initAccounts();" +
      "const u = await import('./server/usage.js');" +
      "const first = await u.getUsage('acc_tok', true);" +
      "await u.refreshAccount('acc_tok');" +
      "const saved = JSON.parse(require('node:fs').readFileSync(process.env.ARIGAMI_DIR + '/accounts.json', 'utf8')).accounts[0].lastUsage;" +
      "emit({ first, saved });",
    { ARIGAMI_DIR: dir, HOME: dir, ARIGAMI_CODEX_HOME: path.join(dir, 'no-codex') }
  );
  expect(r.ok).toBe(true);
  const { first, saved } = r.out[0];
  expect(first.available).toBe(true);
  expect(first.stale).toBe(true);
  expect(first.session.pct).toBe(33);
  expect(first.week.pct).toBe(84);
  // the snapshot on disk is untouched — no {reason:'usage-throttled'} overwrote it
  expect(saved).toEqual({ session: 33, week: 84, at: 1700000000000 });
});

test('a real failure (401) still replaces the snapshot', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-usage-401-'));
  fs.writeFileSync(
    path.join(dir, 'accounts.json'),
    JSON.stringify({
      activeId: 'acc_tok',
      accounts: [{ id: 'acc_tok', label: 'Work', provider: 'claude', type: 'oauth-token', pool: true, token: { v: 0, t: 'sk-ant-oat01-x' }, lastUsage: { session: 33, week: 84, at: 1 } }],
    })
  );
  const r = runInChild(
    "globalThis.fetch = async () => new Response('', { status: 401 });" +
      "const a = await import('./server/accounts.js'); a.initAccounts();" +
      "const u = await import('./server/usage.js');" +
      "const first = await u.getUsage('acc_tok', true); await u.refreshAccount('acc_tok');" +
      "emit({ first, saved: a.getAccount('acc_tok').lastUsage });",
    { ARIGAMI_DIR: dir, HOME: dir, ARIGAMI_CODEX_HOME: path.join(dir, 'no-codex') }
  );
  expect(r.ok).toBe(true);
  expect(r.out[0].first).toMatchObject({ available: false, reason: 'http-401' });
  expect(r.out[0].saved.reason).toBe('http-401');
});
