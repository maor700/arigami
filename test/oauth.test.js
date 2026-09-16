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
