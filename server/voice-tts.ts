// TTS for the in-app voice MVP (docs/VOICE.md): one sentence in → the vendor's audio stream out; the key stays here.
import type { ServerResponse } from 'node:http';
import { cfg } from './lib/config.js';
import { requireVoiceProvider, providerSecretFields, VOICE_PROVIDERS, isVoiceProviderId, type VoiceRequirement } from './voice-providers.js';
import { recordVoiceUsage } from './voice-usage.js';

export const TTS_MAX_CHARS = 1200;
export const TTS_MAX_INFLIGHT = 2; // per session: the client keeps 1–2 sentences in flight
const HEADERS_TIMEOUT_MS = 30_000;

// Vendor defaults; config.voice.tts.{voice,model}[providerId] overrides (Hebrew needs the v3/v4 families; eleven_v4_turbo is the low-latency pick, flash/multilingual_v2 have no Hebrew).
const DEFAULT_VOICE: Record<string, string> = { 'voice:elevenlabs': '21m00Tcm4TlvDq8ikWAM', 'voice:cartesia': 'a0e99841-438c-4a64-b679-ae501e7d6091', 'voice:openai': 'alloy' };
const DEFAULT_MODEL: Record<string, string> = { 'voice:elevenlabs': 'eleven_v3', 'voice:cartesia': 'sonic-3', 'voice:openai': 'gpt-4o-mini-tts' };
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const LANG_RE = /^[a-z]{2,3}$/;

export type TtsResult =
  | { kind: 'json'; status: number; body: Record<string, unknown> | VoiceRequirement }
  | { kind: 'stream'; provider: string; contentType: string; stream: ReadableStream<Uint8Array>; release: () => void; abort: () => void };

const inflight = new Map<string, number>();
export const inflightFor = (key: string): number => inflight.get(key) || 0;

interface VendorRequest { url: string; headers: Record<string, string>; body: Record<string, unknown>; contentType: string }
export function vendorRequest(provider: string, text: string, opts: { voice?: string; lang?: string } = {}): VendorRequest {
  if (!isVoiceProviderId(provider)) throw new Error(`no TTS driver for ${provider}`);
  const s = providerSecretFields(provider);
  if (!s?.token) throw new Error(`no key stored for ${VOICE_PROVIDERS[provider].title}`);
  const voice = (opts.voice && ID_RE.test(opts.voice) ? opts.voice : cfg.voice?.tts?.voice?.[provider]) || DEFAULT_VOICE[provider];
  const model = cfg.voice?.tts?.model?.[provider] || DEFAULT_MODEL[provider];
  const lang = opts.lang && LANG_RE.test(opts.lang) ? opts.lang : undefined;
  switch (provider) {
    case 'voice:elevenlabs':
      return {
        url: `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}/stream?output_format=mp3_44100_128`,
        headers: { 'xi-api-key': s.token, 'content-type': 'application/json', accept: 'audio/mpeg' },
        body: { text, model_id: model, ...(lang && !/multilingual_v2/.test(model) ? { language_code: lang } : {}) }, // docs: language_code is not supported for multilingual_v2; others ignore it when unsupported
        contentType: 'audio/mpeg',
      };
    case 'voice:cartesia':
      return {
        url: 'https://api.cartesia.ai/tts/bytes',
        headers: { 'X-API-Key': s.token, 'Cartesia-Version': '2025-04-16', 'content-type': 'application/json' },
        body: { model_id: model, transcript: text, voice: { mode: 'id', id: voice }, output_format: { container: 'mp3', bit_rate: 128000, sample_rate: 44100 }, ...(lang ? { language: lang } : {}) },
        contentType: 'audio/mpeg',
      };
    case 'voice:openai':
      return {
        url: 'https://api.openai.com/v1/audio/speech',
        headers: { Authorization: `Bearer ${s.token}`, 'content-type': 'application/json' },
        body: { model, input: text, voice, response_format: 'mp3' },
        contentType: 'audio/mpeg',
      };
    default:
      throw new Error(`no TTS driver for ${provider}`);
  }
}

