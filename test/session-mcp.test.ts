// The session /mcp panel's rows (server/lib/session-mcp.ts): exactly the servers
// the engine was started with, each with the status of what really serves it.
import { test, expect } from 'bun:test';
import { rows, classify, type Facts } from '../server/lib/session-mcp.ts';

const base = (over: Partial<Facts>): Facts => ({
  engine: 'claude',
  loaded: [],
  health: {},
  snapshot: [],
  hostGrant: () => null,
  composioKey: false,
  extensionLoaded: () => true,
  codexGrantLive: () => false,
  hostCanLogin: (n) => ['linear', 'sentry', 'figma'].includes(n),
  ...over,
});
const by = (r: ReturnType<typeof rows>) => Object.fromEntries(r.map((x) => [x.name, x]));

test('classify: gateway entries by url, vendor urls as CLI grants, commands as stdio', () => {
  expect(classify('arigami', { type: 'http', url: 'http://127.0.0.1:3099/__mcp/s/arigami' })).toEqual({ name: 'arigami', via: 'gateway', kind: 'arigami' });
  expect(classify('linear', { url: 'http://h/__mcp/s/linear' })).toEqual({ name: 'linear', via: 'gateway', kind: 'grant' });
  expect(classify('linear--sales', { type: 'http', url: 'https://mcp.linear.app/mcp' })).toEqual({ name: 'linear--sales', via: 'cli', kind: 'grant' });
  expect(classify('ext-notes', { command: 'bun', args: [] })).toEqual({ name: 'ext-notes', via: 'stdio', kind: 'extension' });
});

test("a host-held Linear reads connected, and the CLI's stale twin does not show", () => {
  const r = by(
    rows(
      base({
        loaded: [classify('arigami', { url: 'x/__mcp/s/arigami' }), classify('composio-mcp', { url: 'x/__mcp/s/composio-mcp' }), classify('linear', { url: 'x/__mcp/s/linear' })],
        composioKey: true,
        hostGrant: (n) => (n === 'linear' ? { live: true } : null),
        snapshot: [
          { name: 'linear', status: 'connected', source: 'dynamic' },
          { name: 'sentry', status: 'connected', source: 'user' },
        ],
        health: { linear: { status: 'needs-auth', source: 'probe' }, sentry: { status: 'connected', source: 'probe' } },
      })
    )
  );
  expect(Object.keys(r).sort()).toEqual(['arigami', 'composio-mcp', 'linear', 'sentry']);
  expect(r.linear).toMatchObject({ via: 'gateway', status: 'connected', statusText: 'connected via Arigami', logout: 'host' });
  expect(r.sentry).toMatchObject({ via: 'cli', status: 'connected', logout: 'cli' });
  expect(r.arigami.status).toBe('connected');
  expect(r['composio-mcp'].status).toBe('connected');
});

test("a Codex session lists only what Codex loaded — never Claude's own servers", () => {
  const r = by(
    rows(
      base({
        engine: 'codex',
        loaded: [classify('arigami', { url: 'x/__mcp/s/arigami' }), classify('linear', { url: 'x/__mcp/s/linear' })],
        hostGrant: (n) => (n === 'linear' ? { live: true } : null),
        // left over from an older probe that ran Claude's list for this session
        health: { sentry: { status: 'connected', source: 'probe' }, figma: { status: 'connected', source: 'probe' } },
        snapshot: [{ name: 'figma', status: 'connected', source: 'user' }],
      })
    )
  );
  expect(Object.keys(r).sort()).toEqual(['arigami', 'linear']);
});

test('a session started before the host held Linear says so, and offers Reconnect', () => {
  const r = by(
    rows(
      base({
        loaded: [classify('arigami', { url: 'x/__mcp/s/arigami' })],
        snapshot: [{ name: 'linear', status: 'needs-auth', source: 'user' }],
        hostGrant: (n) => (n === 'linear' ? { live: true } : null),
      })
    )
  );
  expect(r.linear).toMatchObject({ via: 'cli', status: 'needs-reconnect' });
  expect(r.linear.login).toBeUndefined();
});

