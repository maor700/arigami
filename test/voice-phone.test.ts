// Stage 2 phone (docs/VOICE.md): the Twilio signature (Twilio's own documented vector, bases, invalid, replay), μ-law ↔ PCM and
// resampling, TwiML shapes; then — each in a fresh child with its own ARIGAMI_DIR (test/fixtures/voice-phone-child.ts) — the
// owner gate, the PIN flow with lockout, the gates (busy / cap / kill-switch / no PIN), status billing, the settings view; the
// `twilio` webhook kind over HTTP; and the media-stream bridge against a fake Twilio client and a stubbed realtime backend
// (early frames, outbound frames, clear on barge-in, tool round-trip + audit card, transcript, ledger, kill-switch mid-call,
// status callback ending the bridge). No real call, no Twilio account, no provider socket.
import { test, expect, describe } from 'bun:test';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './_tmp.js';
import { twilioSignature, verifyTwilioSignature, twiml, reject, hashPin, verifyPin, E164_RE, PIN_RE, TWILIO_VOICE_PATH, TWILIO_STATUS_PATH, TWILIO_STREAM_PATH } from '../server/voice-phone.ts';
import { mulawEncode, mulawDecode, mulawEncodeSample, mulawDecodeSample, resample, mulawB64ToPcmB64, pcmB64ToMulawB64, pcmToBuffer, bufferToPcm } from '../server/lib/audio-g711.ts';
import { INBOUND_RE, isInboundWebhookPath } from '../server/webhooks.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHILD = path.join(ROOT, 'test/fixtures/voice-phone-child.ts');

function scenario(name: string): any {
  const dir = tmpDir(`arigami-phone-${name}-`);
  const env: Record<string, string> = { ...(process.env as Record<string, string>), ARIGAMI_DIR: dir, ARIGAMI_FUNNEL_QUIET: '1', HOME: path.join(dir, 'home'), GROQ_API_KEY: '', NODE_ENV: 'test' };
  for (const k of ['ARIGAMI_URL', 'ARIGAMI_TOKEN', 'ARIGAMI_SESSION_ID', 'ARIGAMI_PUBLIC_URL']) delete env[k];
  const r = spawnSync('bun', [CHILD, name], { cwd: ROOT, env, encoding: 'utf8', timeout: 60_000 });
  let j: any;
  try { j = JSON.parse(r.stdout); } catch { throw new Error(`child ${name} produced no JSON (code ${r.status}). stdout=${r.stdout?.slice(0, 800)} stderr=${r.stderr?.slice(0, 800)}`); }
  if (!j.ok) throw new Error(`child ${name} failed: ${j.error}\nlogs: ${(j.logs || []).join('\n')}`);
  return j.out;
}

describe('signature', () => {
  test("Twilio's documented example: token 12345, URL with query, five params", () => {
    const url = 'https://mycompany.com/myapp.php?foo=1&bar=2';
    const params = { CallSid: 'CA1234567890ABCDE', Caller: '+12349013030', Digits: '1234', From: '+12349013030', To: '+18005551212' };
    expect(twilioSignature('12345', url, params)).toBe('0/KCTR6DLpKmkAf8muzZqo1nDgQ=');
  });
  test('verify: any configured base may match, a wrong token / tampered param / missing header fails, a replay is a replay only when asked', () => {
    const token = 't0ken-secret';
    const params = { CallSid: 'CA1', From: '+1' };
    const sig = twilioSignature(token, 'https://b.example' + TWILIO_STATUS_PATH, params);
    const ok = (o: Partial<Parameters<typeof verifyTwilioSignature>[0]> = {}) => verifyTwilioSignature({ token, sig, bases: ['https://a.example', 'https://b.example'], pathAndQuery: TWILIO_STATUS_PATH, params, now: 1, ...o });
    expect(ok({ replay: false })).toBe('');
    expect(ok({ bases: ['https://a.example'], replay: false })).toBe('bad twilio signature');
    expect(ok({ token: 'other', replay: false })).toBe('no twilio auth token stored'.replace('no twilio auth token stored', 'bad twilio signature'));
    expect(ok({ token: '', replay: false })).toBe('no twilio auth token stored');
    expect(ok({ sig: '', replay: false })).toBe('missing X-Twilio-Signature');
    expect(ok({ params: { ...params, From: '+2' }, replay: false })).toBe('bad twilio signature');
    expect(ok({ pathAndQuery: TWILIO_STATUS_PATH + '?x=1', replay: false })).toBe('bad twilio signature');
    expect(ok({ replay: true })).toBe('');
    expect(ok({ replay: true })).toBe('twilio replay');
    expect(ok({ replay: false })).toBe(''); // the voice route never counts replays
    expect(ok({ replay: true, now: 10 * 60_000 })).toBe(''); // past the 5-minute window
  });
  test('paths: twilio/voice + twilio/status are inbound (public, self-authenticating); the stream and the bare prefix are not', () => {
    expect(isInboundWebhookPath(TWILIO_VOICE_PATH)).toBe(true);
    expect(isInboundWebhookPath(TWILIO_STATUS_PATH)).toBe(true);
    expect(INBOUND_RE.exec(TWILIO_STATUS_PATH)![3]).toBe('status');
    for (const p of [TWILIO_STREAM_PATH, '/__api/webhooks/twilio', '/__api/webhooks/twilio/', '/__api/webhooks/twilio/voice/x']) expect([p, isInboundWebhookPath(p)]).toEqual([p, false]);
  });
});

