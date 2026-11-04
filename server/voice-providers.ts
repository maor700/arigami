// Voice & phone providers (docs/VOICE.md): specs, host-side keys, one cheap auth check each, gating for later stages.
import fs from 'node:fs';
import path from 'node:path';
import { ARIGAMI_DIR } from './lib/instance.js';
import { cfg } from './lib/config.js';
import { voiceBudgetState } from './voice-usage.js';

export type VoiceKind = 'stt' | 'tts' | 'realtime' | 'telephony';
export const VOICE_PROVIDER_IDS = ['voice:openai', 'voice:elevenlabs', 'voice:cartesia', 'voice:deepgram', 'telephony:twilio'] as const;
export type VoiceProviderId = (typeof VOICE_PROVIDER_IDS)[number];
export const isVoiceProviderId = (id: unknown): id is VoiceProviderId => typeof id === 'string' && (VOICE_PROVIDER_IDS as readonly string[]).includes(id);

export interface Field {
  name: string;
  label: string;
  secret?: boolean;
  placeholder?: string;
}
export interface VoiceProviderSpec {
  id: VoiceProviderId;
  title: string;
  kinds: VoiceKind[];
  fields: Field[];
  help: string;
  docs: string;
}

export const VOICE_PROVIDERS: Record<VoiceProviderId, VoiceProviderSpec> = {
  'voice:openai': { id: 'voice:openai', title: 'OpenAI (voice)', kinds: ['stt', 'tts', 'realtime'], fields: [{ name: 'token', label: 'OpenAI API key', secret: true, placeholder: 'sk-…' }], help: 'An OpenAI API key with Realtime / audio access. Stored on this host only.', docs: 'https://platform.openai.com/api-keys' },
  'voice:elevenlabs': { id: 'voice:elevenlabs', title: 'ElevenLabs', kinds: ['tts'], fields: [{ name: 'token', label: 'ElevenLabs API key', secret: true, placeholder: 'xi-…' }], help: 'Text-to-speech (Hebrew supported). Stored on this host only.', docs: 'https://elevenlabs.io/app/settings/api-keys' },
  'voice:cartesia': { id: 'voice:cartesia', title: 'Cartesia', kinds: ['tts'], fields: [{ name: 'token', label: 'Cartesia API key', secret: true, placeholder: 'sk_car_…' }], help: 'Text-to-speech, streaming. Stored on this host only.', docs: 'https://play.cartesia.ai/keys' },
  'voice:deepgram': { id: 'voice:deepgram', title: 'Deepgram', kinds: ['stt'], fields: [{ name: 'token', label: 'Deepgram API key', secret: true }], help: 'Speech-to-text (Nova-3). Stored on this host only.', docs: 'https://console.deepgram.com/' },
  'telephony:twilio': { id: 'telephony:twilio', title: 'Twilio (phone)', kinds: ['telephony'], fields: [{ name: 'sid', label: 'Account SID', placeholder: 'AC…' }, { name: 'token', label: 'Auth Token', secret: true }], help: 'Phone numbers and calls. Both values are on the Twilio console home page; stored on this host only.', docs: 'https://console.twilio.com/' },
};

// The provider a needs_setup names when none serves a kind (PLAN.md), and the try-order among connected ones.
export const RECOMMENDED: Record<VoiceKind, VoiceProviderId> = { stt: 'voice:deepgram', tts: 'voice:elevenlabs', realtime: 'voice:openai', telephony: 'telephony:twilio' };
const ORDER: Record<VoiceKind, string[]> = {
  stt: ['groq', 'voice:deepgram', 'voice:openai'],
  tts: ['voice:elevenlabs', 'voice:cartesia', 'voice:openai'],
  realtime: ['voice:openai'],
  telephony: ['telephony:twilio'],
};

