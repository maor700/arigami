// Runs the stage-2 phone scenarios in a fresh process (ARIGAMI_DIR from env) and prints one JSON line. Spawned by test/voice-phone.test.ts.
import http from 'node:http';
import { cfg, updateVoiceConfig, updateTelephonyConfig } from '../../server/lib/config.js';
import { setProviderSecret } from '../../server/voice-providers.js';
import { voiceUsageThisMonth } from '../../server/voice-usage.js';
import * as rt from '../../server/voice-realtime.js';
import * as vp from '../../server/voice-phone.js';
import { createPhoneBridge, type Backend, type BackendEvents } from '../../server/voice-phone-bridge.js';
import { createWebhooks } from '../../server/webhooks.js';
import { pcmB64ToMulawB64 } from '../../server/lib/audio-g711.js';

const OWNER = '+972501234567';
const SID = 'AC' + 'a'.repeat(32);
const TOKEN = 'twilio-auth-token-SECRET-0123456789';
const callSid = (n: number): string => 'CA' + String(n).padStart(32, '0');
const out: Record<string, unknown> = {};
const logs: string[] = [];
console.log = (...a) => logs.push(a.join(' '));
console.error = (...a) => logs.push(a.join(' '));

const cards: { id: string; ev: any }[] = [];
const sent: { id: string; text: string }[] = [];
const host = {
  listSessions: () => [{ id: 'sess_a', title: 'Alpha', status: 'working', claude: { state: 'working' } }, { id: 'sess_b', title: 'Beta', archived: true }],
  getSession: (id: string) => host.listSessions().find((s) => s.id === id) || null,
  sendMessage: (id: string, text: string) => { sent.push({ id, text }); },
  interrupt: () => true,
  createSession: ({ title }: { title: string }) => ({ id: 'sess_new', title }),
  chatSeq: () => 0,
  getChat: () => [{ kind: 'assistant-text', text: 'done it' }, { kind: 'result' }],
  appendChat: (id: string, ev: any) => { cards.push({ id, ev }); },
  voiceHome: () => ({ id: 'sess_home' }),
} as any;
const cardTitles = () => cards.map((c) => `${c.id}:${c.ev.title}:${c.ev.voice?.event || c.ev.voice?.tool || c.ev.voice?.reason || ''}`);

setProviderSecret('telephony:twilio', { sid: SID, token: TOKEN });
setProviderSecret('voice:gemini', { token: 'AIza-test-gemini-key-0123456789' });
updateTelephonyConfig({ ownerNumber: OWNER, pinHash: vp.hashPin('4321'), publicUrl: 'https://pub.example' });
const BASE = 'https://pub.example';
let t = 1_800_000_000_000;
const voice = (params: Record<string, string>, now = t) => vp.handleVoice(params, { host, base: BASE, now });
const has = (xml: string, re: RegExp | string) => (typeof re === 'string' ? xml.includes(re) : re.test(xml));

