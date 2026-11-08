// Runs the stage-4a outbound scenarios in a fresh process (ARIGAMI_DIR from env) and prints one JSON line. Spawned by test/voice-outbound.test.ts.
import http from 'node:http';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { cfg, updateVoiceConfig, updateTelephonyConfig } from '../../server/lib/config.js';
import { setProviderSecret } from '../../server/voice-providers.js';
import { voiceUsageThisMonth } from '../../server/voice-usage.js';
import * as rt from '../../server/voice-realtime.js';
import * as vp from '../../server/voice-phone.js';
import * as vo from '../../server/voice-outbound.js';
import { describe as describeOutbound, cardPrompt } from '../../server/lib/outbound.js';
import { createPhoneBridge, connectGeminiBackend, type Backend, type BackendEvents } from '../../server/voice-phone-bridge.js';
import { createWebhooks } from '../../server/webhooks.js';

const OWNER = '+972500000000';
const AGENT = '+97233000000';
const SID = 'AC' + 'b'.repeat(32);
const TOKEN = 'twilio-auth-token-SECRET-outbound-42';
const callSid = (n: number): string => 'CA' + n.toString(16).padStart(32, '0');
const out: Record<string, unknown> = {};
const logs: string[] = [];
console.log = (...a) => logs.push(a.join(' '));
console.error = (...a) => logs.push(a.join(' '));
const BASE = 'https://pub.example';
// Tue 2026-11-10 12:00 Israel (UTC+2) — inside the allowed window
const NOON = Date.UTC(2026, 10, 10, 10, 0);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean, ms = 3000) => { const t0 = Date.now(); while (!f() && Date.now() - t0 < ms) await sleep(10); return f(); };

// a stub Twilio REST: records every request, answers like the real API for the paths we use
const reqs: { method: string; url: string; params: Record<string, string[]> }[] = [];
let n = 0;
const stubFetch = (async (input: any, init: any = {}) => {
  const url = String(input);
  const body = String(init.body || '');
  const params: Record<string, string[]> = {};
  for (const [k, v] of new URLSearchParams(body || url.split('?')[1] || '')) (params[k] ||= []).push(v);
  reqs.push({ method: String(init.method || 'GET'), url: url.replace(/^https?:\/\/[^/]+/, ''), params });
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
  if (url.includes('/Calls.json')) return json({ sid: callSid(++n + 100), status: 'queued' }, 201);
  if (url.includes('/Messages.json')) return json({ sid: 'SM' + '1'.repeat(32), status: 'queued' }, 201);
  if (url.includes('/IncomingPhoneNumbers.json')) return json({ incoming_phone_numbers: [{ phone_number: AGENT, friendly_name: 'local', capabilities: { voice: true, sms: false } }, { phone_number: '+972530000000', friendly_name: '053 mobile', capabilities: { voice: true, sms: true } }, { phone_number: 'junk' }] });
  if (url.includes('/OutgoingCallerIds.json') && init.method === 'POST') return json({ phone_number: params.PhoneNumber?.[0], validation_code: '482913', call_sid: callSid(999) }, 201);
  if (url.includes('/OutgoingCallerIds.json')) return json({ outgoing_caller_ids: verifiedAtTwilio ? [{ phone_number: OWNER, sid: 'PN' + '2'.repeat(32) }] : [] });
  return json({});
}) as typeof fetch;
let verifiedAtTwilio = false;

const cards: { id: string; ev: any }[] = [];
const told: { id: string; line: string }[] = [];
const asked: any[] = [];
let ownerAnswer: string | null = 'Tuesday works';
vo.setOutboundHost({
  appendChat: (id, ev) => { cards.push({ id, ev }); },
  tell: (id, line) => { told.push({ id, line }); },
  askOwner: async (o) => { asked.push(o); return ownerAnswer; },
});

