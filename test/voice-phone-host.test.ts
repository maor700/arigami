// Stage 2 phone over a real isolated host: the admin routes (number/PIN, never the hash), the public twilio webhook (no cookie,
// signature only), the stream WebSocket passing the upgrade gate without a cookie, and the REAL Gemini Live backend code against a
// fake Live server (setup, 16 kHz PCM in, 24 kHz PCM out → μ-law frames to the fake Twilio, tool round-trip, transcript card in the
// voice home session, both ledgers). Twilio's REST + check and Gemini's HTTP check are the same fake. No real call, no vendor.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './_tmp.js';
import { twilioSignature, TWILIO_VOICE_PATH, TWILIO_STATUS_PATH, TWILIO_STREAM_PATH } from '../server/voice-phone.ts';
import { pcmToBuffer } from '../server/lib/audio-g711.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SID = 'AC' + 'b'.repeat(32);
const TOKEN = 'twilio-auth-token-SECRET-abcdef0123';
const GKEY = 'AIza-test-gemini-SECRET-0123456789';
const OWNER = '+972500000000';
const CALL = 'CA' + '7'.repeat(32);
const PUB = 'https://pub.example';

let host: ChildProcess;
let dir: string;
let base: string;
let fake: ReturnType<typeof Bun.serve>;
const gemini: { setups: any[]; audioIn: any[]; toolResponses: any[]; sockets: any[] } = { setups: [], audioIn: [], toolResponses: [], sockets: [] };
const twilioRest: { url: string; body: string }[] = [];

const freePort = (): Promise<number> => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); }); });
async function api(method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<any> {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  const text = await r.text();
  try { return { status: r.status, json: JSON.parse(text), text, type: r.headers.get('content-type') || '' }; } catch { return { status: r.status, json: null, text, type: r.headers.get('content-type') || '' }; }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, ms = 8000): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v as T; await sleep(50); }
  throw new Error('condition not met in time');
}

beforeAll(async () => {
  dir = tmpDir('arigami-phone-host-');
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  const stub = path.join(dir, 'cli-stub.sh');
  fs.writeFileSync(stub, '#!/bin/sh\nexec sleep 3600\n', { mode: 0o755 });
  const codexHome = path.join(dir, 'codex-home');
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'auth.json'), '{"auth_mode":"chatgpt"}');
  fs.writeFileSync(path.join(dir, 'voice-providers.json'), JSON.stringify({ 'telephony:twilio': { sid: SID, token: TOKEN, at: new Date().toISOString() }, 'voice:gemini': { token: GKEY, at: new Date().toISOString() } }), { mode: 0o600 });
  // one fake for both vendors: Twilio REST (account check + Calls update) and Gemini (models check + the Live WebSocket)
  fake = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: async (req, server) => {
      const u = new URL(req.url);
      if (u.pathname.includes('BidiGenerateContent')) {
        if (u.searchParams.get('key') !== GKEY) return new Response('bad key', { status: 403 });
        return server.upgrade(req) ? undefined : new Response('no upgrade', { status: 400 });
      }
      if (u.pathname === '/v1beta/models') return Response.json({ models: [] });
      if (u.pathname === `/2010-04-01/Accounts/${SID}.json`) return Response.json({ sid: SID });
      if (u.pathname.startsWith(`/2010-04-01/Accounts/${SID}/Calls/`) && req.method === 'POST') { twilioRest.push({ url: u.pathname, body: await req.text() }); return Response.json({ sid: CALL }); }
      return new Response('nope', { status: 404 });
    },
    websocket: {
      open(ws) { gemini.sockets.push(ws); },
      message(ws, data) {
        const m = JSON.parse(String(data));
        if (m.setup) { gemini.setups.push(m.setup); ws.send(JSON.stringify({ setupComplete: {} })); return; }
        if (m.realtimeInput?.audio) {
          gemini.audioIn.push({ mime: m.realtimeInput.audio.mimeType, bytes: Buffer.from(m.realtimeInput.audio.data, 'base64').length });
          if (gemini.audioIn.length === 3) {
            // the model answers: a transcript of what it heard, 0.1 s of 24 kHz audio, its own words, a tool call, turn done
            ws.send(JSON.stringify({ serverContent: { inputTranscription: { text: 'מה המצב' } } }));
            ws.send(JSON.stringify({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: pcmToBuffer(new Int16Array(2400).fill(3000)).toString('base64') } }] }, outputTranscription: { text: 'רגע, בודק' } } }));
            ws.send(JSON.stringify({ toolCall: { functionCalls: [{ id: 'fc-1', name: 'list_sessions', args: {} }] } }));
          }
          return;
        }
        if (m.toolResponse) { gemini.toolResponses.push(m.toolResponse); ws.send(JSON.stringify({ serverContent: { interrupted: true } })); ws.send(JSON.stringify({ serverContent: { turnComplete: true } })); }
      },
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
      ARIGAMI_GEMINI_API_BASE: `http://127.0.0.1:${fake.port}`,
      ARIGAMI_TWILIO_API_BASE: `http://127.0.0.1:${fake.port}`,
      ARIGAMI_VOICE_LANG: 'he',
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
    await until(async () => { try { return (await fetch(base + '/__api/config', { signal: AbortSignal.timeout(3000) })).ok; } catch { return false; } }, 30000);
  } catch {
    throw new Error(`host did not come up: ${log.slice(-1500)}`);
  }
}, 60_000);

