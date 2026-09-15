// OPENUI pilot (host): POST /__api/sessions/:id/ui — the render_ui tool's
// endpoint — appends exactly one {kind:'openui', ui, title?} chat event and
// refuses an empty / root-less / oversize block. Also: render_ui is a CORE tool
// (never hidden by an agent allowlist) and the host-MCP tool reads its
// component list out of the generated skill file.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hostDiag } from './_host-diag.js';
import { runInChild } from './_child.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let host: ChildProcess;
let dir: string;
let base: string;

const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
async function api(method: string, p: string, body?: unknown): Promise<any> {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  try {
    return { status: r.status, json: JSON.parse(text) };
  } catch {
    return { status: r.status, json: { raw: text } };
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T | null | undefined | false>, ms = 8000): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn();
    if (v) return v as T;
    await sleep(50);
  }
  throw new Error('condition not met in time');
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-openui-host-'));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-openui-ws-'));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  // A stream-json stub that only reports init and then idles — no turns needed here.
  const stub = path.join(dir, 'claude-stub.js');
  fs.writeFileSync(
    stub,
    `#!/usr/bin/env bun
const sidIdx=process.argv.indexOf('--session-id');const rsIdx=process.argv.indexOf('--resume');
const sid=sidIdx>0?process.argv[sidIdx+1]:rsIdx>0?process.argv[rsIdx+1]:'stub';
process.stdout.write(JSON.stringify({type:'system',subtype:'init',session_id:sid,model:'claude-stub',tools:['Bash','Read'],mcp_servers:[{name:'arigami',status:'connected'}]})+'\\n');
process.stdin.on('data',()=>{});
setInterval(()=>{},1e6);
`,
    { mode: 0o755 }
  );
  host = spawn('bun', ['server/index.ts'], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOME: home,
      ARIGAMI_DIR: dir,
      ARIGAMI_PORT: String(port),
      ARIGAMI_AUTH: 'off',
      ARIGAMI_SCREEN_ENABLED: '0',
      ARIGAMI_CLAUDE_BIN: stub,
      ARIGAMI_WA_DATA_DIR: path.join(dir, 'wa'),
      ARIGAMI_TELEMETRY: '0',
      ARIGAMI_DEFAULT_CWD: ws,
      COMPOSIO_API_KEY: '',
      GH_TOKEN: '',
      GITHUB_TOKEN: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  host.stdout!.on('data', (d) => (log += d));
  host.stderr!.on('data', (d) => (log += d));
  try {
    await until(async () => {
      try {
        return (await fetch(base + '/__api/config', { signal: AbortSignal.timeout(3000) })).ok;
      } catch {
        return false;
      }
    }, 30000);
  } catch {
    throw new Error(`host did not come up: ${log.slice(-1500)}${hostDiag(host)}`);
  }
}, 60_000);

afterAll(() => {
  try {
    host?.kill('SIGTERM');
  } catch {}
});

const UI = 'root = Stack([s])\ns = Stat("Visitors", "12,480", "+8%")';

test('POST …/ui appends one openui chat event (with the optional title) and returns its id', async () => {
  const sid = (await api('POST', '/__api/sessions', { title: 'ui' })).json.id;
  const r = await api('POST', `/__api/sessions/${sid}/ui`, { ui: UI, title: '  Weekly  ' });
  expect(r.status).toBe(201);
  expect(r.json.ok).toBe(true);
  expect(typeof r.json.event_id).toBe('string');
  const evs = await until(async () => {
    const c = (await api('GET', `/__api/sessions/${sid}/chat`)).json as any[];
    return c.some((e) => e.kind === 'openui') ? c : null;
  });
  const ours = evs.filter((e) => e.kind === 'openui');
  expect(ours.length).toBe(1);
  expect(ours[0]).toMatchObject({ id: r.json.event_id, ui: UI, title: 'Weekly' });
  // no title → no title key
  const r2 = await api('POST', `/__api/sessions/${sid}/ui`, { ui: UI });
  expect(r2.status).toBe(201);
  const again = ((await api('GET', `/__api/sessions/${sid}/chat`)).json as any[]).filter((e) => e.kind === 'openui');
  expect(again.length).toBe(2);
  expect('title' in again[1]).toBe(false);
});

test('POST …/ui refuses empty, root-less and oversize blocks', async () => {
  const sid = (await api('POST', '/__api/sessions', { title: 'ui-bad' })).json.id;
  expect((await api('POST', `/__api/sessions/${sid}/ui`, {})).status).toBe(400);
  expect((await api('POST', `/__api/sessions/${sid}/ui`, { ui: '   ' })).status).toBe(400);
  const noRoot = await api('POST', `/__api/sessions/${sid}/ui`, { ui: 's = Stat("a", "b")' });
  expect(noRoot.status).toBe(400);
  expect(noRoot.json.error).toContain('root');
  const big = await api('POST', `/__api/sessions/${sid}/ui`, { ui: 'root = Stack([])\n' + '#'.repeat(65 * 1024) });
  expect(big.status).toBe(400);
  expect(big.json.error).toContain('too long');
  const chat = (await api('GET', `/__api/sessions/${sid}/chat`)).json as any[];
  expect(chat.filter((e) => e.kind === 'openui').length).toBe(0);
});

test('render_ui is a CORE tool: allowed under the tightest allowlist', () => {
  const r = runInChild(
    "const p=await import('./server/agent-policy.ts');" +
      "emit({core:p.CORE_TOOLS.includes('render_ui'),allowed:p.toolAllowed({tools:[]},'render_ui'),long:p.toolAllowed({tools:['gmail']},'mcp__arigami__render_ui')});"
  );
  expect(r.ok).toBe(true);
  expect(r.out[0]).toEqual({ core: true, allowed: true, long: true });
});

test('the host-MCP render_ui tool embeds the component signatures from the generated skill', () => {
  const src = fs.readFileSync(path.join(ROOT, 'mcp/host-mcp.js'), 'utf8');
  expect(src).toContain("name: 'render_ui'");
  expect(src).toContain("`/__api/sessions/${sid(a)}/ui`");
  const skill = fs.readFileSync(path.join(ROOT, 'skills/render-ui/SKILL.md'), 'utf8');
  expect(skill.startsWith('---\ndescription: ')).toBe(true);
  const sig = (skill.match(/## Components\n\n([\s\S]*?)\n\n## /) || [])[1] || '';
  expect(sig.split('\n').length).toBeGreaterThanOrEqual(13);
  expect(sig).toContain('Form(name: string, children: any[]');
});
