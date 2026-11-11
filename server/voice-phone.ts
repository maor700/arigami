// Stage 2 phone (docs/VOICE.md): the `twilio` webhook kind — X-Twilio-Signature, owner-number gate, DTMF PIN with
// lockout, TwiML answers, a one-time token for the media stream, Twilio minutes in the ledger. No audio is ever stored.
import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { cfg, updateTelephonyConfig, type TelephonyConfig } from './lib/config.js';
import { providerSecretFields, hasProviderSecret, requireVoiceProvider, telephonyConnected, voiceEnabled, twilioBase, type VoiceRequirement } from './voice-providers.js';
import { recordVoiceUsage } from './voice-usage.js';
import { liveCallCount } from './voice-realtime.js';

export const TWILIO_VOICE_PATH = '/__api/webhooks/twilio/voice';
export const TWILIO_STATUS_PATH = '/__api/webhooks/twilio/status';
export const TWILIO_STREAM_PATH = '/__api/webhooks/twilio/stream';
export const TWILIO_SUBPATHS = ['voice', 'status'] as const;
export const PIN_ATTEMPTS = 3;
export const LOCKOUT_MS = 15 * 60_000;
export const PIN_RE = /^\d{4,8}$/;
export const E164_RE = /^\+[1-9]\d{6,14}$/;
export const STREAM_TOKEN_TTL_MS = 60_000;
export const REPLAY_MS = 5 * 60_000;
const CALL_SID_RE = /^CA[a-f0-9]{32}$/;
const STATUS_FALLBACK_MS = 90_000; // no status callback this long after the stream ended → bill the stream's own duration

export type Params = Record<string, string>;

// ---- signature: base64(HMAC-SHA1(authToken, url + sorted(key+value)…)) --------------------------------------------
export function twilioSignature(authToken: string, url: string, params: Params = {}): string {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  return crypto.createHmac('sha1', authToken).update(data).digest('base64');
}
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(String(a)), bb = Buffer.from(String(b));
  if (ab.length !== bb.length) { crypto.timingSafeEqual(bb, bb); return false; }
  return crypto.timingSafeEqual(ab, bb);
}
const seen = new Map<string, number>();
function replayed(sig: string, now: number): boolean {
  if (seen.size > 2000) for (const [k, e] of seen) if (e <= now) seen.delete(k);
  if ((seen.get(sig) || 0) > now) return true;
  seen.set(sig, now + REPLAY_MS);
  return false;
}
/** '' when `sig` matches `pathAndQuery` under one of `bases` (Twilio signs the URL exactly as the console has it); the reason otherwise. */
export function verifyTwilioSignature(o: { token: string; sig: string; bases: string[]; pathAndQuery: string; params?: Params; now?: number; replay?: boolean }): string {
  if (!o.token) return 'no twilio auth token stored';
  if (!o.sig || o.sig.length > 64) return 'missing X-Twilio-Signature';
  let ok = false;
  for (const b of o.bases) ok = safeEqual(o.sig, twilioSignature(o.token, b + o.pathAndQuery, o.params || {})) || ok; // no early exit
  if (!ok) return 'bad twilio signature';
  if (o.replay !== false && replayed(o.sig, o.now ?? Date.now())) return 'twilio replay';
  return '';
}
const header = (req: IncomingMessage, n: string): string => { const v = req.headers[n]; return Array.isArray(v) ? v[0] || '' : String(v || ''); };
/** The public bases a request may have been signed under: the configured one first, then what the proxy says it was. */
export function signatureBases(req: Pick<IncomingMessage, 'headers'>): string[] {
  const out = new Set<string>();
  const add = (u: string) => { const v = String(u || '').trim().replace(/\/+$/, ''); if (v) out.add(v); };
  add(cfg.telephony?.publicUrl || '');
  add(cfg.publicUrl);
  for (const h of [header(req as IncomingMessage, 'x-forwarded-host'), header(req as IncomingMessage, 'host')]) {
    const host = h.split(',')[0].trim();
    if (/^[A-Za-z0-9.-]+(:\d+)?$/.test(host)) { add(`https://${host}`); add(`http://${host}`); }
  }
  return [...out];
}
export const twilioToken = (): string => providerSecretFields('telephony:twilio')?.token || '';
export const twilioSid = (): string => providerSecretFields('telephony:twilio')?.sid || '';