afterAll(() => {
  try { host?.kill('SIGKILL'); } catch {}
  try { fake?.stop(true); } catch {}
});

const form = (p: Record<string, string>) => new URLSearchParams(p).toString();
const signed = (pathname: string, p: Record<string, string>) => api('POST', pathname, form(p), { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': twilioSignature(TOKEN, PUB + pathname, p) });

test('settings → signed webhook → PIN → stream WebSocket → Gemini Live fake → cards + ledgers', async () => {
  // admin routes: the config exposes only {ownerNumber, pinSet}; the view has the URLs once a base is set
  let cfg = (await api('GET', '/__api/config')).json;
  expect(cfg.telephony).toEqual({ ownerNumber: '', pinSet: false });
  expect(cfg.voiceProviders.telephony).toBe(true);
  const before = (await api('GET', '/__api/voice/phone')).json;
  expect(before).toMatchObject({ telephony: true, pinSet: false, ownerNumber: '' }); // the base may already be a Funnel host on this box
  expect((await api('POST', '/__api/voice/phone', { pin: '12' })).status).toBe(400);
  const set = (await api('POST', '/__api/voice/phone', { ownerNumber: OWNER, pin: '2468', publicUrl: PUB })).json;
  expect(set).toMatchObject({ ownerNumber: OWNER, pinSet: true, base: PUB, voiceUrl: PUB + TWILIO_VOICE_PATH, statusUrl: PUB + TWILIO_STATUS_PATH, streamUrl: 'wss://pub.example' + TWILIO_STREAM_PATH });
  expect(JSON.stringify(set)).not.toContain('2468');
  cfg = (await api('GET', '/__api/config')).json;
  expect(cfg.telephony).toEqual({ ownerNumber: OWNER, pinSet: true });
  expect(JSON.stringify(cfg)).not.toContain('scrypt');
  expect((await api('POST', '/__api/voice/phone/test-signature', {})).json.ok).toBe(true);

  // the public webhook: no cookie needed (auth off here, but the allowlist is what a real host uses) — the signature decides
  const p = { CallSid: CALL, From: OWNER, To: '+972330000000', CallStatus: 'ringing', AccountSid: SID };
  expect((await api('POST', TWILIO_VOICE_PATH, form(p), { 'content-type': 'application/x-www-form-urlencoded' })).status).toBe(401);
  const first = await signed(TWILIO_VOICE_PATH, p);
  expect(first.status).toBe(200);
  expect(first.type).toBe('text/xml; charset=utf-8');
  expect(first.text).toContain('<Gather input="dtmf"');
  expect((await signed(TWILIO_VOICE_PATH, { ...p, Digits: '0000' })).text).toContain('<Gather');
  const ok = await signed(TWILIO_VOICE_PATH, { ...p, Digits: '2468' });
  const token = /name="token" value="([^"]+)"/.exec(ok.text)?.[1] || '';
  expect(ok.text).toContain(`<Connect><Stream url="wss://pub.example${TWILIO_STREAM_PATH}">`);
  expect(token.length).toBeGreaterThanOrEqual(32);

  // the stream: an anonymous upgrade passes index.ts (no cookie) and the bridge talks to the fake Live server
  const msgs: any[] = [];
  let closeCode: number | null = null;
  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const w = new WebSocket(base.replace(/^http/, 'ws') + TWILIO_STREAM_PATH);
    w.onmessage = (e) => { try { msgs.push(JSON.parse(String(e.data))); } catch {} };
    w.onclose = (e) => { closeCode = e.code; };
    w.onopen = () => resolve(w);
    w.onerror = () => reject(new Error('stream upgrade refused'));
  });
  ws.send(JSON.stringify({ event: 'connected', protocol: 'Call' }));
  ws.send(JSON.stringify({ event: 'start', streamSid: 'MZ1', start: { streamSid: 'MZ1', callSid: CALL, customParameters: { token }, mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 } } }));
  const frame = Buffer.alloc(160, 0xff).toString('base64');
  for (let i = 0; i < 3; i++) ws.send(JSON.stringify({ event: 'media', media: { track: 'inbound', chunk: String(i), payload: frame } }));
  await until(() => gemini.toolResponses.length === 1, 10000);
  expect(gemini.setups[0].model).toBe('models/gemini-3.8-live');
  expect(gemini.setups[0].systemInstruction.parts[0].text).toContain('calling by phone');
  expect(gemini.setups[0].tools[0].functionDeclarations.map((f: any) => f.name)).toContain('list_sessions');
  expect(gemini.audioIn.slice(0, 3)).toEqual([{ mime: 'audio/pcm;rate=16000', bytes: 640 }, { mime: 'audio/pcm;rate=16000', bytes: 640 }, { mime: 'audio/pcm;rate=16000', bytes: 640 }]);
  expect(gemini.toolResponses[0].functionResponses[0]).toMatchObject({ id: 'fc-1', name: 'list_sessions', response: { result: { sessions: expect.any(Array) } } });
  await until(() => msgs.some((m) => m.event === 'clear'));
  const media = msgs.filter((m) => m.event === 'media');
  expect(media.length).toBe(1);
  expect(Buffer.from(media[0].media.payload, 'base64').length).toBe(800); // 2400 samples at 24 kHz → 800 μ-law bytes
  expect(media[0].streamSid).toBe('MZ1');

  // hang up → transcript + audit cards in the voice home session; Twilio's status → its minutes
  ws.send(JSON.stringify({ event: 'stop', streamSid: 'MZ1' }));
  await until(() => closeCode !== null);
  const st = { CallSid: CALL, CallStatus: 'completed', CallDuration: '42', AccountSid: SID };
  expect((await signed(TWILIO_STATUS_PATH, st)).status).toBe(204);
  const sessions = (await api('GET', '/__api/sessions')).json;
  const home = (Array.isArray(sessions) ? sessions : sessions.sessions).find((s: any) => s.metadata?.voiceHome);
  expect(home?.title).toBe('Voice calls');
  const chat = await until(async () => { const c = (await api('GET', `/__api/sessions/${home.id}/chat`)).json; return Array.isArray(c) && c.some((e: any) => e.voice?.reason) ? c : null; });
  const cards = chat.filter((e: any) => e.kind === 'ext-card' && e.extension === 'voice');
  expect(cards.map((c: any) => c.voice.event || c.voice.tool || c.voice.reason)).toEqual(['pin-fail', 'pin-ok', 'list_sessions', 'hangup']);
  const tr = cards[3];
  expect(tr.title).toMatch(/^📞 שיחת טלפון · 0:0\d$/);
  expect(tr.body).toBe('**אתה:** מה המצב\n\n**הפקיד:** רגע, בודק');
  expect(tr.voice.channel).toBe('phone');
  const budget = (await api('GET', '/__api/voice/budget')).json;
  expect(budget.usage['telephony:twilio']).toMatchObject({ seconds: 42, calls: 1 });
  expect(budget.usage['voice:gemini'].calls).toBe(1);
  expect(JSON.stringify(chat) + JSON.stringify(budget)).not.toMatch(new RegExp(`${TOKEN}|${GKEY}|2468`));
  expect(twilioRest.length).toBe(0); // nothing forced the call down
}, 40_000);
