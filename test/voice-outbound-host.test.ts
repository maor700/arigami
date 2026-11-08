// Stage 4a over a real isolated host: settings, call_contact/send_sms routes file an outbound card (nothing dials), "Don't send"
// dials nothing, Send POSTs Calls.json/Messages.json to a fake Twilio, the signed outbound TwiML + status → the outcome card in the
// requesting session, inbound SMS → the voice home, caller-ID verification shows the code. No real call or SMS.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './_tmp.js';
import { twilioSignature } from '../server/voice-phone.ts';
import { TWILIO_OUTBOUND_PATH, TWILIO_OUTBOUND_STATUS_PATH, TWILIO_SMS_PATH } from '../server/voice-outbound.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SID = 'AC' + 'b'.repeat(32);
const TOKEN = 'twilio-auth-token-SECRET-abcdef0123';
const GKEY = 'AIza-test-gemini-SECRET-0123456789';
const OWNER = '+972500000000';
const AGENT = '+97233000000';
const CALL = 'CA' + '7'.repeat(32);
const PUB = 'https://pub.example';

let host: ChildProcess;
let dir: string;
let base: string;
let fake: ReturnType<typeof Bun.serve>;
const twilio: { method: string; path: string; params: Record<string, string> }[] = [];

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
  dir = tmpDir('arigami-outbound-host-');
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
  // the fake Twilio REST: account check, Calls/Messages create, call updates, caller-ID verification
  fake = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: async (req) => {
      const u = new URL(req.url);
      if (u.pathname === '/v1beta/models') return Response.json({ models: [] });
      if (u.pathname === `/2010-04-01/Accounts/${SID}.json`) return Response.json({ sid: SID });
      if (u.pathname.startsWith(`/2010-04-01/Accounts/${SID}/`)) {
        const body = req.method === 'POST' ? await req.text() : u.search.slice(1);
        twilio.push({ method: req.method, path: u.pathname.slice(`/2010-04-01/Accounts/${SID}/`.length), params: Object.fromEntries(new URLSearchParams(body)) });
        if (u.pathname.endsWith('/Calls.json')) return Response.json({ sid: CALL, status: 'queued' }, { status: 201 });
        if (u.pathname.endsWith('/Messages.json')) return Response.json({ sid: 'SM' + '3'.repeat(32) }, { status: 201 });
        if (u.pathname.endsWith('/OutgoingCallerIds.json')) return req.method === 'POST' ? Response.json({ validation_code: '135790', phone_number: OWNER }, { status: 201 }) : Response.json({ outgoing_caller_ids: [] });
        return Response.json({});
      }
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
const signed = (pathQ: string, p: Record<string, string>) => api('POST', pathQ, form(p), { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': twilioSignature(TOKEN, PUB + pathQ, p) });
const chatOf = async (id: string) => (await api('GET', `/__api/sessions/${id}/chat`)).json as any[];
const actionOf = async (id: string) => (await api('GET', `/__api/sessions/${id}`)).json?.action;

test('outbound settings → call card → Don\'t send / Send → fake Twilio → signed TwiML + status → outcome card; SMS both ways; caller-ID code', async () => {
  expect((await api('POST', '/__api/voice/phone', { ownerNumber: OWNER, publicUrl: PUB })).status).toBe(200);
  // quiet hours off so the test does not depend on the clock / Shabbat
  const view = (await api('POST', '/__api/voice/outbound', { number: AGENT, settings: { ownerName: 'מאור', quiet: { start: '00:00', end: '00:00', shabbat: false } } })).json;
  expect(view).toMatchObject({ smsUrl: PUB + TWILIO_SMS_PATH, number: AGENT, settings: { ownerName: 'מאור', callerId: 'agent', amd: 'voicemail', maxMinutes: 10 } });
  expect((await api('POST', '/__api/voice/outbound', { settings: { amd: 'nope' } })).status).toBe(400);
  const sid = (await api('POST', '/__api/sessions', { title: 'calls', cwd: path.join(dir, 'workspace') })).json.id;

  // call_contact → a card; nothing dials
  const filed = await api('POST', '/__api/voice/call', { sessionId: sid, to: '052-111-2222', goal: 'לאשר את התור ביום שלישי', brief: 'לאשר שלישי ב-10:00; אם לא מתאים, לבקש רביעי.', why: 'the owner asked' });
  expect(filed.status).toBe(202);
  expect(filed.json).toMatchObject({ pending: true, sent: false });
  let act = await actionOf(sid);
  expect(act.kind).toBe('outbound');
  expect(act.outbound).toMatchObject({ via: 'call', tool: 'call_contact', args: { to: '+972521112222', from: AGENT, callerKind: 'agent', goal: 'לאשר את התור ביום שלישי' } });
  for (const x of ['+972521112222', 'לאשר שלישי ב-10:00', 'שלום, כאן העוזר הדיגיטלי של מאור.', `מספר הסוכן ${AGENT}`]) expect([x, String(act.prompt).includes(x)]).toEqual([x, true]);
  expect(twilio.filter((r) => r.path === 'Calls.json').length).toBe(0);
  // a refusal comes back as {ok:false, error}, no card
  const refused = await api('POST', '/__api/voice/call', { sessionId: sid, to: '0521', goal: 'g', brief: 'b' });
  expect(refused.json).toMatchObject({ ok: false, error: expect.stringContaining('ask the owner') });

  // Don't send → nothing dials
  expect((await api('POST', `/__api/sessions/${sid}/action/answer`, { actionId: act.id, value: 'deny' })).status).toBe(200);
  expect(twilio.filter((r) => r.path === 'Calls.json').length).toBe(0);

  // Send → Calls.json with the card's own arguments
  await api('POST', '/__api/voice/call', { sessionId: sid, to: '+972521112222', goal: 'לאשר את התור ביום שלישי', brief: 'לאשר שלישי ב-10:00.' });
  act = await actionOf(sid);
  expect((await api('POST', `/__api/sessions/${sid}/action/answer`, { actionId: act.id, value: 'send' })).status).toBe(200);
  const calls = twilio.filter((r) => r.path === 'Calls.json');
  expect(calls.length).toBe(1);
  const c = calls[0].params;
  expect(c).toMatchObject({ To: '+972521112222', From: AGENT, Method: 'POST', MachineDetection: 'DetectMessageEnd', TimeLimit: '600', Timeout: '30' });
  expect(c.Url.startsWith(PUB + TWILIO_OUTBOUND_PATH + '?ob=ob_')).toBe(true);
  const ob = c.Url.split('?')[1];

  // Twilio fetches the TwiML (an answering machine) and reports the end
  expect((await api('POST', `${TWILIO_OUTBOUND_PATH}?${ob}`, form({ CallSid: CALL, AnsweredBy: 'machine_end_beep' }), { 'content-type': 'application/x-www-form-urlencoded' })).status).toBe(401);
  const tw = await signed(`${TWILIO_OUTBOUND_PATH}?${ob}`, { CallSid: CALL, AnsweredBy: 'machine_end_beep' });
  expect(tw.type).toBe('text/xml; charset=utf-8');
  expect(tw.text).toContain('<Say voice="Google.he-IL-Wavenet-A" language="he-IL">שלום, כאן העוזר הדיגיטלי של מאור.');
  expect((await signed(`${TWILIO_OUTBOUND_STATUS_PATH}?${ob}`, { CallSid: CALL, CallStatus: 'completed', CallDuration: '21', AnsweredBy: 'machine_end_beep' })).status).toBe(204);
  const chat = await until(async () => { const ch = await chatOf(sid); return ch.some((e) => e.voice?.channel === 'phone-out') ? ch : null; });
  const card = chat.find((e) => e.voice?.channel === 'phone-out');
  expect(card.title).toBe('📞 שיחה ל-+972521112222 · משיבון · 0:21');
  expect(card.voice).toMatchObject({ outcome: 'voicemail', seconds: 21 });
  const budget = (await api('GET', '/__api/voice/budget')).json;
  expect(budget.usage['telephony:twilio'].seconds).toBe(21);

  // SMS: card → Send → Messages.json
  const sms = await api('POST', '/__api/voice/sms', { sessionId: sid, to: '+972521112222', text: 'התור אושר לשלישי.' });
  expect(sms.status).toBe(202);
  act = await actionOf(sid);
  expect(act.outbound).toMatchObject({ via: 'sms', args: { to: '+972521112222', from: AGENT, text: 'התור אושר לשלישי.' } });
  expect(twilio.filter((r) => r.path === 'Messages.json').length).toBe(0);
  await api('POST', `/__api/sessions/${sid}/action/answer`, { actionId: act.id, value: 'send' });
  expect(twilio.filter((r) => r.path === 'Messages.json').map((r) => r.params)).toEqual([{ To: '+972521112222', From: AGENT, Body: 'התור אושר לשלישי.' }]);

  // inbound SMS on the agent number → the voice home
  const inSms = { MessageSid: 'SM' + '9'.repeat(32), From: '+972521112222', To: AGENT, Body: 'תודה, נתראה', AccountSid: SID };
  expect((await api('POST', TWILIO_SMS_PATH, form(inSms), { 'content-type': 'application/x-www-form-urlencoded' })).status).toBe(401);
  expect((await signed(TWILIO_SMS_PATH, inSms)).text).toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  const sessions = (await api('GET', '/__api/sessions')).json;
  const home = (Array.isArray(sessions) ? sessions : sessions.sessions).find((s: any) => s.metadata?.voiceHome);
  const homeChat = await until(async () => { const ch = await chatOf(home.id); return ch.some((e) => e.voice?.channel === 'sms') ? ch : null; });
  expect(homeChat.find((e) => e.voice?.channel === 'sms').body).toBe('תודה, נתראה');

  // caller-ID verification: the code is shown, nothing answers it
  const v = await api('POST', '/__api/voice/phone/caller-id', { action: 'start' });
  expect(v.json).toMatchObject({ ok: true, code: '135790', number: OWNER });
  expect((await api('POST', '/__api/voice/phone/caller-id', { action: 'check' })).json).toMatchObject({ ok: true, verified: false });
  expect(JSON.stringify(chat) + JSON.stringify(homeChat)).not.toContain(TOKEN);
}, 60_000);
