// Stage 4a (docs/VOICE.md): calls and SMS to others. Pure parts in-process (numbers, quiet hours/Shabbat/holidays, segments, outcome,
// persona, schemas); the rest in fresh children with their own ARIGAMI_DIR (test/fixtures/voice-outbound-child.ts) against a stubbed
// Twilio REST: filing + refusals (nothing dials), the Calls/Messages request shape, TwiML per AMD, the outbound clerk on the stream,
// the outcome card, inbound SMS (signed, STOP), caller-ID verification. No real call or SMS, no Twilio account.
import { test, expect, describe } from 'bun:test';
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './_tmp.js';
import { normalizeNumber, quietReason, sunsetMs, smsSegments, outcomeOf, outboundInstructions, disclosureText, OUTBOUND_DEFAULTS, OUTBOUND_TOOLS, STOP_RE, START_RE, HOLIDAYS, TWILIO_OUTBOUND_PATH, TWILIO_OUTBOUND_STATUS_PATH, TWILIO_SMS_PATH } from '../server/voice-outbound.ts';
import { isInboundWebhookPath, INBOUND_RE } from '../server/webhooks.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHILD = path.join(ROOT, 'test/fixtures/voice-outbound-child.ts');

function scenario(name: string): any {
  const dir = tmpDir(`arigami-outbound-${name}-`);
  const env: Record<string, string> = { ...(process.env as Record<string, string>), ARIGAMI_DIR: dir, ARIGAMI_FUNNEL_QUIET: '1', HOME: path.join(dir, 'home'), NODE_ENV: 'test' };
  for (const k of ['ARIGAMI_URL', 'ARIGAMI_TOKEN', 'ARIGAMI_SESSION_ID', 'ARIGAMI_PUBLIC_URL', 'ARIGAMI_TWILIO_API_BASE']) delete env[k];
  const r = spawnSync('bun', [CHILD, name], { cwd: ROOT, env, encoding: 'utf8', timeout: 60_000 });
  let j: any;
  try { j = JSON.parse(r.stdout); } catch { throw new Error(`child ${name} produced no JSON (code ${r.status}). stdout=${r.stdout?.slice(0, 800)} stderr=${r.stderr?.slice(0, 800)}`); }
  if (!j.ok) throw new Error(`child ${name} failed: ${j.error}\nlogs: ${(j.logs || []).join('\n')}`);
  return j.out;
}
const S = (patch: Partial<typeof OUTBOUND_DEFAULTS> = {}) => ({ ...OUTBOUND_DEFAULTS, ...patch, quiet: { ...OUTBOUND_DEFAULTS.quiet, ...(patch.quiet || {}) } });
const ILQ = { ...OUTBOUND_DEFAULTS.quiet, shabbat: true, timezone: 'Asia/Jerusalem' }; // an instance that opted in
const il = (y: number, m: number, d: number, hh: number, mm = 0) => Date.UTC(y, m - 1, d, hh - 2, mm); // Israel winter time (UTC+2)