// ---- PIN: scrypt, never the digits -----------------------------------------------------------------------------------
export function hashPin(pin: string): string {
  if (!PIN_RE.test(pin)) throw new Error('PIN must be 4–8 digits');
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('base64url')}$${crypto.scryptSync(pin, salt, 32, { N: 16384 }).toString('base64url')}`;
}
export function verifyPin(pin: string, stored: string): boolean {
  const [kind, salt, hash] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !salt || !hash || !/^\d{1,16}$/.test(pin)) return false;
  const got = crypto.scryptSync(pin, Buffer.from(salt, 'base64url'), 32, { N: 16384 });
  const want = Buffer.from(hash, 'base64url');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

// ---- state (in memory; a restart forgets live calls and the lockout) --------------------------------------------------
export interface PhoneCall { callSid: string; from: string; attempts: number; state: 'pin' | 'connected' | 'ended'; token?: string; tokenExp?: number; answeredAt: number; streamStart?: number; streamEnd?: number; billed?: boolean; timer?: ReturnType<typeof setTimeout> }
const phoneCalls = new Map<string, PhoneCall>();
let lockedUntil = 0;
let failures = 0;
export const phoneCall = (callSid: string): Readonly<PhoneCall> | null => phoneCalls.get(callSid) || null;
export const lockedUntilMs = (): number => lockedUntil;
export const livePhoneCalls = (): number => [...phoneCalls.values()].filter((c) => c.state !== 'ended').length;
/** Tests only. */
export function __resetPhone(): void { for (const c of phoneCalls.values()) if (c.timer) clearTimeout(c.timer); phoneCalls.clear(); lockedUntil = 0; failures = 0; seen.clear(); }

export interface PhoneHost { voiceHome(): { id: string }; appendChat(id: string, ev: Record<string, unknown>): void }
function audit(host: PhoneHost | null, title: string, body: string, extra: Record<string, unknown> = {}): void {
  try { host?.appendChat(host.voiceHome().id, { kind: 'ext-card', extension: 'voice', title: `📞 ${title}`, body, voice: { channel: 'phone', ...extra } }); } catch (e) { console.error('[voice-phone] audit card failed:', (e as Error).message); }
}
const mask = (n: string): string => (n.length > 4 ? `${n.slice(0, 4)}…${n.slice(-3)}` : '•••');

// ---- TwiML -------------------------------------------------------------------------------------------------------------
export const esc = (s: string): string => s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c] as string);
export const twiml = (inner: string): string => `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;
const sayLang = (): string => (cfg.voiceLang === 'he' ? 'he-IL' : 'en-US');
// Twilio's default voice has no Hebrew (error 13512) — Hebrew prompts need a Google voice.
const sayVoice = (): string => (cfg.voiceLang === 'he' ? ' voice="Google.he-IL-Wavenet-A"' : '');
const say = (text: string): string => `<Say${sayVoice()} language="${sayLang()}">${esc(text)}</Say>`;
/** <Say> in an explicit language (stage 4a: a call's own language, not cfg.voiceLang). */
export const sayIn = (lang: string, text: string): string => (lang === 'he' ? `<Say voice="Google.he-IL-Wavenet-A" language="he-IL">${esc(text)}</Say>` : `<Say language="en-US">${esc(text)}</Say>`);
const T = {
  he: { pin: 'שלום. הקישו את הקוד ואז סולמית.', again: 'קוד שגוי. נסו שוב ואז סולמית.', locked: 'יותר מדי ניסיונות. נסו שוב בעוד רבע שעה.', noInput: 'לא התקבל קוד. להתראות.', noPin: 'לא הוגדר קוד. הגדירו אותו בהגדרות קול וטלפון.', off: 'שכבת הקול כבויה.', budget: 'תקרת התקציב החודשית הושגה. להתראות.', noProvider: 'אין ספק קול מחובר.', busy: 'שיחה אחרת פעילה כרגע. להתראות.', connected: 'מחובר.', bye: 'השיחה הסתיימה. להתראות.' },
  en: { pin: 'Hello. Enter your code, then pound.', again: 'Wrong code. Try again, then pound.', locked: 'Too many attempts. Try again in fifteen minutes.', noInput: 'No code received. Goodbye.', noPin: 'No PIN is set. Set one under Voice and phone settings.', off: 'The voice layer is switched off.', budget: 'This month\'s budget cap is reached. Goodbye.', noProvider: 'No voice provider is connected.', busy: 'Another call is live right now. Goodbye.', connected: 'Connected.', bye: 'The call has ended. Goodbye.' },
} as const;
export type PhoneText = keyof typeof T.he;
export const phoneText = (k: PhoneText): string => (cfg.voiceLang === 'he' ? T.he : T.en)[k];
const hangup = (k: PhoneText): string => twiml(say(phoneText(k)) + '<Hangup/>');
const gather = (k: PhoneText, action: string): string => twiml(`<Gather input="dtmf" finishOnKey="#" timeout="10" action="${esc(action)}" method="POST">${say(phoneText(k))}</Gather>${say(phoneText('noInput'))}<Hangup/>`);
export const reject = (): string => twiml('<Reject reason="rejected"/>');
function connectStream(wsUrl: string, token: string): string {
  return twiml(`${say(phoneText('connected'))}<Connect><Stream url="${esc(wsUrl)}"><Parameter name="token" value="${esc(token)}"/></Stream></Connect>${say(phoneText('bye'))}`);
}

