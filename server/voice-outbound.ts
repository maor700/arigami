// Stage 4a (docs/VOICE.md): the agent calls and texts OTHER people for the owner — only after the owner's Send on a card.
// call_contact / send_sms → outbound card; Send → Twilio Calls/Messages API; the call's TwiML streams into an outbound clerk.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ARIGAMI_DIR } from './lib/instance.js';
import { cfg, updateTelephonyConfig } from './lib/config.js';
import { requireVoiceProvider, telephonyConnected, voiceEnabled, twilioBase } from './voice-providers.js';
import { recordVoiceUsage, voiceBudgetState, TWILIO_OUTBOUND_USD_PER_MIN, GEMINI_LIVE_USD_PER_MIN, OPENAI_REALTIME_USD_PER_MIN, TWILIO_SMS_USD } from './voice-usage.js';
import { liveCallCount, type ToolDef } from './voice-realtime.js';
import { twilioSid, twilioToken, twiml, sayIn, esc, streamUrl, phoneGate, E164_RE, STREAM_TOKEN_TTL_MS, type Params } from './voice-phone.js';

export const TWILIO_OUTBOUND_PATH = '/__api/webhooks/twilio/outbound';
export const TWILIO_OUTBOUND_STATUS_PATH = '/__api/webhooks/twilio/outbound-status';
export const TWILIO_SMS_PATH = '/__api/webhooks/twilio/sms';
export const STATE_FILE = path.join(ARIGAMI_DIR, 'voice-outbound.json');
export const RING_TIMEOUT_S = 30;
export const END_DELAY_MS = 2500; // let the goodbye play before the REST hang-up
export const FINAL_FALLBACK_MS = 90_000; // stream ended, no final status this long → post the card anyway
const CALL_SID_RE = /^CA[a-f0-9]{32}$/;
const OB_ID_RE = /^ob_[a-z0-9]{8,40}$/;
const TEXT_MAX = 1000;
const BRIEF_MAX = 3000;
const NOTE_MAX = 300;
const NOTES_MAX = 30;

// ---- settings (config.telephony.outbound, merged over these) ------------------------------------------------------------
export interface QuietConfig { start: string; end: string; shabbat: boolean; timezone: string; lat: number; lon: number; extraDates: string[] }
export interface OutboundConfig {
  disclosure: { he: string; en: string }; // {owner} → ownerName
  ownerName: string;
  callerId: 'agent' | 'owner';
  amd: 'voicemail' | 'hangup' | 'off';
  maxMinutes: number;
  maxCallsPerDay: number;
  maxSmsPerDay: number;
  allowTransfer: boolean;
  askOwnerSeconds: number;
  defaultCountry: string; // local 05x… → +<country>5x…
  quiet: QuietConfig;
}
export const OUTBOUND_DEFAULTS: OutboundConfig = {
  disclosure: { he: 'שלום, כאן העוזר הדיגיטלי של {owner}.', en: "Hello, this is {owner}'s digital assistant." },
  ownerName: '',
  callerId: 'agent',
  amd: 'voicemail',
  maxMinutes: 10,
  maxCallsPerDay: 5,
  maxSmsPerDay: 10,
  allowTransfer: true,
  askOwnerSeconds: 60,
  defaultCountry: '972',
  quiet: { start: '21:00', end: '08:00', shabbat: true, timezone: 'Asia/Jerusalem', lat: 31.778, lon: 35.235, extraDates: [] },
};
export function outboundSettings(): OutboundConfig {
  const o = (cfg.telephony?.outbound || {}) as Partial<OutboundConfig>;
  return { ...OUTBOUND_DEFAULTS, ...o, disclosure: { ...OUTBOUND_DEFAULTS.disclosure, ...(o.disclosure || {}) }, quiet: { ...OUTBOUND_DEFAULTS.quiet, ...(o.quiet || {}) } };
}
/** The disclosure line the clerk opens with, {owner} filled. */
export function disclosureText(lang: string, s = outboundSettings()): string {
  const he = lang === 'he';
  const owner = s.ownerName.trim() || (he ? 'בעל החשבון' : 'the account owner');
  return (he ? s.disclosure.he : s.disclosure.en).replace(/\{owner\}/g, owner);
}