describe('pure', () => {
  test('numbers: E.164 as given, local 05x → +972, never a guess', () => {
    expect(normalizeNumber('+972 52-000-0001', '972')).toBe('+972520000001');
    expect(normalizeNumber('052-0000001', '972')).toBe('+972520000001');
    expect(normalizeNumber('00972520000001', '972')).toBe('+972520000001');
    expect(normalizeNumber('972520000001', '972')).toBe('+972520000001');
    for (const x of ['0521', 'Dana', '', '5211122', '+0123456789']) expect([x, normalizeNumber(x, '972')]).toEqual([x, '']);
  });
  test('quiet: 21:00–08:00; Shabbat (opt-in) from candle-lighting to after nightfall, Yom Tov from its eve; a weekday noon is open', () => {
    expect([OUTBOUND_DEFAULTS.quiet.shabbat, OUTBOUND_DEFAULTS.defaultCountry]).toEqual([false, '']); // generic defaults: no personal observance or country
    const s = S({ quiet: ILQ });
    expect(quietReason(il(2026, 11, 10, 12), s)).toBe('');
    expect(quietReason(il(2026, 11, 10, 21, 30), s)).toBe('quiet hours (21:00–08:00)');
    expect(quietReason(il(2026, 11, 10, 7, 59), s)).toBe('quiet hours (21:00–08:00)');
    expect(quietReason(il(2026, 11, 13, 12), s)).toBe(''); // Friday noon
    expect(quietReason(il(2026, 11, 13, 16, 30), s)).toBe('Shabbat'); // candles ≈ 16:00
    expect(quietReason(il(2026, 11, 14, 11), s)).toBe('Shabbat');
    expect(quietReason(il(2026, 11, 14, 17, 45), s)).toBe(''); // after nightfall
    expect(quietReason(Date.UTC(2027, 9, 11, 9), s)).toBe('Yom Kippur'); // 12:00 IDT
    expect(quietReason(Date.UTC(2027, 9, 10, 16, 30), s)).toBe('Yom Kippur'); // its eve, 19:30 IDT — after candles
    expect(quietReason(il(2026, 11, 14, 11), S({ quiet: { ...ILQ, shabbat: false } }))).toBe('');
    expect(quietReason(il(2026, 11, 10, 12), S({ quiet: { ...ILQ, extraDates: ['2026-11-10'] } }))).toBe('a holiday');
    expect(Object.keys(HOLIDAYS).every((d) => /^\d{4}-\d\d-\d\d$/.test(d))).toBe(true);
  });
  test('sunset: Jerusalem ≈ 16:40 in mid-November, ≈ 19:48 in late June (local)', () => {
    const nov = new Date(sunsetMs(2026, 11, 13, 31.778, 35.235)); // UTC+2
    expect(nov.getUTCHours() * 60 + nov.getUTCMinutes() + 120).toBeGreaterThan(16 * 60 + 30);
    expect(nov.getUTCHours() * 60 + nov.getUTCMinutes() + 120).toBeLessThan(16 * 60 + 50);
    const jun = new Date(sunsetMs(2027, 6, 25, 31.778, 35.235)); // UTC+3
    expect(jun.getUTCHours() * 60 + jun.getUTCMinutes() + 180).toBeGreaterThan(19 * 60 + 38);
    expect(jun.getUTCHours() * 60 + jun.getUTCMinutes() + 180).toBeLessThan(19 * 60 + 58);
  });
  test('SMS segments (GSM vs Hebrew), outcomes, STOP/START', () => {
    expect(smsSegments('a'.repeat(160))).toBe(1);
    expect(smsSegments('a'.repeat(161))).toBe(2);
    expect(smsSegments('ש'.repeat(70))).toBe(1);
    expect(smsSegments('ש'.repeat(71))).toBe(2);
    expect(outcomeOf({ status: 'busy' })).toBe('busy');
    expect(outcomeOf({ status: 'no-answer' })).toBe('no-answer');
    expect(outcomeOf({ status: 'completed', answeredBy: 'machine_end_beep' })).toBe('voicemail');
    expect(outcomeOf({ status: 'completed', answeredBy: 'human', streamStarted: true })).toBe('reached');
    expect(outcomeOf({ status: 'failed' })).toBe('failed');
    expect(outcomeOf({ status: 'canceled' })).toBe('failed');
    for (const t of ['STOP', 'stop', ' Unsubscribe ', 'הסר', 'עצור.']) expect([t, STOP_RE.test(t)]).toEqual([t, true]);
    for (const t of ['please stop calling me tomorrow', 'stopper']) expect([t, STOP_RE.test(t)]).toEqual([t, false]);
    expect(START_RE.test('START')).toBe(true);
  });
  test('persona: disclosure (with the owner name) + goal + brief + the rules; the four tools only', () => {
    const s = S({ ownerName: 'דני' });
    expect(disclosureText('he', s)).toBe('שלום, כאן העוזר הדיגיטלי של דני.');
    expect(disclosureText('en', S())).toBe("Hello, this is the account owner's digital assistant.");
    const p = outboundInstructions({ language: 'he', goal: 'לקבוע תור', brief: 'בוקר בלבד', name: 'דנה' }, s);
    for (const x of ['שלום, כאן העוזר הדיגיטלי של דני.', 'Goal: לקבוע תור', 'בוקר בלבד', 'never claim to be human', 'ask_owner', 'transfer_to_owner', 'end_call', 'Speak Hebrew']) expect([x, p.includes(x)]).toEqual([x, true]);
    expect(p).toContain('Write every end_call summary, take_note and ask_owner question in Hebrew');
    expect(outboundInstructions({ language: 'en', goal: 'g', brief: 'b', name: '' }, S())).toContain('Write every end_call summary, take_note and ask_owner question in English');
    expect(outboundInstructions({ language: 'en', goal: 'g', brief: 'b', name: '' }, S({ allowTransfer: false }))).not.toContain('transfer_to_owner');
    expect(OUTBOUND_TOOLS.map((t) => t.name)).toEqual(['end_call', 'take_note', 'ask_owner', 'transfer_to_owner']);
    for (const t of OUTBOUND_TOOLS) expect(t.parameters.type).toBe('object');
    expect((OUTBOUND_TOOLS[0].parameters as any).required).toEqual(['summary']);
  });
  test('routes: outbound TwiML, outbound status and inbound SMS are signed webhook paths', () => {
    for (const p of [TWILIO_OUTBOUND_PATH, TWILIO_OUTBOUND_STATUS_PATH, TWILIO_SMS_PATH]) expect([p, isInboundWebhookPath(p)]).toEqual([p, true]);
    expect(INBOUND_RE.exec(TWILIO_SMS_PATH)![3]).toBe('sms');
    expect(isInboundWebhookPath('/__api/webhooks/twilio/outbound/x')).toBe(false);
  });
  test('the phone family gates call_contact + send_sms; the web lists it', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server/agent-policy.ts'), 'utf8');
    expect(src).toContain("phone: ['call_contact', 'send_sms']");
    expect(fs.readFileSync(path.join(ROOT, 'web/src/components/AgentCard.jsx'), 'utf8')).toContain("'phone'");
  });
});

