// Stage 2 phone (docs/VOICE.md): Twilio Media Streams (μ-law 8 kHz over WebSocket) ↔ the realtime clerk, host-side.
// Same tools, transcript, audit cards and ledger as the in-app call (voice-realtime.ts); audio is relayed, never stored.
import type { IncomingMessage } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { cfg } from './lib/config.js';
import { mulawB64ToPcmB64, pcmB64ToMulawB64 } from './lib/audio-g711.js';
import { providerSecretFields, openaiBase, scrubProviderSecrets } from './voice-providers.js';
import {
  geminiSetup, geminiWsUrl, geminiModel, realtimeModel, realtimeVoice, realtimeSessionConfig, phoneInstructions,
  openHostCall, touchCall, handleClerkTool, addRealtimeTranscript, endRealtimeCall, MAX_CALL_S, type ClerkHost, type Turn,
} from './voice-realtime.js';
import { consumeStreamToken, streamEnded, phoneGate, phoneText, hangupWithMessage, TWILIO_STREAM_PATH, type PhoneHost } from './voice-phone.js';

export const START_TIMEOUT_MS = 10_000; // Twilio sends `start` right after the upgrade
export const CONNECT_TIMEOUT_MS = 15_000; // the provider's socket + setup
export const BUDGET_EVERY_MS = 30_000;
export const OUT_FRAME_BYTES = 4000; // ≈ 0.5 s of μ-law per Twilio media message
const EARLY_FRAMES = 150; // ≈ 3 s of caller audio kept while the provider connects

export interface BackendEvents { audio(mulawB64: string): void; interrupted(): void; tool(c: { callId: string; name: string; args: Record<string, unknown> }): void; turn(t: Turn): void; closed(reason: string): void }
export interface Backend { sendMulaw(b64: string): void; toolResult(c: { callId: string; name: string }, out: Record<string, unknown>): void; close(): void }
export type BackendFactory = (o: { provider: string; token: string; instructions: string; events: BackendEvents }) => Promise<Backend>;

const parse = (d: unknown): Record<string, any> | null => { try { return JSON.parse(typeof d === 'string' ? d : String(d)); } catch { return null; } };
const openSocket = (url: string, headers: Record<string, string>, onMessage: (m: Record<string, any>) => void, onClose: (why: string) => void): Promise<WebSocket> =>
  new Promise((resolve, reject) => {
    const w = new WebSocket(url, { headers });
    let settled = false;
    const t = setTimeout(() => { if (!settled) { settled = true; reject(new Error('provider socket timed out')); try { w.terminate(); } catch { /* ignore */ } } }, CONNECT_TIMEOUT_MS);
    w.on('open', () => { if (!settled) { settled = true; clearTimeout(t); resolve(w); } });
    w.on('message', (d) => { const m = parse(d.toString()); if (m) onMessage(m); });
    w.on('error', (e) => { if (!settled) { settled = true; clearTimeout(t); reject(e); } else onClose(`provider error: ${e.message}`); });
    w.on('close', (code) => { if (!settled) { settled = true; clearTimeout(t); reject(new Error(`provider socket closed (${code})`)); } else onClose(`provider closed (${code})`); });
  });
const sendJson = (w: WebSocket | null, m: unknown): void => { if (w && w.readyState === WebSocket.OPEN) w.send(JSON.stringify(m)); };