// ---- quiet hours: a clock window + Shabbat/holidays (sunset by the NOAA approximation) -----------------------------------
// Israel's Yom Tov days (one day each; Rosh Hashana two). Extend with outbound.quiet.extraDates.
export const HOLIDAYS: Record<string, string> = {
  '2026-09-12': 'Rosh Hashana', '2026-09-13': 'Rosh Hashana', '2026-09-21': 'Yom Kippur', '2026-09-26': 'Sukkot', '2026-10-03': 'Shemini Atzeret',
  '2027-04-22': 'Pesach', '2027-04-28': 'Pesach', '2027-06-11': 'Shavuot',
  '2027-10-02': 'Rosh Hashana', '2027-10-03': 'Rosh Hashana', '2027-10-11': 'Yom Kippur', '2027-10-16': 'Sukkot', '2027-10-23': 'Shemini Atzeret',
  '2028-04-11': 'Pesach', '2028-04-17': 'Pesach', '2028-05-31': 'Shavuot',
  '2028-09-21': 'Rosh Hashana', '2028-09-22': 'Rosh Hashana', '2028-09-30': 'Yom Kippur', '2028-10-05': 'Sukkot', '2028-10-12': 'Shemini Atzeret',
  '2029-03-31': 'Pesach', '2029-04-06': 'Pesach', '2029-05-20': 'Shavuot',
  '2029-09-10': 'Rosh Hashana', '2029-09-11': 'Rosh Hashana', '2029-09-19': 'Yom Kippur', '2029-09-24': 'Sukkot', '2029-10-01': 'Shemini Atzeret',
};
const CANDLES_MIN = 40; // before sunset
const HAVDALA_MIN = 45; // after sunset
const rad = Math.PI / 180;
/** Sunset (ms epoch) on a civil date at lat/lon. */
export function sunsetMs(y: number, m: number, d: number, lat: number, lon: number): number {
  const jd = Date.UTC(y, m - 1, d, 12) / 86400000 + 2440587.5;
  const n = Math.round(jd - 2451545.0 + 0.0008);
  const jStar = n - lon / 360;
  const M = (357.5291 + 0.98560028 * jStar) % 360;
  const C = 1.9148 * Math.sin(M * rad) + 0.02 * Math.sin(2 * M * rad) + 0.0003 * Math.sin(3 * M * rad);
  const L = (M + C + 180 + 102.9372) % 360;
  const transit = 2451545.0 + jStar + 0.0053 * Math.sin(M * rad) - 0.0069 * Math.sin(2 * L * rad);
  const decl = Math.asin(Math.sin(L * rad) * Math.sin(23.44 * rad));
  const cosW = (Math.sin(-0.833 * rad) - Math.sin(lat * rad) * Math.sin(decl)) / (Math.cos(lat * rad) * Math.cos(decl));
  const w = Math.acos(Math.max(-1, Math.min(1, cosW))) / rad;
  return (transit + w / 360 - 2440587.5) * 86400000;
}
interface Local { y: number; m: number; d: number; hh: number; mm: number; wd: number; date: string }
export function localParts(now: number, tz: string): Local {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' }).formatToParts(new Date(now)).map((p) => [p.type, p.value]));
  const y = Number(parts.year), m = Number(parts.month), d = Number(parts.day);
  return { y, m, d, hh: Number(parts.hour) % 24, mm: Number(parts.minute), wd: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday), date: `${parts.year}-${parts.month}-${parts.day}` };
}
const nextDate = (l: Local): string => new Date(Date.UTC(l.y, l.m - 1, l.d + 1)).toISOString().slice(0, 10);
const hm = (s: string): number => { const [h, m] = String(s).split(':').map(Number); return (h || 0) * 60 + (m || 0); };
/** '' when a call/SMS to others is allowed now; else the reason (quiet hours / Shabbat / a holiday). */
export function quietReason(now: number, s: OutboundConfig = outboundSettings()): string {
  const q = s.quiet;
  const l = localParts(now, q.timezone);
  if (q.shabbat) {
    const holidays: Record<string, string> = { ...HOLIDAYS, ...Object.fromEntries((q.extraDates || []).map((d) => [d, 'a holiday'])) };
    const sunset = sunsetMs(l.y, l.m, l.d, q.lat, q.lon);
    if ((l.wd === 5 && now >= sunset - CANDLES_MIN * 60_000) || (l.wd === 6 && now < sunset + HAVDALA_MIN * 60_000)) return 'Shabbat';
    if (holidays[l.date] && now < sunset + HAVDALA_MIN * 60_000) return holidays[l.date];
    const tomorrow = holidays[nextDate(l)];
    if (tomorrow && now >= sunset - CANDLES_MIN * 60_000) return tomorrow;
  }
  const t = l.hh * 60 + l.mm, a = hm(q.start), b = hm(q.end);
  if (a !== b && (a < b ? t >= a && t < b : t >= a || t < b)) return `quiet hours (${q.start}–${q.end})`;
  return '';
}

// ---- daily counters + opt-outs (survive a restart) --------------------------------------------------------------------
interface StateFile { day: string; calls: number; sms: number; optOut: string[] }
function readState(): StateFile {
  try { const j = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); return { day: String(j.day || ''), calls: Number(j.calls) || 0, sms: Number(j.sms) || 0, optOut: Array.isArray(j.optOut) ? j.optOut.map(String) : [] }; }
  catch { return { day: '', calls: 0, sms: 0, optOut: [] }; }
}
function writeState(s: StateFile): void {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, STATE_FILE);
}
function today(now: number): StateFile {
  const st = readState();
  const day = localParts(now, outboundSettings().quiet.timezone).date;
  return st.day === day ? st : { ...st, day, calls: 0, sms: 0 };
}
export const usageToday = (now = Date.now()): { calls: number; sms: number } => { const s = today(now); return { calls: s.calls, sms: s.sms }; };
function bump(kind: 'calls' | 'sms', now: number): void { const s = today(now); s[kind] += 1; writeState(s); }
export const isOptedOut = (n: string): boolean => readState().optOut.includes(n);
function setOptOut(n: string, out: boolean): void {
  const s = readState();
  const set = new Set(s.optOut);
  if (out) set.add(n); else set.delete(n);
  writeState({ ...s, optOut: [...set] });
}

// ---- numbers, recipients, caller IDs ------------------------------------------------------------------------------------
/** '+972 50-123 4567' / '050-1234567' / '972501234567' → E.164, or '' (never a guess beyond the configured country). */
export function normalizeNumber(raw: unknown, country = outboundSettings().defaultCountry): string {
  const t = String(raw ?? '').trim();
  if (!/^\+?[\d\s\-().]{6,20}$/.test(t)) return '';
  const digits = t.replace(/\D/g, '');
  let n = '';
  if (t.startsWith('+')) n = '+' + digits;
  else if (digits.startsWith('00')) n = '+' + digits.slice(2);
  else if (digits.startsWith('0') && country) n = '+' + country + digits.slice(1);
  else if (country && digits.startsWith(country)) n = '+' + digits;
  return E164_RE.test(n) ? n : '';
}
export type Recipient = { number: string; name: string } | { error: string; candidates?: { name: string; number: string }[] };
/** A number as given, else a unique WhatsApp contact/chat name with a phone; never a guess. */
export function resolveRecipient(to: unknown, dbPath?: string): Recipient {
  const raw = String(to ?? '').trim().slice(0, 120);
  if (!raw) return { error: 'to required: a contact name or a phone number' };
  const n = normalizeNumber(raw);
  if (n) return { number: n, name: raw.replace(/[\d\s+\-().]/g, '') ? raw : '' };
  if (/^\+?[\d\s\-().]+$/.test(raw)) return { error: `"${raw}" is not a full phone number — ask the owner for it` };
  const db = dbPath || waDbPath();
  if (!db || !fs.existsSync(db)) return { error: `no number known for "${raw}" (WhatsApp contacts unavailable) — ask the owner for the number` };
  const hits = new Map<string, string>();
  try {
    const lw = require('./listeners-whatsapp.js') as typeof import('./listeners-whatsapp.js');
    for (const c of lw.lookupContactByName(db, raw)) { const p = c.phoneJid?.endsWith('@s.whatsapp.net') ? normalizeNumber('+' + c.phoneJid.split('@')[0]) : ''; if (p && !hits.has(p)) hits.set(p, c.name); }
    if (!hits.size) for (const c of chatsByName(db, raw)) if (!hits.has(c.number)) hits.set(c.number, c.name);
  } catch (e) {
    return { error: `could not read WhatsApp contacts (${(e as Error).message}) — ask the owner for the number` };
  }
  const list = [...hits].map(([number, name]) => ({ number, name }));
  if (list.length === 1) return list[0];
  if (!list.length) return { error: `no phone number found for "${raw}" — ask the owner for the number` };
  return { error: `"${raw}" matches ${list.length} contacts — ask the owner which one`, candidates: list.slice(0, 6) };
}
function waDbPath(): string { try { return (require('./whatsapp-bridge.js') as typeof import('./whatsapp-bridge.js')).WA_DB_PATH; } catch { return ''; } }
function chatsByName(db: string, term: string): { name: string; number: string }[] {
  const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
  const d = new DatabaseSync(db, { open: true });
  try {
    const rows = d.prepare(`SELECT jid, name FROM chats WHERE jid LIKE '%@s.whatsapp.net' AND name LIKE ? LIMIT 10`).all(`%${term}%`) as { jid: string; name: string }[];
    return rows.map((r) => ({ name: r.name, number: normalizeNumber('+' + r.jid.split('@')[0]) })).filter((r) => r.number);
  } finally { d.close(); }
}
export const agentNumber = (): string => (E164_RE.test(String(cfg.telephony?.number || '')) ? String(cfg.telephony!.number) : '');
export const verifiedCallerIds = (): string[] => (cfg.telephony?.callerIds || []).map((c) => c.number).filter((n) => E164_RE.test(n));
export type CallerId = { from: string; kind: 'agent' | 'owner' | 'verified' } | { error: string };
/** 'agent' | 'owner' | an E.164 number → the From for the call; the owner's number only once Twilio verified it. */
export function resolveCallerId(choice?: unknown): CallerId {
  const c = String(choice || outboundSettings().callerId || 'agent').trim();
  const agent = agentNumber();
  const owner = String(cfg.telephony?.ownerNumber || '');
  const verified = verifiedCallerIds();
  const asAgent = (): CallerId => (agent ? { from: agent, kind: 'agent' } : { error: "the agent's own number is not set (Settings → Voice & phone → Agent number)" });
  const asOwner = (): CallerId => (owner && verified.includes(owner) ? { from: owner, kind: 'owner' } : { error: 'your number is not a verified caller ID yet (Settings → Voice & phone → Verify my number as caller ID)' });
  if (c === 'agent') return asAgent();
  if (c === 'owner') return asOwner();
  const n = normalizeNumber(c);
  if (n && n === agent) return asAgent();
  if (n && n === owner) return asOwner();
  if (n && verified.includes(n)) return { from: n, kind: 'verified' };
  return { error: 'caller_id must be "agent", "owner" or a verified number' };
}