test('host-mcp: call_contact and send_sms schemas', async () => {
  const env: Record<string, string | undefined> = { ...process.env, ARIGAMI_URL: 'http://127.0.0.1:1', ARIGAMI_SESSION_ID: 'sess_test', ARIGAMI_AGENT: '', ARIGAMI_ENGINE: '' };
  const child = spawn('bun', [path.join(ROOT, 'mcp/host-mcp.js')], { env, stdio: ['pipe', 'pipe', 'ignore'] });
  let buf = '';
  const tools = await new Promise<any[]>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no tools/list reply')), 20000);
    child.stdout!.on('data', (d) => {
      buf += d;
      for (const line of buf.split('\n')) { try { const j = JSON.parse(line); if (j.id === 2) { clearTimeout(timer); resolve(j.result.tools); } } catch { /* partial */ } }
    });
    const send = (o: unknown) => child.stdin!.write(JSON.stringify(o) + '\n');
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  }).finally(() => child.kill());
  const call = tools.find((t) => t.name === 'call_contact');
  const sms = tools.find((t) => t.name === 'send_sms');
  expect(call.inputSchema.required).toEqual(['to', 'goal', 'brief']);
  expect(Object.keys(call.inputSchema.properties)).toEqual(expect.arrayContaining(['to', 'goal', 'brief', 'caller_id', 'language', 'voicemail']));
  expect(call.description).toContain('NOTHING dials until the owner presses Send');
  expect(sms.inputSchema.required).toEqual(['to', 'text']);
  expect(sms.description).toContain('NOTHING is sent until the owner presses Send');
}, 30_000);

