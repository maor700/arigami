# Voice & phone — the optional provider layer

Everything voice-related in Arigami stands on providers the owner connects by pasting a key. With no provider
connected nothing changes: no banner, no button, no tab. The providers only appear inside Settings → Connections →
"Add connection", under **Voice & phone**.

## Capabilities (`server/capabilities.ts`, specs in `server/voice-providers.ts`)

| id | serves | key field(s) | `check()` |
|---|---|---|---|
| `voice:openai` | stt, tts, realtime | API key | `GET /v1/models` |
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