// ---- costs -------------------------------------------------------------------------------------------------------------
export function callUsdPerMin(): number {
  const rt = requireVoiceProvider('realtime');
  const live = 'ok' in rt && rt.ok && rt.provider === 'voice:openai' ? OPENAI_REALTIME_USD_PER_MIN : GEMINI_LIVE_USD_PER_MIN;
  return TWILIO_OUTBOUND_USD_PER_MIN + live;
}
export function smsSegments(text: string): number {
  const gsm = /^[\x20-\x7E\n\r]*$/.test(text);
  const one = gsm ? 160 : 70, many = gsm ? 153 : 67;
  return text.length <= one ? 1 : Math.ceil(text.length / many);
}
const usd = (n: number): string => `$${(Math.round(n * 100) / 100).toFixed(2)}`;

// ---- guards (filing and again on Send) ----------------------------------------------------------------------------------
/** '' when allowed; else a reason the agent can say as-is. */
export function outboundGuard(kind: 'call' | 'sms', now = Date.now()): string {
  if (!voiceEnabled()) return 'the voice & phone layer is switched off (Settings → Voice & phone)';
  if (!telephonyConnected()) return 'Twilio is not connected (Settings → Connections → Voice & phone)';
  if (voiceBudgetState('telephony:twilio') === 'soft-stopped') return "this month's Twilio budget cap is reached";
  if (kind === 'call') {
    const g = phoneGate();
    if (!g.ok) return g.why === 'twilio cap reached' ? "this month's Twilio budget cap is reached" : `no realtime voice for the call (${g.why})`;
  }
  const s = outboundSettings();
  const quiet = quietReason(now, s);
  if (quiet) return `${quiet} — no ${kind === 'call' ? 'calls' : 'SMS'} to others now`;
  const u = usageToday(now);
  if (kind === 'call' && u.calls >= s.maxCallsPerDay) return `the daily cap of ${s.maxCallsPerDay} outbound calls is reached`;
  if (kind === 'sms' && u.sms >= s.maxSmsPerDay) return `the daily cap of ${s.maxSmsPerDay} SMS is reached`;
  return '';
}

