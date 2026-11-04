# Voice & phone — the optional provider layer

Everything voice-related in Arigami stands on providers the owner connects by pasting a key. With no provider
connected nothing changes: no banner, no button, no tab. The providers only appear inside Settings → Connections →
"Add connection", under **Voice & phone**.

## Capabilities (`server/capabilities.ts`, specs in `server/voice-providers.ts`)

| id | serves | key field(s) | `check()` |
|---|---|---|---|
| `voice:openai` | stt, tts, realtime | API key | `GET /v1/models` |
| `voice:gemini` | realtime (Live API) | API key (AI Studio) | `GET /v1beta/models?pageSize=1` |
| `voice:elevenlabs` | tts | API key | `GET /v1/user` |
| `voice:cartesia` | tts | API key | `GET /voices` (+ `Cartesia-Version`) |
| `voice:deepgram` | stt | API key | `GET /v1/projects` |
| `telephony:twilio` | telephony | Account SID + Auth Token | `GET /2010-04-01/Accounts/{sid}.json` |

`manual.kind` is `token`; Twilio's two fields render as two inputs (`TokenStep.jsx`). `POST /__api/setup/<id>` with
`{token}` or `{sid, token}` stores the key in `$ARIGAMI_DIR/voice-providers.json` (0600), verifies it once, and drops
it again if the vendor rejects it. `DELETE /__api/setup/<id>` removes it. The key never reaches the agent, the browser,
`config.json`, a log line or an error message. `check()` is cached 60 s; `bin/host doctor` answers offline.
Today's STT (Groq via `groqApiKey`, `server/voice.js`) is untouched and reported as the `groq` provider.

## Gating (`server/voice-providers.ts`)

- `voiceProviders()` → `{enabled, stt[], tts[], realtime[], telephony}` — connected provider ids per kind. The same
  object rides on `GET /__api/config` as `voiceProviders` (the web already polls it; no new polling).
- `telephonyConnected()` → boolean.
- `requireVoiceProvider(kind, why?)`, `kind` = `'stt' | 'tts' | 'realtime' | 'telephony'`, the first call of every
  voice tool. It returns one of:
  - `{ok:true, provider, kind}` — use it (`provider` is a capability id or `'groq'`).
  - `{needs_setup, why, hint}` — nothing serves the kind; pass it through untouched and the host shows the Setup card.
    `needs_setup` names the recommended provider (tts → `voice:elevenlabs`, realtime → `voice:openai`,
    stt → `voice:deepgram`, telephony → `telephony:twilio`); the human may connect another one in Settings.
  - `{ok:false, disabled:true, why}` — the kill-switch is off.
  - `{ok:false, budget:'soft-stopped', provider, why}` — every connected provider for the kind reached its cap;
    answer in text.

"Connected" is an offline read: a stored key, the layer on, and no fresh (≤60 s) rejection from the vendor.

## Cost protection (`server/voice-usage.ts`, `config.voice`)

- `recordVoiceUsage(provider, {seconds?, chars?, usd?, inbound?})` adds to this month's counter in
  `$ARIGAMI_DIR/voice-usage.json` (counters only grow). `usd` wins when the caller knows it; otherwise it is
  estimated from the PLAN.md prices (one constant per provider in the file).
- `voiceBudgetState(provider)` → `'ok' | 'soft-stopped'`; never throws. Caps live in `config.voice.caps[<id>]`
  (USD per month, absent = no cap). `requireVoiceProvider` skips a soft-stopped provider.
- Kill-switch: `config.voice.enabled` (default `true`). Off → every provider reads as not connected, the summary is
  empty, `requireVoiceProvider` returns `{disabled:true}`.
- `GET/POST /__api/voice/budget` (POST is admin): `{enabled?, caps?}` in, `{enabled, caps, month, usage, providers}`
  out. Settings → Connections → Voice & phone shows the switch, the caps and this month's usage, and exists only
  while at least one voice/telephony provider holds a key.

## For stage 1b / 1c

Call `requireVoiceProvider(kind)` first and return its non-ok shapes as the tool result; call
`recordVoiceUsage(provider, …)` after each vendor call. Nothing else is needed for the Setup card.