function waDb(): string {
  const p = path.join(process.env.ARIGAMI_DIR!, 'wa.db');
  const d = new DatabaseSync(p);
  d.exec(`CREATE TABLE contacts (jid TEXT, name TEXT, notify TEXT, phone_number TEXT); CREATE TABLE chats (jid TEXT, name TEXT); CREATE TABLE messages (chat_jid TEXT, content TEXT, timestamp TEXT);`);
  d.prepare('INSERT INTO contacts VALUES (?,?,?,?)').run('111@lid', 'Dana Plumber', null, '972520000001');
  d.prepare('INSERT INTO contacts VALUES (?,?,?,?)').run('972530000002@s.whatsapp.net', 'Yossi Garage', null, null);
  d.prepare('INSERT INTO contacts VALUES (?,?,?,?)').run('972540000003@s.whatsapp.net', 'Yossi Bank', null, null);
  d.prepare('INSERT INTO contacts VALUES (?,?,?,?)').run('222@lid', 'NoPhone Guy', null, null);
  d.prepare('INSERT INTO chats VALUES (?,?)').run('972550000004@s.whatsapp.net', 'Clinic Desk');
  d.close();
  return p;
}

setProviderSecret('telephony:twilio', { sid: SID, token: TOKEN });
setProviderSecret('voice:gemini', { token: 'AIza-test-gemini-key-outbound' });
updateTelephonyConfig({ ownerNumber: OWNER, pinHash: vp.hashPin('4321'), publicUrl: BASE, number: AGENT });
// an instance that opted in: Hebrew, local numbers, Shabbat/holidays, Israel time (none of these are the generic defaults)
(cfg as any).voiceLang = 'he';
updateTelephonyConfig({ outbound: { ...vo.outboundSettings(), defaultCountry: '972', quiet: { ...vo.outboundSettings().quiet, shabbat: true, timezone: 'Asia/Jerusalem' } } });

// ---- filing: validation, refusals, the card; nothing dials ---------------------------------------------------------------
async function file(): Promise<void> {
  const db = waDb();
  out.recipients = {
    e164: vo.resolveRecipient('+972 52-000-0001', db),
    local: vo.resolveRecipient('052-0000001', db),
    byName: vo.resolveRecipient('Dana', db),
    chatName: vo.resolveRecipient('Clinic', db),
    ambiguous: vo.resolveRecipient('Yossi', db),
    noPhone: vo.resolveRecipient('NoPhone', db),
    unknown: vo.resolveRecipient('Nobody', db),
    partial: vo.resolveRecipient('0521', db),
  };
  out.callerIds = { agent: vo.resolveCallerId('agent'), owner: vo.resolveCallerId('owner'), other: vo.resolveCallerId('+15005550006') };
  const body = { to: 'Dana', goal: 'Book a plumber visit for the kitchen sink', brief: 'Ask for the first slot next week, mornings preferred. Do not agree to a price above 400 NIS.' };
  const ok = vo.prepareCall(body, { now: NOON, dbPath: db });
  out.prepared = ok;
  if (ok.ok) {
    const exec = { via: 'call' as const, tool: 'call_contact', args: ok.args as unknown as Record<string, unknown> };
    out.card = cardPrompt(exec, 'the owner asked');
    out.describe = describeOutbound(exec);
  }
  const sms = vo.prepareSms({ to: '+972520000001', text: 'שלום, כאן העוזר הדיגיטלי. נשמח לתיאום.' }, { now: NOON });
  out.sms = sms;
  if (sms.ok) out.smsCard = cardPrompt({ via: 'sms', tool: 'send_sms', args: sms.args as unknown as Record<string, unknown> });
  // refusals with a clear reason
  const r: Record<string, unknown> = {};
  r.noGoal = vo.prepareCall({ to: 'Dana', brief: 'x' }, { now: NOON, dbPath: db });
  r.ambiguous = vo.prepareCall({ ...body, to: 'Yossi' }, { now: NOON, dbPath: db });
  r.night = vo.prepareCall(body, { now: Date.UTC(2026, 10, 10, 20, 30), dbPath: db }); // 22:30 local
  r.shabbat = vo.prepareCall(body, { now: Date.UTC(2026, 10, 14, 9, 0), dbPath: db }); // Sat 11:00
  r.fridayEve = vo.prepareCall(body, { now: Date.UTC(2026, 10, 13, 14, 30), dbPath: db }); // Fri 16:30 (sunset ≈16:40)
  r.ownerCallerId = vo.prepareCall({ ...body, caller_id: 'owner' }, { now: NOON, dbPath: db });
  updateVoiceConfig({ caps: { 'telephony:twilio': 0.0001 } });
  vo.__setOutboundFetch(stubFetch);
  rtRecord(); // a tiny spend so the cap is reached
  r.budget = vo.prepareCall(body, { now: NOON, dbPath: db });
  r.smsBudget = vo.prepareSms({ to: '+972520000001', text: 'hi' }, { now: NOON });
  updateVoiceConfig({ caps: { 'telephony:twilio': null } });
  updateVoiceConfig({ enabled: false });
  r.off = vo.prepareCall(body, { now: NOON, dbPath: db });
  updateVoiceConfig({ enabled: true });
  updateTelephonyConfig({ outbound: { ...vo.outboundSettings(), maxCallsPerDay: 0 } });
  r.dailyCap = vo.prepareCall(body, { now: NOON, dbPath: db });
  updateTelephonyConfig({ outbound: { ...vo.outboundSettings(), maxCallsPerDay: 5 } });
  out.refusals = r;
  out.requestsWhileFiling = reqs.length; // nothing dials before Send
}
function rtRecord(): void { (require('../../server/voice-usage.js') as typeof import('../../server/voice-usage.js')).recordVoiceUsage('telephony:twilio', { usd: 0.01 }); }