// ---- public URLs ---------------------------------------------------------------------------------------------------------
/** The https base Twilio should call: Settings' own value, else cfg.publicUrl, else the Funnel host, else what the request says. */
export function publicBase(req?: Pick<IncomingMessage, 'headers'> | null, funnelHost = ''): string {
  const own = String(cfg.telephony?.publicUrl || cfg.publicUrl || '').replace(/\/+$/, '');
  if (own) return own;
  if (funnelHost) return `https://${funnelHost}`;
  const h = req ? (header(req as IncomingMessage, 'x-forwarded-host') || header(req as IncomingMessage, 'host')).split(',')[0].trim() : '';
  return h ? `https://${h}` : '';
}
export const streamUrl = (base: string): string => base.replace(/^http/, 'ws') + TWILIO_STREAM_PATH;

// ---- the gate every answered call passes (shared by /voice and the bridge) -----------------------------------------------
export type GateResult = { ok: true; provider: string } | { ok: false; text: PhoneText; why: string };
export function phoneGate(): GateResult {
  if (!voiceEnabled()) return { ok: false, text: 'off', why: 'voice off' };
  const tw: VoiceRequirement = requireVoiceProvider('telephony');
  if ('budget' in tw) return { ok: false, text: 'budget', why: 'twilio cap reached' };
  const rt = requireVoiceProvider('realtime');
  if ('needs_setup' in rt) return { ok: false, text: 'noProvider', why: 'no realtime provider' };
  if (!rt.ok) return { ok: false, text: 'budget' in rt ? 'budget' : 'off', why: rt.why };
  return { ok: true, provider: rt.provider };
}