## Stage 1b — read-aloud + hands-free (the in-app MVP)

- **Endpoint** `POST /__api/voice/tts {sessionId, text, voice?, lang?}` (`server/voice-tts.ts`): `requireVoiceProvider('tts')` first —
  its non-ok shape comes back as JSON 200 (`{needs_setup}`, `{disabled:true}`, `{budget:'soft-stopped'}`); empty or over-long text
  (> `TTS_MAX_CHARS` = 1200) → 400; a third sentence in flight for one session → 429; a vendor failure → 502 with the key scrubbed.
  Success streams the vendor's audio (chunked `audio/mpeg`, `x-voice-provider`) and records `chars` in the ledger.
- **Drivers**, in the 1a order: ElevenLabs `/v1/text-to-speech/{voice}/stream` (`eleven_v3` — Hebrew lives in the v3/v4 families only; `eleven_v4_turbo` is the ~100 ms pick to set in config once verified on a real key; flash/multilingual_v2 have no Hebrew; `language_code` is sent for every model but multilingual_v2),
  Cartesia `/tts/bytes` (`sonic-3`), OpenAI `/v1/audio/speech` (`gpt-4o-mini-tts`). `config.voice.tts.{voice,model}[<provider id>]`
  overrides the defaults (file only, no UI).
- **Sources + gating** (`web/src/lib/speak.js`): `ttsSource(config, prefs)` = `'server'` when `config.voiceProviders.tts` is non-empty,
  else `'browser'` when the person switched on *Browser voice (free)* (speechSynthesis — quality varies in Hebrew), else `null`; the
  kill-switch nulls both. *Read answers aloud* (`prefs.voiceReadAloud`, per device, default off) renders only once a source exists;
  hands-free needs STT (`config.voiceEnabled`) on top. No source → no button, no toggle, no HUD change.
- **Chunking**: the armed turn's `chat:<id>` partials → `SentenceChunker` (Hebrew/English sentence ends, line breaks, a fenced block →
  one spoken marker "קטע קוד." / "Code block.", markdown stripped, abbreviations and decimals kept, a 280-char cut for runs without
  punctuation). `Speaker` keeps ≤ 2 TTS fetches in flight and plays strictly in order (`<audio>`; speechSynthesis for the browser source).
- **Arming**: the composer arms the selected session right before it POSTs the message; the store tap feeds partials; the persisted
  copy is not spoken twice; a full message that had no deltas is; `result` flushes the remainder.
- **Barge-in**: the Stop button (composer / HUD / Esc), opening the mic, the composer's interrupt, or — hands-free — a word from the
  person: playback stops at once, the queue is dropped, and `/sessions/:id/interrupt` is called only while `claude.state === 'working'`.
  A `needs_setup` / `disabled` / `soft-stopped` answer mid-turn falls back to the browser voice when it is on, else the reading stops.
- **Hands-free** (`web/src/lib/handsfree.js`, VoiceHUD): the headphones button in the composer opens the mic in `handsfree` mode (the
  VOICE2 endpointing), the sentence goes to the session as-is (no router, no confirmation), the answer is spoken, the mic stays open
  for a barge-in, and the HUD shows one state: listening / thinking / speaking. A stop word ("עצור", "stop"…), Esc, ✕, the button, or
  120 s of silence ends it. On a phone speaker the open mic relies on the browser's echo cancellation — headphones are better.
- **Mobile**: `unlockAudio()` runs inside the tap on the speaker / headphones button (a silent WAV through the shared `<audio>`,
  `AudioContext.resume()`, an empty utterance), so iOS allows the later programmatic plays.
- **Tests**: `test/voice-tts.test.ts` (endpoint logic against a stubbed vendor), `test/speak-web.test.js` (chunker, queue, gating,
  barge-in, unlock, hands-free HUD).

## Stage 1c — the voice clerk (full duplex, `server/voice-realtime.ts`, `web/src/lib/call.js`)

- **What it is**: a realtime speech model (OpenAI Realtime over WebRTC) holds the conversation — turns, barge-in, "רגע, בודק" — and
  delegates the real work to the existing sessions through tools the host runs. Claude/Codex are never in the latency path.