// ---- Send: the Calls / Messages API request shape against the stub; guards re-checked; caller-ID verification ------------
async function place(): Promise<void> {
  const prep = vo.prepareCall({ to: '+972520000001', goal: 'Confirm the Tuesday appointment', brief: 'Confirm Tuesday 10:00. If they cannot, ask for Wednesday.', language: 'he' }, { now: NOON });
  if (!prep.ok) throw new Error('prepare failed: ' + prep.error);
  out.beforeSend = reqs.length;
  const placed = await vo.placeCall(prep.args, 'sess_req', { base: BASE, fetchImpl: stubFetch, now: NOON });
  out.placed = placed;
  out.callReq = reqs[reqs.length - 1];
  out.today = vo.usageToday(NOON);
  // a second call while one is live is refused before any request
  const before = reqs.length;
  out.second = await vo.placeCall(prep.args, 'sess_req', { base: BASE, fetchImpl: stubFetch, now: NOON });
  out.secondRequests = reqs.length - before;
  vo.__resetOutbound();
  // quiet hours at Send time → refused, no request
  out.sendAtNight = await vo.placeCall(prep.args, 'sess_req', { base: BASE, fetchImpl: stubFetch, now: Date.UTC(2026, 10, 10, 21, 0) });
  out.nightRequests = reqs.length - before;
  // caller ID = the owner, once verified; AMD hang-up / off change the request
  updateTelephonyConfig({ callerIds: [{ number: OWNER, verifiedAt: new Date(NOON).toISOString() }], outbound: { ...vo.outboundSettings(), amd: 'off' } });
  const own = vo.prepareCall({ to: '+972520000001', goal: 'g', brief: 'b', caller_id: 'owner' }, { now: NOON });
  if (!own.ok) throw new Error('owner caller id: ' + own.error);
  await vo.placeCall(own.args, 'sess_req', { base: BASE, fetchImpl: stubFetch, now: NOON });
  out.ownerReq = reqs[reqs.length - 1];
  vo.__resetOutbound();
  // SMS
  const sms = vo.prepareSms({ to: '+972520000001', text: 'Your appointment is confirmed for Tuesday.' }, { now: NOON });
  if (!sms.ok) throw new Error('sms: ' + sms.error);
  out.smsSent = await vo.sendSms(sms.args, { fetchImpl: stubFetch, now: NOON });
  out.smsReq = reqs[reqs.length - 1];
  out.smsLedger = voiceUsageThisMonth()['telephony:twilio'];
  // caller-ID verification: the code is returned for the owner to type; check adds it only once Twilio lists it
  updateTelephonyConfig({ callerIds: [] });
  out.verifyStart = await vo.startCallerIdVerification('', stubFetch);
  out.verifyStartReq = reqs[reqs.length - 1];
  out.verifyCheckNo = await vo.checkCallerIdVerification('', stubFetch);
  verifiedAtTwilio = true;
  out.verifyCheckYes = await vo.checkCallerIdVerification('', stubFetch);
  out.verifyCheckReq = reqs[reqs.length - 1];
  out.callerIdsAfter = cfg.telephony.callerIds;
  out.view = vo.outboundView(NOON);
  out.accountNumbers = await vo.listAccountNumbers(stubFetch, NOON);
  out.numbersReq = reqs[reqs.length - 1];
  vo.updateOutbound({ number: '+972530000000' });
  out.switched = vo.prepareSms({ to: '+972520000001', text: 'x' }, { now: NOON });
  const bad: string[] = [];
  for (const b of [{ number: '12' }, { settings: { amd: 'x' } }, { settings: { maxMinutes: 0 } }, { settings: { quiet: { start: '25:00' } } }, { settings: { disclosure: { he: '' } } }]) { try { vo.updateOutbound(b); bad.push('accepted'); } catch (e) { bad.push((e as Error).message); } }
  out.badUpdates = bad;
  out.updated = (vo.updateOutbound({ settings: { ownerName: 'דני', maxMinutes: 5, quiet: { start: '22:00' } } }).settings as any);
  out.secretLeak = JSON.stringify({ out, logs }).includes(TOKEN);
}

