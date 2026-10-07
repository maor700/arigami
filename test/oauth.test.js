// OAuth login flow: the PKCE `state` must be carried into the authorize URL
// (43-char base64url, matching `claude setup-token`) and must NOT be clobbered
// by the flow's UI-state field. Submitting a code whose state doesn't match is
// rejected up front (CSRF guard) — before any token exchange.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isolate } from './_isolate.js';
isolate(); // restore globalThis/process.env after this file (bun test shares them)

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-oauth-'));
process.env.ARIGAMI_DIR = tmp;

const oauth = await import('../server/oauth-login.js');

test('startLogin mints a 43-char state into the authorize URL and reports awaiting-code', () => {
  const f = oauth.startLogin({ label: 'test' });
  expect(f.state).toBe('awaiting-code'); // UI state, not the OAuth state
  const u = new URL(f.url);
  const state = u.searchParams.get('state');
  expect(state).not.toBe('awaiting-code'); // regression: state must not be the UI-state string
  expect(state.length).toBe(43);
  expect(u.searchParams.get('code_challenge_method')).toBe('S256');
  // Full CLI-login scope set — user:profile is what unlocks the usage endpoint
  // for added accounts. Spaces must ride as '+', which URLSearchParams does.
  expect(u.searchParams.get('scope')).toBe(
    'user:profile user:inference user:sessions:claude_code user:mcp_servers'
  );
  expect(f.url).toContain('scope=user%3Aprofile+user%3Ainference');
});

test('submitCode rejects a state mismatch without attempting an exchange', async () => {
  const f = oauth.startLogin({ label: 'csrf' });
  const res = await oauth.submitCode(f.id, 'somecode#not-the-real-state');
  expect(res.ok).toBe(false);
  expect(res.error).toMatch(/state mismatch/i);
  // the flow is now in error, not 'exchanging' (proves we never hit the network)
  expect(oauth.loginStatus(f.id).state).toBe('error');
});

test('submitCode with an empty code is rejected', async () => {
  const f = oauth.startLogin({});
  const res = await oauth.submitCode(f.id, '   ');
  expect(res.ok).toBe(false);
  expect(res.error).toMatch(/no code/i);
});

test('refreshOne is single-flight: concurrent callers share ONE token exchange (a reused refresh token revokes the grant)', async () => {
  const accounts = await import('../server/accounts.js');
  const acc = accounts.addTokenAccount({ label: 'sf', token: 'sk-ant-oat01-old', trusted: true, refreshToken: 'rt-old', expiresAt: new Date(Date.now() - 1000).toISOString() });
  const id = acc.id ?? acc;
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 40));
    return { ok: true, status: 200, json: async () => ({ access_token: 'sk-ant-oat01-new', refresh_token: 'rt-new', expires_in: 28800 }) };
  };
  try {
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => oauth.refreshOne(id)));
    expect(results).toEqual([true, true, true, true, true]);
    expect(calls).toBe(1);
    // right after a success, a late caller reuses it instead of spending the rotated token again
    expect(await oauth.refreshOne(id)).toBe(true);
    expect(calls).toBe(1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a failing child holding an older token is restarted, not refreshed (a refresh revokes everyone else)', async () => {
  const { storedTokenIsNewer } = await import('../server/claude.js');
  const { createHash } = await import('node:crypto');
  const sig = (t) => createHash('sha256').update(t).digest('hex').slice(0, 12);
  const soon = new Date(Date.now() + 3 * 3600_000).toISOString();
  expect(storedTokenIsNewer({ childSig: sig('old'), storedToken: 'new', expiresAt: soon })).toBe(true);
  // it already holds the stored token → it really is expired/revoked → refresh
  expect(storedTokenIsNewer({ childSig: sig('same'), storedToken: 'same', expiresAt: soon })).toBe(false);
  // stored token about to die → refresh instead
  expect(storedTokenIsNewer({ childSig: sig('old'), storedToken: 'new', expiresAt: new Date(Date.now() + 60_000).toISOString() })).toBe(false);
  // unknown child token (spawned before any account) → keep the old path
  expect(storedTokenIsNewer({ childSig: null, storedToken: 'new', expiresAt: soon })).toBe(false);
});