- **Mint** `POST /__api/voice/realtime/session {sessionId, lang?}`: `requireVoiceProvider('realtime')` first (its shapes come back as
  JSON 200; order OpenAI → Gemini, whichever is connected), then one of two transports, named by `transport` in the answer:
  - `openai-webrtc` (`voice:openai`): `POST {base}/v1/realtime/client_secrets` → `{callId, clientSecret, expiresAt, model, voice, callsUrl}`.
    The secret is an ephemeral `ek_…` (10 min, SDP handshake only). Model = `config.voice.realtime.model` (default `gpt-realtime-2.1`;
    `gpt-realtime-2.1-mini` is the cheap pick), voice = `config.voice.realtime.voice` (default `marin`). The session config carries the
    clerk persona (`CLERK_INSTRUCTIONS`), server VAD with `interrupt_response` (native barge-in), input transcription
    (`gpt-4o-transcribe`, the mic language), and the five tool schemas.
  - `gemini-ws` (`voice:gemini`, Gemini Live): `POST {base}/v1beta/auth_tokens` (`x-goog-api-key`) → `{callId, token, wsUrl, setup, model,
    voice, expiresAt}`. The token is an ephemeral `auth_tokens/…` (one session, may be opened within 2 min, lives 2 h, resumes ride it);
    the browser connects `wsUrl?access_token=` and sends the host-built `setup` first (same persona and tools as `functionDeclarations`,
    `AUDIO` out, input/output transcription on, `sessionResumption`, `contextWindowCompression` so the 15-min audio cap does not apply).
    Model = `config.voice.realtime.geminiModel` (default `gemini-3.8-live`; tools are `BLOCKING` there, the model's default is async),
    voice = `config.voice.realtime.geminiVoice` (default `Kore`). Hebrew is picked up automatically (native-audio models take no language code).
  The API key never leaves the host for either; all config keys are file-only. ≈ $0.10/min (OpenAI) vs ≈ $0.023/min (Gemini) in the ledger.
- **Tools** (`CLERK_TOOLS`, run by the host with the cockpit's own paths — `clerkHost()` in `api.ts`): `list_sessions` (id, title, status,
  folder, working), `session_status(id)` (+ `metadata.result` summary), `ask_session(id, prompt)` (the normal message path, then the turn's
  final `assistant-text` is awaited ≤ 90 s, else `still working` + what it said so far), `create_session(title, prompt)`, `interrupt_session(id)`.
  No sending to third parties, no merge, no delete, no notify. The browser relays `response.function_call_arguments.done` to
  `POST /__api/voice/realtime/tool {sessionId, callId, name, args}` and sends the result back as `function_call_output` + `response.create`.
  Unknown tool / bad call → 400 / 403; a tool error comes back as `{ok:false, error}` so the clerk can say it.
- **Calls** live in memory, keyed by `callId`, bound to the session that minted them; every post must name both. `POST …/transcript
  {turns:[{role, text, id?}]}` grows the call's transcript (same `id` = the turn's final text). `POST …/end {seconds, reason}` records minutes
  in the ledger — the browser's number is trusted only inside the call's own window (`now − startedAt + 5 s`, ≤ 2 h) — and writes the
  transcript. A browser that goes quiet for 10 min is swept with the time it was last seen.
- **Audit trail**: every tool call lands in the calling session's chat as a compact `ext-card` (`extension:'voice'`: what was asked, what came
  back, `voice:{callId, tool, ms}`); the spoken transcript lands once per call as one more card (`voice:{seconds, turns, tools, reason}`).
- **Web**: the phone button next to the headphones (composer) exists only while `config.voiceProviders.realtime` is non-empty and the layer
  is on — no provider, no change. `startCall()` mints and hands the answer to the transport it names: `call-openai.js` opens
  `RTCPeerConnection` (mic track up, remote audio down, data channel `oai-events`) and POSTs the SDP offer to `callsUrl` with the ephemeral
  secret; `call-gemini.js` opens the Live WebSocket, sends `setup`, streams the mic as 16 kHz PCM (`pcm.js`: AudioWorklet, ScriptProcessor
  fallback) and plays the 24 kHz PCM parts back to back; `interrupted` drops the queue; a `goAway`/dropped socket is reopened with the
  resumption handle (≤ 3 times, same token). Both report the same phases: the HUD shows connecting / listening / speaking / checking (tool
  name), with Mute and Hang up (Esc too). A connection that fails falls back to the 1b hands-free mode with one line (or a toast without 1b).
  `unlockAudio()` runs inside the tap (iOS).