// ---- the answered call: TwiML per AMD; the final status → the outcome card ------------------------------------------------
async function twimlAndStatus(): Promise<void> {
  const mk = async (args: Record<string, unknown> = {}) => {
    const p = vo.prepareCall({ to: '+972520000001', goal: 'Ask about opening hours', brief: 'Ask when they open on Friday.', name: 'x', ...args }, { now: NOON });
    if (!p.ok) throw new Error(p.error);
    const r = await vo.placeCall(p.args, 'sess_req', { base: BASE, fetchImpl: stubFetch, now: NOON });
    if (!r.ok) throw new Error(r.error);
    return r;
  };
  const q = (id: string) => new URLSearchParams({ ob: id });
  // human → the stream (token as a Parameter, no query in the stream URL)
  const a = await mk();
  out.wrongSid = vo.handleOutboundTwiml({ CallSid: callSid(5), AnsweredBy: 'human' }, q(a.id), { base: BASE });
  out.human = vo.handleOutboundTwiml({ CallSid: a.callSid, AnsweredBy: 'human' }, q(a.id), { base: BASE });
  vo.handleOutboundStatus({ CallSid: a.callSid, CallStatus: 'busy' }, q(a.id)); // the stream never started → card at once
  // machine + voicemail
  const b = await mk({ voicemail: 'Please call back about Friday.' });
  out.machine = vo.handleOutboundTwiml({ CallSid: b.callSid, AnsweredBy: 'machine_end_beep' }, q(b.id), { base: BASE });
  vo.handleOutboundStatus({ CallSid: b.callSid, CallStatus: 'completed', CallDuration: '19', AnsweredBy: 'machine_end_beep' }, q(b.id));
  // machine + hang-up setting
  updateTelephonyConfig({ outbound: { ...vo.outboundSettings(), amd: 'hangup' } });
  const c = await mk();
  out.machineHangup = vo.handleOutboundTwiml({ CallSid: c.callSid, AnsweredBy: 'machine_start' }, q(c.id), { base: BASE });
  vo.handleOutboundStatus({ CallSid: c.callSid, CallStatus: 'no-answer' }, q(c.id));
  // the card follows the call's language, not the cockpit's voiceLang
  (cfg as any).voiceLang = 'en';
  const heCall = await mk({ language: 'he' });
  vo.handleOutboundStatus({ CallSid: heCall.callSid, CallStatus: 'busy' }, q(heCall.id));
  (cfg as any).voiceLang = 'he';
  const enCall = await mk({ language: 'en' });
  vo.handleOutboundStatus({ CallSid: enCall.callSid, CallStatus: 'no-answer' }, q(enCall.id));
  out.cards = cards.map((x) => ({ id: x.id, title: x.ev.title, body: x.ev.body, outcome: x.ev.voice?.outcome, seconds: x.ev.voice?.seconds }));
  out.told = told.map((x) => ({ id: x.id, line: x.line }));
  out.ledger = voiceUsageThisMonth()['telephony:twilio'];
  out.live = vo.liveOutboundCalls();
}