async function flow(): Promise<void> {
  // owner gate
  out.stranger = voice({ CallSid: callSid(1), From: '+972509999999' });
  out.noSid = voice({ CallSid: 'nope', From: OWNER });
  // first contact → gather
  const first = voice({ CallSid: callSid(2), From: OWNER });
  out.first = first;
  out.firstGather = has(first, `<Gather input="dtmf" finishOnKey="#" timeout="10" action="${BASE}${vp.TWILIO_VOICE_PATH}" method="POST"><Say language="he-IL">`);
  // two wrong, third wrong → lockout
  out.wrong1 = voice({ CallSid: callSid(2), From: OWNER, Digits: '0000' });
  out.wrong2 = voice({ CallSid: callSid(2), From: OWNER, Digits: '1111' });
  out.wrong3 = voice({ CallSid: callSid(2), From: OWNER, Digits: '2222' });
  out.lockedUntil = vp.lockedUntilMs();
  out.whileLocked = voice({ CallSid: callSid(3), From: OWNER, Digits: '4321' });
  out.afterLockout = voice({ CallSid: callSid(4), From: OWNER }, t + vp.LOCKOUT_MS + 1);
  t += vp.LOCKOUT_MS + 1;
  // right PIN → connect + stream token
  const ok = voice({ CallSid: callSid(4), From: OWNER, Digits: '4321' });
  out.ok = ok;
  const token = /name="token" value="([^"]+)"/.exec(ok)?.[1] || '';
  out.tokenLen = token.length;
  out.okReplay = voice({ CallSid: callSid(4), From: OWNER, Digits: '4321' }); // inert: no second token
  out.consumeBad = vp.consumeStreamToken(callSid(4), 'x'.repeat(32), t);
  out.consumeOk = !!vp.consumeStreamToken(callSid(4), token, t);
  out.consumeTwice = vp.consumeStreamToken(callSid(4), token, t);
  // cumulative failures across calls lock too (hang up + redial must not reset the count)
  vp.__resetPhone();
  for (const n of [10, 11, 12]) voice({ CallSid: callSid(n), From: OWNER, Digits: '9999' });
  out.crossCallLock = vp.lockedUntilMs() > 0;
  vp.__resetPhone();
  // status billing: once, with CallDuration
  voice({ CallSid: callSid(5), From: OWNER });
  vp.handleStatus({ CallSid: callSid(5), CallStatus: 'completed', CallDuration: '61' });
  vp.handleStatus({ CallSid: callSid(5), CallStatus: 'completed', CallDuration: '61' });
  vp.handleStatus({ CallSid: callSid(6), CallStatus: 'completed', CallDuration: '600' }); // unknown call → ignored
  out.twilioLedger = voiceUsageThisMonth()['telephony:twilio'];
  // gates
  const busy = rt.openHostCall({ sessionId: 'sess_home', provider: 'voice:gemini', model: 'm' });
  out.busy = voice({ CallSid: callSid(7), From: OWNER, Digits: '4321' });
  if ('callId' in busy) rt.endRealtimeCall({ sessionId: 'sess_home', callId: busy.callId, seconds: 1 }, host);
  updateVoiceConfig({ caps: { 'telephony:twilio': 0.001 } });
  out.twilioCapped = voice({ CallSid: callSid(8), From: OWNER });
  updateVoiceConfig({ caps: { 'telephony:twilio': null } });
  updateVoiceConfig({ enabled: false });
  out.off = voice({ CallSid: callSid(8), From: OWNER });
  updateVoiceConfig({ enabled: true });
  updateTelephonyConfig({ pinHash: '' });
  out.noPin = voice({ CallSid: callSid(9), From: OWNER });
  updateTelephonyConfig({ pinHash: vp.hashPin('4321') });
  // settings
  out.view = vp.phoneView('tail.ts.net');
  out.selfTest = vp.selfTestSignature();
  updateTelephonyConfig({ publicUrl: '' });
  out.viewFunnel = vp.phoneView('tail.ts.net');
  out.selfTestNoBase = vp.selfTestSignature('');
  const bad: string[] = [];
  for (const b of [{ ownerNumber: '0501234567' }, { pin: '12' }, { pin: 'abcd' }, { publicUrl: 'http://x' }]) { try { vp.updatePhone(b); bad.push('accepted'); } catch (e) { bad.push((e as Error).message); } }
  out.badUpdates = bad;
  out.updated = vp.updatePhone({ ownerNumber: '+1 (234) 567-8901', pin: '123456', publicUrl: 'https://my.host:8443/' });
  out.cfgHashKind = String(cfg.telephony.pinHash).split('$')[0];
  out.cfgHashHasPin = String(cfg.telephony.pinHash).includes('123456');
  out.cleared = vp.updatePhone({ clearPin: true });
  out.cards = cardTitles();
  out.secretLeak = JSON.stringify({ out, logs }).includes(TOKEN) || JSON.stringify({ out, logs }).includes('4321');
}

