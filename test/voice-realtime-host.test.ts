// Stage 1c clerk over HTTP against an isolated host: the mint goes to a fake OpenAI (ARIGAMI_OPENAI_API_BASE) with the
// stored key and comes back without it; the tools run with the host's own paths (list/status/create/interrupt),
// transcript + end write the ledger and the cards; a call of another session is refused.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hostDiag } from './_host-diag.js';
import { tmpDir } from './_tmp.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEY = 'sk-test-SECRETKEY-0123456789abcdef';

let host: ChildProcess;
let dir: string;
let base: string;
let openai: ReturnType<typeof Bun.serve>;
const minted: { auth: string | null; body: any }[] = [];

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
  try { return { status: r.status, json: JSON.parse(text) }; } catch { return { status: r.status, json: { raw: text } }; }
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
  dir = tmpDir('arigami-rt-host-');
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  const stub = path.join(dir, 'cli-stub.sh');
  fs.writeFileSync(stub, '#!/bin/sh\nexec sleep 3600\n', { mode: 0o755 });
  const codexHome = path.join(dir, 'codex-home');
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'auth.json'), '{"auth_mode":"chatgpt"}');
  // The key is seeded the way POST /__api/setup/voice:openai stores it (that route would verify against the real vendor).
  fs.writeFileSync(path.join(dir, 'voice-providers.json'), JSON.stringify({ 'voice:openai': { token: KEY, at: new Date().toISOString() } }), { mode: 0o600 });
  openai = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: async (req) => {
      const u = new URL(req.url);
      if (u.pathname === '/v1/realtime/client_secrets' && req.method === 'POST') {
        minted.push({ auth: req.headers.get('authorization'), body: await req.json() });
        return Response.json({ value: `ek_fake_${minted.length}`, expires_at: 1900000000, session: { id: 'sess_vendor' } });
      }
      if (u.pathname === '/v1/models') return Response.json({ data: [] }); // the boot-time check() of the stored key
      return new Response('nope', { status: 404 });
    },
  });
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
      ARIGAMI_CODEX_BIN: stub,
      ARIGAMI_CODEX_HOME: codexHome,
      ARIGAMI_WA_DATA_DIR: path.join(dir, 'wa'),
      ARIGAMI_TELEMETRY: '0',
      ARIGAMI_DEFAULT_CWD: path.join(dir, 'workspace'),
      ARIGAMI_OPENAI_API_BASE: `http://127.0.0.1:${openai.port}`,
      COMPOSIO_API_KEY: '',
      GROQ_API_KEY: '',
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
      try { return (await fetch(base + '/__api/config', { signal: AbortSignal.timeout(3000) })).ok; } catch { return false; }
    }, 30000);
  } catch {
    throw new Error(`host did not come up: ${log.slice(-1500)}${hostDiag(host)}`);
  }
}, 60_000);

