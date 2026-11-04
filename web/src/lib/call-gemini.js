// Gemini Live transport (stage 1c): one WebSocket with an ephemeral token — 16 kHz PCM up, 24 kHz PCM down, the host-built
// `setup` first. `interrupted` is the model's own barge-in; a goAway / dropped socket is resumed with the session handle.
import { openMicPcm as defaultMic, pcmPlayer as defaultPlayer } from './pcm.js';

export const GEMINI_RECONNECTS = 3;
const IN_MIME = 'audio/pcm;rate=16000';

export async function connectGemini({ mint, deps, hooks }) {
  if (!deps.WebSocket || !deps.AudioContext) throw new Error('no WebSocket/AudioContext in this browser');
  const ctx = new deps.AudioContext();
  try { await ctx.resume?.(); } catch { /* fine */ }
  const stream = await deps.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  const player = (deps.pcmPlayer || defaultPlayer)(ctx, 24000);
  let ws = null;
  let mic = null;
  let closed = false;
  let handle = '';
  let reconnects = 0;
  let n = 0;
  let user = null; // { id, text } of the turn being transcribed
  let asst = null;

  const parseText = (t) => { try { return JSON.parse(t); } catch { return null; } };
  // A text frame is handled on the spot; a Blob/ArrayBuffer frame (what browsers get from Live) is decoded first.
  const parse = (d, fn) => {
    if (typeof d === 'string') return fn(parseText(d));
    if (typeof d?.text === 'function') return d.text().then((t) => fn(parseText(t)), () => fn(null));
    try { return fn(parseText(new TextDecoder().decode(d))); } catch { return fn(null); }
  };
  const send = (msg) => { if (ws && (ws.readyState === 1 || ws.readyState === undefined)) ws.send(JSON.stringify(msg)); };
  const endAsst = () => { asst = null; };
  const endUser = () => { user = null; };

  function onMsg(msg) {
    const ru = msg.sessionResumptionUpdate;
    if (ru?.resumable && ru.newHandle) handle = ru.newHandle;
    if (msg.toolCall?.functionCalls) for (const fc of msg.toolCall.functionCalls) hooks.tool({ callId: fc.id, name: String(fc.name || ''), args: fc.args && typeof fc.args === 'object' ? fc.args : {} });
    const sc = msg.serverContent;
    if (!sc) return;
    if (sc.interrupted) { player.stop(); endAsst(); hooks.phase('listening'); }
    if (sc.inputTranscription?.text) {
      if (!user) user = { id: `u${++n}`, text: '' };
      user.text += sc.inputTranscription.text;
      hooks.turn({ role: 'user', text: user.text, id: user.id });
    }
    if (sc.outputTranscription?.text) {
      if (!asst) asst = { id: `a${++n}`, text: '' };
      asst.text += sc.outputTranscription.text;
      hooks.turn({ role: 'assistant', text: asst.text, id: asst.id });
    }
    for (const p of sc.modelTurn?.parts || []) {
      if (!p.inlineData?.data) continue;
      endUser(); // the model answers → the next words from the person are a new turn
      player.play(p.inlineData.data);
      hooks.phase('speaking');
    }
    if (sc.turnComplete) { endAsst(); endUser(); if (!player.playing) hooks.phase('listening', 'speaking'); }
  }

  const open = (resume) => new Promise((resolve, reject) => {
    const w = new deps.WebSocket(`${mint.wsUrl}?access_token=${encodeURIComponent(mint.token)}`);
    let settled = false;
    w.onopen = () => w.send(JSON.stringify({ setup: { ...mint.setup, ...(resume && handle ? { sessionResumption: { handle } } : {}) } }));
    w.onmessage = (e) => parse(e.data, (msg) => {
      if (!msg) return;
      if (msg.setupComplete) { if (!settled) { settled = true; resolve(w); } return; }
      if (ws === w || !settled) onMsg(msg);
    });
    w.onerror = () => { if (!settled) { settled = true; reject(new Error('Live socket failed')); } };
    w.onclose = (ev) => {
      if (!settled) { settled = true; reject(new Error(`Live socket closed${ev?.code ? ` (${ev.code})` : ''}`)); return; }
      if (closed || ws !== w) return;
      lost();
    };
  });
  async function lost() {
    if (closed) return;
    while (handle && reconnects < GEMINI_RECONNECTS) {
      reconnects++;
      hooks.phase('connecting');
      try { ws = await open(true); hooks.phase('listening'); return; } catch { /* next try */ }
    }
    hooks.lost(true);
  }
  player.onIdle = (idle) => { if (idle && !closed) hooks.phase('listening', 'speaking'); };

  const close = () => {
    if (closed) return;
    closed = true;
    try { mic?.stop(); } catch { /* ignore */ }
    try { player.stop(); } catch { /* ignore */ }
    try { ws?.close(); } catch { /* ignore */ }
    try { for (const tr of stream.getTracks?.() || []) tr.stop?.(); } catch { /* ignore */ }
    try { ctx.close?.()?.catch?.(() => {}); } catch { /* ignore */ }
  };
  try {
    ws = await open(false);
    mic = await (deps.openMicPcm || defaultMic)({ ctx, stream, onChunk: (b64) => send({ realtimeInput: { audio: { data: b64, mimeType: IN_MIME } } }) });
    hooks.phase('listening');
  } catch (e) {
    close();
    throw e;
  }
  return {
    kind: 'gemini-ws',
    onMessage: onMsg,
    mute(v) { mic?.mute(!!v); },
    toolResult({ callId, name }, out) { send({ toolResponse: { functionResponses: [{ id: callId, name, response: out && out.error ? out : { result: out } }] } }); },
    close,
  };
}
