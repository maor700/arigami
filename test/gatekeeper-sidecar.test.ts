// The gatekeeper as a sidecar (Helm chart `isolation.gatekeeper`): an extension's module tools served over HTTP by
// mcp/ext-serve.ts, the host routing to it (server/lib/ext-remote.ts), and the gatekeeper's managed mode — identities
// and scope from read-only mounted files that nothing in the pod can change.
import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { parseExtRemote, extRemoteUrl } from '../server/lib/ext-remote.ts';
import { runInChild } from './_child.js';
import { tmpDir } from './_tmp.js';

const REPO = path.resolve(import.meta.dir, '..');

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
    s.on('error', reject);
  });

async function waitHealthy(url: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${url}/health`)).ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${url} never became healthy`);
}

function serve(modulePath: string, port: number, env: Record<string, string> = {}): ChildProcess {
  const p = spawn('bun', [path.join(REPO, 'mcp/ext-serve.ts'), modulePath], {
    cwd: REPO,
    env: { ...process.env, EXT_SERVE_PORT: String(port), ...env },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  return p;
}

async function call(url: string, tool: string, args: Record<string, unknown> = {}, meta?: Record<string, unknown>) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const c = new Client({ name: 't', version: '0' }, { capabilities: {} });
  await c.connect(new StreamableHTTPClientTransport(new URL(url)));
  try {
    const tools = ((await c.listTools()) as any).tools.map((t: any) => t.name);
    const r: any = await c.callTool({ name: tool, arguments: args, ...(meta ? { _meta: meta } : {}) } as any);
    return { tools, isError: !!r.isError, body: JSON.parse(r.content[0].text) };
  } finally {
    await c.close();
  }
}

describe('ARIGAMI_EXT_REMOTE', () => {
  test('parses name=url pairs; ignores anything malformed', () => {
    const m = parseExtRemote(' gatekeeper=http://127.0.0.1:3199/ , bad name=http://x, notes=ftp://x, x=http://a/b, y=, =http://z, other=https://h:1');
    expect([...m.entries()]).toEqual([['gatekeeper', 'http://127.0.0.1:3199'], ['other', 'https://h:1']]);
    expect(parseExtRemote(undefined).size).toBe(0);
  });
  test('unset = no extension is remote (every standalone install)', () => {
    expect(extRemoteUrl('gatekeeper', {})).toBeNull();
    expect(extRemoteUrl('gatekeeper', { ARIGAMI_EXT_REMOTE: 'gatekeeper=http://127.0.0.1:1' })).toBe('http://127.0.0.1:1');
    expect(extRemoteUrl('notes', { ARIGAMI_EXT_REMOTE: 'gatekeeper=http://127.0.0.1:1' })).toBeNull();
  });
});

describe('mcp/ext-serve.ts', () => {
  let proc: ChildProcess;
  let url = '';
  beforeAll(async () => {
    const dir = tmpDir('arigami-extserve-');
    fs.mkdirSync(path.join(dir, 'tools'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'tools', 'module.ts'),
      "export const tools = [{ name: 'whoami', description: 'x', inputSchema: { type: 'object', properties: {} }, run: (_a, ctx) => ({ ok: true, caller: ctx.caller }) }];\n"
    );
    const port = await freePort();
    url = `http://127.0.0.1:${port}`;
    proc = serve(path.join(dir, 'tools', 'module.ts'), port, { EXT_NAME: 'probe' });
    await waitHealthy(url);
  });
  afterAll(() => proc?.kill('SIGTERM'));

  test('/shared: the caller the host names in _meta reaches the tool, as in the host gateway', async () => {
    const r = await call(`${url}/shared`, 'whoami', {}, { 'arigami/session': 's1', 'arigami/token': 't', 'arigami/profile': { name: 'fix', grants: [] }, 'arigami/lineage': ['p1'], 'arigami/cwd': '/w/s1' });
    expect(r.tools).toEqual(['whoami']);
    expect(r.body.caller).toEqual({ session: 's1', shared: true, hostCall: false, profile: { name: 'fix', grants: [] }, lineage: ['p1'], cwd: '/w/s1' });
  });

  test('/host: a host call — never a session, whatever _meta says', async () => {
    const r = await call(`${url}/host`, 'whoami', {}, { 'arigami/session': 's1', 'arigami/profile': { name: 'fix' } });
    expect(r.body.caller).toMatchObject({ session: null, shared: false, hostCall: true, profile: null });
  });

  test('anything else is 404; it listens on loopback only', async () => {
    expect((await fetch(`${url}/nope`)).status).toBe(404);
    expect((await fetch(`${url}/health`)).status).toBe(200);
  });
});

describe('gatekeeper managed mode (sidecar)', () => {
  let dir: string;
  let ids: string;
  let conf: string;
  const IDS = { slack: { botToken: 'xoxb-fake-canary-managed-000' }, linear: { apiKey: 'lin_api_fake_managed' } };
  beforeAll(() => {
    dir = tmpDir('arigami-gkm-');
    const mounts = tmpDir('arigami-gkm-mnt-');
    ids = path.join(mounts, 'identities.json');
    conf = path.join(mounts, 'config.json');
    fs.writeFileSync(ids, JSON.stringify(IDS));
    fs.writeFileSync(conf, JSON.stringify({ github: { repo: 'o/app' }, slack: { channel: 'CINCIDENT1' } }));
  });
  const env = () => ({ GATEKEEPER_DIR: dir, GATEKEEPER_IDENTITIES_FILE: ids, GATEKEEPER_CONFIG_FILE: conf });

  test('identities and scope come from the mounted files; writes are refused; the store dir gets neither', () => {
    const r = runInChild(
      "const S=await import('./extensions/gatekeeper/lib/store.ts');" +
        "let w1='',w2='';try{S.writeIdentities({})}catch(e){w1=e.message}try{S.writeConfig(S.readConfig())}catch(e){w2=e.message}" +
        'emit({managed:S.isManaged(),ids:S.readIdentities(),repo:S.readConfig().github.repo,ch:S.readConfig().slack.channel,api:S.readConfig().github.apiUrl,w1,w2});',
      env()
    );
    if (!r.ok) throw new Error(r.error);
    const o = r.out[0];
    expect(o.managed).toBe(true);
    expect(o.ids).toEqual(IDS);
    expect([o.repo, o.ch, o.api]).toEqual(['o/app', 'CINCIDENT1', 'https://api.github.com']);
    expect(o.w1).toContain('managed by the deployment');
    expect(o.w2).toContain('managed by the deployment');
    expect(fs.existsSync(path.join(dir, 'identities.json'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'config.json'))).toBe(false);
    expect(JSON.parse(fs.readFileSync(ids, 'utf8'))).toEqual(IDS);
  });

  test('the tab cannot change scope, identities or bindings; it can still read the state (no values)', () => {
    const r = runInChild(
      "const m=await import('./extensions/gatekeeper/tools/module.ts');const host={caller:{session:null,shared:false,hostCall:true,profile:null,lineage:[],cwd:null}};" +
        "const t=(n)=>m._test.adminTools.find(x=>x.name===n);" +
        "emit({save:await t('gk_admin_save_config').run({config:{github:{repo:'evil/repo'}}},host)," +
        "set:await t('gk_admin_set_identity').run({service:'slack',values:{botToken:'xoxb-other'}},host)," +
        "clear:await t('gk_admin_clear_identity').run({service:'slack'},host)," +
        "bind:await t('gk_admin_bind').run({session:'s9',channel:'COTHER1',thread_ts:'1.1'},host)," +
        "state:await t('gk_admin_state').run({},host)});",
      env()
    );
    if (!r.ok) throw new Error(r.error);
    const o = r.out[0];
    for (const k of ['save', 'set', 'clear', 'bind']) expect(o[k]).toMatchObject({ ok: false, error: expect.stringContaining('managed by the deployment') });
    expect(o.state.ok).toBe(true);
    expect(o.state.managed).toBe(true);
    expect(o.state.config.github.repo).toBe('o/app');
    expect(o.state.identities.slack.botToken).toBe(true);
    expect(JSON.stringify(o.state)).not.toContain('xoxb-');
    expect(JSON.parse(fs.readFileSync(ids, 'utf8'))).toEqual(IDS);
    expect(JSON.parse(fs.readFileSync(conf, 'utf8')).github.repo).toBe('o/app');
    expect(fs.readFileSync(path.join(dir, 'audit.log'), 'utf8')).toContain('managed by the deployment');
  });

  test('the host routes a tab call to the sidecar (ARIGAMI_EXT_REMOTE) — nothing runs in the host process', async () => {
    const port = await freePort();
    const sidecar = serve(path.join(REPO, 'extensions/gatekeeper/tools/module.ts'), port, { EXT_NAME: 'gatekeeper', ...env() });
    try {
      await waitHealthy(`http://127.0.0.1:${port}`);
      const d = tmpDir('arigami-gkm-host-');
      const r = runInChild(
        "const ext=await import('./server/extensions.ts');await ext.reload();await ext.patchExtension('gatekeeper',{enabled:true});" +
          "const r=await ext.callExtTool('gatekeeper','gk_admin_state',{});emit(r);",
        {
          ARIGAMI_DIR: d,
          ARIGAMI_PORT: '',
          ARIGAMI_STATE_FILE: path.join(d, 'state.json'),
          ARIGAMI_CHAT_DIR: path.join(d, 'chat'),
          ARIGAMI_BUNDLED_EXT_DIR: path.join(REPO, 'extensions'),
          ARIGAMI_EXT_REMOTE: `gatekeeper=http://127.0.0.1:${port}`,
          GATEKEEPER_DIR: '',
          GATEKEEPER_IDENTITIES_FILE: '',
          GATEKEEPER_CONFIG_FILE: '',
        }
      );
      if (!r.ok) throw new Error(r.error);
      const o = r.out[0];
      expect(o.ok).toBe(true);
      const body = JSON.parse(o.result[0].text);
      // The answer is the SIDECAR's: its store dir and its managed files, not the host's ARIGAMI_DIR/gatekeeper.
      expect(body.managed).toBe(true);
      expect(body.dir).toBe(dir);
      expect(body.config.github.repo).toBe('o/app');
      expect(fs.existsSync(path.join(d, 'gatekeeper'))).toBe(false);
    } finally {
      sidecar.kill('SIGTERM');
    }
  });
});