// ---- Gemini Live: PCM 16 kHz in / 24 kHz out, transcripts on, BLOCKING tools, interruption by the model's VAD -----------
export async function connectGeminiBackend(o: { token: string; instructions: string; events: BackendEvents }): Promise<Backend> {
  let ready: () => void = () => {};
  let fail: (e: Error) => void = () => {};
  const setup = new Promise<void>((res, rej) => { ready = res; fail = rej; });
  let n = 0;
  let user: Turn | null = null;
  let asst: Turn | null = null;
  const onMsg = (msg: Record<string, any>): void => {
    if (msg.setupComplete) return ready();
    if (msg.toolCall?.functionCalls) for (const fc of msg.toolCall.functionCalls) o.events.tool({ callId: String(fc.id || ''), name: String(fc.name || ''), args: fc.args && typeof fc.args === 'object' ? fc.args : {} });
    const sc = msg.serverContent;
    if (!sc) return;
    if (sc.interrupted) { asst = null; o.events.interrupted(); }
    if (sc.inputTranscription?.text) { if (!user) user = { role: 'user', text: '', id: `u${++n}` }; user.text += sc.inputTranscription.text; o.events.turn({ ...user }); }
    if (sc.outputTranscription?.text) { if (!asst) asst = { role: 'assistant', text: '', id: `a${++n}` }; asst.text += sc.outputTranscription.text; o.events.turn({ ...asst }); }
    for (const p of sc.modelTurn?.parts || []) if (p.inlineData?.data) { user = null; o.events.audio(pcmB64ToMulawB64(String(p.inlineData.data), 24000)); }
    if (sc.turnComplete) { asst = null; user = null; }
  };
  // The host holds the API key, so it uses the plain endpoint; `…Constrained` is for the browser's ephemeral access_token (1007 otherwise).
  const ws = await openSocket(`${geminiWsUrl().replace(/Constrained$/, '')}?key=${encodeURIComponent(o.token)}`, {}, onMsg, (why) => o.events.closed(why));
  sendJson(ws, { setup: geminiSetup({ instructions: o.instructions, lang: cfg.voiceLang }) });
  const t = setTimeout(() => fail(new Error('Gemini setup timed out')), CONNECT_TIMEOUT_MS);
  try { await setup; } finally { clearTimeout(t); }
  return {
    sendMulaw: (b64) => sendJson(ws, { realtimeInput: { audio: { data: mulawB64ToPcmB64(b64, 16000), mimeType: 'audio/pcm;rate=16000' } } }),
    toolResult: ({ callId, name }, out) => sendJson(ws, { toolResponse: { functionResponses: [{ id: callId, name, response: out && out.error ? out : { result: out } }] } }),
    close: () => { try { ws.close(); } catch { /* ignore */ } },
  };
}

// ---- OpenAI Realtime over WebSocket: μ-law both ways (`audio/pcmu`), so no resampling at all --------------------------
export async function connectOpenAIBackend(o: { token: string; instructions: string; events: BackendEvents }): Promise<Backend> {
  const model = realtimeModel();
  let ready: () => void = () => {};
  const updated = new Promise<void>((res) => { ready = res; });
  const onMsg = (ev: Record<string, any>): void => {
    switch (ev.type) {
      case 'session.updated': return ready();
      case 'response.output_audio.delta': return typeof ev.delta === 'string' ? o.events.audio(ev.delta) : undefined;
      case 'input_audio_buffer.speech_started': return o.events.interrupted();
      case 'response.function_call_arguments.done': {
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(ev.arguments || '{}'); } catch { /* bad args → the tool says so */ }
        return o.events.tool({ callId: String(ev.call_id || ''), name: String(ev.name || ''), args });
      }
      case 'conversation.item.input_audio_transcription.completed': return o.events.turn({ role: 'user', text: String(ev.transcript || ''), id: String(ev.item_id || '') });
      case 'response.output_audio_transcript.done': return o.events.turn({ role: 'assistant', text: String(ev.transcript || ''), id: String(ev.item_id || '') });
      case 'error': return console.error('[voice-phone] openai:', scrubProviderSecrets(String(ev.error?.message || 'error'), 'voice:openai'));
    }
  };
  const ws = await openSocket(`${openaiBase().replace(/^http/, 'ws')}/v1/realtime?model=${encodeURIComponent(model)}`, { Authorization: `Bearer ${o.token}` }, onMsg, (why) => o.events.closed(why));
  const session = realtimeSessionConfig({ model, voice: realtimeVoice(), lang: cfg.voiceLang, instructions: o.instructions }) as any;
  session.audio.input.format = { type: 'audio/pcmu' };
  session.audio.output.format = { type: 'audio/pcmu' };
  delete session.model;
  sendJson(ws, { type: 'session.update', session });
  const t = setTimeout(ready, CONNECT_TIMEOUT_MS); // an old server may not echo session.updated; proceed anyway
  try { await updated; } finally { clearTimeout(t); }
  return {
    sendMulaw: (b64) => sendJson(ws, { type: 'input_audio_buffer.append', audio: b64 }),
    toolResult: ({ callId }, out) => { sendJson(ws, { type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(out) } }); sendJson(ws, { type: 'response.create' }); },
    close: () => { try { ws.close(); } catch { /* ignore */ } },
  };
}