// ---- filing: validate + the exact arguments the card shows ----------------------------------------------------------------
const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
export interface CallArgs { to: string; name: string; goal: string; brief: string; from: string; callerKind: string; language: 'he' | 'en'; voicemail: string; amd: OutboundConfig['amd']; maxMinutes: number; usdPerMin: number; origin: 'agent' | 'clerk' }
export interface SmsArgs { to: string; name: string; text: string; from: string; segments: number; estUsd: number }
type Refusal = { ok: false; error: string; candidates?: { name: string; number: string }[] };
export function prepareCall(body: Record<string, unknown>, o: { origin?: 'agent' | 'clerk'; now?: number; dbPath?: string } = {}): { ok: true; args: CallArgs } | Refusal {
  const goal = str(body.goal, 300), brief = str(body.brief, BRIEF_MAX);
  if (!goal || !brief) return { ok: false, error: 'goal and brief required' };
  const why = outboundGuard('call', o.now);
  if (why) return { ok: false, error: `refused: ${why}` };
  const r = resolveRecipient(body.to, o.dbPath);
  if ('error' in r) return { ok: false, error: r.error, ...(r.candidates ? { candidates: r.candidates } : {}) };
  if (isOptedOut(r.number)) return { ok: false, error: `refused: ${r.number} opted out (STOP)` };
  if (r.number === agentNumber()) return { ok: false, error: "refused: that is the agent's own number" };
  const cid = resolveCallerId(body.caller_id);
  if ('error' in cid) return { ok: false, error: `refused: ${cid.error}` };
  const s = outboundSettings();
  const lang = body.language === 'en' ? 'en' : body.language === 'he' ? 'he' : cfg.voiceLang === 'en' ? 'en' : 'he';
  return { ok: true, args: { to: r.number, name: r.name, goal, brief, from: cid.from, callerKind: cid.kind, language: lang, voicemail: str(body.voicemail, 400), amd: s.amd, maxMinutes: s.maxMinutes, usdPerMin: Math.round(callUsdPerMin() * 1000) / 1000, origin: o.origin || 'agent' } };
}
export function prepareSms(body: Record<string, unknown>, o: { now?: number; dbPath?: string } = {}): { ok: true; args: SmsArgs } | Refusal {
  const text = str(body.text, TEXT_MAX);
  if (!text) return { ok: false, error: 'text required' };
  const why = outboundGuard('sms', o.now);
  if (why) return { ok: false, error: `refused: ${why}` };
  const r = resolveRecipient(body.to, o.dbPath);
  if ('error' in r) return { ok: false, error: r.error, ...(r.candidates ? { candidates: r.candidates } : {}) };
  if (isOptedOut(r.number)) return { ok: false, error: `refused: ${r.number} opted out (STOP)` };
  const from = agentNumber();
  if (!from) return { ok: false, error: "refused: the agent's own number is not set (Settings → Voice & phone → Agent number)" };
  const segments = smsSegments(text);
  return { ok: true, args: { to: r.number, name: r.name, text, from, segments, estUsd: Math.round(segments * TWILIO_SMS_USD * 100) / 100 } };
}
/** The card text: everything the call will do, nothing paraphrased later. */
export function callCardText(a: CallArgs, why?: string): string {
  const he = cfg.voiceLang !== 'en';
  const who = a.name ? `${a.name} (${a.to})` : a.to;
  const cid = a.callerKind === 'agent' ? (he ? `מספר הסוכן ${a.from}` : `the agent's number ${a.from}`) : he ? `המספר שלך ${a.from}` : `your number ${a.from}`;
  const amd = a.amd === 'voicemail' ? (he ? 'להשאיר הודעה קצרה' : 'leave a short message') : a.amd === 'hangup' ? (he ? 'לנתק' : 'hang up') : he ? 'ללא זיהוי' : 'no detection';
  const max = usd(a.usdPerMin * a.maxMinutes);
  const lines = he
    ? [`📞 להתקשר ל-${who}?`, ...(why ? [`למה: ${why}`] : []), `מטרה: ${a.goal}`, '', `תדריך (הסוכן פועל רק לפיו):`, a.brief, '', `פתיחה: "${disclosureText(a.language)}"`, `מזהה מתקשר: ${cid}`, `משיבון: ${amd}${a.voicemail ? ` — "${a.voicemail}"` : ''}`, `עד ${a.maxMinutes} דק׳ · עלות משוערת עד ${max} (${usd(a.usdPerMin)}/דק׳)`]
    : [`📞 Call ${who}?`, ...(why ? [`Why: ${why}`] : []), `Goal: ${a.goal}`, '', 'Brief (the caller follows only this):', a.brief, '', `Opens with: "${disclosureText(a.language)}"`, `Caller ID: ${cid}`, `Voicemail: ${amd}${a.voicemail ? ` — "${a.voicemail}"` : ''}`, `Up to ${a.maxMinutes} min · est. up to ${max} (${usd(a.usdPerMin)}/min)`];
  return lines.join('\n');
}
export function smsCardText(a: SmsArgs, why?: string): string {
  const he = cfg.voiceLang !== 'en';
  const who = a.name ? `${a.name} (${a.to})` : a.to;
  return (he ? [`💬 לשלוח SMS ל-${who}?`, ...(why ? [`למה: ${why}`] : []), '', a.text, '', `מ-${a.from} · ${a.segments} הודעות · ${usd(a.estUsd)}`] : [`💬 Send an SMS to ${who}?`, ...(why ? [`Why: ${why}`] : []), '', a.text, '', `From ${a.from} · ${a.segments} segment(s) · ${usd(a.estUsd)}`]).join('\n');
}

