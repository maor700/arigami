// OpenAI Realtime transport (stage 1c): WebRTC — mic track up, the clerk's audio down, events + tools on the 'oai-events' data channel.
// The model's own server VAD handles barge-in. Returns the connection the call module drives; hooks report phases, turns, tools.
export async function connectOpenAI({ mint, deps, hooks }) {
  if (!deps.RTCPeerConnection) throw new Error('no WebRTC in this browser');
  const pc = new deps.RTCPeerConnection();
  const audio = deps.audio();
  let connected = false;
  let closed = false;
  let stream = null;
  let dc = null;
  const close = () => {
    if (closed) return;
    closed = true;
    try { dc?.close?.(); } catch { /* ignore */ }
    try { for (const tr of stream?.getTracks?.() || []) tr.stop?.(); } catch { /* ignore */ }
    try { pc.close?.(); } catch { /* ignore */ }
    try { audio.srcObject = null; audio.pause?.(); } catch { /* ignore */ }
  };
  const send = (msg) => { if (dc && (dc.readyState === 'open' || dc.readyState === undefined)) dc.send(JSON.stringify(msg)); };
  const onEvent = (ev) => {
    if (closed || !ev || typeof ev.type !== 'string') return;
    switch (ev.type) {
      case 'input_audio_buffer.speech_started': return hooks.phase('listening');
      case 'output_audio_buffer.started': return hooks.phase('speaking');
      case 'output_audio_buffer.stopped':
      case 'output_audio_buffer.cleared': return hooks.phase('listening', 'speaking');
      case 'conversation.item.input_audio_transcription.completed': return hooks.turn({ role: 'user', text: ev.transcript, id: ev.item_id });
      case 'response.output_audio_transcript.done': return hooks.turn({ role: 'assistant', text: ev.transcript, id: ev.item_id });
      case 'response.function_call_arguments.done': {
        let args = {};
        try { args = ev.arguments ? JSON.parse(ev.arguments) : {}; } catch { args = {}; }
        return hooks.tool({ callId: ev.call_id, name: String(ev.name || ''), args });
      }
      case 'error': return hooks.error(String(ev.error?.message || 'error'));
      default:
    }
  };
  try {
    pc.ontrack = (e) => { try { audio.srcObject = e.streams?.[0] || null; audio.play?.()?.catch?.(() => {}); } catch { /* ignore */ } };
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === 'connected') { connected = true; return; }
      if ((s === 'failed' || s === 'closed' || s === 'disconnected') && !closed) hooks.lost(connected);
    };
    stream = await deps.getUserMedia({ audio: true });
    for (const tr of stream.getTracks?.() || []) pc.addTrack(tr, stream);
    dc = pc.createDataChannel('oai-events');
    dc.onmessage = (e) => { try { onEvent(JSON.parse(e.data)); } catch { /* not JSON */ } };
    dc.onopen = () => { if (!closed) hooks.phase('listening'); };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const res = await deps.fetchImpl(mint.callsUrl, { method: 'POST', body: offer.sdp, headers: { Authorization: `Bearer ${mint.clientSecret}`, 'Content-Type': 'application/sdp' } });
    if (!res.ok) throw new Error(`SDP answer ${res.status}`);
    await pc.setRemoteDescription({ type: 'answer', sdp: await res.text() });
  } catch (e) {
    close();
    throw e;
  }
  return {
    kind: 'openai-webrtc',
    onEvent,
    mute(v) { for (const tr of stream?.getTracks?.() || []) tr.enabled = !v; },
    toolResult({ callId }, out) {
      send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(out) } });
      send({ type: 'response.create' });
    },
    close,
  };
}
