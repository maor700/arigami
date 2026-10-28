// RESUME end-to-end against an ISOLATED host (tmp ARIGAMI_DIR, own port, auth
// off, stub claude), over a real /__ws:
//   - an OLD cockpit (no params) still gets the full v1 replay, heavy fields and all;
//   - a v2 cockpit gets the slim replay with {v, rev, boot}, stamped broadcasts;
//   - reconnecting with since+boot → only the sessions that changed + deleted ids,
//     and the open chat's gap rides along (?open&seq);
//   - an unknown boot → the full replay again;
//   - z=1 → big frames arrive as one binary gzip frame;
//   - REST: ?wire=2 list is slim, gzip only when asked, ?fields= picks heavy parts.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import zlib from 'node:zlib';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './_tmp.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let host: ChildProcess;
let dir: string;
let base: string;
let wsBase: string;
const ids: string[] = [];

const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T | null | undefined | false> | T, ms = 8000): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn();
    if (v) return v as T;
    await sleep(30);
  }
  throw new Error('condition not met in time');
}
async function api(method: string, p: string, body?: unknown): Promise<any> {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return r.json().catch(() => null);
}

// A socket that records every message (binary frames inflated, flagged).
type Rx = { msg: any; binary: boolean };
async function openWs(query = ''): Promise<{ ws: WebSocket; rx: Rx[]; close: () => Promise<void> }> {
  const ws = new WebSocket(`${wsBase}/__ws${query}`);
  ws.binaryType = 'arraybuffer';
  const rx: Rx[] = [];
  ws.onmessage = (e) => {
    if (typeof e.data === 'string') rx.push({ msg: JSON.parse(e.data), binary: false });
    else rx.push({ msg: JSON.parse(zlib.gunzipSync(Buffer.from(e.data as ArrayBuffer)).toString()), binary: true });
  };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  await until(() => rx.some((r) => r.msg.type === 'state'));
  return {
    ws,
    rx,
    close: () => new Promise<void>((res) => { ws.onclose = () => res(); ws.close(); }),
  };
}
const stateOf = (rx: Rx[]) => rx.find((r) => r.msg.type === 'state')!;

beforeAll(async () => {
  dir = tmpDir('arigami-resume-host-');
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  wsBase = `ws://127.0.0.1:${port}`;
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(dir, 'workspace'), { recursive: true });
  const stub = path.join(dir, 'claude-stub.sh');
  fs.writeFileSync(stub, '#!/bin/sh\nexec sleep 3600\n', { mode: 0o755 });
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
      ARIGAMI_DEFAULT_CWD: path.join(dir, 'workspace'),
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
      return (await fetch(base + '/__api/sessions')).ok;
    } catch {
      return false;
    }
  }, 30000).catch(() => {
    throw new Error('host did not start: ' + err.slice(-2000));
  });
  // enough sessions that the replay crosses the gzip-frame threshold
  for (let i = 0; i < 12; i++) {
    const r = await api('POST', '/__api/sessions', { title: `resume ${i} ${'x'.repeat(200)}`, cwd: path.join(dir, 'workspace') });
    ids.push(r.session?.id || r.id);
  }
  // a heavy field on the first one
  await api('POST', `/__api/sessions/${ids[0]}/changes/explanation`, {
    mode: 'uncommitted',
    activate: false,
    files: [{ path: 'a.js', summary: 'y'.repeat(3000) }],
    features: [],
  });
}, 60000);

afterAll(() => {
  try {
    host?.kill('SIGTERM');
  } catch {}
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an old cockpit (no params) still gets the full v1 replay, heavy fields inline, text frames', async () => {
  const c = await openWs();
  const st = stateOf(c.rx);
  expect(st.binary).toBe(false);
  expect(st.msg.v).toBeUndefined();
  expect(st.msg.rev).toBeUndefined();
  const s0 = st.msg.sessions.find((s: any) => s.id === ids[0]);
  expect(s0.changesExplanations.uncommitted.files[0].path).toBe('a.js');
  // its broadcasts stay unstamped and unslimmed
  await api('PATCH', `/__api/sessions/${ids[0]}`, { title: 'renamed for v1' });
  const up = await until(() => c.rx.find((r) => r.msg.type === 'session-updated' && r.msg.session?.title === 'renamed for v1'));
  expect(up.msg.wrev).toBeUndefined();
  expect(up.msg.session.changesExplanations).toBeDefined();
  await c.close();
});