describe('filing (child)', () => {
  const o = scenario('file');
  test('recipients: number, local number, a unique WhatsApp name, a chat name; ambiguous/unknown/partial ask instead of guessing', () => {
    expect(o.recipients.e164).toEqual({ number: '+972520000001', name: '' });
    expect(o.recipients.local.number).toBe('+972520000001');
    expect(o.recipients.byName).toEqual({ number: '+972520000001', name: 'Dana Plumber' });
    expect(o.recipients.chatName).toEqual({ number: '+972550000004', name: 'Clinic Desk' });
    expect(o.recipients.ambiguous.error).toContain('ask the owner which one');
    expect(o.recipients.ambiguous.candidates.length).toBe(2);
    for (const k of ['noPhone', 'unknown', 'partial']) expect([k, String(o.recipients[k].error)]).toEqual([k, expect.stringContaining('ask the owner')]);
  });
  test('caller ID: the agent number by default; the owner only once verified; any other number refused', () => {
    expect(o.callerIds.agent).toEqual({ from: '+97233000000', kind: 'agent' });
    expect(o.callerIds.owner.error).toContain('not a verified caller ID');
    expect(o.callerIds.other.error).toContain('caller_id must be');
  });
  test('the card carries recipient, goal, the brief, the disclosure, caller ID, AMD and the cost', () => {
    expect(o.prepared.ok).toBe(true);
    expect(o.prepared.args).toMatchObject({ to: '+972520000001', name: 'Dana Plumber', from: '+97233000000', callerKind: 'agent', language: 'he', amd: 'voicemail', maxMinutes: 10, origin: 'agent' });
    for (const x of ['Dana Plumber (+972520000001)', 'Book a plumber visit', 'Do not agree to a price above 400 NIS', 'העוזר הדיגיטלי', 'מספר הסוכן +97233000000', 'להשאיר הודעה קצרה', 'עד 10 דק׳', '$0.88', 'the owner asked']) expect([x, o.card.includes(x)]).toEqual([x, true]);
    expect(o.describe).toEqual({ channel: 'phone call', to: 'Dana Plumber (+972520000001)', text: 'Book a plumber visit for the kitchen sink', rest: {} });
    expect(o.sms.args).toMatchObject({ to: '+972520000001', from: '+97233000000', segments: 1, estUsd: 0.26 });
    expect(o.smsCard).toContain('שלום, כאן העוזר הדיגיטלי. נשמח לתיאום.');
  });
  test('refusals say why: quiet hours, Shabbat (Friday after candle-lighting too), budget, kill-switch, daily cap, unverified caller ID', () => {
    const r = o.refusals;
    expect(r.noGoal.error).toBe('goal and brief required');
    expect(r.night.error).toBe('refused: quiet hours (21:00–08:00) — no calls to others now');
    expect(r.shabbat.error).toBe('refused: Shabbat — no calls to others now');
    expect(r.fridayEve.error).toBe('refused: Shabbat — no calls to others now');
    expect(r.budget.error).toBe("refused: this month's Twilio budget cap is reached");
    expect(r.smsBudget.error).toBe("refused: this month's Twilio budget cap is reached");
    expect(r.off.error).toContain('switched off');
    expect(r.dailyCap.error).toBe('refused: the daily cap of 0 outbound calls is reached');
    expect(r.ownerCallerId.error).toContain('not a verified caller ID');
  });
  test('nothing dials while filing', () => expect(o.requestsWhileFiling).toBe(0));
});

describe('Send (child, stubbed Twilio)', () => {
  const o = scenario('place');
  test('Calls API: To, From per caller ID, Url → the outbound TwiML, StatusCallback + events, MachineDetection, TimeLimit = the cap', () => {
    expect(o.beforeSend).toBe(0);
    expect(o.placed.ok).toBe(true);
    const p = o.callReq.params;
    expect(o.callReq.url).toBe('/2010-04-01/Accounts/AC' + 'b'.repeat(32) + '/Calls.json');
    expect(p.To).toEqual(['+972520000001']);
    expect(p.From).toEqual(['+97233000000']);
    expect(p.Url[0]).toBe(`https://pub.example${TWILIO_OUTBOUND_PATH}?ob=${o.placed.id}`);
    expect(p.StatusCallback[0]).toBe(`https://pub.example${TWILIO_OUTBOUND_STATUS_PATH}?ob=${o.placed.id}`);
    expect(p.StatusCallbackEvent).toEqual(['initiated', 'ringing', 'answered', 'completed']);
    expect(p.MachineDetection).toEqual(['DetectMessageEnd']);
    expect(p.TimeLimit).toEqual(['600']);
    expect(o.today.calls).toBe(1);
    expect(o.ownerReq.params.From).toEqual(['+972500000000']); // verified owner caller ID
    expect(o.ownerReq.params.MachineDetection).toBeUndefined(); // amd: off
  });
  test('Send re-checks: a live call or quiet hours refuse with no request', () => {
    expect(o.second).toEqual({ ok: false, error: 'another voice call is live — try again when it ends' });
    expect(o.secondRequests).toBe(0);
    expect(o.sendAtNight.error).toContain('quiet hours');
    expect(o.nightRequests).toBe(0);
  });
  test('SMS: Messages API from the agent number, cost in the ledger', () => {
    expect(o.smsSent.ok).toBe(true);
    expect(o.smsReq.url).toContain('/Messages.json');
    expect(o.smsReq.params).toEqual({ To: ['+972520000001'], From: ['+97233000000'], Body: ['Your appointment is confirmed for Tuesday.'] });
    expect(o.smsLedger.usd).toBeCloseTo(0.26, 2);
  });
  test('caller-ID verification: the code comes back for the owner to type; the number counts only once Twilio lists it', () => {
    expect(o.verifyStart).toEqual({ ok: true, code: '482913', number: '+972500000000' });
    expect(o.verifyStartReq.params.PhoneNumber).toEqual(['+972500000000']);
    expect(o.verifyCheckNo.verified).toBe(false);
    expect(o.verifyCheckYes.verified).toBe(true);
    expect(o.verifyCheckReq.method).toBe('GET');
    expect(o.callerIdsAfter.map((c: any) => c.number)).toEqual(['+972500000000']);
  });
  test('number-agnostic: the account\'s numbers are listed for the picker; switching the agent number moves From', () => {
    expect(o.accountNumbers).toEqual([{ number: '+97233000000', name: 'local', voice: true, sms: false }, { number: '+972530000000', name: '053 mobile', voice: true, sms: true }]);
    expect(o.numbersReq.url).toContain('/IncomingPhoneNumbers.json?PageSize=50');
    expect(o.switched.args.from).toBe('+972530000000');
  });
  test('settings: validated; the view has the number, caller IDs, settings, today', () => {
    expect(o.badUpdates.every((x: string) => x !== 'accepted')).toBe(true);
    expect(o.updated).toMatchObject({ ownerName: 'דני', maxMinutes: 5, quiet: { start: '22:00', end: '08:00', shabbat: true } });
    expect(o.view).toMatchObject({ number: '+97233000000', today: { calls: 2, sms: 1 }, quietNow: '' });
    expect(o.secretLeak).toBe(false);
  });
});