// ---- Twilio REST ----------------------------------------------------------------------------------------------------------
export type TwilioResult = { ok: true; json: Record<string, any> } | { ok: false; error: string; status?: number };
export async function twilioRequest(method: 'GET' | 'POST', rel: string, params: URLSearchParams | null, fetchImpl: typeof fetch = fetch): Promise<TwilioResult> {
  const sid = twilioSid(), token = twilioToken();
  if (!sid || !token) return { ok: false, error: 'Twilio is not connected' };
  const url = `${twilioBase()}/2010-04-01/Accounts/${encodeURIComponent(sid)}/${rel}`;
  try {
    const res = await fetchImpl(method === 'GET' && params ? `${url}?${params}` : url, {
      method,
      headers: { Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`, ...(method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
      ...(method === 'POST' ? { body: (params || new URLSearchParams()).toString() } : {}),
      signal: AbortSignal.timeout(15_000),
    });
    let j: Record<string, any> = {};
    try { j = (await res.json()) as Record<string, any>; } catch { /* empty */ }
    if (!res.ok) return { ok: false, status: res.status, error: `Twilio answered ${res.status}${j?.message ? `: ${String(j.message).replace(token, '•••').slice(0, 300)}` : ''}` };
    return { ok: true, json: j };
  } catch (e) {
    return { ok: false, error: `Twilio unreachable: ${(e as Error).message}` };
  }
}

// ---- the host side the outbound call needs (api.ts installs it) ----------------------------------------------------------
export interface OutboundHost {
  appendChat(id: string, ev: Record<string, unknown>): void;
  tell(id: string, line: string): void; // an agent session gets a message; the voice home a system line
  askOwner(o: { sessionId: string; prompt: string; options: string[]; timeoutMs: number }): Promise<string | null>;
}
let host: OutboundHost | null = null;
let fetcher: typeof fetch = ((...a: Parameters<typeof fetch>) => fetch(...a)) as typeof fetch;
export const setOutboundHost = (h: OutboundHost | null): void => { host = h; };
/** Tests only. */
export const __setOutboundFetch = (f: typeof fetch | null): void => { fetcher = f || (((...a: Parameters<typeof fetch>) => fetch(...a)) as typeof fetch); };

// ---- live outbound calls (in memory; a restart forgets them) --------------------------------------------------------------
export interface OutboundCall extends CallArgs {
  id: string; sessionId: string; callSid: string; placedAt: number;
  token?: string; tokenExp?: number; answeredBy?: string; voicemailLeft?: boolean;
  streamStarted?: boolean; streamLive?: boolean; transferred?: boolean;
  turns: { role: string; text: string }[]; notes: string[]; summary?: string; clerkOutcome?: string;
  status?: string; duration?: number; done?: boolean; timer?: ReturnType<typeof setTimeout>;
}
const byId = new Map<string, OutboundCall>();
const bySid = new Map<string, OutboundCall>();
export const outboundCall = (idOrSid: string): Readonly<OutboundCall> | null => byId.get(idOrSid) || bySid.get(idOrSid) || null;
export const liveOutboundCalls = (): number => [...byId.values()].filter((c) => !c.done).length;
/** Tests only. */
export function __resetOutbound(): void { for (const c of byId.values()) if (c.timer) clearTimeout(c.timer); byId.clear(); bySid.clear(); }

/** On the owner's Send: re-check, then POST Calls.json (Url → the outbound TwiML, AMD, a hard TimeLimit). */
export async function placeCall(a: CallArgs, sessionId: string, o: { base: string; fetchImpl?: typeof fetch; now?: number }): Promise<{ ok: true; callSid: string; id: string } | { ok: false; error: string }> {
  const now = o.now ?? Date.now();
  const why = outboundGuard('call', now);
  if (why) return { ok: false, error: why };
  if (liveCallCount() > 0 || liveOutboundCalls() > 0) return { ok: false, error: 'another voice call is live — try again when it ends' };
  if (isOptedOut(a.to)) return { ok: false, error: `${a.to} opted out (STOP)` };
  const cid = resolveCallerId(a.from);
  if ('error' in cid || cid.from !== a.from) return { ok: false, error: 'error' in cid ? cid.error : 'caller ID changed since the card' };
  if (!o.base) return { ok: false, error: 'no public URL for Twilio to reach this host (turn on the Funnel or set Public URL)' };
  const id = `ob_${crypto.randomBytes(8).toString('hex')}`;
  const p = new URLSearchParams({ To: a.to, From: a.from, Url: `${o.base}${TWILIO_OUTBOUND_PATH}?ob=${id}`, Method: 'POST', StatusCallback: `${o.base}${TWILIO_OUTBOUND_STATUS_PATH}?ob=${id}`, StatusCallbackMethod: 'POST', Timeout: String(RING_TIMEOUT_S), TimeLimit: String(Math.max(60, Math.round(a.maxMinutes * 60))) });
  for (const ev of ['initiated', 'ringing', 'answered', 'completed']) p.append('StatusCallbackEvent', ev);
  if (a.amd !== 'off') p.set('MachineDetection', 'DetectMessageEnd');
  const r = await twilioRequest('POST', 'Calls.json', p, o.fetchImpl || fetcher);
  if (!r.ok) return { ok: false, error: r.error };
  const callSid = String(r.json.sid || '');
  if (!CALL_SID_RE.test(callSid)) return { ok: false, error: 'Twilio answered without a call sid' };
  bump('calls', now);
  const call: OutboundCall = { ...a, id, sessionId, callSid, placedAt: now, turns: [], notes: [] };
  byId.set(id, call);
  bySid.set(callSid, call);
  arm(call, (a.maxMinutes * 60 + RING_TIMEOUT_S + 120) * 1000); // no status ever → the card still comes
  console.log(`[voice-outbound] ${id} placed ${callSid} (${a.callerKind} caller ID)`);
  return { ok: true, callSid, id };
}
/** On the owner's Send: re-check, then POST Messages.json from the agent's number. */
export async function sendSms(a: SmsArgs, o: { fetchImpl?: typeof fetch; now?: number } = {}): Promise<{ ok: true; sid: string } | { ok: false; error: string }> {
  const now = o.now ?? Date.now();
  const why = outboundGuard('sms', now);
  if (why) return { ok: false, error: why };
  if (isOptedOut(a.to)) return { ok: false, error: `${a.to} opted out (STOP)` };
  if (a.from !== agentNumber()) return { ok: false, error: "the agent's number changed since the card" };
  const r = await twilioRequest('POST', 'Messages.json', new URLSearchParams({ To: a.to, From: a.from, Body: a.text }), o.fetchImpl || fetcher);
  if (!r.ok) return { ok: false, error: r.error };
  bump('sms', now);
  recordVoiceUsage('telephony:twilio', { usd: a.estUsd });
  return { ok: true, sid: String(r.json.sid || '') };
}

// ---- TwiML for the answered call --------------------------------------------------------------------------------------------
const isMachine = (a?: string): boolean => /^(machine|fax)/.test(String(a || ''));
export function voicemailText(c: CallArgs): string {
  if (c.voicemail) return `${disclosureText(c.language)} ${c.voicemail}`;
  const owner = outboundSettings().ownerName.trim();
  return c.language === 'he'
    ? `${disclosureText('he')} התקשרתי בעניין: ${c.goal}. ${owner || 'בעל החשבון'} יחזור אליך. תודה.`
    : `${disclosureText('en')} I called about: ${c.goal}. ${owner || 'The account owner'} will get back to you. Thank you.`;
}
const SORRY = { he: 'מצטערים, לא ניתן להמשיך את השיחה כרגע. להתראות.', en: 'Sorry, this call cannot continue right now. Goodbye.' };
/** POST …/twilio/outbound?ob=<id> → TwiML: voicemail/hang-up for a machine, else the stream into the outbound clerk. */
export function handleOutboundTwiml(params: Params, query: URLSearchParams, ctx: { base: string; now?: number }): string {
  const now = ctx.now ?? Date.now();
  const id = String(query.get('ob') || '');
  const c = OB_ID_RE.test(id) ? byId.get(id) : null;
  if (!c || c.done || String(params.CallSid || '') !== c.callSid) return twiml('<Hangup/>');
  c.answeredBy = String(params.AnsweredBy || c.answeredBy || '');
  if (isMachine(c.answeredBy)) {
    if (c.amd !== 'voicemail') return twiml('<Hangup/>');
    c.voicemailLeft = true;
    return twiml(`<Pause length="1"/>${sayIn(c.language, voicemailText(c))}<Hangup/>`);
  }
  const gate = phoneGate();
  if (!gate.ok || liveCallCount() > 0) return twiml(sayIn(c.language, SORRY[c.language]) + '<Hangup/>');
  c.token = crypto.randomBytes(24).toString('base64url');
  c.tokenExp = now + STREAM_TOKEN_TTL_MS;
  return twiml(`<Connect><Stream url="${esc(streamUrl(ctx.base))}"><Parameter name="token" value="${esc(c.token)}"/></Stream></Connect><Hangup/>`);
}
/** The bridge's `start` for an outbound call: one-time token, bound to the CallSid. */
export function consumeOutboundToken(callSid: string, token: string, now = Date.now()): OutboundCall | null {
  const c = bySid.get(callSid);
  if (!c || c.done || !c.token || !token || (c.tokenExp || 0) < now) return null;
  const a = Buffer.from(token), b = Buffer.from(c.token);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  delete c.token;
  c.streamStarted = true;
  c.streamLive = true;
  return c;
}

// ---- the outbound clerk: persona + its four tools -----------------------------------------------------------------------------
export const OUTBOUND_TOOLS: readonly ToolDef[] = [
  { type: 'function', name: 'end_call', description: 'Hang up. Say goodbye FIRST, then call this with a two-sentence summary for the owner and the outcome.', parameters: { type: 'object', properties: { summary: { type: 'string', description: 'What was said and agreed, for the owner' }, outcome: { type: 'string', description: 'done | partial | refused | wrong-number | call-back' } }, required: ['summary'] } },
  { type: 'function', name: 'take_note', description: 'Keep one fact for the owner (a time, a name, a price, a number, a commitment).', parameters: { type: 'object', properties: { note: { type: 'string' } }, required: ['note'] } },
  { type: 'function', name: 'ask_owner', description: "Ask the owner a question the brief does not answer; waits up to a minute. Say 'רגע, אני בודק' first. If no answer comes, tell the person the owner will get back to them.", parameters: { type: 'object', properties: { question: { type: 'string' }, options: { type: 'array', items: { type: 'string' }, description: 'Optional: 2–4 short answers the owner can tap' } }, required: ['question'] } },
  { type: 'function', name: 'transfer_to_owner', description: 'Connect the person to the owner directly (only when they ask for the owner, or the brief says so). Say you are transferring first.', parameters: { type: 'object', properties: { reason: { type: 'string' } }, required: [] } },
];
const clean = (s: string, n: number): string => s.replace(/[\r\n]+/g, ' ').slice(0, n);
/** The outbound persona: disclosure, goal, brief, the rules. */
export function outboundInstructions(c: Pick<CallArgs, 'language' | 'goal' | 'brief' | 'name'>, s = outboundSettings()): string {
  const he = c.language === 'he';
  return [
    `You are placing a phone call on behalf of ${s.ownerName.trim() || 'the account owner'} to ${c.name ? clean(c.name, 80) : 'the person who answers'}.`,
    `Open with exactly: "${disclosureText(c.language, s)}" and then state why you are calling.`,
    `Goal: ${clean(c.goal, 300)}`,
    `Brief — follow it and never go beyond it: ${c.brief.slice(0, BRIEF_MAX)}`,
    'Rules: one or two short spoken sentences at a time. You are a digital assistant: never claim to be human, and say so if asked. ' +
      'Do not agree to payments, sign-ups or anything the brief does not allow, and share no personal detail the brief does not give. ' +
      'Use take_note for any fact worth keeping. If the person asks something the brief does not cover, use ask_owner, or say the owner will get back to them. ' +
      `${s.allowTransfer ? 'If they ask to speak with the owner, use transfer_to_owner. ' : ''}` +
      'If the person asks not to be called again, apologise, note it and end the call. When the goal is reached or the person wants to stop, say goodbye and call end_call with a summary.',
    he ? 'Speak Hebrew unless the person clearly speaks another language.' : 'Speak English unless the person clearly speaks another language.',
  ].join('\n');
}
export const outboundKick = (c: Pick<CallArgs, 'language'>): string => (c.language === 'he' ? '(השיחה התחברה — פתח עכשיו בהצגה עצמית.)' : '(The call just connected — open now with the introduction.)');

const callUpdate = (c: OutboundCall, p: Record<string, string>): Promise<TwilioResult> => twilioRequest('POST', `Calls/${c.callSid}.json`, new URLSearchParams(p), fetcher);
/** One outbound-clerk tool; never throws. */
export async function runOutboundTool(c: OutboundCall, name: string, args: Record<string, unknown>, o: { endDelayMs?: number } = {}): Promise<Record<string, unknown>> {
  switch (name) {
    case 'take_note': {
      const note = str(args.note, NOTE_MAX);
      if (!note) return { error: 'note required' };
      if (c.notes.length < NOTES_MAX) c.notes.push(note);
      return { ok: true, notes: c.notes.length };
    }
    case 'end_call': {
      c.summary = str(args.summary, 1200) || c.summary;
      c.clerkOutcome = str(args.outcome, 40) || c.clerkOutcome;
      const t = setTimeout(() => { void callUpdate(c, { Status: 'completed' }); }, o.endDelayMs ?? END_DELAY_MS);
      t.unref?.();
      return { ok: true, ending: true, note: 'The line closes in a moment; say nothing more.' };
    }
    case 'ask_owner': {
      const q = str(args.question, 400);
      if (!q) return { error: 'question required' };
      if (!host) return { answer: null, say: 'The owner cannot be reached now; say they will get back to them.' };
      const options = (Array.isArray(args.options) ? args.options : []).map((x) => str(x, 60)).filter(Boolean).slice(0, 4);
      const who = c.name || c.to;
      const prompt = cfg.voiceLang !== 'en' ? `📞 בשיחה עם ${who} (${c.goal}) שואלים:\n\n${q}` : `📞 On the call with ${who} (${c.goal}):\n\n${q}`;
      const answer = await host.askOwner({ sessionId: c.sessionId, prompt, options: options.length ? options : cfg.voiceLang !== 'en' ? ['כן', 'לא'] : ['Yes', 'No'], timeoutMs: outboundSettings().askOwnerSeconds * 1000 });
      if (answer) c.notes.length < NOTES_MAX && c.notes.push(`${q} → ${answer}`);
      return answer ? { answer } : { answer: null, say: 'No answer from the owner yet; say they will get back to them.' };
    }
    case 'transfer_to_owner': {
      const owner = String(cfg.telephony?.ownerNumber || '');
      if (!outboundSettings().allowTransfer || !E164_RE.test(owner)) return { error: 'transfer is not available; offer that the owner will call back' };
      const lead = c.language === 'he' ? 'מעביר אותך עכשיו. רגע אחד.' : 'Transferring you now. One moment.';
      const r = await callUpdate(c, { Twiml: twiml(`${sayIn(c.language, lead)}<Dial callerId="${esc(agentNumber() || c.from)}" timeout="25">${esc(owner)}</Dial>`) });
      if (!r.ok) return { error: `transfer failed: ${r.error}` };
      c.transferred = true;
      c.notes.length < NOTES_MAX && c.notes.push(`transferred to the owner${args.reason ? `: ${str(args.reason, 120)}` : ''}`);
      return { ok: true, transferring: true };
    }
    default:
      return { error: `unknown tool: ${name}` };
  }
}

// ---- the end: the stream closed and/or the final status → one card + a line to the requesting session --------------------------
const FINAL = new Set(['completed', 'busy', 'failed', 'no-answer', 'canceled']);
export type Outcome = 'reached' | 'voicemail' | 'no-answer' | 'busy' | 'failed';
export function outcomeOf(c: Pick<OutboundCall, 'status' | 'answeredBy' | 'streamStarted'>): Outcome {
  if (c.status === 'busy') return 'busy';
  if (c.status === 'no-answer') return 'no-answer';
  if (isMachine(c.answeredBy)) return 'voicemail';
  if (c.status === 'completed' || c.streamStarted) return 'reached';
  return 'failed';
}
function arm(c: OutboundCall, ms: number): void {
  if (c.timer) clearTimeout(c.timer);
  c.timer = setTimeout(() => finalize(c), ms);
  c.timer.unref?.();
}
/** The bridge: the outbound clerk's stream ended with these turns. */
export function outboundStreamEnded(callSid: string, o: { transcript?: { role: string; text: string }[]; reason?: string } = {}): void {
  const c = bySid.get(callSid);
  if (!c || c.done) return;
  c.streamLive = false;
  if (o.transcript?.length) c.turns = o.transcript;
  if (c.status && FINAL.has(c.status)) finalize(c);
  else arm(c, FINAL_FALLBACK_MS);
}
/** POST …/twilio/outbound-status?ob=<id> → ''. A final status bills Twilio's outbound minutes and posts the card. */
export function handleOutboundStatus(params: Params, query: URLSearchParams): void {
  const id = String(query.get('ob') || '');
  const c = OB_ID_RE.test(id) ? byId.get(id) : null;
  if (!c || c.done || String(params.CallSid || '') !== c.callSid) return;
  const status = String(params.CallStatus || '');
  if (status) c.status = status;
  if (params.AnsweredBy) c.answeredBy = String(params.AnsweredBy);
  if (!FINAL.has(status)) return;
  const d = Number(params.CallDuration);
  c.duration = Number.isFinite(d) ? d : 0;
  if (c.streamLive) arm(c, FINAL_FALLBACK_MS); // the bridge's end posts the card with the transcript
  else finalize(c);
}
const LABEL: Record<Outcome, [string, string]> = { reached: ['נענתה', 'reached'], voicemail: ['משיבון', 'voicemail'], 'no-answer': ['לא ענו', 'no answer'], busy: ['תפוס', 'busy'], failed: ['נכשלה', 'failed'] };
const mmss = (s: number): string => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
function finalize(c: OutboundCall): void {
  if (c.done) return;
  c.done = true;
  if (c.timer) clearTimeout(c.timer);
  const outcome = outcomeOf(c);
  const seconds = c.duration || 0;
  if (seconds > 0) recordVoiceUsage('telephony:twilio', { seconds, inbound: false });
  const he = cfg.voiceLang !== 'en';
  const who = c.name || c.to;
  const label = LABEL[outcome][he ? 0 : 1];
  const summary = c.summary || (outcome === 'voicemail' ? (c.voicemailLeft ? (he ? 'הושארה הודעה במשיבון.' : 'A voicemail was left.') : he ? 'משיבון — ניתקתי בלי הודעה.' : 'Voicemail — hung up without a message.') : outcome === 'reached' && !c.turns.length ? (he ? 'נענתה, בלי שיחה מתועדת.' : 'Answered, no conversation recorded.') : '');
  const them = c.name || (he ? 'הצד השני' : 'Them');
  const turns = c.turns.map((t) => `**${t.role === 'assistant' ? (he ? 'הסוכן' : 'Agent') : them}:** ${t.text}`).join('\n\n');
  const body = [
    `**${he ? 'מטרה' : 'Goal'}:** ${c.goal}`,
    `**${he ? 'תוצאה' : 'Outcome'}:** ${label}${c.transferred ? (he ? ' · הועבר אליך' : ' · transferred to you') : ''}${c.clerkOutcome ? ` (${c.clerkOutcome})` : ''}`,
    ...(summary ? [`**${he ? 'סיכום' : 'Summary'}:** ${summary}`] : []),
    ...(c.notes.length ? [`**${he ? 'הערות' : 'Notes'}:**\n${c.notes.map((n) => `- ${n}`).join('\n')}`] : []),
    ...(turns ? ['---', turns] : []),
  ].join('\n\n');
  try { host?.appendChat(c.sessionId, { kind: 'ext-card', extension: 'voice', title: `📞 ${he ? 'שיחה ל-' : 'Call to '}${who} · ${label}${seconds ? ` · ${mmss(seconds)}` : ''}`, body, voice: { channel: 'phone-out', outcome, seconds, callSid: c.callSid, turns: c.turns.length, transferred: !!c.transferred } }); }
  catch (e) { console.error('[voice-outbound] outcome card failed:', (e as Error).message); }
  const line = `[host] The call to ${c.name ? `${c.name} (${c.to})` : c.to} ended — outcome: ${outcome}${c.transferred ? ' (transferred to the owner)' : ''}${seconds ? `, ${mmss(seconds)}` : ''}.${summary ? ` Summary: ${summary}` : ''}${c.notes.length ? ` Notes: ${c.notes.join(' | ')}.` : ''} ${c.turns.length ? 'The transcript is on the card in this chat.' : 'The card is in this chat.'}`;
  try { host?.tell(c.sessionId, line); } catch (e) { console.error('[voice-outbound] tell failed:', (e as Error).message); }
  byId.delete(c.id);
  bySid.delete(c.callSid);
  console.log(`[voice-outbound] ${c.id} done: ${outcome} ${seconds}s`);
}

// ---- inbound SMS on the agent's number: STOP/START, a card in the voice home, the sms listener store ---------------------------
export const STOP_RE = /^\s*(stop|stopall|unsubscribe|cancel|end|quit|הסר|הסרה|עצור|הפסק)\s*[.!]?\s*$/i;
export const START_RE = /^\s*(start|unstop|yes|התחל)\s*[.!]?\s*$/i;
export interface SmsSinkHost { voiceHome(): { id: string }; appendChat(id: string, ev: Record<string, unknown>): void; receive?(from: string, body: string): void }
/** POST …/twilio/sms → TwiML (empty: no auto-reply). */
export function handleInboundSms(params: Params, h: SmsSinkHost | null): string {
  const from = normalizeNumber(params.From) || String(params.From || '').slice(0, 32);
  const body = String(params.Body || '').slice(0, 1600);
  if (!from) return twiml('');
  let tag = '';
  if (STOP_RE.test(body)) { setOptOut(from, true); tag = 'opt-out'; }
  else if (START_RE.test(body)) { setOptOut(from, false); tag = 'opt-in'; }
  try { (h?.receive || defaultReceive)(from, body); } catch (e) { console.error('[voice-outbound] sms store failed:', (e as Error).message); }
  const he = cfg.voiceLang !== 'en';
  const note = tag === 'opt-out' ? (he ? '\n\n_ביקש/ה לא לקבל יותר הודעות ושיחות — נחסם._' : '\n\n_Asked to stop — no more calls or SMS to this number._') : tag === 'opt-in' ? (he ? '\n\n_ביטל/ה את החסימה._' : '\n\n_Opted back in._') : '';
  try { h?.appendChat(h.voiceHome().id, { kind: 'ext-card', extension: 'voice', title: `💬 SMS ${he ? 'מ-' : 'from '}${from}`, body: body + note, voice: { channel: 'sms', from, ...(tag ? { event: tag } : {}) } }); }
  catch (e) { console.error('[voice-outbound] sms card failed:', (e as Error).message); }
  return twiml('');
}
function defaultReceive(from: string, body: string): void { (require('./sms.js') as typeof import('./sms.js')).receiveSms(from, body); }

// ---- caller-ID verification (Twilio OutgoingCallerIds) — the owner types the code on his phone; never auto-answered ----------------
export async function startCallerIdVerification(number: unknown, fetchImpl?: typeof fetch): Promise<{ ok: true; code: string; number: string } | { ok: false; error: string }> {
  const n = normalizeNumber(number || cfg.telephony?.ownerNumber);
  if (!n) return { ok: false, error: 'a number in international format is required (+9725…)' };
  const r = await twilioRequest('POST', 'OutgoingCallerIds.json', new URLSearchParams({ PhoneNumber: n, FriendlyName: 'Arigami owner' }), fetchImpl || fetcher);
  if (!r.ok) return { ok: false, error: r.error };
  const code = String(r.json.validation_code || '');
  if (!/^\d{4,8}$/.test(code)) return { ok: false, error: 'Twilio answered without a validation code' };
  return { ok: true, code, number: n };
}
export async function checkCallerIdVerification(number: unknown, fetchImpl?: typeof fetch): Promise<{ ok: true; verified: boolean; number: string } | { ok: false; error: string }> {
  const n = normalizeNumber(number || cfg.telephony?.ownerNumber);
  if (!n) return { ok: false, error: 'a number in international format is required (+9725…)' };
  const r = await twilioRequest('GET', 'OutgoingCallerIds.json', new URLSearchParams({ PhoneNumber: n }), fetchImpl || fetcher);
  if (!r.ok) return { ok: false, error: r.error };
  const hit = (Array.isArray(r.json.outgoing_caller_ids) ? r.json.outgoing_caller_ids : []).find((x: any) => String(x?.phone_number || '') === n);
  if (hit) {
    const rest = (cfg.telephony?.callerIds || []).filter((c) => c.number !== n);
    updateTelephonyConfig({ callerIds: [...rest, { number: n, sid: String(hit.sid || ''), verifiedAt: new Date().toISOString() }] });
  }
  return { ok: true, verified: !!hit, number: n };
}

// ---- Settings → Voice & phone → outbound -----------------------------------------------------------------------------------------
export function outboundView(now = Date.now(), base = ''): Record<string, unknown> {
  return { smsUrl: base ? base + TWILIO_SMS_PATH : '', number: cfg.telephony?.number || '', callerIds: cfg.telephony?.callerIds || [], settings: outboundSettings(), today: usageToday(now), optOuts: readState().optOut.length, quietNow: quietReason(now), live: liveOutboundCalls(), usdPerMin: Math.round(callUsdPerMin() * 1000) / 1000, smsUsd: TWILIO_SMS_USD };
}
const HM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
/** {number?, settings?: Partial<OutboundConfig>, removeCallerId?} → the view; throws on a bad value. */
export function updateOutbound(body: Record<string, unknown>, base = ''): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (body.number !== undefined) {
    const n = body.number ? normalizeNumber(body.number) : '';
    if (body.number && !n) throw new Error('agent number must be a phone number in international format');
    patch.number = n;
  }
  if (typeof body.removeCallerId === 'string') patch.callerIds = (cfg.telephony?.callerIds || []).filter((c) => c.number !== body.removeCallerId);
  const s = body.settings && typeof body.settings === 'object' ? (body.settings as Record<string, any>) : null;
  if (s) {
    const cur = outboundSettings();
    const next: OutboundConfig = { ...cur, disclosure: { ...cur.disclosure }, quiet: { ...cur.quiet } };
    const int = (v: unknown, lo: number, hi: number, name: string): number => { const n = Number(v); if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(`${name} must be ${lo}–${hi}`); return n; };
    if (s.disclosure) for (const k of ['he', 'en'] as const) if (s.disclosure[k] !== undefined) { const v = String(s.disclosure[k] || '').trim(); if (!v || v.length > 200) throw new Error(`disclosure.${k}: 1–200 characters`); next.disclosure[k] = v; }
    if (s.ownerName !== undefined) next.ownerName = String(s.ownerName || '').trim().slice(0, 60);
    if (s.callerId !== undefined) { if (!['agent', 'owner'].includes(s.callerId)) throw new Error('callerId is agent or owner'); next.callerId = s.callerId; }
    if (s.amd !== undefined) { if (!['voicemail', 'hangup', 'off'].includes(s.amd)) throw new Error('amd is voicemail, hangup or off'); next.amd = s.amd; }
    if (s.maxMinutes !== undefined) next.maxMinutes = int(s.maxMinutes, 1, 60, 'maxMinutes');
    if (s.maxCallsPerDay !== undefined) next.maxCallsPerDay = int(s.maxCallsPerDay, 0, 100, 'maxCallsPerDay');
    if (s.maxSmsPerDay !== undefined) next.maxSmsPerDay = int(s.maxSmsPerDay, 0, 200, 'maxSmsPerDay');
    if (s.allowTransfer !== undefined) next.allowTransfer = s.allowTransfer === true;
    if (s.quiet) {
      for (const k of ['start', 'end'] as const) if (s.quiet[k] !== undefined) { if (!HM_RE.test(String(s.quiet[k]))) throw new Error(`quiet.${k} must be HH:MM`); next.quiet[k] = String(s.quiet[k]); }
      if (s.quiet.shabbat !== undefined) next.quiet.shabbat = s.quiet.shabbat === true;
    }
    patch.outbound = next;
  }
  updateTelephonyConfig(patch as any);
  return outboundView(Date.now(), base);
}
