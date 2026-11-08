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

### Team by voice (`list_agents` / `ask_agent` / `create_session({agent})`)

- **Tools** (same `CLERK_TOOLS` table for the web mints and the phone bridge): `list_agents` (slug, name, first persona line);
  `create_session(title, prompt, agent?)` — with `agent` the session is born from that team member through `applyAgentToSession`, exactly
  like POST /__api/sessions (persona, engine/model, allowlists, daily budget — a spent budget comes back as the tool's spoken error);
  `ask_agent(agent, prompt)` reuses the agent's most recent idle session (the call's folder first, then its home, then a root-level one;
  other folders are never hijacked), else opens one, and waits ≤ 90 s like `ask_session`; `list_sessions({agent})` filters by team member.
- **Names**: `resolveAgent` accepts the slug, the display name, Maor's spoken forms (`SPOKEN_NAMES`: צ'יף/צ׳יף/ציף/chief, קשר, סטודיו,
  אסטרה/astra, נדל"ן/נדלן, social manager/סושיאל) and a unique ≥ 3-char prefix; `nameKey` drops punctuation and Hebrew final letters.
  Unknown → "no agent called X — the team is: …"; two candidates → "did you mean A or B?". The persona lists the team with slugs, maps
  "תן ל-X / תבקש מ-X / מה X עושה" to `ask_agent` / `list_sessions({agent})`, and asks to confirm a garbled name in one word first.
- **Audit**: sessions created by voice carry `metadata.createdBy='voice'` (+ `metadata.agent`); tool cards show the slug
  (`📞 ask_agent · chief`, `voice.agent`). Sending to third parties, merge and delete stay in-app cards (PLAN.md decision 2). No team → no
  team line, nothing else changes. Tests: `test/voice-clerk-agents.test.ts`, the agent case in `test/voice-realtime-host.test.ts`.
- **Language**: `config.voiceLang` (default `he`) is the clerk's opening language on both paths — the persona gets `HEBREW_FIRST` (greet in
  Hebrew, follow the caller after that), Gemini's `speechConfig.languageCode` gets `speechLang()` (`he-IL`), OpenAI's input transcription gets
  `he`; a browser that names its own `lang` wins for that call. Any other `voiceLang` drops the Hebrew line and maps to its BCP-47 code.

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
- **Live wave** (`web/src/components/VoiceWave.jsx`, `web/src/lib/audioLevel.js`): seven bars under the state line follow the voice —
  brand-tinted from the mic while the person speaks (listening, not muted), info-tinted from the playback while the agent speaks; resting
  dots otherwise, same height always (no layout shift). `useAudioLevel('mic'|'out')` meters whatever the voice code registered with
  `setAudioSource` (the recorder's stream, the call's mic track and remote stream, Gemini's player output node, the TTS `<audio>` per
  sentence) through one shared AudioContext + AnalyserNode, smoothed RMS at ~30 fps via rAF, nodes released on stop, 0 without a source.
  Playback that cannot be tapped (speechSynthesis) gets a CSS pulse; `prefers-reduced-motion` → quarter-step static bars at 4 fps, no
  transitions. No voice source → no box → nothing.
- **Tests**: `test/voice-anim-web.test.js` (meter with a fake AnalyserNode, sources, the wave in both boxes, reduced motion), `test/voice-dock-web.test.js` (placement LTR/RTL, clamping, per-device storage, keyboard nudge), `test/voice-s1d-web.test.js`
  (rail gating + global mint, busy/takeover, OpenAI/Gemini resume, wake lock with a fake navigator), the stage-1d case in
  `test/voice-realtime.test.ts` (home anchor, context, guard, takeover), plus box/mute checks in `speak-web` and `voice-call-web`.

## Stage 2 — inbound phone (`server/voice-phone.ts`, `server/voice-phone-bridge.ts`, `server/lib/audio-g711.ts`)

- **What it is**: the owner calls a Twilio number; Twilio's voice webhook lands on the host as a new webhook kind `twilio`, the host checks
  the caller is the owner's number, asks for a PIN by DTMF, then bridges the call's audio (Twilio Media Streams) to the same realtime clerk
  as the in-app call — same tools (`list/status/ask/create/interrupt`), same audit cards and transcript, same ledger. Nothing is sent to third
  parties, merged or deleted by voice (those stay cards in the app). No audio is stored; the transcript lands in the **Voice calls** session.