describe('answered call + outcome (child)', () => {
  const o = scenario('twiml');
  test('TwiML: human → <Connect><Stream> with a one-time token; machine → the voicemail in the call language; hang-up setting; wrong CallSid → hang up', () => {
    expect(o.wrongSid).toContain('<Hangup/>');
    expect(o.human).toMatch(/<Connect><Stream url="wss:\/\/pub\.example\/__api\/webhooks\/twilio\/stream"><Parameter name="token" value="[^"]{20,}"\/><\/Stream><\/Connect><Hangup\/>/);
    expect(o.machine).toContain('<Say voice="Google.he-IL-Wavenet-A" language="he-IL">שלום, כאן העוזר הדיגיטלי של בעל החשבון. Please call back about Friday.</Say><Hangup/>');
    expect(o.machineHangup).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
  });
  test('the card follows the call language, not the cockpit voiceLang', () => {
    expect(o.cards[3].title).toBe('📞 שיחה ל-+972520000001 · תפוס'); // he call, voiceLang en
    expect(o.cards[3].body).toContain('**מטרה:**');
    expect(o.cards[4].title).toBe('📞 Call to +972520000001 · no answer'); // en call, voiceLang he
    expect(o.cards[4].body).toContain('**Outcome:** no answer');
  });
  test('final status → one card + a [host] line in the requesting session; outbound minutes in the ledger', () => {
    expect(o.cards.map((c: any) => [c.id, c.outcome])).toEqual([['sess_req', 'busy'], ['sess_req', 'voicemail'], ['sess_req', 'no-answer'], ['sess_req', 'busy'], ['sess_req', 'no-answer']]);
    expect(o.cards[1].body).toContain('הושארה הודעה במשיבון');
    expect(o.told.map((t: any) => t.line.match(/outcome: ([a-z-]+)/)[1])).toEqual(['busy', 'voicemail', 'no-answer', 'busy', 'no-answer']);
    expect(o.ledger.seconds).toBe(19);
    expect(o.ledger.usd).toBeCloseTo((19 / 60) * 0.0646, 4);
    expect(o.live).toBe(0);
  });
});