// ---- the outbound clerk on the stream: persona, tools, transcript, the outcome card --------------------------------------------
async function bridge(): Promise<void> {
  vo.__setOutboundFetch(stubFetch);
  const backends: { events: BackendEvents; results: any[]; closed: boolean; o: any }[] = [];
  const host = {
    listSessions: () => [], getSession: () => null, sendMessage: () => {}, interrupt: () => true, createSession: () => ({ id: 'x', title: 'x' }),
    chatSeq: () => 0, getChat: () => [], appendChat: (id: string, ev: any) => { cards.push({ id, ev }); }, voiceHome: () => ({ id: 'sess_home' }),
  } as any;
  const br = createPhoneBridge({
    host, budgetEveryMs: 40, startTimeoutMs: 500,
    backendFactory: async (o) => {
      const b = { events: o.events, results: [] as any[], closed: false, o: { provider: o.provider, instructions: o.instructions, lang: o.lang, tools: (o.tools || []).map((t) => t.name), kick: o.kick } };
      backends.push(b);
      return { sendMulaw: () => {}, toolResult: (c, r) => { b.results.push({ name: c.name, r }); }, close: () => { b.closed = true; } } as Backend;
    },
  });
  const srv = http.createServer((_q, s) => { s.writeHead(404); s.end(); });
  srv.on('upgrade', (req, socket, head) => { if (req.url === vp.TWILIO_STREAM_PATH) br.handleUpgrade(req, socket as any, head); else socket.destroy(); });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const wsUrl = `ws://127.0.0.1:${(srv.address() as any).port}${vp.TWILIO_STREAM_PATH}`;
  updateTelephonyConfig({ outbound: { ...vo.outboundSettings(), ownerName: 'דני' } });
  const p = vo.prepareCall({ to: '+972520000001', goal: 'לקבוע תור לטכנאי', brief: 'לבקש את התור הראשון בשבוע הבא, עדיף בבוקר.', language: 'he' }, { now: NOON });
  if (!p.ok) throw new Error(p.error);
  const placed = await vo.placeCall(p.args, 'sess_req', { base: BASE, fetchImpl: stubFetch, now: NOON });
  if (!placed.ok) throw new Error(placed.error);
  const xml = vo.handleOutboundTwiml({ CallSid: placed.callSid, AnsweredBy: 'human' }, new URLSearchParams({ ob: placed.id }), { base: BASE });
  const token = /name="token" value="([^"]+)"/.exec(xml)?.[1] || '';
  // a wrong token is refused
  { const ws = new WebSocket(wsUrl); let code: number | null = null; ws.onclose = (e) => { code = e.code; }; await new Promise((r) => (ws.onopen = r)); ws.send(JSON.stringify({ event: 'start', streamSid: 'MZx', start: { callSid: placed.callSid, customParameters: { token: 'nope' } } })); await until(() => code !== null); out.badToken = code; }
  const ws = new WebSocket(wsUrl);
  let closeCode: number | null = null;
  ws.onclose = (e) => { closeCode = e.code; };
  await new Promise((r) => (ws.onopen = r));
  ws.send(JSON.stringify({ event: 'start', streamSid: 'MZ1', start: { streamSid: 'MZ1', callSid: placed.callSid, customParameters: { token } } }));
  await until(() => backends.length === 1);
  const b = backends[0];
  out.backend = b.o;
  out.clerkCalls = rt.liveCallCount();
  b.events.turn({ role: 'assistant', text: 'שלום, כאן העוזר הדיגיטלי של דני. אני מתקשר לקבוע תור.', id: 'a1' });
  b.events.turn({ role: 'user', text: 'יש ביום שלישי בעשר.', id: 'u1' });
  b.events.tool({ callId: 't1', name: 'take_note', args: { note: 'Tuesday 10:00' } });
  b.events.tool({ callId: 't2', name: 'ask_owner', args: { question: 'Is Tuesday 10:00 OK?', options: ['Yes', 'No'] } });
  b.events.tool({ callId: 't3', name: 'transfer_to_owner', args: { reason: 'they asked' } });
  b.events.tool({ callId: 't4', name: 'list_sessions', args: {} }); // not an outbound tool
  await until(() => b.results.length === 4);
  b.events.tool({ callId: 't5', name: 'end_call', args: { summary: 'Booked Tuesday 10:00.', outcome: 'done' } });
  await until(() => b.results.length === 5);
  await sleep(vo.END_DELAY_MS + 200);
  out.toolResults = b.results.map((r) => ({ name: r.name, r: r.r }));
  out.asked = asked.map((a) => ({ sessionId: a.sessionId, options: a.options, prompt: a.prompt, timeoutMs: a.timeoutMs }));
  out.restCalls = reqs.filter((r) => r.url.includes(`/Calls/${placed.callSid}.json`)).map((r) => ({ Status: r.params.Status?.[0], Twiml: r.params.Twiml?.[0] }));
  // Twilio stops the stream, then the final status arrives
  ws.send(JSON.stringify({ event: 'stop', streamSid: 'MZ1' }));
  await until(() => b.closed && br.live() === 0);
  out.cardsBeforeStatus = cards.filter((x) => x.ev.voice?.channel === 'phone-out').length;
  vo.handleOutboundStatus({ CallSid: placed.callSid, CallStatus: 'completed', CallDuration: '95' }, new URLSearchParams({ ob: placed.id }));
  const card = cards.find((x) => x.ev.voice?.channel === 'phone-out');
  out.card = card ? { id: card.id, title: card.ev.title, body: card.ev.body, voice: card.ev.voice } : null;
  out.noInboundTranscriptCard = !cards.some((x) => x.ev.voice?.reason === 'hangup');
  out.told = told;
  out.ledger = { twilio: voiceUsageThisMonth()['telephony:twilio'], gemini: voiceUsageThisMonth()['voice:gemini'] };
  out.closeCode = closeCode;
  br.close();
  srv.close();
}

