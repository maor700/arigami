// P2-4 — remote MCP grants per engine: the codex grant file lookup, the engine-aware capability check, and what a codex session's config.toml loads.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInChild } from './_child.js';
import { codexMcpArgs } from '../server/mcp-auth.js';

const fresh = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'codex-quota-recovery-mcp-'));
const env = (dir: string) => ({
  ARIGAMI_DIR: dir,
  ARIGAMI_FUNNEL_QUIET: '1',
  ARIGAMI_PORT: '',
  HOME: path.join(dir, 'home'),
  CLAUDE_CONFIG_DIR: path.join(dir, 'claude'),
  ARIGAMI_CODEX_HOME: path.join(dir, 'codex-home'),
  ARIGAMI_CODEX_BIN: '/bin/false',
  COMPOSIO_API_KEY: '',
});

/** Claude's store: `linear` global + `notion--sales` agent-owned. */
function claudeGrants(dir: string, names: string[]): void {
  const cdir = path.join(dir, 'claude');
  fs.mkdirSync(cdir, { recursive: true });
  const mcpOAuth = Object.fromEntries(names.map((n) => [`${n}|fe1382f86795a9ab`, { serverName: n, accessToken: 't' }]));
  fs.writeFileSync(path.join(cdir, '.credentials.json'), JSON.stringify({ mcpOAuth }));
}

/** Codex's store, in the shape `codex mcp login` wrote on 0.153.4. */
function codexGrants(dir: string, grants: Record<string, string>): void {
  const home = path.join(dir, 'codex-mcp');
  fs.mkdirSync(home, { recursive: true });
  const creds = Object.fromEntries(
    Object.entries(grants).map(([n, tok]) => [`${n}|638130d5ab3558f4`, { server_name: n, server_url: 'https://mcp.linear.app/mcp', client_id: 'c', access_token: tok, refresh_token: 'r', expires_at: 1, scopes: [] }])
  );
  fs.writeFileSync(path.join(home, '.credentials.json'), JSON.stringify(creds));
}

function records(dir: string): void {
  fs.writeFileSync(
    path.join(dir, 'mcp-connections.json'),
    JSON.stringify([
      { cap: 'mcp:linear', slug: 'linear', name: 'linear', url: 'https://mcp.linear.app/mcp', auth: 'oauth', at: '2026-09-15T00:00:00Z' },
      { cap: 'mcp:sentry', slug: 'sentry', name: 'sentry', url: 'https://mcp.sentry.dev/mcp', auth: 'oauth', at: '2026-09-15T00:00:00Z' },
    ])
  );
  fs.mkdirSync(path.join(dir, 'agents', 'sales'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'agents', 'sales', 'connections.json'),
    JSON.stringify([{ cap: 'mcp:notion', slug: 'notion', name: 'notion--sales', url: 'https://mcp.notion.com/mcp', auth: 'oauth', at: '2026-09-15T00:00:00Z' }])
  );
}

test('codexMcpArgs: the server url and the file store ride on argv', () => {
  expect(codexMcpArgs('login', 'linear--sales', 'https://mcp.linear.app/mcp')).toEqual([
    '-c',
    'mcp_oauth_credentials_store="file"',
    '-c',
    'mcp_servers.linear--sales.url="https://mcp.linear.app/mcp"',
    'mcp',
    'login',
    'linear--sales',
  ]);
  expect(codexMcpArgs('logout', 'linear')).toEqual(['-c', 'mcp_oauth_credentials_store="file"', 'mcp', 'logout', 'linear']);
});