describe('PIN + shapes', () => {
  test('scrypt hash verifies the digits and nothing else; 4–8 digits only; E.164', () => {
    const h = hashPin('4321');
    expect(h.startsWith('scrypt$')).toBe(true);
    expect(h).not.toContain('4321');
    expect(verifyPin('4321', h)).toBe(true);
    expect(verifyPin('4320', h)).toBe(false);
    expect(verifyPin('', h)).toBe(false);
    expect(verifyPin('4321', '')).toBe(false);
    expect(verifyPin('4321', 'plain$x$y')).toBe(false);
    expect(hashPin('1111')).not.toBe(hashPin('1111')); // salted
    expect(() => hashPin('123')).toThrow();
    expect(PIN_RE.test('12345678')).toBe(true);
    expect(PIN_RE.test('123456789')).toBe(false);
    expect(E164_RE.test('+972500000000')).toBe(true);
    expect(E164_RE.test('0500000000')).toBe(false);
  });
  test('TwiML envelope and <Reject>', () => {
    expect(twiml('<Hangup/>')).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
    expect(reject()).toContain('<Reject reason="rejected"/>');
  });
});

describe('audio', () => {
  test('μ-law round trip: every code decodes and re-encodes to itself; silence is 0xff; a ramp survives within μ-law tolerance', () => {
    for (let c = 0; c < 256; c++) if (c !== 0x7f) expect(mulawEncodeSample(mulawDecodeSample(c))).toBe(c); // 0x7f and 0xff are both "zero"
    expect(mulawEncodeSample(0)).toBe(0xff);
    const ramp = new Int16Array(2000).map((_, i) => Math.round(Math.sin(i / 20) * 12000));
    const back = mulawDecode(mulawEncode(ramp));
    let err = 0;
    for (let i = 0; i < ramp.length; i++) err = Math.max(err, Math.abs(ramp[i] - back[i]) / Math.max(64, Math.abs(ramp[i])));
    expect(err).toBeLessThan(0.07);
  });
  test('resampling: 8k→16k doubles, 24k→8k thirds, both keep the level; a 440 Hz tone keeps its period', () => {
    const tone = (rate: number, n: number) => new Int16Array(n).map((_, i) => Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 10000));
    const up = resample(tone(8000, 800), 8000, 16000);
    expect(up.length).toBe(1600);
    const down = resample(tone(24000, 2400), 24000, 8000);
    expect(down.length).toBe(800);
    const rms = (a: Int16Array) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);
    expect(Math.abs(rms(up) - rms(tone(16000, 1600))) / rms(up)).toBeLessThan(0.03);
    expect(Math.abs(rms(down) - rms(tone(8000, 800))) / rms(down)).toBeLessThan(0.05);
    // zero crossings ≈ 2 × 440 × duration for both
    const zc = (a: Int16Array) => a.reduce((n, v, i) => (i && (v >= 0) !== (a[i - 1] >= 0) ? n + 1 : n), 0);
    expect(Math.abs(zc(up) - 88)).toBeLessThanOrEqual(2);
    expect(Math.abs(zc(down) - 88)).toBeLessThanOrEqual(2);
    expect(resample(tone(8000, 80), 8000, 8000).length).toBe(80);
    expect(resample(new Int16Array(0), 8000, 16000).length).toBe(0);
  });
  test('the base64 helpers the bridge uses: 160 μ-law bytes → 320 samples at 16 kHz → 640 bytes; 24 kHz PCM → μ-law at a third', () => {
    const frame = Buffer.alloc(160, 0xff).toString('base64');
    const pcm16 = Buffer.from(mulawB64ToPcmB64(frame, 16000), 'base64');
    expect(pcm16.length).toBe(640);
    expect(bufferToPcm(pcm16).every((v) => v === 0)).toBe(true);
    const pcm24 = pcmToBuffer(new Int16Array(2400).fill(1000)).toString('base64');
    const mu = Buffer.from(pcmB64ToMulawB64(pcm24, 24000), 'base64');
    expect(mu.length).toBe(800);
    expect(Math.abs(mulawDecodeSample(mu[10]) - 1000)).toBeLessThan(40);
    expect(bufferToPcm(Buffer.from([1, 2, 3])).length).toBe(1); // an odd tail is dropped, never thrown
  });
});