// ---- the webhook kinds over HTTP: outbound TwiML, outbound status, inbound SMS (signed; STOP respected) ----------------------
async function webhook(): Promise<void> {
  const smsStore: { from: string; body: string }[] = [];
  const smsHost = { voiceHome: () => ({ id: 'sess_home' }), appendChat: (id: string, ev: any) => { cards.push({ id, ev }); }, receive: (from: string, body: string) => { smsStore.push({ from, body }); } };
  const wh = createWebhooks({
    dir: process.env.ARIGAMI_DIR!, log: (m) => logs.push(m), publicUrl: (p) => BASE + p,
    twilio: { token: vp.twilioToken, bases: () => [BASE], voice: () => vp.twiml(''), status: () => {}, outbound: (pr, _req, q) => vo.handleOutboundTwiml(pr, q, { base: BASE }), outboundStatus: (pr, q) => vo.handleOutboundStatus(pr, q), sms: (pr) => vo.handleInboundSms(pr, smsHost) },
  });
  const srv = http.createServer(async (req, res) => { if (await wh.handle(req, res)) return; res.writeHead(404); res.end(); });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const post = async (pathQ: string, params: Record<string, string>, sign = true) => {
    const r = await fetch(base + pathQ, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...(sign ? { 'x-twilio-signature': vp.twilioSignature(TOKEN, BASE + pathQ, params) } : {}) }, body: new URLSearchParams(params).toString() });
    return { status: r.status, type: r.headers.get('content-type') || '', text: await r.text() };
  };
  const sms = { MessageSid: 'SM' + 'a'.repeat(32), From: '+972520000001', To: AGENT, Body: 'Got it, thanks', AccountSid: SID };
  out.smsUnsigned = await post(vo.TWILIO_SMS_PATH, sms, false);
  out.smsOk = await post(vo.TWILIO_SMS_PATH, sms);
  out.smsReplay = await post(vo.TWILIO_SMS_PATH, sms);
  out.stop = await post(vo.TWILIO_SMS_PATH, { ...sms, MessageSid: 'SM' + 'b'.repeat(32), Body: 'STOP' });
  out.optedOut = vo.isOptedOut('+972520000001');
  out.afterStopSms = vo.prepareSms({ to: '+972520000001', text: 'hello again' }, { now: NOON });
  out.afterStopCall = vo.prepareCall({ to: '+972520000001', goal: 'g', brief: 'b' }, { now: NOON });
  out.start = await post(vo.TWILIO_SMS_PATH, { ...sms, MessageSid: 'SM' + 'c'.repeat(32), Body: 'START' });
  out.optedOutAfterStart = vo.isOptedOut('+972520000001');
  out.smsStore = smsStore;
  out.smsCards = cards.filter((x) => x.ev.voice?.channel === 'sms').map((x) => ({ id: x.id, title: x.ev.title, body: x.ev.body, event: x.ev.voice?.event }));
  // outbound TwiML + status through the real route (query is signed too)
  const p = vo.prepareCall({ to: '+972520000001', goal: 'g', brief: 'b' }, { now: NOON });
  if (!p.ok) throw new Error(p.error);
  const placed = await vo.placeCall(p.args, 'sess_req', { base: BASE, fetchImpl: stubFetch, now: NOON });
  if (!placed.ok) throw new Error(placed.error);
  const ob = `${vo.TWILIO_OUTBOUND_PATH}?ob=${placed.id}`;
  out.obUnsigned = await post(ob, { CallSid: placed.callSid, AnsweredBy: 'human' }, false);
  out.obOk = await post(ob, { CallSid: placed.callSid, AnsweredBy: 'human' });
  out.obStatus = await post(`${vo.TWILIO_OUTBOUND_STATUS_PATH}?ob=${placed.id}`, { CallSid: placed.callSid, CallStatus: 'failed' });
  out.obCard = cards.filter((x) => x.ev.voice?.channel === 'phone-out').map((x) => x.ev.voice.outcome);
  out.events = wh.events({ kind: 'twilio' }).map((e) => ({ event: e.event, payload: e.payload }));
  out.leak = JSON.stringify(out.events).includes('Got it') || JSON.stringify(out.events).includes('+97252');
  srv.close();
}

