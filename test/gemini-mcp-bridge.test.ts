// Gemini MCP bridge (server/lib/gemini-mcp-bridge.ts + server/lib/mcp-gateway.ts + server/gemini-acp.ts):
//   - pure partition, unwrap, filter, and catalog helpers
//   - policy/mods/permission-card/transcript unwrapping in gemini-acp.ts
//   - live host HTTP gateway: compact arigami toolset (<30 KB) + mcp_tools + mcp_call across overflow arigami & external servers,
//     preserving session identity, outbound cards, A3 allowlists, and leaving Claude untouched.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as ho from '../server/handoff.ts';
import { runInChild } from './_child.js';
import { tmpDir } from './_tmp.js';
import {
  GEMINI_DIRECT_ARIGAMI_TOOLS,
  partitionGeminiServers,
  unwrapBridgeCall,
  filterBridgeTools,
  formatBridgeCatalog,
} from '../server/lib/gemini-mcp-bridge.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = 'gemini-mcp-bridge-test-secret-32chars';

// ---- pure helpers -------------------------------------------------------------------------

test('partitionGeminiServers keeps arigami + non-gateway servers direct and bridges all gateway servers', () => {
  const res = partitionGeminiServers({
    arigami: { type: 'http', url: 'http://127.0.0.1:3099/__mcp/s/arigami' },
    linear: { type: 'http', url: 'http://127.0.0.1:3099/__mcp/s/linear' },
    sentry: { type: 'http', url: 'http://127.0.0.1:3099/__mcp/s/sentry' },
    'composio-mcp': { type: 'http', url: 'http://127.0.0.1:3099/__mcp/s/composio-mcp' },
    'ext-notes': { type: 'http', url: 'http://127.0.0.1:3099/__mcp/s/ext-notes' },
    localStdio: { command: 'node', args: ['srv.js'] },
  });
  expect(Object.keys(res.direct).sort()).toEqual(['arigami', 'localStdio']);
  expect(res.bridged.sort()).toEqual(['arigami', 'composio-mcp', 'ext-notes', 'linear', 'sentry']);
});

test('unwrapBridgeCall unwraps mcp_arigami_mcp_call to the real target tool and rejects malformed calls', () => {
  const u = unwrapBridgeCall(
    { name: 'mcp__arigami__mcp_call', server: 'arigami', tool: 'mcp_call' },
    { server: 'linear', tool: 'get_issue', arguments: { id: 'ENG-123' } }
  );
  expect(u).toEqual({
    tool: { name: 'mcp__linear__get_issue', server: 'linear', tool: 'get_issue' },
    args: { id: 'ENG-123' },
  });
  expect(unwrapBridgeCall({ name: 'mcp__arigami__set_title', server: 'arigami', tool: 'set_title' }, { server: 'linear', tool: 'x' })).toBeNull();
  expect(unwrapBridgeCall({ name: 'mcp__arigami__mcp_call', server: 'arigami', tool: 'mcp_call' }, { server: '../bad', tool: 'x' })).toBeNull();
  expect(unwrapBridgeCall({ name: 'mcp__arigami__mcp_call', server: 'arigami', tool: 'mcp_call' }, { server: 'linear', tool: '' })).toBeNull();
});