describe('call flow (child)', () => {
  test('owner gate, PIN with lockout, stream token, busy / cap / off / no-PIN gates, status billing, settings', () => {
    const o = scenario('flow');
    const he = (k: string) => ({ pin: 'הקישו את הקוד', again: 'קוד שגוי', locked: 'יותר מדי ניסיונות', busy: 'שיחה אחרת', budget: 'תקרת התקציב', off: 'שכבת הקול כבויה', noPin: 'לא הוגדר קוד', bye: 'השיחה הסתיימה' })[k]!;
    expect(o.stranger).toContain('<Reject reason="rejected"/>');
    expect(o.noSid).toContain('<Reject');
    expect(o.firstGather).toBe(true);
    expect(o.first).toContain(he('pin'));
    expect(o.first).toContain('<Hangup/>'); // no input → goodbye, no second webhook
    expect(o.wrong1).toContain(he('again'));
    expect(o.wrong2).toContain('<Gather');
    expect(o.wrong3).toContain(he('locked'));
    expect(o.wrong3).not.toContain('<Gather');
    expect(o.lockedUntil).toBe(1_800_000_000_000 + 15 * 60_000);
    expect(o.whileLocked).toContain(he('locked')); // even with the right PIN
    expect(o.afterLockout).toContain('<Gather');
    expect(o.ok).toContain('<Connect><Stream url="wss://pub.example/__api/webhooks/twilio/stream"><Parameter name="token" value="');
    expect(o.ok).toContain(he('bye'));
    expect(o.tokenLen).toBeGreaterThanOrEqual(32);
    expect(o.okReplay).not.toContain('<Stream'); // a replayed success mints nothing
    expect(o.consumeBad).toBeNull();
    expect(o.consumeOk).toBe(true);
    expect(o.consumeTwice).toBeNull();
    expect(o.crossCallLock).toBe(true);
    expect(o.twilioLedger).toMatchObject({ seconds: 61, calls: 1 });
    expect(o.twilioLedger.usd).toBeCloseTo((61 / 60) * 0.0107, 5);
    expect(o.busy).toContain(he('busy'));
    expect(o.twilioCapped).toContain(he('budget'));
    expect(o.off).toContain(he('off'));
    expect(o.off).toContain('<Hangup/>');
    expect(o.noPin).toContain(he('noPin'));
    expect(o.view).toMatchObject({ telephony: true, ownerNumber: '+972500000000', pinSet: true, base: 'https://pub.example', voiceUrl: 'https://pub.example' + TWILIO_VOICE_PATH, statusUrl: 'https://pub.example' + TWILIO_STATUS_PATH, streamUrl: 'wss://pub.example' + TWILIO_STREAM_PATH, lockedUntil: 0, live: 0 });
    expect(o.selfTest.ok).toBe(true);
    expect(o.viewFunnel.base).toBe('https://funnel.example'); // no own base → the Funnel host
    expect(o.selfTestNoBase.ok).toBe(false);
    expect(o.badUpdates).toEqual(['owner number must be E.164 (+9725…)', 'PIN must be 4–8 digits', 'PIN must be 4–8 digits', 'public URL must be https://host[:port]']);
    expect(o.updated).toMatchObject({ ownerNumber: '+12345678901', pinSet: true, publicUrl: 'https://my.host:8443' });
    expect(o.cfgHashKind).toBe('scrypt');
    expect(o.cfgHashHasPin).toBe(false);
    expect(o.cleared.pinSet).toBe(false);
    expect(o.cards.filter((c: string) => c.endsWith(':rejected')).length).toBe(1);
    expect(o.cards.filter((c: string) => c.endsWith(':pin-fail')).length).toBe(6);
    expect(o.cards.filter((c: string) => c.endsWith(':lockout')).length).toBe(2);
    expect(o.cards).toContain('sess_home:📞 שיחה נכנסת:pin-ok');
    expect(o.cards.some((c: string) => c.endsWith(':busy'))).toBe(true);
    expect(o.cards.some((c: string) => c.endsWith(':no-pin'))).toBe(true);
    expect(o.secretLeak).toBe(false);
  });
});

