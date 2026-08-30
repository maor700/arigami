// M1 — native remote MCP (RESEARCH-ARIGAMI-NATIVE-MCP). Unit level, each case in
// a fresh child because capabilities.ts / mcp-connections.ts bind ARIGAMI_DIR
// and $CLAUDE_CONFIG_DIR at import. Covers:
//   1. the catalog is well-formed and slugs can never collide with the `--`
//      agent separator;
//   2. grant naming ↔ ownership: `<service>--<agent>`, round-trip, tool pattern;
//   3. liveness read from Claude Code's own files (a logged-out grant with an
//      empty accessToken is NOT connected);
//   4. the provider layer: every capability says native-mcp / composio / local,
//      native ids are ownable and resolve agent-first with a shared fallback;
//   5. what claude.js injects into a session: only the OWNING agent's grants,
//      under their grant names (the spike showed a different name = a fresh,
//      unauthenticated OAuth flow), and never a bearer server;
//   6. Composio no longer claims linear/notion/github/whatsapp.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInChild } from './_child.js';
import { MCP_CATALOG, MCP_SLUG_RE, grantName, parseGrantName, grantToolPattern, mcpSpec, connectableMcp } from '../server/mcp-catalog.ts';

const fresh = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-m1-'));
const env = (dir: string) => ({
  ARIGAMI_DIR: dir,
  ARIGAMI_FUNNEL_QUIET: '1',
  ARIGAMI_PORT: '',
  HOME: path.join(dir, 'home'),
  CLAUDE_CONFIG_DIR: path.join(dir, 'claude'),
  COMPOSIO_API_KEY: '',
});

/** Write the two files Claude Code owns, as it writes them (spike-verified shapes). */
function claudeState(dir: string, grants: Record<string, string | null>, servers: string[] = []): void {
  const cdir = path.join(dir, 'claude');
  fs.mkdirSync(cdir, { recursive: true });
  const mcpOAuth: Record<string, unknown> = {};
  for (const [name, token] of Object.entries(grants)) {
    // Key is `<serverName>|<16-hex hash OF THE URL>` — the same URL under two
    // names yields the same hash and two separate entries.
    mcpOAuth[`${name}|fe1382f86795a9ab`] = { serverName: name, serverUrl: 'https://mcp.linear.app/mcp', accessToken: token ?? '', refreshToken: token ? 'r' : '', expiresAt: Date.now() + 3.6e6 };
  }
  fs.writeFileSync(path.join(cdir, '.credentials.json'), JSON.stringify({ mcpOAuth }), { mode: 0o600 });
  fs.writeFileSync(path.join(cdir, '.claude.json'), JSON.stringify({ mcpServers: Object.fromEntries(servers.map((n) => [n, { type: 'http', url: 'https://api.githubcopilot.com/mcp/' }])) }));
}

// ---------------------------------------------------------------------------

test('the catalog is well-formed: unique slugs, https URLs, domains that cover the URL host', () => {
  expect(MCP_CATALOG.length).toBeGreaterThanOrEqual(10);
  const slugs = MCP_CATALOG.map((s) => s.slug);
  expect(new Set(slugs).size).toBe(slugs.length);
  for (const s of MCP_CATALOG) {
    // A slug with `--` would be indistinguishable from an agent-owned grant name.
    expect(MCP_SLUG_RE.test(s.slug)).toBe(true);
    expect(s.slug).not.toContain('--');
    expect(s.title.length).toBeGreaterThan(1);
    expect(s.url.startsWith('https://')).toBe(true);
    if (s.readonlyUrl) expect(s.readonlyUrl.startsWith('https://')).toBe(true);
    expect(['oauth', 'bearer', 'oauth-byo-client']).toContain(s.auth);
    expect(s.docs.startsWith('https://')).toBe(true);
    // connect-mcp may only open hosts it declares — the server's own host included.
    expect(s.domains).toContain(new URL(s.url).host);
  }
  // The services the research put on the native path all ship.
  for (const want of ['linear', 'notion', 'sentry', 'vercel', 'stripe', 'figma', 'cloudflare', 'supabase', 'atlassian', 'github']) {
    expect(slugs).toContain(want);
  }
  // GitHub is the token row (a PAT the host already owns), not an OAuth one.
  expect(mcpSpec('github')!.auth).toBe('bearer');
  expect(mcpSpec('github')!.tokenFrom).toBe('gh');
  // Asana has no DCR, so it is listed but not offered as connectable.
  expect(mcpSpec('asana')!.auth).toBe('oauth-byo-client');
  expect(connectableMcp().map((s) => s.slug)).not.toContain('asana');
});