test('filterBridgeTools supports overview, query, names full-schema, and server filtering', () => {
  const entries = [
    {
      server: 'arigami',
      tools: [
        { name: 'open_tab', description: 'open a tab' },
        { name: 'create_session', description: 'create a child session', inputSchema: { type: 'object', properties: { title: { type: 'string' } } } },
      ],
    },
    {
      server: 'linear',
      tools: [
        { name: 'get_issue', description: 'fetch one Linear issue', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
        { name: 'save_issue', description: 'create or update a Linear issue', inputSchema: { type: 'object', properties: { id: { type: 'string' } } } },
      ],
    },
  ];
  const overview = filterBridgeTools(entries, {}) as any;
  expect(overview.servers).toEqual([
    { server: 'arigami', count: 1, tools: ['create_session'] },
    { server: 'linear', count: 2, tools: ['get_issue', 'save_issue'] },
  ]);

  const byNames = filterBridgeTools(entries, { server: 'linear', names: ['get_issue'] }) as any;
  expect(byNames.tools).toHaveLength(1);
  expect(byNames.tools[0].inputSchema.required).toEqual(['id']);

  const byQuery = filterBridgeTools(entries, { query: 'child session' }) as any;
  expect(byQuery.tools.map((t: any) => `${t.server}.${t.name}`)).toEqual(['arigami.create_session']);

  const missing = filterBridgeTools(entries, { server: 'nope' }) as any;
  expect(missing.error).toContain('nope');
});

test('formatBridgeCatalog produces compact plain-text server index with zero startup latency', () => {
  const cat = formatBridgeCatalog(['arigami', 'linear', 'sentry']);
  expect(cat).toContain('mcp_arigami_mcp_call');
  expect(cat).toContain('arigami (additional tools), linear, sentry');
  expect(formatBridgeCatalog([])).toBe('');
});

// ---- driver policy / transcript / permission-card unwrapping ------------------------------

test('gemini-acp unwraps mcp_arigami_mcp_call for policy checks, transcript cards, and ask-mode permissions', () => {
  const dir = tmpDir('gem-bridge-drv-');
  const fakeAgy = path.join(dir, 'agy');
  fs.writeFileSync(fakeAgy, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.mkdirSync(path.join(dir, 'gemini', 'antigravity-cli'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'gemini', 'antigravity-cli', 'antigravity-oauth-token'), 'x');
  try {
    const r = runInChild(
      "const st=await import('./server/state.ts');" +
        "const cl=await import('./server/claude.js');" +
        "const g=await import('./server/gemini-acp.ts');" +
        "const ag=await import('./server/agents.ts');" +
        "const s=st.createSession({title:'gem',engine:'gemini',cwd:process.cwd()});" +
        'const wrote=[];' +
        "const proc={id:s.id,sent:[],resume:false,child:{stdin:{writableEnded:false,destroyed:false,write:(l)=>wrote.push(JSON.parse(l))},once(){}}};" +
        'const A=g.stateOf(s.id);A.proc=proc;A.ready=true;A.modeId="default";A.sessionId="sid1";A.servers=["arigami","linear"];' +
        "const up=(u)=>g.acpHandleEvent(s.id,{jsonrpc:'2.0',method:'session/update',params:{sessionId:'sid1',update:u}});" +
        // 1. Transcript: external bridged call shows as mcp__linear__get_issue; arigami bridged call stays hidden
        "up({sessionUpdate:'tool_call',toolCallId:'b1',name:'mcp_arigami_mcp_call',status:'in_progress',rawInput:{server:'linear',tool:'get_issue',arguments:{id:'ENG-1'}}});" +
        "up({sessionUpdate:'tool_call_update',toolCallId:'b1',name:'mcp_arigami_mcp_call',status:'completed',rawOutput:{output:'ok'}});" +
        "up({sessionUpdate:'tool_call',toolCallId:'b2',name:'mcp_arigami_mcp_call',status:'in_progress',rawInput:{server:'arigami',tool:'create_session',arguments:{title:'x'}}});" +
        "up({sessionUpdate:'tool_call_update',toolCallId:'b2',name:'mcp_arigami_mcp_call',status:'completed',rawOutput:{output:'ok'}});" +
        // 2. Policy: restricted agent with only linear allowed
        "ag.createAgent({name:'LinearOnly',slug:'linonly',tools:['mcp__linear__*']});" +
        "st.patchSession(s.id,{metadata:{agent:'linonly'}});" +
        "const allowLin=g.geminiToolCheck(s.id,'mcp_arigami_mcp_call',{server:'linear',tool:'get_issue',arguments:{id:'ENG-1'}});" +
        "const denySess=g.geminiToolCheck(s.id,'mcp_arigami_mcp_call',{server:'arigami',tool:'create_session',arguments:{title:'x'}});" +
        "const allowLookup=g.geminiToolCheck(s.id,'mcp_arigami_mcp_tools',{server:'linear'});" +
        // 3. Permission request in restricted agent denies disallowed bridged call before any card
        "g.acpHandleEvent(s.id,{jsonrpc:'2.0',id:9,method:'session/request_permission',params:{toolCall:{toolCallId:'b3',name:'mcp_arigami_mcp_call',rawInput:{server:'arigami',tool:'create_session',arguments:{title:'x'}}},options:[{optionId:'a',kind:'allow_once'},{optionId:'d',kind:'reject_once'}]}});" +
        'emit({chat:cl.getChat(s.id,0),allowLin,denySess,allowLookup,wrote});',
      {
        ARIGAMI_DIR: dir,
        ARIGAMI_PORT: '',
        ARIGAMI_FUNNEL_QUIET: '1',
        ARIGAMI_AGY_BIN: fakeAgy,
        ARIGAMI_GEMINI_HOME: path.join(dir, 'gemini'),
        CLAUDE_CONFIG_DIR: path.join(dir, 'no-claude'),
      }
    );
    if (!r.ok) throw new Error(r.error);
    const out = r.out[0];
    const uses = out.chat.filter((e: any) => e.kind === 'tool-use');
    expect(uses).toHaveLength(1);
    expect(uses[0]).toMatchObject({ name: 'mcp__linear__get_issue', input: { id: 'ENG-1' } });
    expect(out.allowLin.decision).toBe('allow');
    expect(out.allowLin.tool.name).toBe('mcp__linear__get_issue');
    expect(out.denySess.decision).toBe('deny');
    expect(out.denySess.tool.name).toBe('mcp__arigami__create_session');
    expect(out.denySess.reason).toContain('[arigami policy]');
    expect(out.allowLookup.decision).toBe('allow');
    expect(out.wrote[0]).toMatchObject({ id: 9, result: { outcome: { outcome: 'selected', optionId: 'd' } } });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- live host HTTP gateway integration ---------------------------------------------------

let host: ChildProcess;
let hostDir: string;
let base: string;
let cookie = '';
let geminiSid = '';
let claudeSid = '';
let restrictedSid = '';
const tokens: Record<string, string> = {};

const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T | null | undefined | false>, ms = 15000): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn();
    if (v) return v as T;
    await sleep(80);
  }
  throw new Error('condition not met in time');
}
async function person(method: string, p: string, body?: unknown) {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}
async function mcp(name: string, token: string) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const client = new Client({ name: 'test', version: '0' }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/__mcp/s/${name}`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return client;
}
const text = (r: any) => String((r.content || []).map((c: any) => c.text).join(''));

beforeAll(async () => {
  hostDir = tmpDir('arigami-gem-bridge-');
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const home = path.join(hostDir, 'home');
  const ws = path.join(hostDir, 'ws');
  const gemHome = path.join(hostDir, 'gemini');
  const tokenDir = path.join(hostDir, 'tokens');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(path.join(gemHome, 'antigravity-cli'), { recursive: true });
  fs.writeFileSync(path.join(gemHome, 'antigravity-cli', 'antigravity-oauth-token'), 'x');
  fs.mkdirSync(tokenDir, { recursive: true });

  // Extension with a normal tool, a sender tool (outbound gate), and many large tools
  const ext = path.join(hostDir, 'user', 'extensions', 'notes');
  fs.mkdirSync(path.join(ext, 'tools'), { recursive: true });
  fs.writeFileSync(
    path.join(ext, 'manifest.json'),
    JSON.stringify({ name: 'notes', version: '0.1.0', apiVersion: 1, tools: [{ kind: 'module', name: 'notes', module: 'tools/module.ts' }], permissions: [] })
  );
  fs.writeFileSync(
    path.join(ext, 'tools', 'module.ts'),
    `const extras = Array.from({ length: 25 }, (_, i) => ({
       name: 'bulk_tool_' + i,
       description: 'Bulk tool ' + i + ' ' + 'z'.repeat(1200),
       inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
       run: async (a) => ({ idx: i, q: a.q || '' }),
     }));
     export const tools = [
       { name: 'whoami', description: 'which session is calling', run: async (_a, ctx) => {
           const me = await ctx.host.api('GET', '/__api/auth/me');
           return { principal: me.principal, session: me.sessionId ?? me.session ?? null };
         } },
       { name: 'send_note', description: 'send a note to a person', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, run: async (a) => ({ sent: a.text }) },
       ...extras,
     ];`
  );

  // Stub claude and agy binaries that record their ARIGAMI_TOKEN and idle
  const claudeStub = path.join(hostDir, 'claude-stub.js');
  fs.writeFileSync(
    claudeStub,
    `#!/usr/bin/env bun
if (process.env.ARIGAMI_SESSION_ID) require('node:fs').writeFileSync(${JSON.stringify(tokenDir)} + '/' + process.env.ARIGAMI_SESSION_ID, process.env.ARIGAMI_TOKEN || '');
process.stdout.write(JSON.stringify({type:'system',subtype:'init',session_id:'s',model:'m',tools:[],mcp_servers:[]})+'\\n');
setInterval(()=>{},1e6);`,
    { mode: 0o755 }
  );
  const agyStub = path.join(hostDir, 'agy-stub.js');
  fs.writeFileSync(
    agyStub,
    `#!/usr/bin/env bun
if (process.env.ARIGAMI_SESSION_ID) require('node:fs').writeFileSync(${JSON.stringify(tokenDir)} + '/' + process.env.ARIGAMI_SESSION_ID, process.env.ARIGAMI_TOKEN || '');
setInterval(()=>{},1e6);`,
    { mode: 0o755 }
  );

  host = spawn('bun', ['server/index.ts'], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOME: home,
      ARIGAMI_DIR: hostDir,
      ARIGAMI_PORT: String(port),
      ARIGAMI_AUTH: 'pairing',
      ARIGAMI_HANDOFF_SECRET: SECRET,
      ARIGAMI_SCREEN_ENABLED: '0',
      ARIGAMI_TELEMETRY: '0',
      ARIGAMI_CLAUDE_BIN: claudeStub,
      ARIGAMI_AGY_BIN: agyStub,
      ARIGAMI_GEMINI_HOME: gemHome,
      ARIGAMI_DEFAULT_CWD: ws,
      COMPOSIO_API_KEY: '',
      GH_TOKEN: '',
      GITHUB_TOKEN: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let err = '';
  host.stderr!.on('data', (d) => (err += d));
  await until(async () => {
    try {
      return (await fetch(base + '/__health', { signal: AbortSignal.timeout(2000) })).ok;
    } catch {
      return false;
    }
  }).catch(() => {
    throw new Error('host did not start: ' + err.slice(-2000));
  });

  const r = await fetch(`${base}/__api/auth/handoff?t=${encodeURIComponent(ho.mint(SECRET, 'owner@fake-org.test'))}`, { redirect: 'manual' });
  cookie = (r.headers.get('set-cookie') || '').split(';')[0];

  // Create restricted agent with only `web`
  await person('POST', '/__api/agents', { name: 'WebOnly', slug: 'webonly', tools: ['web'], engine: 'gemini' });

  const cGem = await person('POST', '/__api/sessions', { title: 'gem-main', cwd: ws, engine: 'gemini' });
  geminiSid = cGem.json.id;
  const cCla = await person('POST', '/__api/sessions', { title: 'cla-main', cwd: ws, engine: 'claude' });
  claudeSid = cCla.json.id;
  const cRes = await person('POST', '/__api/sessions', { title: 'gem-restricted', cwd: ws, engine: 'gemini', agent: 'webonly' });
  restrictedSid = cRes.json.id;

  for (const id of [geminiSid, claudeSid, restrictedSid]) {
    await person('POST', `/__api/sessions/${id}/message`, { text: 'hi' });
    tokens[id] = await until(async () => {
      const f = path.join(tokenDir, id);
      return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim() || null : null;
    });
  }
}, 60000);

afterAll(() => {
  try { host?.kill('SIGTERM'); } catch {}
  try { fs.rmSync(hostDir, { recursive: true, force: true }); } catch {}
});

test('Gemini /__mcp/s/arigami stays compact (<35 KB) with core tools + bridge, while Claude is unchanged', async () => {
  const cg = await mcp('arigami', tokens[geminiSid]);
  const cc = await mcp('arigami', tokens[claudeSid]);
  try {
    const gTools = ((await cg.listTools()) as any).tools;
    const cTools = ((await cc.listTools()) as any).tools;
    const gNames = gTools.map((t: any) => t.name);
    const cNames = cTools.map((t: any) => t.name);

    // Gemini gets core direct tools + mcp_tools + mcp_call, staying well under agy's ~44 KB eager cap
    const gBytes = Buffer.byteLength(JSON.stringify(gTools));
    expect(gBytes).toBeLessThan(35_000);
    for (const core of ['set_title', 'open_tab', 'request_action', 'publish_artifact', 'browser_open', 'sign_in', 'mcp_tools', 'mcp_call']) {
      expect(gNames).toContain(core);
    }
    expect(gNames).not.toContain('create_session'); // bridged, not eagerly declared
    expect(gNames.length).toBeLessThanOrEqual(GEMINI_DIRECT_ARIGAMI_TOOLS.size + 2);

    // Claude gets the full arigami toolset without bridge tools
    expect(cNames).toContain('create_session');
    expect(cNames).toContain('register_listener');
    expect(cNames).not.toContain('mcp_tools');
    expect(cNames).not.toContain('mcp_call');
  } finally {
    await cg.close();
    await cc.close();
  }
});

test('Gemini mcp_tools + mcp_call discover and invoke overflow arigami tools and external extension tools', async () => {
  const cg = await mcp('arigami', tokens[geminiSid]);
  try {
    // 1. Overview discovers arigami overflow + ext-notes
    const ov = JSON.parse(text(await cg.callTool({ name: 'mcp_tools', arguments: {} })));
    const srvNames = ov.servers.map((s: any) => s.server);
    expect(srvNames).toContain('arigami');
    expect(srvNames).toContain('ext-notes');
    const extRow = ov.servers.find((s: any) => s.server === 'ext-notes');
    expect(extRow.tools).toContain('whoami');
    expect(extRow.tools).toContain('bulk_tool_24');

    // 2. Full schema fetch by exact names
    const schema = JSON.parse(text(await cg.callTool({ name: 'mcp_tools', arguments: { server: 'ext-notes', names: ['bulk_tool_7'] } })));
    expect(schema.tools).toHaveLength(1);
    expect(schema.tools[0].inputSchema.properties.q.type).toBe('string');

    // 3. Direct arigami tool call works through bridge wrapper
    await cg.callTool({ name: 'set_title', arguments: { title: 'renamed-direct' } });
    expect((await person('GET', `/__api/sessions/${geminiSid}`)).json.title).toBe('renamed-direct');

    // 4. Overflow arigami tool call via mcp_call works
    const sessList = JSON.parse(text(await cg.callTool({ name: 'mcp_call', arguments: { server: 'arigami', tool: 'list_sessions', arguments: {} } })));
    expect(Array.isArray(sessList)).toBe(true);
    expect(sessList.some((s: any) => s.id === geminiSid)).toBe(true);

    // 5. External extension tool call via mcp_call preserves session identity
    const who = JSON.parse(text(await cg.callTool({ name: 'mcp_call', arguments: { server: 'ext-notes', tool: 'whoami', arguments: {} } })));
    expect(who).toMatchObject({ principal: 'session', session: geminiSid });

    // 6. Bulk overflow tool call via mcp_call works
    const bulk = JSON.parse(text(await cg.callTool({ name: 'mcp_call', arguments: { server: 'ext-notes', tool: 'bulk_tool_24', arguments: { q: 'hello' } } })));
    expect(bulk).toEqual({ idx: 24, q: 'hello' });
  } finally {
    await cg.close();
  }
});

test('Gemini restricted agent cannot list or call disallowed servers/tools through the bridge', async () => {
  const cr = await mcp('arigami', tokens[restrictedSid]);
  try {
    const ov = JSON.parse(text(await cr.callTool({ name: 'mcp_tools', arguments: {} })));
    const srvNames = ov.servers.map((s: any) => s.server);
    expect(srvNames).toContain('arigami');
    expect(srvNames).not.toContain('ext-notes');
    const arigamiRow = ov.servers.find((s: any) => s.server === 'arigami');
    expect(arigamiRow.tools).not.toContain('create_session');

    // Calling disallowed external server is refused
    const badExt = (await cr.callTool({ name: 'mcp_call', arguments: { server: 'ext-notes', tool: 'whoami', arguments: {} } })) as any;
    expect(badExt.isError).toBe(true);
    expect(text(badExt)).toContain('not available in this session');

    // Calling disallowed overflow arigami tool is refused by policy
    const badHost = (await cr.callTool({ name: 'mcp_call', arguments: { server: 'arigami', tool: 'create_session', arguments: { title: 'nope' } } })) as any;
    expect(badHost.isError).toBe(true);
    expect(text(badHost)).toContain('[arigami policy]');
  } finally {
    await cr.close();
  }
});