// ---- the real Gemini backend against a fake Live server: the he-IL transcription hint, and the fallback if Gemini refuses it --------
async function gemini(): Promise<void> {
  const setups: any[] = [];
  const kicks: any[] = [];
  let refuseHint = false;
  const fake = Bun.serve({
    port: 0, hostname: '127.0.0.1',
    fetch: (req, server) => (server.upgrade(req) ? undefined : new Response('no', { status: 400 })),
    websocket: {
      message(ws, data) {
        const m = JSON.parse(String(data));
        if (m.setup) { setups.push(m.setup); if (refuseHint && m.setup.inputAudioTranscription?.languageCodes) ws.close(1007, 'Invalid JSON payload: unknown field languageCodes'); else ws.send(JSON.stringify({ setupComplete: {} })); }
        if (m.clientContent) kicks.push(m.clientContent);
      },
    },
  });
  process.env.ARIGAMI_GEMINI_API_BASE = `http://127.0.0.1:${fake.port}`;
  let closed = 0;
  const events: BackendEvents = { audio() {}, interrupted() {}, tool() {}, turn() {}, closed: () => { closed++; } };
  const p = { language: 'he' as const, goal: 'g', brief: 'b', name: '' };
  const b1 = await connectGeminiBackend({ token: 'AIza-test', instructions: vo.outboundInstructions(p), events, lang: 'he', tools: vo.OUTBOUND_TOOLS, kick: vo.outboundKick(p) });
  await until(() => kicks.length === 1);
  out.hinted = { transcription: setups[0].inputAudioTranscription, speech: setups[0].generationConfig.speechConfig.languageCode, tools: setups[0].tools[0].functionDeclarations.map((f: any) => f.name), kick: kicks[0].turns[0].parts[0].text };
  b1.close();
  await sleep(100);
  closed = 0; // b1's own close above is a normal end
  refuseHint = true;
  const b2 = await connectGeminiBackend({ token: 'AIza-test', instructions: 'x', events, lang: 'he', tools: vo.OUTBOUND_TOOLS });
  out.fallback = { setups: setups.slice(1).map((s) => s.inputAudioTranscription), closedEvents: closed };
  b2.close();
  fake.stop(true);
}

const scenario = process.argv[2];
try {
  if (scenario === 'file') await file();
  else if (scenario === 'place') await place();
  else if (scenario === 'twiml') await twimlAndStatus();
  else if (scenario === 'bridge') await bridge();
  else if (scenario === 'gemini') await gemini();
  else await webhook();
  process.stdout.write(JSON.stringify({ ok: true, out, logs: logs.slice(-40) }));
} catch (e) {
  process.stdout.write(JSON.stringify({ ok: false, error: String((e as Error)?.stack || e), out, logs: logs.slice(-40) }));
}
process.exit(0);