export const defaultBackendFactory: BackendFactory = (o) => (o.provider === 'voice:gemini' ? connectGeminiBackend(o) : connectOpenAIBackend(o));

// ---- the bridge ----------------------------------------------------------------------------------------------------------
export interface BridgeOptions { host: ClerkHost & PhoneHost; backendFactory?: BackendFactory; fetchImpl?: typeof fetch; now?: () => number; budgetEveryMs?: number; startTimeoutMs?: number }
interface Conn { callSid: string; streamSid: string; callId: string; sessionId: string; end(reason: string): void }

export function createPhoneBridge(opts: BridgeOptions) {
  const wss = new WebSocketServer({ noServer: true });
  const now = opts.now || Date.now;
  const factory = opts.backendFactory || defaultBackendFactory;
  const conns = new Map<string, Conn>();

  const splitFrames = (b64: string): string[] => {
    const bytes = Buffer.from(b64, 'base64');
    const out: string[] = [];
    for (let i = 0; i < bytes.length; i += OUT_FRAME_BYTES) out.push(bytes.subarray(i, i + OUT_FRAME_BYTES).toString('base64'));
    return out;
  };

  async function attach(ws: WebSocket, req: IncomingMessage): Promise<void> {
    let streamSid = '';
    let conn: Conn | null = null;
    let backend: Backend | null = null;
    let ended = false;
    const early: string[] = [];
    let frames = 0;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const startTimer = setTimeout(() => { if (!conn) { console.log('[voice-phone] stream without start — closed'); try { ws.close(1008, 'no start'); } catch { /* ignore */ } } }, opts.startTimeoutMs ?? START_TIMEOUT_MS);
    const say = (text: string): void => { if (conn) void hangupWithMessage(conn.callSid, text, opts.fetchImpl); };

    const end = (reason: string): void => {
      if (ended) return;
      ended = true;
      clearTimeout(startTimer);
      for (const t of timers) clearInterval(t);
      try { backend?.close(); } catch { /* ignore */ }
      if (conn) {
        conns.delete(conn.callSid);
        const seconds = Math.round((now() - startedAt) / 1000);
        endRealtimeCall({ sessionId: conn.sessionId, callId: conn.callId, seconds, reason }, opts.host, { now });
        streamEnded(conn.callSid, now());
      }
      try { ws.close(); } catch { /* ignore */ }
    };
    let startedAt = now();

    const onStart = async (start: Record<string, any>): Promise<void> => {
      clearTimeout(startTimer);
      const callSid = String(start.callSid || '');
      const token = String(start.customParameters?.token || '');
      const call = consumeStreamToken(callSid, token, now());
      if (!call) {
        console.log(`[voice-phone] stream refused (${callSid ? 'bad or used token' : 'no callSid'})`);
        try { ws.close(1008, 'unauthorized'); } catch { /* ignore */ }
        return;
      }
      const gate = phoneGate();
      if (!gate.ok) { void hangupWithMessage(callSid, phoneText(gate.text), opts.fetchImpl); streamEnded(callSid, now()); try { ws.close(1011, 'gate'); } catch { /* ignore */ } return; }
      const provider = gate.provider;
      const key = providerSecretFields(provider)?.token || '';
      const model = provider === 'voice:gemini' ? geminiModel() : realtimeModel();
      const sessionId = opts.host.voiceHome().id;
      const opened = openHostCall({ sessionId, provider, model, lang: cfg.voiceLang, channel: 'phone', now });
      if ('busy' in opened) { void hangupWithMessage(callSid, phoneText('busy'), opts.fetchImpl); streamEnded(callSid, now()); try { ws.close(1013, 'busy'); } catch { /* ignore */ } return; }
      startedAt = now();
      conn = { callSid, streamSid, callId: opened.callId, sessionId, end };
      conns.set(callSid, conn);
      const events: BackendEvents = {
        audio: (b64) => { for (const f of splitFrames(b64)) sendJson(ws, { event: 'media', streamSid, media: { payload: f } }); },
        interrupted: () => sendJson(ws, { event: 'clear', streamSid }),
        tool: async (c) => {
          const r = await handleClerkTool({ sessionId, callId: opened.callId, name: c.name, args: c.args }, opts.host, { now });
          const body = r.body as Record<string, unknown>;
          backend?.toolResult(c, body.ok ? (body.result as Record<string, unknown>) : { error: String(body.error || 'tool failed') });
        },
        turn: (t) => { addRealtimeTranscript({ sessionId, callId: opened.callId, turns: [t] }, { now }); },
        closed: (why) => { console.log(`[voice-phone] ${callSid}: ${why}`); end('provider-closed'); },
      };
      try {
        backend = await factory({ provider, token: key, instructions: phoneInstructions(opts.host.listAgents?.() || null), events });
      } catch (e) {
        console.error('[voice-phone] provider connect failed:', scrubProviderSecrets((e as Error).message, provider));
        say(phoneText('noProvider'));
        end('provider-failed');
        return;
      }
      if (ended) { backend.close(); return; }
      for (const f of early.splice(0)) backend.sendMulaw(f);
      // kill-switch / caps flip mid-call → one sentence, hang up; the clerk's own cap ends it too
      const watchdog = setInterval(() => {
        const g = phoneGate();
        if (!g.ok) { say(phoneText(g.text)); end(g.text === 'off' ? 'kill-switch' : 'budget'); return; }
        if ((now() - startedAt) / 1000 >= MAX_CALL_S) { say(phoneText('bye')); end('max-duration'); }
      }, opts.budgetEveryMs ?? BUDGET_EVERY_MS);
      watchdog.unref?.();
      timers.push(watchdog);
      console.log(`[voice-phone] ${callSid} bridged to ${provider} (${model})`);
    };

    ws.on('message', (data) => {
      const m = parse(data.toString());
      if (!m) return;
      switch (m.event) {
        case 'start': streamSid = String(m.streamSid || m.start?.streamSid || ''); void onStart(m.start || {}); return;
        case 'media': {
          const payload = String(m.media?.payload || '');
          if (!payload || m.media?.track === 'outbound') return;
          if (backend) { backend.sendMulaw(payload); if (conn && ++frames % 50 === 0) touchCall(conn.callId, now); }
          else if (early.length < EARLY_FRAMES) early.push(payload);
          return;
        }
        case 'stop': end('hangup'); return;
        default: return; // connected / mark / dtmf
      }
    });
    ws.on('close', () => end('hangup'));
    ws.on('error', (e) => { console.error('[voice-phone] stream socket:', e.message); end('socket-error'); });
    void req;
  }

  return {
    path: TWILIO_STREAM_PATH,
    handleUpgrade(req: IncomingMessage, socket: any, head: Buffer): void {
      wss.handleUpgrade(req, socket, head, (ws) => { void attach(ws, req); });
    },
    /** Twilio's status callback said the call ended → drop the bridge too. */
    closeCall(callSid: string): boolean { const c = conns.get(callSid); if (!c) return false; c.end('status'); return true; },
    live: (): number => conns.size,
    close(): void { for (const c of [...conns.values()]) c.end('shutdown'); wss.close(); },
  };
}
export type PhoneBridge = ReturnType<typeof createPhoneBridge>;