afterAll(() => {
  try { host?.kill('SIGKILL'); } catch {}
  try { openai?.stop(true); } catch {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
});

test('the clerk over HTTP: mint without the key, tools through the host, transcript + end → ledger and cards', async () => {
  const config = (await api('GET', '/__api/config')).json;
  expect(config.voiceProviders.realtime).toEqual(['voice:openai']);
  const s1 = (await api('POST', '/__api/sessions', { title: 'Fix login' })).json;
  expect(s1.id).toMatch(/^sess_/);
  // team by voice: one agent in the registry → the persona names it, create_session({agent}) births the session from it
  const chief = await api('POST', '/__api/agents', { slug: 'chief', name: "צ'יף", emoji: '🎩', persona: 'אתה הצ\'יף אוף סטאף של מאור.\nשורה שנייה.', tools: ['sessions'] });
  expect(chief.status).toBe(201);

  const mint = await api('POST', '/__api/voice/realtime/session', { sessionId: s1.id, lang: 'he' });
  expect(mint.status).toBe(200);
  expect(mint.json.ok).toBe(true);
  expect(mint.json.clientSecret).toBe('ek_fake_1');
  expect(mint.json.callsUrl).toBe(`http://127.0.0.1:${openai.port}/v1/realtime/calls`);
  expect(JSON.stringify(mint.json)).not.toContain(KEY);
  expect(minted[0].auth).toBe(`Bearer ${KEY}`);
  expect(minted[0].body.session.model).toBe('gpt-realtime-2.1');
  expect(minted[0].body.session.tools.length).toBe(7);
  expect(minted[0].body.session.instructions).toContain("team of agents (list_agents): צ'יף (chief).");
  const call = mint.json.callId;

  const tool = (name: string, args: Record<string, unknown>, sessionId = s1.id, callId = call) => api('POST', '/__api/voice/realtime/tool', { sessionId, callId, name, args });
  const list = await tool('list_sessions', {});
  expect(list.json.ok).toBe(true);
  expect(list.json.result.sessions.map((s: any) => s.title)).toContain('Fix login');
  const created = await tool('create_session', { title: 'Deploy', prompt: 'ship it' });
  expect(created.json).toEqual({ ok: true, result: { id: expect.stringMatching(/^sess_/), title: 'Deploy', created: true } });
  const s2 = created.json.result.id;
  const s2chat = await until(async () => { const c = (await api('GET', `/__api/sessions/${s2}/chat`)).json; return Array.isArray(c) && c.some((e: any) => e.kind === 'user') ? c : null; });
  expect(s2chat.find((e: any) => e.kind === 'user').text).toBe('ship it');
  const status = await tool('session_status', { id: s2 });
  expect(status.json.result.title).toBe('Deploy');
  expect(['working', 'idle', 'starting', 'dead']).toContain(status.json.result.state);
  const stop = await tool('interrupt_session', { id: s2 });
  expect(stop.json.ok).toBe(true);
  expect(typeof stop.json.result.interrupted).toBe('boolean');
  const unknown = await tool('merge_session', { id: s2 });
  expect(unknown.status).toBe(400);
  expect((await tool('list_agents', {})).json).toEqual({ ok: true, result: { agents: [{ slug: 'chief', name: "צ'יף", description: "אתה הצ'יף אוף סטאף של מאור." }] } });
  const born = await tool('create_session', { title: 'סיכום היום', prompt: 'תסכם לי את היום', agent: 'צ׳יף' });
  expect(born.json).toEqual({ ok: true, result: { id: expect.stringMatching(/^sess_/), title: 'סיכום היום', created: true, agent: 'chief' } });
  const byId = async (id: string) => { const j = (await api('GET', '/__api/sessions?full=1')).json; return (Array.isArray(j) ? j : j.sessions).find((s: any) => s.id === id); };
  const s3 = await byId(born.json.result.id);
  expect(s3.metadata).toMatchObject({ agent: 'chief', createdBy: 'voice' });
  expect(s3.color).toBe(chief.json.color);
  expect((await tool('create_session', { title: 'x', prompt: 'y', agent: 'nobody' })).json).toEqual({ ok: false, error: "no agent called \"nobody\" — the team is: צ'יף (chief)" });
  expect((await tool('list_sessions', { agent: 'chief' })).json.result.sessions.map((s: any) => [s.title, s.agent])).toEqual([['סיכום היום', 'chief']]);
  expect((await byId(s2)).metadata).toMatchObject({ createdBy: 'voice' });
  const other = await tool('list_sessions', {}, s2);
  expect(other.status).toBe(403);

  const tr = await api('POST', '/__api/voice/realtime/transcript', { sessionId: s1.id, callId: call, turns: [{ role: 'user', text: 'מה המצב?', id: 'i1' }, { role: 'assistant', text: 'הכל בסדר.', id: 'o1' }] });
  expect(tr.json).toEqual({ ok: true, turns: 2 });
  const end = await api('POST', '/__api/voice/realtime/end', { sessionId: s1.id, callId: call, seconds: 3 });
  expect(end.json.ok).toBe(true);
  expect(end.json.seconds).toBe(3);
  expect((await api('POST', '/__api/voice/realtime/end', { sessionId: s1.id, callId: call, seconds: 3 })).status).toBe(403);
  const budget = (await api('GET', '/__api/voice/budget')).json;
  expect(budget.usage['voice:openai'].seconds).toBe(3);
  expect(budget.usage['voice:openai'].calls).toBe(1);

  const chat = (await api('GET', `/__api/sessions/${s1.id}/chat`)).json;
  const cards = chat.filter((e: any) => e.kind === 'ext-card' && e.extension === 'voice');
  expect(cards.map((c: any) => c.voice.tool || c.voice.reason)).toEqual(['list_sessions', 'create_session', 'session_status', 'interrupt_session', 'list_agents', 'create_session', 'create_session', 'list_sessions', 'hangup']);
  expect(cards[5].title).toBe('📞 create_session · chief');
  expect(cards[5].voice.agent).toBe('chief');
  expect(cards[8].title).toBe('📞 שיחה קולית · 0:03');
  expect(cards[8].body).toBe('**אתה:** מה המצב?\n\n**הפקיד:** הכל בסדר.');
  expect(JSON.stringify(chat)).not.toContain(KEY);
}, 30_000);