test('grant names encode the owner and round-trip', () => {
  expect(grantName('linear')).toBe('linear');
  expect(grantName('linear', 'global')).toBe('linear');
  expect(grantName('linear', 'agent:sales')).toBe('linear--sales');
  expect(grantName('LINEAR', 'agent:sales')).toBe('linear--sales');
  expect(grantName('linear', 'nonsense')).toBe('linear'); // not an owner → the host's own grant
  expect(parseGrantName('linear--sales')).toEqual({ slug: 'linear', agent: 'sales' });
  expect(parseGrantName('linear')).toEqual({ slug: 'linear', agent: null });
  // The A3 allowlist pattern for an agent-owned grant (verified against the real
  // CLI in the spike: tools came out as mcp__stub--sales__ping).
  expect(grantToolPattern('linear--sales')).toBe('mcp__linear--sales__*');
});

test('ownership records live per owner and carry no secrets', () => {
  const dir = fresh();
  const r = runInChild(
    `const m=await import('./server/mcp-connections.js');` +
      `m.recordConnection('global',{cap:'mcp:linear',slug:'linear',name:'linear',url:'https://mcp.linear.app/mcp',auth:'oauth',byIdentity:'a@example.com'});` +
      `m.recordConnection('agent:sales',{cap:'mcp:linear',slug:'linear',name:'linear--sales',url:'https://mcp.linear.app/mcp',auth:'oauth'});` +
      // idempotent: connecting twice replaces, never duplicates
      `m.recordConnection('agent:sales',{cap:'mcp:linear',slug:'linear',name:'linear--sales',url:'https://mcp.linear.app/mcp',auth:'oauth'});` +
      `emit({global:m.readConnections('global'),agent:m.readConnections('agent:sales'),all:m.allConnections().map(x=>x.owner),` +
      `files:[m.connectionsFile('global'),m.connectionsFile('agent:sales')],removed:[m.removeConnection('agent:sales','mcp:linear'),m.removeConnection('agent:sales','mcp:linear')]});`,
    env(dir),
  );
  expect(r.ok).toBe(true);
  const o = r.out[0];
  expect(o.global).toHaveLength(1);
  expect(o.agent).toHaveLength(1);
  expect(o.agent[0].name).toBe('linear--sales');
  expect(o.all).toEqual(['global', 'agent:sales']);
  expect(o.files[1]).toBe(path.join(dir, 'agents', 'sales', 'connections.json'));
  expect(o.removed).toEqual([true, false]);
  // PRD §4.3: the record is names/URLs/timestamps — nothing token-shaped.
  const raw = fs.readFileSync(path.join(dir, 'mcp-connections.json'), 'utf8');
  expect(raw).not.toMatch(/accessToken|refreshToken|Bearer|sk-|ghp_/);
});

test('a grant is live only while Claude Code holds a token for that exact name', () => {
  const dir = fresh();
  claudeState(dir, { linear: 'tok', 'linear--sales': null /* logged out */ }, ['github']);
  const r = runInChild(
    `const m=await import('./server/mcp-connections.js');const st=m.readMcpState();` +
      `emit({live:[m.grantLive('linear','oauth',st),m.grantLive('linear--sales','oauth',st),m.grantLive('linear--other','oauth',st)],` +
      `bearer:[m.grantLive('github','bearer',st),m.grantLive('github--sales','bearer',st)]});`,
    env(dir),
  );
  expect(r.ok).toBe(true);
  expect(r.out[0].live).toEqual([true, false, false]);
  expect(r.out[0].bearer).toEqual([true, false]);
});