// the `twilio` webhook kind end to end over HTTP (signature → TwiML / 204)
async function webhook(): Promise<void> {
  const wh = createWebhooks({ dir: process.env.ARIGAMI_DIR!, now: () => t, log: (m) => logs.push(m), publicUrl: (p) => BASE + p, twilio: { token: vp.twilioToken, bases: () => [BASE], voice: (p) => vp.handleVoice(p, { host, base: BASE, now: t }), status: (p) => vp.handleStatus(p) } });
  const srv = http.createServer(async (req, res) => { if (await wh.handle(req, res)) return; res.writeHead(404); res.end(); });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const post = async (path: string, params: Record<string, string>, sig?: string) => {
    const body = new URLSearchParams(params).toString();
    const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...(sig ? { 'x-twilio-signature': sig } : {}) }, body });
    return { status: r.status, type: r.headers.get('content-type') || '', text: await r.text() };
  };
  const p = { CallSid: callSid(20), From: OWNER, To: '+972330000000', CallStatus: 'ringing', AccountSid: SID };
  out.whUnsigned = await post(vp.TWILIO_VOICE_PATH, p);
  out.whBadSig = await post(vp.TWILIO_VOICE_PATH, p, vp.twilioSignature('wrong-token', BASE + vp.TWILIO_VOICE_PATH, p));
  out.whTampered = await post(vp.TWILIO_VOICE_PATH, { ...p, From: '+972509999999' }, vp.twilioSignature(TOKEN, BASE + vp.TWILIO_VOICE_PATH, p));
  out.whOk = await post(vp.TWILIO_VOICE_PATH, p, vp.twilioSignature(TOKEN, BASE + vp.TWILIO_VOICE_PATH, p));
  out.whOkAgain = await post(vp.TWILIO_VOICE_PATH, p, vp.twilioSignature(TOKEN, BASE + vp.TWILIO_VOICE_PATH, p)); // voice: no replay 401
  const st = { CallSid: callSid(20), CallStatus: 'completed', CallDuration: '30', AccountSid: SID };
  const stSig = vp.twilioSignature(TOKEN, BASE + vp.TWILIO_STATUS_PATH, st);
  out.whStatus = await post(vp.TWILIO_STATUS_PATH, st, stSig);
  out.whStatusReplay = await post(vp.TWILIO_STATUS_PATH, st, stSig);
  out.whGet = (await fetch(base + vp.TWILIO_VOICE_PATH)).status;
  out.whEvents = wh.events({ kind: 'twilio' }).map((e) => ({ event: e.event, payload: e.payload }));
  out.whLedger = voiceUsageThisMonth()['telephony:twilio'];
  srv.close();
}