test('per-engine grant lookup: codex file, claude store, bearer never codex', () => {
  const dir = fresh();
  try {
    claudeGrants(dir, ['linear', 'notion--sales']);
    codexGrants(dir, { linear: 'tok', sentry: '' });
    records(dir);
    const r = runInChild(
      "const mc=await import('./server/mcp-connections.ts');" +
        'const cx=mc.readCodexMcpGrants();' +
        "emit({cx:[...cx],linear:mc.grantEngines('linear','oauth'),notion:mc.grantEngines('notion--sales','oauth'),sentry:mc.grantEngines('sentry','oauth'),bearer:mc.grantEngines('linear','bearer')," +
        "global:mc.codexServersFor('global'),agent:mc.codexServersFor('agent:sales')});",
      env(dir)
    );
    if (!r.ok) throw new Error(r.error);
    const o = r.out[0];
    expect(o.cx).toEqual([['linear', true], ['sentry', false]]);
    expect(o.linear).toEqual(['claude', 'codex']);
    expect(o.notion).toEqual(['claude']);
    expect(o.sentry).toEqual([]);
    expect(o.bearer).toEqual([]);
    expect(o.global).toEqual({ granted: { linear: { url: 'https://mcp.linear.app/mcp' } }, claudeOnly: [] });
    expect(o.agent).toEqual({ granted: { linear: { url: 'https://mcp.linear.app/mcp' } }, claudeOnly: ['notion--sales'] });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the capability check answers for the asking engine and lists which engines hold the grant', () => {
  const dir = fresh();
  try {
    claudeGrants(dir, ['linear', 'notion--sales']);
    codexGrants(dir, { linear: 'tok' });
    records(dir);
    const r = runInChild(
      "const caps=await import('./server/capabilities.ts');" +
        'const chk=async(id,engine,owner)=>{const c=caps.getCapability(id,engine?{engine:()=>engine}:{},owner);const x=await c.check();return {ok:x.ok,engines:x.data&&x.data.engines,detail:x.detail};};' +
        "emit({any:await chk('mcp:notion',null,'agent:sales'),claude:await chk('mcp:notion','claude','agent:sales'),codex:await chk('mcp:notion','codex','agent:sales'),linearCodex:await chk('mcp:linear','codex','global')});",
      env(dir)
    );
    if (!r.ok) throw new Error(r.error);
    const o = r.out[0];
    expect(o.any).toMatchObject({ ok: true, engines: ['claude'] });
    expect(o.claude).toMatchObject({ ok: true, engines: ['claude'] });
    expect(o.codex).toMatchObject({ ok: false, engines: ['claude'] });
    expect(o.codex.detail).toContain('authorize it once more for codex');
    expect(o.linearCodex).toMatchObject({ ok: true, engines: ['claude', 'codex'] });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a codex session loads only codex-granted url servers, links the grant file, and notes the claude-only ones once', () => {
  const dir = fresh();
  try {
    fs.mkdirSync(path.join(dir, 'codex-home'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'codex-home', 'auth.json'), '{"auth_mode":"chatgpt"}');
    claudeGrants(dir, ['linear', 'notion--sales']);
    codexGrants(dir, { linear: 'tok' });
    records(dir);
    fs.writeFileSync(path.join(dir, 'agents', 'sales', 'agent.json'), JSON.stringify({ slug: 'sales', name: 'Sales', emoji: '', color: '', skills: [], engine: 'codex', createdAt: '', updatedAt: '' }));
    const r = runInChild(
      "const st=await import('./server/state.ts');" +
        "const cl=await import('./server/claude.js');" +
        "const cx=await import('./server/codex.ts');" +
        "const fs=await import('node:fs');" +
        "const s=st.createSession({title:'c',engine:'codex',cwd:'/tmp',metadata:{agent:'sales'}});" +
        'cx.codexPrepare(s,{resume:false});cx.codexPrepare(s,{resume:true});' +
        'const h=cx.codexHomeFor(s.id);' +
        "emit({toml:fs.readFileSync(h+'/config.toml','utf8'),link:fs.readlinkSync(h+'/.credentials.json'),notes:cl.getChat(s.id,0).filter(e=>e.kind==='system').map(e=>e.text)});",
      env(dir)
    );
    if (!r.ok) throw new Error(r.error);
    const o = r.out[0];
    expect(o.toml).toContain('mcp_oauth_credentials_store = "file"');
    expect(o.toml).toContain('[mcp_servers.linear]\nurl = "https://mcp.linear.app/mcp"');
    expect(o.toml).not.toContain('notion');
    expect(o.link).toBe(path.join(dir, 'codex-mcp', '.credentials.json'));
    expect(o.notes).toHaveLength(1);
    expect(o.notes[0]).toContain('notion--sales');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