test('capabilities: provider per id, mcp:* is ownable and resolves agent-first with a shared fallback', () => {
  const dir = fresh();
  claudeState(dir, { linear: 'tok', 'notion--sales': 'tok' });
  const r = runInChild(
    `const c=await import('./server/capabilities.js');const m=await import('./server/mcp-connections.js');` +
      `m.recordConnection('global',{cap:'mcp:linear',slug:'linear',name:'linear',url:'https://mcp.linear.app/mcp',auth:'oauth'});` +
      `m.recordConnection('agent:sales',{cap:'mcp:notion',slug:'notion',name:'notion--sales',url:'https://mcp.notion.com/mcp',auth:'oauth'});` +
      `emit({providers:{mcp:c.providerOf('mcp:linear'),composio:c.providerOf('composio:gmail'),local:c.providerOf('whatsapp')},` +
      `ownable:[c.isOwnable('mcp:linear'),c.isOwnable('composio:gmail'),c.isOwnable('git')],` +
      `ids:[c.isCapabilityId('mcp:linear'),c.isCapabilityId('mcp:'),c.isCapabilityId('mcp:BAD')]});` +
      `const own=await c.statusOf(c.getCapability('mcp:notion',{},'agent:sales'),{},'agent:sales');` +
      `const shared=await c.statusOf(c.getCapability('mcp:linear',{},'agent:sales'),{},'agent:sales');` +
      `const missing=await c.statusOf(c.getCapability('mcp:sentry',{},'global'),{},'global');` +
      `const byo=await c.statusOf(c.getCapability('mcp:asana',{},'global'),{},'global');` +
      `emit({own:{ok:own.ok,from:own.resolvedFrom,provider:own.provider,tools:own.data.tools,playbook:own.playbook},` +
      `shared:{ok:shared.ok,from:shared.resolvedFrom,detail:shared.detail},` +
      `missing:{ok:missing.ok,tools:missing.data.tools,auto:missing.autoCapable},` +
      `byo:{ok:byo.ok,auto:byo.autoCapable,playbook:byo.playbook||null}});` +
      `const all=await c.capabilitiesStatus({composioConnected:async()=>null},'global');` +
      `emit({everyHasProvider:all.capabilities.every(x=>!!x.provider),` +
      `nativeCount:all.capabilities.filter(x=>x.provider==='native-mcp').length,` +
      `composioIds:all.capabilities.filter(x=>x.provider==='composio').map(x=>x.id),` +
      `order:all.capabilities.findIndex(x=>x.id==='mcp:linear')<all.capabilities.findIndex(x=>x.id==='composio:gmail')});`,
    env(dir),
  );
  expect(r.ok).toBe(true);
  const [a, b, c] = r.out;
  expect(a.providers).toEqual({ mcp: 'native-mcp', composio: 'composio', local: 'local' });
  expect(a.ownable).toEqual([true, true, false]);
  expect(a.ids).toEqual([true, false, false]);
  // The agent's own grant answers for the agent, with its own tool pattern.
  expect(b.own).toEqual({ ok: true, from: 'agent:sales', provider: 'native-mcp', tools: 'mcp__notion--sales__*', playbook: 'connect-mcp' });
  // Linear is only connected globally → the agent falls back to the shared one and is told so.
  expect(b.shared.ok).toBe(true);
  expect(b.shared.from).toBe('global');
  expect(b.shared.detail).toContain('shared');
  // Nothing connected → the card can still show the name it WOULD get.
  expect(b.missing).toEqual({ ok: false, tools: 'mcp__sentry__*', auto: true });
  // A BYO-client vendor is listed but never offered to the auto playbook.
  expect(b.byo).toEqual({ ok: false, auto: false, playbook: null });
  expect(c.everyHasProvider).toBe(true);
  expect(c.nativeCount).toBe(MCP_CATALOG.length);
  // M1 §5: Composio keeps Google + Slack + Facebook; Linear/Notion/GitHub/WhatsApp are gone from it.
  expect(c.composioIds.sort()).toEqual(['composio:facebook', 'composio:gmail', 'composio:googlecalendar', 'composio:googledocs', 'composio:googledrive', 'composio:slack']);
  expect(c.order).toBe(true);
});

test('injection: only the owning agent’s live OAuth grants, under their grant names', () => {
  const dir = fresh();
  claudeState(dir, { 'linear--sales': 'tok', 'notion--sales': null, linear: 'tok' }, ['github--sales']);
  const r = runInChild(
    `const m=await import('./server/mcp-connections.js');` +
      `for(const [owner,rec] of [['agent:sales',{cap:'mcp:linear',slug:'linear',name:'linear--sales',url:'https://mcp.linear.app/mcp',auth:'oauth'}],` +
      `['agent:sales',{cap:'mcp:notion',slug:'notion',name:'notion--sales',url:'https://mcp.notion.com/mcp',auth:'oauth'}],` +
      `['agent:sales',{cap:'mcp:github',slug:'github',name:'github--sales',url:'https://api.githubcopilot.com/mcp/',auth:'bearer'}],` +
      `['agent:ops',{cap:'mcp:linear',slug:'linear',name:'linear--ops',url:'https://mcp.linear.app/mcp',auth:'oauth'}],` +
      `['global',{cap:'mcp:linear',slug:'linear',name:'linear',url:'https://mcp.linear.app/mcp',auth:'oauth'}]]) m.recordConnection(owner,rec);` +
      `emit({sales:m.injectedServersFor('agent:sales'),ops:m.injectedServersFor('agent:ops'),global:m.injectedServersFor('global')});`,
    env(dir),
  );
  expect(r.ok).toBe(true);
  const o = r.out[0];
  // Live OAuth grant → injected under the GRANT name (a different name would
  // start a fresh, unauthenticated flow — verified against the real CLI).
  expect(o.sales).toEqual({ 'linear--sales': { type: 'http', url: 'https://mcp.linear.app/mcp' } });
  // notion--sales is logged out, github--sales is a bearer server whose header we
  // deliberately do not store, another agent's grant is not ours, and the host's
  // own grants are user-scoped (every session sees them already).
  expect(o.ops).toEqual({});
  expect(o.global).toEqual({});
});