// the media stream against a fake Twilio client and a stubbed backend
async function bridge(): Promise<void> {
  const twilioRest: { url: string; body: string }[] = [];
  const rest = http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { twilioRest.push({ url: req.url || '', body: b }); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); }); });
  await new Promise<void>((r) => rest.listen(0, '127.0.0.1', () => r()));
  process.env.ARIGAMI_TWILIO_API_BASE = `http://127.0.0.1:${(rest.address() as any).port}`;
  const backends: { received: number[]; events: BackendEvents; results: any[]; closed: boolean; provider: string; instructions: string }[] = [];
  const bridge = createPhoneBridge({
    host,
    budgetEveryMs: 40,
    startTimeoutMs: 300,
    backendFactory: async (o) => {
      const b = { received: [] as number[], events: o.events, results: [] as any[], closed: false, provider: o.provider, instructions: o.instructions };
      backends.push(b);
      const be: Backend = {
        sendMulaw: (b64) => { b.received.push(Buffer.from(b64, 'base64').length); },
        toolResult: (c, r) => { b.results.push({ c, r }); },
        close: () => { b.closed = true; },
      };
      return be;
    },
  });
  const srv = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
  srv.on('upgrade', (req, socket, head) => { if (req.url === vp.TWILIO_STREAM_PATH) bridge.handleUpgrade(req, socket as any, head); else socket.destroy(); });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const wsUrl = `ws://127.0.0.1:${(srv.address() as any).port}${vp.TWILIO_STREAM_PATH}`;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const until = async (f: () => boolean, ms = 3000) => { const t0 = Date.now(); while (!f() && Date.now() - t0 < ms) await sleep(10); return f(); };
  const open = (): Promise<{ ws: WebSocket; msgs: any[]; closeCode: () => number | null }> => new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const msgs: any[] = [];
    let code: number | null = null;
    ws.onmessage = (e) => { try { msgs.push(JSON.parse(String(e.data))); } catch { /* ignore */ } };
    ws.onclose = (e) => { code = e.code; };
    ws.onopen = () => resolve({ ws, msgs, closeCode: () => code });
    ws.onerror = () => reject(new Error('ws failed'));
  });
  const tokenFor = (n: number): string => { voice({ CallSid: callSid(n), From: OWNER }); return /name="token" value="([^"]+)"/.exec(voice({ CallSid: callSid(n), From: OWNER, Digits: '4321' }))?.[1] || ''; };
  const start = (ws: WebSocket, n: number, token: string) => ws.send(JSON.stringify({ event: 'start', streamSid: `MZ${n}`, start: { streamSid: `MZ${n}`, callSid: callSid(n), customParameters: { token }, mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 } } }));
  const frame = Buffer.alloc(160, 0xff).toString('base64'); // 20 ms of μ-law silence

  // 1) a bad token is refused before any media
  { const c = await open(); start(c.ws, 30, 'bad-token'); await until(() => c.closeCode() !== null); out.badToken = { code: c.closeCode(), backends: backends.length }; }
  // 2) no start at all → closed
  { const c = await open(); await until(() => c.closeCode() !== null, 2000); out.noStart = c.closeCode(); }
  // 3) the real thing
  const tok = tokenFor(31);
  const c = await open();
  c.ws.send(JSON.stringify({ event: 'connected', protocol: 'Call' }));
  for (let i = 0; i < 3; i++) c.ws.send(JSON.stringify({ event: 'media', media: { track: 'inbound', chunk: String(i), payload: frame } }));
  start(c.ws, 31, tok);
  for (let i = 0; i < 5; i++) c.ws.send(JSON.stringify({ event: 'media', media: { track: 'inbound', chunk: String(i), payload: frame } }));
  await until(() => backends.length === 1 && backends[0].received.length >= 5);
  const b = backends[0];
  out.bridged = { provider: b.provider, received: b.received, phoneInstructions: b.instructions.includes('calling by phone'), live: bridge.live(), clerkCalls: rt.liveCallCount() };
  // the clerk speaks: a backend hands the bridge μ-law (here: 24 kHz PCM through the same converter the Gemini backend uses)
  const pcm = Buffer.alloc(2 * 24000 * 0.5); // 0.5 s at 24 kHz → 4000 μ-law bytes → one frame
  b.events.audio(pcmB64ToMulawB64(pcm.toString('base64'), 24000));
  const big = Buffer.alloc(2 * 24000); // 1 s → two frames
  b.events.audio(pcmB64ToMulawB64(big.toString('base64'), 24000));
  await until(() => c.msgs.filter((m) => m.event === 'media').length >= 3);
  out.outMedia = c.msgs.filter((m) => m.event === 'media').map((m) => ({ streamSid: m.streamSid, bytes: Buffer.from(m.media.payload, 'base64').length }));
  // barge-in → clear
  b.events.interrupted();
  await until(() => c.msgs.some((m) => m.event === 'clear'));
  out.clear = c.msgs.find((m) => m.event === 'clear');
  // a tool round-trip through the host (audit card in the home session) and a transcript
  b.events.tool({ callId: 'fc1', name: 'list_sessions', args: {} });
  b.events.tool({ callId: 'fc2', name: 'nope', args: {} });
  await until(() => b.results.length === 2);
  out.toolResults = b.results.map((r) => ({ id: r.c.callId, keys: Object.keys(r.r), sessions: r.r.sessions?.map((s: any) => s.title) }));
  b.events.turn({ role: 'user', text: 'מה המצב?', id: 'u1' });
  b.events.turn({ role: 'assistant', text: 'הכל טוב.', id: 'a1' });
  // Twilio hangs up
  c.ws.send(JSON.stringify({ event: 'stop', streamSid: 'MZ31' }));
  await until(() => b.closed && bridge.live() === 0);
  const transcript = cards.find((x) => x.ev.voice?.reason === 'hangup');
  out.ended = { closed: b.closed, live: bridge.live(), clerkCalls: rt.liveCallCount(), transcript: transcript ? { id: transcript.id, title: transcript.ev.title, body: transcript.ev.body, channel: transcript.ev.voice.channel, turns: transcript.ev.voice.turns, tools: transcript.ev.voice.tools } : null };
  out.geminiLedger = voiceUsageThisMonth()['voice:gemini'];
  vp.handleStatus({ CallSid: callSid(31), CallStatus: 'completed', CallDuration: '45' }, (sid) => bridge.closeCall(sid));
  out.twilioLedgerAfterStatus = voiceUsageThisMonth()['telephony:twilio'];
  // 4) busy: a live in-app call → the PIN step already answers "busy" (no token), so a stream for that call is refused
  const busy = rt.openHostCall({ sessionId: 'sess_home', provider: 'voice:gemini', model: 'm' });
  { voice({ CallSid: callSid(32), From: OWNER }); const xml = voice({ CallSid: callSid(32), From: OWNER, Digits: '4321' }); const c2 = await open(); start(c2.ws, 32, ''); await until(() => c2.closeCode() !== null); out.busyStream = { busyTwiml: has(xml, vp.phoneText('busy')) && has(xml, '<Hangup/>'), code: c2.closeCode(), backends: backends.length }; }
  if ('callId' in busy) rt.endRealtimeCall({ sessionId: 'sess_home', callId: busy.callId, seconds: 1 }, host);
  // 5) kill-switch mid-call → one sentence through Twilio's REST, then hang up
  const tok3 = tokenFor(33);
  const c3 = await open();
  start(c3.ws, 33, tok3);
  await until(() => backends.length === 2);
  updateVoiceConfig({ enabled: false });
  await until(() => c3.closeCode() !== null && twilioRest.length >= 2, 4000);
  updateVoiceConfig({ enabled: true });
  const last = twilioRest[twilioRest.length - 1];
  out.killSwitch = { code: c3.closeCode(), restUrl: last?.url, twiml: decodeURIComponent(last?.body || '').replace(/\+/g, ' '), reason: cards.filter((x) => x.ev.voice?.reason).map((x) => x.ev.voice.reason) };
  // 6) a status callback while bridged ends the bridge too
  const tok4 = tokenFor(34);
  const c4 = await open();
  start(c4.ws, 34, tok4);
  await until(() => backends.length === 3);
  vp.handleStatus({ CallSid: callSid(34), CallStatus: 'completed', CallDuration: '12' }, (sid) => bridge.closeCall(sid));
  await until(() => c4.closeCode() !== null);
  out.statusEnds = { code: c4.closeCode(), live: bridge.live() };
  out.cards = cardTitles();
  out.secretLeak = JSON.stringify({ out, logs }).includes(TOKEN) || JSON.stringify(out).includes('AIza-test');
  bridge.close();
  srv.close();
  rest.close();
}

const scenario = process.argv[2];
try {
  if (scenario === 'flow') await flow();
  else if (scenario === 'webhook') await webhook();
  else await bridge();
  process.stdout.write(JSON.stringify({ ok: true, out, logs: logs.slice(-40) }));
} catch (e) {
  process.stdout.write(JSON.stringify({ ok: false, error: String((e as Error)?.stack || e), out, logs: logs.slice(-40) }));
}
process.exit(0);