- **Routes** (public, self-authenticating, under the Funnel path `/__api/webhooks`): `POST …/twilio/voice` (the call + every `<Gather>` action,
  answers TwiML), `POST …/twilio/status` (status callback, 204), `wss://…/twilio/stream` (the media stream; no cookie — its `start` must
  carry the one-time token the voice webhook minted after the PIN). Every HTTP request must carry a valid `X-Twilio-Signature`
  (base64 HMAC-SHA1 of the full public URL + sorted form params with the Auth Token stored by `telephony:twilio`); constant-time compare,
  the URL is tried under the configured base, `cfg.publicUrl` and the proxy's `X-Forwarded-Host`/`Host`; a replayed status is a 401, a replayed
  voice request is inert (the call's state machine answers it without side effects, so the same wrong PIN twice is not a 401).
- **Call flow**: `From` ≠ `config.telephony.ownerNumber` (E.164) → `<Reject/>` + an audit card (no minutes billed). Owner → the gate
  (`voiceEnabled`, Twilio cap, a realtime provider with budget) → `<Gather input="dtmf" finishOnKey="#">` for the PIN (scrypt hash in
  `config.telephony.pinHash`, never the digits). 3 wrong tries (per call or in a row across calls) → 15-minute lockout; every try is a card.
  Right PIN while another call is live → "busy" + hang-up. Right PIN → `<Connect><Stream url="wss://…/twilio/stream"><Parameter name="token"/>`
  (the token: 60 s, single use, bound to the CallSid). After the stream ends the TwiML says goodbye.
- **Bridge**: Twilio sends μ-law 8 kHz frames; the host decodes (`audio-g711.ts`, pure JS) and resamples to the provider — Gemini Live gets
  16 kHz PCM in and sends 24 kHz PCM back (block-averaged to 8 kHz, μ-law encoded); OpenAI Realtime runs over its WebSocket with
  `audio/pcmu` both ways (no resampling). Barge-in is the provider's own VAD: Gemini `interrupted` / OpenAI `speech_started` → Twilio `clear`.
  Tool calls run through `handleClerkTool` (audit card per call), transcripts through `addRealtimeTranscript`, the end through `endRealtimeCall`
  (provider minutes). Twilio's own minutes come from the status callback's `CallDuration` (or the stream's window if no status arrives in 90 s).
  A kill-switch flip or a cap reached mid-call → one sentence through Twilio's REST (`Calls/{sid}` with TwiML) and hang-up; 2 h max.
  Only one call at a time with the in-app clerk (`openHostCall`).
- **Funnel + WebSocket**: Tailscale `serve`/`funnel` proxy WebSocket upgrades (verified on this host: an `Upgrade: websocket` request through
  the serve URL reaches the host's own upgrade gate; see also tailscale/tailscale#18651 — the query string of a WS upgrade may be dropped,
  which is why the stream URL carries no query and the token travels as a `<Parameter>`). HTTP/2 does not carry `Upgrade`; Twilio speaks HTTP/1.1.
  If a non-Tailscale proxy fronts the host, it must forward upgrades (Caddy does by default) — set its https base under *Public URL*.
- **Settings → Connections → Voice & phone** (only while `telephony:twilio` is connected): your number, PIN set/reset, the two URLs to paste
  into the Twilio console, *Test signature* (signs a sample request with the stored token for the configured base and runs it through the
  verifier), an optional public base. `GET/POST /__api/voice/phone`, `POST /__api/voice/phone/test-signature` (admin). `GET /__api/config`
  exposes only `telephony.{ownerNumber, pinSet}`.
- **Twilio console (one screen)**: buy an Israeli number (regulatory bundle + address on Twilio's side). Phone Numbers → Manage → Active numbers →
  the number → Voice configuration: *A call comes in* = Webhook, URL = the first URL from Settings, HTTP POST; *Call status changes* = the second URL,
  POST. Save. Media Streams need no console setting (the `<Stream>` verb opens them). Turn the Funnel on under Settings → Webhooks first, or set
  *Public URL*. Then call the number from your own phone: PIN, `#`, talk.
- **Tests**: `test/voice-phone.test.ts` (signature valid/invalid/replayed + base candidates, owner gate, PIN flow with lockout, TwiML shapes,
  μ-law/resampling round trip, the stream WebSocket with a fake Twilio client against a stubbed backend incl. tool round-trip, transcript, clear
  on interruption, ledger entries, kill-switch/budget mid-call, status billing), `test/voice-phone-host.test.ts` (a real isolated host: admin routes, the
  cookie-less webhook + stream upgrade, the real Gemini Live backend against a fake Live server, cards + ledgers), `test/voice-phone-web.test.js` (the settings panel).
  No real call was placed: there is no Twilio account in CI or on the dev host.

## Stage 4a — calls and SMS to others (`server/voice-outbound.ts`)

- **Rule**: the agent drafts, the owner presses **Send** on a card. `call_contact({to, goal, brief, caller_id?, language?, voicemail?})` and
  `send_sms({to, text})` (host-mcp, agent family `phone`) and the clerk's `call_contact` only file an outbound card (`lib/outbound.ts`,
  `via:'call'|'sms'`) with the recipient, goal, the brief, the opening line, caller ID, voicemail behaviour and the estimated cost. Nothing
  dials or sends before Send; "Don't send" ends it. Only a person can answer the card.
- **Recipient**: an E.164 number, a local number (`05x…` → `+972…`, `outbound.defaultCountry`), or a WhatsApp contact/chat name with a
  phone. Ambiguous or unknown → `{ok:false, error, candidates?}` and the agent asks; it never guesses.
- **Guards** (on filing and again on Send, refused with a sayable reason): kill-switch, Twilio connected, Twilio monthly cap, a realtime
  provider (calls), quiet hours (default 21:00–08:00, `Asia/Jerusalem`), Shabbat and Yom Tov (candle-lighting −40 min to sunset +45 min,
  NOAA sunset at `quiet.lat/lon`, holiday table through 5790 Sukkot + `quiet.extraDates`), daily caps (5 calls / 10 SMS), opted-out
  numbers, one live call at a time.
- **Send → call**: `POST Calls.json` with `To`, `From` (caller ID), `Url` = `…/twilio/outbound?ob=<id>`, `StatusCallback` =
  `…/twilio/outbound-status?ob=<id>` (initiated/ringing/answered/completed), `MachineDetection=DetectMessageEnd` (unless AMD off),
  `Timeout=30`, `TimeLimit` = the minute cap (Twilio enforces it; the bridge's watchdog too). Both routes are signed like stage 2.
- **Answered**: a machine → the voicemail (`voicemail` arg, else disclosure + goal) in the call's language, or hang-up (`amd`). A person →
  `<Connect><Stream>` with a one-time token into an **outbound clerk**: persona = disclosure ("שלום, כאן העוזר הדיגיטלי של {owner}") +
  goal + brief + rules (never claims to be human, nothing beyond the brief); it speaks first; tools only `end_call({summary, outcome})`,
  `take_note`, `ask_owner` (a card in the requesting session with tap answers + "I'll get back to them", ≤60 s) and `transfer_to_owner`
  (REST `<Dial>` to the owner's number).
- **Language**: the call's `language` (default he) drives the persona, the summary/notes the clerk writes, the card's labels, and the ASR — the host's phone bridge sends Gemini `inputAudioTranscription.languageCodes:[he-IL]` (inbound and outbound; retried once without it if refused).
- **After**: on the final status (and the stream's end) one card in the requesting session — outcome (reached / voicemail / no-answer / busy
  / failed, transferred), the summary, notes, both sides of the transcript — plus a `[host]` line to its agent (the voice home gets a system
  line). Twilio's outbound minutes from `CallDuration`, the realtime minutes from the bridge. The transferred leg is billed by Twilio, not
  estimated here. Live calls are in memory (a restart forgets them); counters and opt-outs live in `voice-outbound.json`.
- **SMS**: Send → `POST Messages.json` from the agent's number, cost `$0.2575`/segment (70 Hebrew / 160 GSM chars) in the ledger. Inbound on
  `…/twilio/sms` (signed) → a card in the **Voice calls** session + the sms store (sms listeners wake). `STOP`/`הסר`/… opts the number out
  of calls and SMS; `START` lifts it; no auto-reply.
- **Caller ID**: `telephony.number` (the agent's number — Settings lists the account's numbers via `IncomingPhoneNumbers.json`, e.g. the local one and the 053 mobile) or the owner's own number once verified:
  Settings → *Verify my number as caller ID* → `POST OutgoingCallerIds.json`, the 6-digit code is shown and the owner types it on his phone
  (never answered by the host); *I typed it — check* / a 5 s poll lists it into `telephony.callerIds`. A call back to the owner's caller ID
  rings his phone, not the agent.
- **Settings → Voice & phone → Calls & SMS to others** (only with Twilio connected): agent number, default caller ID, verify, owner name,
  opening line he/en, AMD, minutes/calls/SMS caps, quiet hours, Shabbat/holidays, transfer. `GET/POST /__api/voice/outbound`,
  `POST /__api/voice/phone/caller-id {action:'start'|'check'}` (admin); `POST /__api/voice/call|sms` (a session; admin may pass `sessionId`).
- **Twilio console**: the number's *Messaging → A message comes in* = `…/__api/webhooks/twilio/sms`, POST. Calls need no console setting.
- **Tests**: `test/voice-outbound.test.ts` (+ `fixtures/voice-outbound-child.ts`), `test/voice-outbound-host.test.ts`,
  `test/voice-outbound-web.test.js`. Twilio is stubbed; no real call or SMS was placed.