const scrub = (msg: string, provider: string): string => {
  const s = isVoiceProviderId(provider) ? providerSecretFields(provider) : null;
  return Object.values(s || {}).reduce((m, v) => (v && v.length >= 8 ? m.split(v).join('•••') : m), msg);
};

/** POST /__api/voice/tts {sessionId, text, voice?, lang?} → the gate's shape, an error, or the audio stream. */
export async function handleTts(body: Record<string, unknown>, opts: { fetchImpl?: typeof fetch } = {}): Promise<TtsResult> {
  const text = String(body?.text ?? '').trim();
  if (!text) return { kind: 'json', status: 400, body: { error: 'text required' } };
  if (text.length > TTS_MAX_CHARS) return { kind: 'json', status: 400, body: { error: `text too long (max ${TTS_MAX_CHARS} chars)` } };
  const key = typeof body?.sessionId === 'string' && ID_RE.test(body.sessionId) ? body.sessionId : 'default';
  const gate = requireVoiceProvider('tts', 'speak the answer aloud');
  if (!('ok' in gate) || !gate.ok) return { kind: 'json', status: 200, body: gate };
  if (inflightFor(key) >= TTS_MAX_INFLIGHT) return { kind: 'json', status: 429, body: { error: 'busy: too many sentences in flight for this session' } };
  const provider = gate.provider;
  let req: VendorRequest;
  try {
    req = vendorRequest(provider, text, { voice: typeof body?.voice === 'string' ? body.voice : undefined, lang: typeof body?.lang === 'string' ? body.lang : undefined });
  } catch (e) {
    return { kind: 'json', status: 502, body: { error: scrub((e as Error).message, provider) } };
  }
  inflight.set(key, inflightFor(key) + 1);
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    const n = inflightFor(key) - 1;
    if (n > 0) inflight.set(key, n);
    else inflight.delete(key);
  };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new Error('vendor did not answer in time')), HEADERS_TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const f = opts.fetchImpl || fetch;
    const res = await f(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body), signal: ctl.signal });
    clearTimeout(timer);
    if (!res.ok || !res.body) {
      let detail = '';
      try { detail = (await res.text()).slice(0, 300); } catch { /* no body */ }
      release();
      const title = isVoiceProviderId(provider) ? VOICE_PROVIDERS[provider].title : provider;
      console.error(`[voice-tts] ${provider} answered ${res.status} after ${Date.now() - t0}ms`);
      return { kind: 'json', status: 502, body: { error: scrub(`${title} answered ${res.status}${detail ? `: ${detail}` : ''}`, provider) } };
    }
    recordVoiceUsage(provider, { chars: text.length });
    console.log(`[voice-tts] ${provider} ${text.length} chars, first byte in ${Date.now() - t0}ms`);
    return { kind: 'stream', provider, contentType: res.headers.get('content-type') || req.contentType, stream: res.body, release, abort: () => ctl.abort() };
  } catch (e) {
    clearTimeout(timer);
    release();
    const msg = scrub((e as Error)?.message || String(e), provider);
    console.error(`[voice-tts] ${provider} failed: ${msg}`);
    return { kind: 'json', status: 502, body: { error: msg } };
  }
}

/** Pipe the vendor stream to the HTTP response; a client that goes away aborts the vendor call. */
export async function pipeTts(r: Extract<TtsResult, { kind: 'stream' }>, res: ServerResponse): Promise<void> {
  res.writeHead(200, { 'content-type': r.contentType, 'cache-control': 'no-store', 'x-voice-provider': r.provider });
  res.on('close', () => { if (!res.writableFinished) r.abort(); });
  const reader = r.stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value?.length && !res.write(value)) await new Promise<void>((ok) => res.once('drain', ok));
    }
  } catch { /* aborted or vendor hiccup mid-stream: end what we have */ }
  finally {
    r.release();
    try { reader.releaseLock(); } catch { /* ignore */ }
    if (!res.writableEnded) res.end();
  }
}