test('a v2 cockpit: slim replay with a cursor, stamped + slim broadcasts', async () => {
  const c = await openWs('?wire=2');
  const st = stateOf(c.rx).msg;
  expect(st.v).toBe(2);
  expect(typeof st.boot).toBe('string');
  expect(Number.isInteger(st.rev)).toBe(true);
  expect(st.delta).toBeUndefined();
  expect(st.sessions.length).toBeGreaterThanOrEqual(12);
  const s0 = st.sessions.find((s: any) => s.id === ids[0]);
  expect(s0.changesExplanations).toBeUndefined();
  expect(typeof s0.changesExplained.uncommitted).toBe('string');
  await api('PATCH', `/__api/sessions/${ids[1]}`, { title: 'renamed for v2' });
  const up = await until(() => c.rx.find((r) => r.msg.type === 'session-updated' && r.msg.session?.title === 'renamed for v2'));
  expect(up.msg.wrev).toBeGreaterThan(st.rev);
  await c.close();
});

test('reconnect with since+boot → only what changed (and what was deleted), plus the open chat gap', async () => {
  const c1 = await openWs('?wire=2');
  const st = stateOf(c1.rx).msg;
  // the last seq the "page" has for ids[2]'s chat
  const before = await api('GET', `/__api/sessions/${ids[2]}/chat`);
  const seq = Array.isArray(before) && before.length ? before[before.length - 1].seq : 0;
  await c1.close();
  // while away: one rename, one delete, one chat card in the open chat
  await api('PATCH', `/__api/sessions/${ids[3]}`, { title: 'changed while away' });
  await api('DELETE', `/__api/sessions/${ids[11]}`);
  const card = await api('POST', `/__api/sessions/${ids[2]}/ui`, { ui: 'root = Stack([TextContent("hi")])', title: 'while away' });
  const c2 = await openWs(`?wire=2&since=${st.rev}&boot=${st.boot}&open=${ids[2]}&seq=${seq}&clip=1500`);
  const d = stateOf(c2.rx).msg;
  expect(d.delta).toBe(true);
  expect(d.rev).toBeGreaterThan(st.rev);
  const changed = d.sessions.map((s: any) => s.id).sort();
  expect(changed).toEqual([ids[2], ids[3]].sort()); // the chat card bumps ids[2]; nothing else
  expect(d.sessions.find((s: any) => s.id === ids[3]).title).toBe('changed while away');
  expect(d.deleted).toContain(ids[11]);
  expect(d.chat.sessionId).toBe(ids[2]);
  expect(d.chat.since).toBe(seq);
  expect(d.chat.events.map((e: any) => e.id)).toContain(card.event_id);
  // listeners/folders/queue always come whole
  expect(Array.isArray(d.folders)).toBe(true);
  expect(Array.isArray(d.listeners)).toBe(true);
  await c2.close();
});

test('an unknown boot (host restarted) → the full replay', async () => {
  const c = await openWs('?wire=2&since=1&boot=not-this-host');
  const st = stateOf(c.rx).msg;
  expect(st.delta).toBeUndefined();
  expect(st.sessions.length).toBeGreaterThanOrEqual(11);
  await c.close();
});

test('z=1: a replay above the threshold arrives as one binary gzip frame', async () => {
  const c = await openWs('?wire=2&z=1');
  const st = stateOf(c.rx);
  expect(st.binary).toBe(true);
  expect(st.msg.v).toBe(2);
  await c.close();
});

test('REST: ?wire=2 slims the list, gzip/br only when asked, ?fields= picks the heavy parts', async () => {
  const raw = (enc?: string, q = '') =>
    fetch(`${base}/__api/sessions?archived=true${q}`, { headers: enc ? { 'accept-encoding': enc } : {}, decompress: false } as any);
  const plain = await raw(undefined, '&wire=2');
  expect(plain.headers.get('content-encoding')).toBe(null);
  const list = await plain.json();
  expect(list.find((s: any) => s.id === ids[0]).changesExplanations).toBeUndefined();
  const gz = await raw('gzip', '&wire=2');
  expect(gz.headers.get('content-encoding')).toBe('gzip');
  expect(gz.headers.get('vary')).toBe('Accept-Encoding');
  expect(JSON.parse(zlib.gunzipSync(Buffer.from(await gz.arrayBuffer())).toString())).toEqual(list);
  const br = await raw('gzip, br', '&wire=2');
  expect(br.headers.get('content-encoding')).toBe('br');
  // no wire param → the old, full form
  const v1 = await (await raw()).json();
  expect(v1.find((s: any) => s.id === ids[0]).changesExplanations.uncommitted).toBeDefined();
  // the on-demand fetch
  const f = await api('GET', `/__api/sessions/${ids[0]}?fields=changesExplanations,claude.state`);
  expect(Object.keys(f).sort()).toEqual(['changesExplanations', 'claude', 'id']);
  expect(f.changesExplanations.uncommitted.files[0].path).toBe('a.js');
  expect(Object.keys(f.claude)).toEqual(['state']);
});