// ---- the voice webhook ---------------------------------------------------------------------------------------------------
export interface VoiceCtx { host?: PhoneHost | null; base: string; now?: number }
/** POST …/twilio/voice (initial call and every <Gather> action) → TwiML. */
export function handleVoice(params: Params, ctx: VoiceCtx): string {
  const now = ctx.now ?? Date.now();
  const host = ctx.host || null;
  const from = String(params.From || '');
  const callSid = CALL_SID_RE.test(String(params.CallSid || '')) ? String(params.CallSid) : '';
  const owner = cfg.telephony?.ownerNumber || '';
  if (!callSid || !hasProviderSecret('telephony:twilio')) return reject(); // a stored key (not `connected`): with the layer off the owner still hears why
  if (!owner || !safeEqual(from, owner)) {
    audit(host, 'שיחה נדחתה', `מספר לא מורשה ${mask(from)}`, { event: 'rejected', callSid });
    console.log(`[voice-phone] rejected ${mask(from)} (${owner ? 'not the owner' : 'no owner number set'})`);
    return reject();
  }
  if (now < lockedUntil) { audit(host, 'שיחה נדחתה', 'נעילה אחרי ניסיונות כושלים', { event: 'locked', callSid }); return hangup('locked'); }
  const gate = phoneGate();
  if (!gate.ok) { audit(host, 'שיחה נדחתה', gate.why, { event: 'gate', callSid }); return hangup(gate.text); }
  if (!cfg.telephony?.pinHash) { audit(host, 'שיחה נדחתה', 'לא הוגדר PIN', { event: 'no-pin', callSid }); return hangup('noPin'); }
  let call = phoneCalls.get(callSid);
  if (!call) { call = { callSid, from, attempts: 0, state: 'pin', answeredAt: now }; phoneCalls.set(callSid, call); }
  if (call.state !== 'pin') return hangup('bye');
  const action = ctx.base + TWILIO_VOICE_PATH;
  if (!('Digits' in params) && call.attempts === 0) return gather('pin', action);
  const digits = String(params.Digits || '').replace(/\D/g, '');
  if (digits && verifyPin(digits, cfg.telephony.pinHash)) {
    failures = 0;
    if (liveCallCount() > 0) { audit(host, 'שיחה נדחתה', 'שיחה אחרת פעילה', { event: 'busy', callSid }); call.state = 'ended'; return hangup('busy'); }
    call.state = 'connected';
    call.token = crypto.randomBytes(24).toString('base64url');
    call.tokenExp = now + STREAM_TOKEN_TTL_MS;
    audit(host, 'שיחה נכנסת', `PIN אומת, ${mask(from)}`, { event: 'pin-ok', callSid });
    return connectStream(streamUrl(ctx.base), call.token);
  }
  call.attempts += 1;
  failures += 1;
  audit(host, 'ניסיון PIN שגוי', `ניסיון ${call.attempts} מתוך ${PIN_ATTEMPTS}`, { event: 'pin-fail', callSid, attempt: call.attempts });
  if (call.attempts >= PIN_ATTEMPTS || failures >= PIN_ATTEMPTS) {
    lockedUntil = now + LOCKOUT_MS;
    failures = 0;
    call.state = 'ended';
    audit(host, 'נעילה', `${PIN_ATTEMPTS} ניסיונות כושלים — נעול ל-15 דקות`, { event: 'lockout', callSid });
    return hangup('locked');
  }
  return gather('again', action);
}

/** The bridge's `start`: one-time token, bound to the call, 60 s. */
export function consumeStreamToken(callSid: string, token: string, now = Date.now()): PhoneCall | null {
  const c = phoneCalls.get(callSid);
  if (!c || c.state !== 'connected' || !c.token || !token || (c.tokenExp || 0) < now || !safeEqual(token, c.token)) return null;
  delete c.token;
  c.streamStart = now;
  return c;
}
/** The stream closed: Twilio's status callback bills the call; if it never comes, the stream's own window does. */
export function streamEnded(callSid: string, now = Date.now(), delayMs = STATUS_FALLBACK_MS): void {
  const c = phoneCalls.get(callSid);
  if (!c) return;
  c.streamEnd = now;
  c.state = 'ended';
  if (c.billed) { phoneCalls.delete(callSid); return; }
  if (c.timer) clearTimeout(c.timer);
  c.timer = setTimeout(() => billTwilio(callSid, Math.round((now - c.answeredAt) / 1000), 'stream'), delayMs);
  c.timer.unref?.();
}
function billTwilio(callSid: string, seconds: number, source: string): void {
  const c = phoneCalls.get(callSid);
  if (!c || c.billed) return;
  c.billed = true;
  if (c.timer) clearTimeout(c.timer);
  recordVoiceUsage('telephony:twilio', { seconds: Math.max(0, seconds), inbound: true });
  console.log(`[voice-phone] ${callSid} billed ${seconds}s (${source})`);
  if (c.state === 'ended' || source === 'status') phoneCalls.delete(callSid);
}
const FINAL = new Set(['completed', 'busy', 'failed', 'no-answer', 'canceled']);
/** POST …/twilio/status → '' (204). A final status bills CallDuration; a rejected/unknown call is ignored. */
export function handleStatus(params: Params, onEnded?: (callSid: string) => void): void {
  const callSid = String(params.CallSid || '');
  const status = String(params.CallStatus || '');
  if (!CALL_SID_RE.test(callSid) || !FINAL.has(status)) return;
  const c = phoneCalls.get(callSid);
  if (!c) return;
  const dur = Number(params.CallDuration);
  billTwilio(callSid, Number.isFinite(dur) ? dur : Math.round((Date.now() - c.answeredAt) / 1000), 'status');
  try { onEnded?.(callSid); } catch { /* best effort */ }
}