describe('webhook kind twilio over HTTP (child)', () => {
  test('unsigned / wrong token / tampered → 401; signed → TwiML (text/xml); a voice re-send is not a replay, a status re-send is; GET → 405; events carry no number', () => {
    const o = scenario('webhook');
    for (const k of ['whUnsigned', 'whBadSig', 'whTampered']) expect([k, o[k].status, o[k].text]).toEqual([k, 401, '{"error":"unauthorized"}']);
    expect(o.whOk.status).toBe(200);
    expect(o.whOk.type).toBe('text/xml; charset=utf-8');
    expect(o.whOk.text).toContain('<Gather input="dtmf"');
    expect(o.whOkAgain.status).toBe(200);
    expect(o.whStatus.status).toBe(204);
    expect(o.whStatusReplay.status).toBe(401);
    expect(o.whGet).toBe(405);
    expect(o.whEvents.map((e: any) => e.event)).toEqual(['voice', 'voice', 'status']);
    expect(JSON.stringify(o.whEvents)).not.toContain('+972');
    expect(o.whLedger).toMatchObject({ seconds: 30, calls: 1 });
  });
});

describe('media-stream bridge (child)', () => {
  test('token gate, early frames, μ-law both ways, clear on barge-in, tool + transcript + cards, ledger, busy, kill-switch, status', () => {
    const o = scenario('bridge');
    expect(o.badToken).toEqual({ code: 1008, backends: 0 });
    expect(o.noStart).toBe(1008);
    expect(o.bridged).toEqual({ provider: 'voice:gemini', received: [160, 160, 160, 160, 160, 160, 160, 160], phoneInstructions: true, live: 1, clerkCalls: 1 }); // 3 early + 5 live frames, none lost
    expect(o.outMedia).toEqual([{ streamSid: 'MZ31', bytes: 4000 }, { streamSid: 'MZ31', bytes: 4000 }, { streamSid: 'MZ31', bytes: 4000 }]);
    expect(o.clear).toEqual({ event: 'clear', streamSid: 'MZ31' });
    expect(o.toolResults).toEqual(expect.arrayContaining([{ id: 'fc1', keys: ['sessions'], sessions: ['Alpha'] }, { id: 'fc2', keys: ['error'], sessions: undefined }]));
    expect(o.ended).toMatchObject({ closed: true, live: 0, clerkCalls: 0, transcript: { id: 'sess_home', channel: 'phone', turns: 2, tools: 1 } });
    expect(o.ended.transcript.title).toContain('שיחת טלפון');
    expect(o.ended.transcript.body).toBe('**אתה:** מה המצב?\n\n**הפקיד:** הכל טוב.');
    expect(o.geminiLedger.calls).toBe(1);
    expect(o.twilioLedgerAfterStatus).toMatchObject({ seconds: 45, calls: 1 });
    expect(o.busyStream).toEqual({ busyTwiml: true, code: 1008, backends: 1 });
    expect(o.killSwitch.code).toBe(1000);
    expect(o.killSwitch.restUrl).toBe('/2010-04-01/Accounts/ACaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/Calls/CA00000000000000000000000000000033.json');
    expect(o.killSwitch.twiml).toContain('<Say voice="Google.he-IL-Wavenet-A" language="he-IL">שכבת הקול כבויה.</Say><Hangup/>');
    expect(o.killSwitch.reason).toContain('kill-switch');
    expect(o.statusEnds).toEqual({ code: 1000, live: 0 });
    expect(o.cards).toContain('sess_home:📞 list_sessions:list_sessions');
    expect(o.cards.filter((c: string) => c.includes('שיחת טלפון')).length).toBe(3);
    expect(o.secretLeak).toBe(false);
  });
});