test('a CLI server that needs auth is signed in through the host when the catalog has it', () => {
  const r = by(rows(base({ snapshot: [{ name: 'sentry', status: 'needs-auth', source: 'user' }, { name: 'my-own', status: 'needs-auth', source: 'user' }] })));
  expect(r.sentry.login).toBe('host');
  expect(r['my-own'].login).toBe('cli');
});

test('an expired host grant asks for a sign-in; a grant removed since spawn asks for Reconnect', () => {
  const r = by(
    rows(
      base({
        loaded: [classify('linear', { url: 'x/__mcp/s/linear' }), classify('figma', { url: 'x/__mcp/s/figma' })],
        hostGrant: (n) => (n === 'linear' ? { live: false } : null),
      })
    )
  );
  expect(r.linear).toMatchObject({ status: 'needs-auth', login: 'host' });
  expect(r.figma.status).toBe('needs-reconnect');
});

test('a failed live tool call beats every other signal', () => {
  const r = by(
    rows(
      base({
        loaded: [classify('linear', { url: 'x/__mcp/s/linear' })],
        hostGrant: () => ({ live: true }),
        health: { linear: { status: 'degraded', statusText: 'tool call failed: 502', source: 'traffic' } },
      })
    )
  );
  expect(r.linear).toMatchObject({ status: 'degraded', statusText: 'tool call failed: 502' });
});

test('Codex grants: the engine startup report wins; a re-auth failure is a host sign-in', () => {
  const r = by(
    rows(
      base({
        engine: 'codex',
        loaded: [
          { name: 'sentry', via: 'codex-grant', kind: 'grant' },
          { name: 'figma', via: 'codex-grant', kind: 'grant' },
        ],
        codexGrantLive: (n) => n === 'figma',
        health: { sentry: { status: 'needs-auth', statusText: 'reauthentication required', source: 'engine' } },
      })
    )
  );
  expect(r.sentry).toMatchObject({ status: 'needs-auth', login: 'host' });
  expect(r.figma.status).toBe('connected');
});

test('an extension that is not loaded is not reported connected', () => {
  const r = by(rows(base({ loaded: [classify('ext-notes', { url: 'x/__mcp/s/ext-notes' })], extensionLoaded: () => false })));
  expect(r['ext-notes'].status).toBe('failed');
});

test('claude.ai connectors and plugin servers are listed without CLI sign-in buttons', () => {
  const r = by(
    rows(
      base({
        snapshot: [
          { name: 'claude.ai Gmail', status: 'needs-auth', source: 'claudeai' },
          { name: 'plugin:vercel:vercel', status: 'connected', source: 'plugin' },
          { name: 'mine', status: 'connected', source: 'user' },
        ],
      })
    )
  );
  expect(r['claude.ai Gmail'].login).toBeUndefined();
  expect(r['claude.ai Gmail'].statusText).toContain('claude.ai account');
  expect(r['plugin:vercel:vercel'].logout).toBeUndefined();
  expect(r.mine.logout).toBe('cli');
});

test("a gateway entry the engine did not connect is not shown connected — and says why", () => {
  const r = by(
    rows(
      base({
        loaded: [classify('linear', { url: 'x/__mcp/s/linear' })],
        hostGrant: () => ({ live: true }),
        snapshot: [{ name: 'linear', status: 'needs-auth', source: 'dynamic' }],
        cliTwin: (n) => n === 'linear',
      })
    )
  );
  expect(r.linear.status).toBe('needs-reconnect');
  expect(r.linear.statusText).toContain('same name');
  // a live call that went through since beats the init report
  const r2 = by(
    rows(
      base({
        loaded: [classify('linear', { url: 'x/__mcp/s/linear' })],
        hostGrant: () => ({ live: true }),
        snapshot: [{ name: 'linear', status: 'needs-auth', source: 'dynamic' }],
        health: { linear: { status: 'connected', source: 'traffic' } },
      })
    )
  );
  expect(r2.linear.status).toBe('connected');
});