// ---- keys: $ARIGAMI_DIR/voice-providers.json (0600), never read by the agent or the browser ----
export const SECRETS_FILE = path.join(ARIGAMI_DIR, 'voice-providers.json');
type Secrets = Record<string, Record<string, string>>;
function readSecrets(): Secrets {
  try {
    const j = JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  } catch {
    return {};
  }
}
function writeSecrets(s: Secrets): void {
  fs.mkdirSync(path.dirname(SECRETS_FILE), { recursive: true });
  fs.writeFileSync(SECRETS_FILE, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
  try {
    fs.chmodSync(SECRETS_FILE, 0o600);
  } catch {
    /* ignore */
  }
}
export const hasProviderSecret = (id: string): boolean => !!readSecrets()[id];
/** Host-side only (voice-tts.ts): the stored fields of one provider; never serialised to the agent or the browser. */
export const providerSecretFields = (id: string): Record<string, string> | null => readSecrets()[id] || null;

export function setProviderSecret(id: string, fields: Record<string, unknown>): void {
  if (!isVoiceProviderId(id)) throw new Error(`unknown voice provider: ${id}`);
  const rec: Record<string, string> = {};
  for (const f of VOICE_PROVIDERS[id].fields) {
    const v = String(fields?.[f.name] ?? '').trim();
    if (!/^[\x21-\x7e]{8,512}$/.test(v)) throw new Error(`${f.label} is missing or does not look right`);
    rec[f.name] = v;
  }
  rec.at = new Date().toISOString();
  const s = readSecrets();
  s[id] = rec;
  writeSecrets(s);
  checkCache.delete(id);
}
export function clearProviderSecret(id: string): boolean {
  const s = readSecrets();
  if (!s[id]) return false;
  delete s[id];
  writeSecrets(s);
  checkCache.delete(id);
  return true;
}

// ---- check: one cheap authenticated call, short timeout, the key never in a message ----
export interface ProviderCheck {
  ok: boolean;
  detail: string;
  data?: Record<string, unknown>;
}
const CHECK_TTL_MS = 60_000;
const CHECK_TIMEOUT_MS = 6_000;
const checkCache = new Map<string, { at: number; r: ProviderCheck }>();
export const invalidateVoiceChecks = (): void => checkCache.clear();

/** OpenAI's API base; `config.voice.realtime.baseUrl` / ARIGAMI_OPENAI_API_BASE point it at a stand-in (tests). */
export const openaiBase = (): string => String(cfg.voice?.realtime?.baseUrl || process.env.ARIGAMI_OPENAI_API_BASE || 'https://api.openai.com').replace(/\/+$/, '');
const basic = (sid: string, token: string): string => `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`;
function probeRequest(id: VoiceProviderId, s: Record<string, string>): { url: string; headers: Record<string, string> } {
  switch (id) {
    case 'voice:openai': return { url: `${openaiBase()}/v1/models`, headers: { Authorization: `Bearer ${s.token}` } };
    case 'voice:elevenlabs': return { url: 'https://api.elevenlabs.io/v1/user', headers: { 'xi-api-key': s.token } };
    case 'voice:cartesia': return { url: 'https://api.cartesia.ai/voices', headers: { 'X-API-Key': s.token, 'Cartesia-Version': '2025-04-16' } };
    case 'voice:deepgram': return { url: 'https://api.deepgram.com/v1/projects', headers: { Authorization: `Token ${s.token}` } };
    case 'telephony:twilio': return { url: `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(s.sid)}.json`, headers: { Authorization: basic(s.sid, s.token) } };
  }
}
const scrub = (msg: string, s: Record<string, string>): string => Object.values(s).reduce((m, v) => (v && v.length >= 8 ? m.split(v).join('•••') : m), msg);
/** A message with every stored field of `id` blanked (for logs and error bodies). */
export const scrubProviderSecrets = (msg: string, id: string): string => scrub(msg, (isVoiceProviderId(id) && providerSecretFields(id)) || {});

export const voiceEnabled = (): boolean => cfg.voice?.enabled !== false;
const offDetail = 'voice is switched off (Settings → Connections → Voice & phone)';

export async function checkProvider(id: string, opts: { fetchImpl?: typeof fetch; fresh?: boolean } = {}): Promise<ProviderCheck> {
  if (!isVoiceProviderId(id)) return { ok: false, detail: `unknown voice provider ${id}` };
  const spec = VOICE_PROVIDERS[id];
  const s = readSecrets()[id];
  if (!s) return { ok: false, detail: `paste a key for ${spec.title}`, data: { hasKey: false, kinds: spec.kinds, docs: spec.docs } };
  if (!voiceEnabled()) return { ok: false, detail: offDetail, data: { hasKey: true, disabled: true, kinds: spec.kinds } };
  const hit = checkCache.get(id);
  if (hit && !opts.fresh && Date.now() - hit.at < CHECK_TTL_MS) return hit.r;
  const f = opts.fetchImpl || fetch;
  const { url, headers } = probeRequest(id, s);
  let r: ProviderCheck;
  try {
    const res = await f(url, { headers, signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
    if (res.ok) r = { ok: true, detail: 'connected', data: { hasKey: true, kinds: spec.kinds, at: s.at } };
    else if (res.status === 401 || res.status === 403) r = { ok: false, detail: `${spec.title} rejected the key (${res.status}) — paste a new one`, data: { hasKey: true, rejected: true, kinds: spec.kinds, docs: spec.docs } };
    else r = { ok: false, detail: `${spec.title} answered ${res.status}`, data: { hasKey: true, kinds: spec.kinds } };
  } catch (e) {
    const timeout = (e as Error)?.name === 'TimeoutError';
    r = { ok: false, detail: scrub(timeout ? `${spec.title} did not answer in ${CHECK_TIMEOUT_MS / 1000}s` : `could not reach ${spec.title}: ${(e as Error)?.message || e}`, s), data: { hasKey: true, unreachable: true, kinds: spec.kinds } };
  }
  checkCache.set(id, { at: Date.now(), r });
  return r;
}

/** Offline answer for doctor / tests: a stored key counts, nothing is called. */
export function checkProviderOffline(id: string): ProviderCheck {
  if (!isVoiceProviderId(id)) return { ok: false, detail: `unknown voice provider ${id}` };
  const spec = VOICE_PROVIDERS[id];
  if (!hasProviderSecret(id)) return { ok: false, detail: `paste a key for ${spec.title}`, data: { hasKey: false, kinds: spec.kinds } };
  if (!voiceEnabled()) return { ok: false, detail: offDetail, data: { hasKey: true, disabled: true, kinds: spec.kinds } };
  return { ok: true, detail: 'key stored (not verified)', data: { hasKey: true, kinds: spec.kinds } };
}

/** POST /__api/setup/<id> {token} or {sid, token}: store, verify once, drop the key again if the provider rejects it. */
export async function connectProvider(id: string, body: Record<string, unknown>, fetchImpl?: typeof fetch): Promise<{ ok: true; detail: string }> {
  setProviderSecret(id, body);
  const r = await checkProvider(id, { fetchImpl, fresh: true });
  if (!r.ok) {
    clearProviderSecret(id);
    throw new Error(r.detail);
  }
  return { ok: true, detail: r.detail };
}

// ---- gating (offline reads only) ----
const groqKey = (): boolean => !!(cfg.groqApiKey || process.env.GROQ_API_KEY);
/** Key stored, layer on, and the last check (if any) did not reject it. */
export function providerConnected(id: string): boolean {
  if (!voiceEnabled()) return false;
  if (id === 'groq') return groqKey();
  if (!isVoiceProviderId(id) || !hasProviderSecret(id)) return false;
  const hit = checkCache.get(id);
  return !(hit && Date.now() - hit.at < CHECK_TTL_MS && !hit.r.ok);
}

export interface VoiceSummary {
  enabled: boolean;
  stt: string[];
  tts: string[];
  realtime: string[];
  telephony: boolean;
}
/** What the UI may gate on (GET /__api/config.voiceProviders): connected provider ids per kind; 'groq' is today's STT. */
export function voiceProviders(): VoiceSummary {
  const by = (k: VoiceKind): string[] => ORDER[k].filter(providerConnected);
  return { enabled: voiceEnabled(), stt: by('stt'), tts: by('tts'), realtime: by('realtime'), telephony: providerConnected('telephony:twilio') };
}
export const telephonyConnected = (): boolean => providerConnected('telephony:twilio');

export type VoiceRequirement =
  | { ok: true; provider: string; kind: VoiceKind }
  | { ok: false; disabled: true; why: string }
  | { ok: false; budget: 'soft-stopped'; provider: string; why: string }
  | { needs_setup: string; why: string; hint: string };

/** The one gate a voice tool calls first: a provider to use, or the shape to return as-is. */
export function requireVoiceProvider(kind: VoiceKind, why?: string): VoiceRequirement {
  const reason = why || `${kind === 'telephony' ? 'place or take phone calls' : kind === 'tts' ? 'speak the answer aloud' : kind === 'stt' ? 'transcribe speech' : 'hold a live voice conversation'}`;
  if (!voiceEnabled()) return { ok: false, disabled: true, why: offDetail };
  const connected = ORDER[kind].filter(providerConnected);
  if (!connected.length) {
    const rec = RECOMMENDED[kind];
    return { needs_setup: rec, why: reason, hint: `call request_setup({capability:"${rec}", why}) — any ${kind} provider works; the human can connect a different one in Settings → Connections → Voice & phone` };
  }
  const usable = connected.find((p) => voiceBudgetState(p) === 'ok');
  if (!usable) return { ok: false, budget: 'soft-stopped', provider: connected[0], why: `this month's cap for ${connected[0]} is reached — answer in text instead` };
  return { ok: true, provider: usable, kind };
}
