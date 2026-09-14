// M1 — server/mcp-auth.js against a stub `claude` (test/fixtures/claude-mcp-stub.sh)
// that prints exactly what the real CLI printed in the spike. What is asserted
// here is the wrapper's half of the contract:
//   * `mcp login <name> --no-browser` runs under the pty bridge, its authorize
//     URL is scraped from stdout (ANSI/OSC-8 stripped) and the login goes
//     'starting' → 'awaiting';
//   * submitRedirect writes the pasted redirect URL to the pty's stdin and the
//     login reaches 'done' — the path a cockpit on another device needs, since
//     the loopback callback only works on the host itself;
//   * a bare code is refused (the CLI wants the whole URL — it re-checks `state`);
//   * add / add-json / remove / get / logout drive the CLI and never echo a token.
import { test, expect, beforeEach, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolate } from './_isolate.js';
isolate(); // restore globalThis/process.env after this file (bun test shares them)

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STUB = path.join(ROOT, 'test', 'fixtures', 'claude-mcp-stub.sh');
const state = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-mcpauth-'));

// The stub writes the same two files the real CLI owns, into a throwaway config
// dir — nothing here can touch the developer's own ~/.claude.
process.env.CLAUDE_CONFIG_DIR = state;
process.env.ARIGAMI_CLAUDE_BIN = STUB;
const mcp = await import('../server/mcp-auth.js');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => T | null | undefined | false, ms = 8000): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = fn();
    if (v) return v as T;
    await sleep(25);
  }
  throw new Error('condition not met in time');
}

beforeEach(() => {
  for (const f of fs.readdirSync(state)) fs.rmSync(path.join(state, f), { force: true });
});
afterAll(() => fs.rmSync(state, { recursive: true, force: true }));

test('login prints the authorize URL, then the pasted redirect URL completes it', async () => {
  const started = mcp.startLogin('linear--sales');
  expect(started.state).toBe('starting');
  // Asking again while it runs attaches to the same login instead of spawning a second.
  expect(mcp.startLogin('linear--sales').state).not.toBe('error');

  const awaiting = await until(() => {
    const s = mcp.loginStatus('linear--sales');
    return s.state === 'awaiting' && s.url ? s : null;
  });
  expect(awaiting.url).toBe('https://vendor.example/authorize?client_id=stub&state=xyz&redirect_uri=http%3A%2F%2Flocalhost%3A3118%2Fcallback');

  // A bare code is not enough — `claude` wants the whole redirect URL back.
  const bad = mcp.submitRedirect('linear--sales', 'abc123');
  expect(bad.ok).toBe(false);
  expect(bad.error).toMatch(/full redirect URL/);
  expect(mcp.loginStatus('linear--sales').state).toBe('awaiting');

  const ok = mcp.submitRedirect('linear--sales', 'http://localhost:3118/callback?code=abc&state=xyz');
  expect(ok.ok).toBe(true);
  await until(() => mcp.loginStatus('linear--sales').state === 'done');

  // …and the CLI now reports the grant as connected, under that exact name.
  expect((await mcp.getServer('linear--sales')).status).toBe('connected');
  expect((await mcp.getServer('linear')).status).toBe('needs-auth');
});

test('submitRedirect on a login that is not running says so instead of throwing', () => {
  const r = mcp.submitRedirect('nobody', 'http://localhost:3118/callback?code=abc');
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/no login in progress/);
});

test('a redirect URL the CLI rejects ends the login as an error, not a spinner', async () => {
  // '?code=' with an empty value never reaches the CLI.
  mcp.startLogin('sentry');
  await until(() => mcp.loginStatus('sentry').state === 'awaiting');
  expect(mcp.submitRedirect('sentry', 'https://vendor.example/callback?code=').ok).toBe(false);
  expect(mcp.loginStatus('sentry').state).toBe('awaiting');

  // A well-formed URL the CLI refuses (stale code / wrong state) must surface as
  // an error — `claude` exits non-zero after having printed an authorize URL,
  // which on its own would read as "still waiting".
  const handed = mcp.submitRedirect('sentry', 'http://localhost:3118/callback?code=bad&state=xyz');
  expect(handed.ok).toBe(true);
  const failed = await until(() => {
    const s = mcp.loginStatus('sentry');
    return s.state === 'error' ? s : null;
  });
  expect(failed.error).toMatch(/rejected/i);
  expect((await mcp.getServer('sentry')).status).toBe('needs-auth');

  mcp.cancelLogin('sentry');
  expect(mcp.loginStatus('sentry').state).toBe('idle');
});

test('add / add-json / remove / get drive the CLI, and a token never comes back out', async () => {
  const added = await mcp.addServer('linear', 'https://mcp.linear.app/mcp', { scope: 'user' });
  expect(added.ok).toBe(true);

  const hdr = await mcp.addServerWithHeader('github', 'https://api.githubcopilot.com/mcp/', 'Authorization', 'Bearer ghp_SECRETVALUE', { scope: 'user' });
  expect(hdr.ok).toBe(true);
  expect(JSON.stringify(hdr)).not.toContain('ghp_SECRETVALUE');
  expect((await mcp.getServer('github')).status).toBe('connected'); // header servers need no OAuth grant

  await mcp.removeServer('github', { scope: 'user' });
  expect((await mcp.getServer('github')).status).toBe('needs-auth');
});

test('logout drops the grant the CLI reported as connected', async () => {
  mcp.startLogin('notion');
  await until(() => mcp.loginStatus('notion').state === 'awaiting');
  mcp.submitRedirect('notion', 'http://localhost:3118/callback?code=abc&state=xyz');
  await until(() => mcp.loginStatus('notion').state === 'done');
  expect((await mcp.getServer('notion')).status).toBe('connected');

  const out = await mcp.logout('notion');
  expect(out.ok).toBe(true);
  expect((await mcp.getServer('notion')).status).toBe('needs-auth');
});

test('parseList reads the CLI table the way the real one prints it', () => {
  const rows = mcp.parseList(
    'Checking MCP server health…\n\n' +
      'linear--sales: https://mcp.linear.app/mcp (HTTP) - ✔ Connected\n' +
      'notion: https://mcp.notion.com/mcp (HTTP) - ! Needs authentication\n',
  );
  expect(rows.map((r: any) => [r.name, r.status])).toEqual([
    ['linear--sales', 'connected'],
    ['notion', 'needs-auth'],
  ]);
});