// ---- Twilio REST: say one sentence and hang up a live call (kill-switch / budget mid-call) ------------------------------
export async function hangupWithMessage(callSid: string, text: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const sid = twilioSid(), token = twilioToken();
  if (!sid || !token || !CALL_SID_RE.test(callSid)) return false;
  try {
    const res = await fetchImpl(`${twilioBase()}/2010-04-01/Accounts/${encodeURIComponent(sid)}/Calls/${callSid}.json`, {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ Twiml: twiml(say(text) + '<Hangup/>') }).toString(),
      signal: AbortSignal.timeout(8000),
    });
    return res.ok;
  } catch (e) {
    console.error('[voice-phone] hangup failed:', (e as Error).message);
    return false;
  }
}

// ---- Settings → Voice & phone -------------------------------------------------------------------------------------------
export function phoneView(funnelHost = ''): Record<string, unknown> {
  const base = publicBase(null, funnelHost);
  const t = cfg.telephony || ({} as TelephonyConfig);
  return {
    telephony: telephonyConnected(),
    ownerNumber: t.ownerNumber || '',
    pinSet: !!t.pinHash,
    publicUrl: t.publicUrl || '',
    base,
    voiceUrl: base ? base + TWILIO_VOICE_PATH : '',
    statusUrl: base ? base + TWILIO_STATUS_PATH : '',
    streamUrl: base ? streamUrl(base) : '',
    lockedUntil: lockedUntil > Date.now() ? lockedUntil : 0,
    live: livePhoneCalls(),
  };
}
/** {ownerNumber?, pin?, clearPin?, publicUrl?} → the view; throws on a bad value. */
export function updatePhone(body: Record<string, unknown>, funnelHost = ''): Record<string, unknown> {
  const patch: Partial<TelephonyConfig> = {};
  if (body.ownerNumber !== undefined) {
    const n = String(body.ownerNumber || '').replace(/[\s()-]/g, '');
    if (n && !E164_RE.test(n)) throw new Error('owner number must be E.164 (+9725…)');
    patch.ownerNumber = n;
  }
  if (body.pin !== undefined) {
    const pin = String(body.pin || '');
    if (!PIN_RE.test(pin)) throw new Error('PIN must be 4–8 digits');
    patch.pinHash = hashPin(pin);
  }
  if (body.clearPin === true) patch.pinHash = '';
  if (body.publicUrl !== undefined) {
    const u = String(body.publicUrl || '').trim().replace(/\/+$/, '');
    if (u && !/^https:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(u)) throw new Error('public URL must be https://host[:port]');
    patch.publicUrl = u;
  }
  updateTelephonyConfig(patch);
  if (patch.pinHash !== undefined) { lockedUntil = 0; failures = 0; }
  return phoneView(funnelHost);
}
/** "Test signature": sign a sample request with the stored token for the configured base and run it through the verifier. */
export function selfTestSignature(funnelHost = ''): { ok: boolean; detail: string; url: string } {
  const base = publicBase(null, funnelHost);
  const url = base ? base + TWILIO_VOICE_PATH : '';
  if (!base) return { ok: false, detail: 'no public URL: turn on the Funnel (Settings → Webhooks) or set one here', url };
  const token = twilioToken();
  if (!token) return { ok: false, detail: 'Twilio is not connected', url };
  const params: Params = { CallSid: 'CA' + '0'.repeat(32), From: cfg.telephony?.ownerNumber || '+10000000000', To: '+10000000000', AccountSid: twilioSid() };
  const sig = twilioSignature(token, url, params);
  const why = verifyTwilioSignature({ token, sig, bases: [base], pathAndQuery: TWILIO_VOICE_PATH, params, replay: false });
  return { ok: !why, detail: why || `signature verifies for ${url}`, url };
}