describe('outbound clerk on the stream (child)', () => {
  const o = scenario('bridge');
  test('a bad token is refused; the backend gets the outbound persona, its four tools, the call language and a kick to speak first', () => {
    expect(o.badToken).toBe(1008);
    expect(o.backend.provider).toBe('voice:gemini');
    expect(o.backend.instructions).toContain('שלום, כאן העוזר הדיגיטלי של דני.');
    expect(o.backend.instructions).toContain('Goal: לקבוע תור לטכנאי');
    expect(o.backend.instructions).toContain('לבקש את התור הראשון בשבוע הבא');
    expect(o.backend.tools).toEqual(['end_call', 'take_note', 'ask_owner', 'transfer_to_owner']);
    expect(o.backend.lang).toBe('he');
    expect(o.backend.kick).toContain('השיחה התחברה');
    expect(o.clerkCalls).toBe(1);
  });
  test('tools: note, ask the owner (card in the requesting session, ≤60 s), transfer (REST <Dial> to the owner), end (REST completed); clerk tools are not available', () => {
    const by = Object.fromEntries(o.toolResults.map((r: any) => [r.name, r.r]));
    expect(by.take_note).toEqual({ ok: true, notes: 1 });
    expect(by.ask_owner).toEqual({ answer: 'Tuesday works' });
    expect(by.transfer_to_owner).toEqual({ ok: true, transferring: true });
    expect(by.end_call.ending).toBe(true);
    expect(by.list_sessions.error).toContain('unknown tool');
    expect(o.asked).toEqual([{ sessionId: 'sess_req', options: ['Yes', 'No'], prompt: expect.stringContaining('Is Tuesday 10:00 OK?'), timeoutMs: 60_000 }]);
    expect(o.restCalls[0].Twiml).toContain('<Dial callerId="+97233000000" timeout="25">+972500000000</Dial>');
    expect(o.restCalls[1]).toEqual({ Status: 'completed' });
  });
  test('the end: no card until the final status; then one card with outcome, summary, notes and both sides of the transcript; ledgers', () => {
    expect(o.cardsBeforeStatus).toBe(0);
    expect(o.card.id).toBe('sess_req');
    expect(o.card.voice).toMatchObject({ channel: 'phone-out', outcome: 'reached', seconds: 95, turns: 2, transferred: true });
    expect(o.card.body).toContain('**תוצאה:** נענתה · הועבר אליך (הושג)');
    for (const x of ['**סיכום:** Booked Tuesday 10:00.', '- Tuesday 10:00', 'Is Tuesday 10:00 OK? → Tuesday works', '**הסוכן:** שלום, כאן העוזר הדיגיטלי של דני', '**הצד השני:** יש ביום שלישי בעשר.']) expect([x, o.card.body.includes(x)]).toEqual([x, true]);
    expect(o.noInboundTranscriptCard).toBe(true);
    expect(o.told[0].line).toContain('outcome: reached (transferred to the owner)');
    expect(o.ledger.twilio.seconds).toBe(95);
    expect(o.ledger.gemini.calls).toBe(1);
  });
});

describe('webhooks over HTTP (child)', () => {
  const o = scenario('webhook');
  test('inbound SMS: unsigned/replayed 401; signed → empty TwiML, a card in the voice home, the sms store for listeners', () => {
    expect(o.smsUnsigned.status).toBe(401);
    expect(o.smsReplay.status).toBe(401);
    expect(o.smsOk.status).toBe(200);
    expect(o.smsOk.text).toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    expect(o.smsStore[0]).toEqual({ from: '+972520000001', body: 'Got it, thanks' });
    expect(o.smsCards[0]).toMatchObject({ id: 'sess_home', body: 'Got it, thanks' });
  });
  test('STOP opts the number out of calls and SMS; START lifts it', () => {
    expect(o.optedOut).toBe(true);
    expect(o.smsCards[1].event).toBe('opt-out');
    expect(o.afterStopSms.error).toBe('refused: +972520000001 opted out (STOP)');
    expect(o.afterStopCall.error).toBe('refused: +972520000001 opted out (STOP)');
    expect(o.optedOutAfterStart).toBe(false);
  });
  test('outbound TwiML + status over the signed route; the event log never carries the number or the text', () => {
    expect(o.obUnsigned.status).toBe(401);
    expect(o.obOk.status).toBe(200);
    expect(o.obOk.text).toContain('<Connect><Stream');
    expect(o.obStatus.status).toBe(204);
    expect(o.obCard).toEqual(['failed']);
    expect(o.events.map((e: any) => e.event)).toEqual(['sms', 'sms', 'sms', 'outbound', 'outbound-status']);
    expect(o.leak).toBe(false);
  });
});

describe('the real Gemini backend on the outbound path (child, fake Live server)', () => {
  const o = scenario('gemini');
  test('setup carries the he-IL transcription hint + speech language, the outbound tools and the kick', () => {
    expect(o.hinted).toEqual({ transcription: { languageCodes: ['he-IL'] }, speech: 'he-IL', tools: ['end_call', 'take_note', 'ask_owner', 'transfer_to_owner'], kick: '(השיחה התחברה — פתח עכשיו בהצגה עצמית.)' });
  });
  test('if Gemini refuses the hint, the bridge retries once without it — the call is not dropped', () => {
    expect(o.fallback).toEqual({ setups: [{ languageCodes: ['he-IL'] }, {}], closedEvents: 0 });
  });
});