- **Privacy**: everything the clerk hears, everything it says and every tool result passes through the provider as audio/text. Connecting
  the provider is the consent; Settings → Voice & phone says so next to each provider.
- **Tests**: `test/voice-realtime.test.ts` (both mints, call window, executor, audit cards, Gemini order/pricing), `test/voice-realtime-host.test.ts`
  (the routes on an isolated host against a fake OpenAI via `ARIGAMI_OPENAI_API_BASE`; `ARIGAMI_GEMINI_API_BASE` is the Gemini twin),
  `test/voice-call-web.test.js` (gating, fake WebRTC flow, fake Live socket flow incl. resumption, tool round-trips, transcripts, hang-up,
  fallback, PCM helpers).

## Stage 1d — the floating voice box (`web/src/components/VoiceHUD.jsx`, `web/src/lib/voiceDock.js`)

- Hands-free (1b) and call mode (1c) no longer open the centred window; they show a small **floating box**: one state line
  (listening / thinking / speaking; connecting / checking in a call; muted), the latest sentence (two lines at most), **Mute** and
  **End / Hang up**. The command/dictation window (VOICE1/2) is unchanged and still centred.
- **Default spot**: desktop — over the bottom of the rail (start edge, so the right side in RTL), as wide as the rail allows
  (200–320 px), so it never covers the chat. Phone (< 768 px): a compact bar docked at the bottom edge (safe-area aware), no free drag.
- **Moving it**: drag the header (pointer events, works with touch); the grip also takes the arrow keys (16 px a step) and Home;
  a double-click on the header puts it back. The dropped spot is kept **per device** under its own localStorage key
  `arigami-voice-dock` (not a pref) and clamped back fully on screen on every resize.
- **Hands-free mute**: `toggleHandsFreeMute()` closes the mic (the answer still plays, nothing is sent, the silence timeout pauses);
  unmute opens it again. Call mute is the existing `toggleMute()`.
- **No voice source → no box**: the box only exists while hands-free or a call is active, both of which are gated as before.
- **Global call (rail phone)**: `RailCallButton` in the rail's brand row, only while `voiceProviders.realtime` is non-empty (and the
  layer is on). It mints `{home:true, contextSessionId}`: the host anchors the call in one **voice home session** (`metadata.voiceHome`,
  worktree-less, created on first use and not spawned — audit cards and the transcript land there) and adds the open session to the
  clerk's instructions as its default subject (`clerkInstructions()`; an archived or unknown id is dropped). The mint answers
  `sessionId` = the anchor; the browser uses it for every later post.
- **One call at a time**: a mint while any call is live answers 409 `{busy:true}`; the browser shows one toast with "End it and call",
  which re-mints with `takeover:true` — the old call is finished (`reason:'takeover'`) only once the new mint succeeded.
- **Wake lock + resume** (`web/src/lib/wakeLock.js`, wired in `main.jsx`): `navigator.wakeLock.request('screen')` while a call or
  hands-free is live, released at the end, re-taken on every `visibilitychange` → visible. A connection lost while the page is
  hidden waits (phase `connecting`) instead of ending; back to visible, `resumeCall()` reopens Gemini with its session handle, or for
  OpenAI ends the old call (`reason:'resume'`) and re-mints + reconnects once; if that fails the call ends with one toast line.
- **Tests**: `test/voice-dock-web.test.js` (placement LTR/RTL, clamping, per-device storage, keyboard nudge), `test/voice-s1d-web.test.js`
  (rail gating + global mint, busy/takeover, OpenAI/Gemini resume, wake lock with a fake navigator), the stage-1d case in
  `test/voice-realtime.test.ts` (home anchor, context, guard, takeover), plus box/mute checks in `speak-web` and `voice-call-web`.
