// Voice control: speech-to-text + intent routing, both via Groq (one key).
//   transcribe()  → Groq Whisper large-v3-turbo (fast + accurate Hebrew)
//   route()       → Groq LLM maps a transcript to app commands / prompt-inject
//
// The browser records a short clip (push-to-talk) and posts it here; we never
// expose the Groq key to the client. The router is intentionally model-driven
// so Hebrew + Hebrew/English code-switching ("תעבור ל-session של ה-PR") works.
import { cfg } from './lib/config.js';
import { readToken } from './usage.js';

const GROQ = 'https://api.groq.com/openai/v1';
const ANTHROPIC = 'https://api.anthropic.com/v1/messages';

function apiKey() {
  return cfg.groqApiKey || process.env.GROQ_API_KEY || '';
}
export function voiceEnabled() {
  return !!apiKey();
}

// Map a clip's mime type to a filename extension Groq accepts.
function extFor(mime = '') {
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('mp4') || mime.includes('m4a')) return 'm4a';
  if (mime.includes('wav')) return 'wav';
  if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3';
  return 'webm';
}

// --- speech to text -----------------------------------------------------------

async function groqTranscribe(buf, baseType, ext, language, model) {
  const form = new FormData();
  form.append('file', new Blob([buf], { type: baseType }), `clip.${ext}`);
  form.append('model', model);
  form.append('language', language);
  form.append('response_format', 'json');
  form.append('temperature', '0');
  const r = await fetch(`${GROQ}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey()}` },
    body: form,
  });
  if (r.ok) return { ok: true, text: ((await r.json()).text || '').trim() };
  return { ok: false, status: r.status, errText: (await r.text()).slice(0, 220) };
}

const TURBO = 'whisper-large-v3-turbo';

export async function transcribe({ audioBase64, mimeType, lang }) {
  if (!apiKey()) throw new Error('voice disabled: no GROQ_API_KEY');
  if (!audioBase64) throw new Error('no audio');
  const buf = Buffer.from(audioBase64, 'base64');
  const baseType = (mimeType || 'audio/webm').split(';')[0]; // drop ;codecs=…
  const ext = extFor(mimeType);
  const language = lang || cfg.voiceLang || 'he';
  const primary = cfg.sttModel || TURBO;

  let res = await groqTranscribe(buf, baseType, ext, language, primary);
  // Free-tier audio (length / seconds-per-minute) limits hit the full model
  // first; turbo has much higher limits — fall back transparently.
  if (!res.ok && (res.status === 413 || res.status === 429) && primary !== TURBO) {
    res = await groqTranscribe(buf, baseType, ext, language, TURBO);
  }
  // Surface what we sent so a bad-media/limit error stays diagnosable.
  if (!res.ok) throw new Error(`groq stt ${res.status} [${baseType}, ${buf.length}B, ${primary}]: ${res.errText}`);
  return { text: res.text };
}

// --- intent routing -----------------------------------------------------------

// The command vocabulary the router may emit. Keep in sync with the client's
// command bus (web/src/lib/commands.js).
const COMMANDS = `
- select_session {sessionId} — switch to a session
- next_session {} / prev_session {} — cycle sessions
- new_session {} — create an empty session instantly
- open_launcher {} — open the full "start a session" dialog
- open_terminal {sessionId?} — go to the chat/terminal/conversation tab
- open_changes {sessionId?} — open the Changes/diff tab
- activate_tab {tabId} — switch to an open tab (tabId from "Current session tabs")
- open_tab {sessionId?, url, title?} — open a website/URL as a new tab
- reload_tab {} — reload the current website tab
- close_tab {tabId} — close a tab
- rename_session {sessionId?, title} — rename a session
- archive_session {sessionId?} / delete_session {sessionId} — open archive/delete confirmation
- restore_session {sessionId} — unarchive a session
- focus_input {} — focus the chat composer
- set_theme {mode} — "light"|"dark"|"toggle"
- set_terminal {sessionId?, theme?, dir?} — theme "light"|"dark"; dir "auto"|"ltr"|"rtl" (RTL/ימין-לשמאל = "rtl")
- open_settings {} — open settings
- dismiss {} — close any open overlay (settings / new-session dialog / a dialog) and return to the current view
- interrupt {sessionId?} — stop the working agent
- inject_prompt {sessionId?, text} — send TEXT to the coding agent
- clarify {} — intent unclear; put a question in "say"
`.trim();

function systemPrompt(context) {
  const list = (context?.sessions || [])
    .map((s, i) => `  ${i + 1}. id=${s.id} ${s.selected ? '(CURRENT) ' : ''}${s.working ? '[working] ' : ''}${s.archived ? '[archived] ' : ''}label="${s.label}"`)
    .join('\n') || '  (no sessions yet)';
  const tabs = (context?.tabs || [])
    .map((t) => `  - tabId=${t.id} "${t.title}" (${t.type})`)
    .join('\n') || '  (current session has only its chat)';
  const chat = (context?.recentChat || '').trim();
  const at = context?.activeTab;
  const screen = [
    chat ? `Recent chat in the CURRENT session (the terminal content):\n${chat}` : '',
    at ? `Active tab "${at.title}" (${at.type})${at.text ? `:\n${at.text}` : ''}` : '',
  ].filter(Boolean).join('\n\n') || '(no readable session/tab content)';
  return `You are the intent router for "Arigami", a cockpit for parallel Claude Code coding sessions. The user controls it by voice in Hebrew and/or English (they code-switch freely). Convert their utterance into a JSON plan.

Available commands:
${COMMANDS}

Current sessions:
${list}

Current session tabs:
${tabs}

What's on screen now:
${screen}

Rules:
- You can READ the session/tab content above. If the user asks a QUESTION about it — what was said, the status, "is it done?", "what's the error?", "summarize this", "מה הוא אמר?", "מה קורה?" — ANSWER concisely in "say" (in the user's language) from that content, with "actions":[]. Only act when they ask you to act. If the content needed isn't available (e.g. a live website tab), say so briefly.
- "go back to the terminal / chat / conversation / Claude" → open_terminal (NOT activate_tab). "show me the changes/diff" → open_changes.
- For "go to / open the X tab" use activate_tab with the matching tabId from "Current session tabs" above. For "close the X tab" use close_tab. To open a NEW website ("open localhost:3000", "open the storybook at …") use open_tab with the url. "reload/refresh the page/tab" → reload_tab.
- "rename this session to NAME" → rename_session (title = NAME, verbatim). "dark mode"/"light mode" → set_theme. "switch the terminal to RTL/Hebrew/LTR" → set_terminal with dir. "let me type"/"focus the input" → focus_input.
- "close the settings / close the new-session page / go back / cancel / סגור / תחזור אחורה / תצא מההגדרות" → if they want the terminal/chat, use open_terminal; for a plain "close this / go back", use dismiss. Both leave the settings/launcher overlay.
- For deleting/archiving/restoring a session, resolve the session by name to its id. delete_session and archive_session open a confirmation dialog (the user still confirms), so it's safe to emit them.
- Output STRICT JSON: {"actions":[{"type":...,...}], "say":""}. No prose outside JSON.
- "actions" runs in order; a single utterance may yield several (e.g. "go to the PR session and tell it to run the tests" → select_session then inject_prompt).
- If the user is giving an instruction, task, question, or request meant for the CODING AGENT (e.g. "add a feature", "fix the bug", "why is this failing"), use inject_prompt. "text" MUST be the user's own words copied VERBATIM from the transcript, in the ORIGINAL language — NEVER translate, summarize, or rephrase. Only strip a leading wake/command phrase that addresses the app (e.g. "tell it to", "תגיד לו ש", "say to the session"); keep everything that is the actual instruction.
- Use select_session when they name/describe a session ("go to X", "switch to the login one"); resolve to the best-matching id from the list above. If inject_prompt targets a session other than CURRENT, include its sessionId.
- An inject_prompt "sessionId" MUST be one of the ids under "Current sessions" — NEVER a tabId. If the prompt is for a session you just created with new_session, OMIT sessionId entirely.
- Only emit app commands the user clearly intended; otherwise prefer inject_prompt into the current session.
- If you cannot tell, return {"actions":[{"type":"clarify"}],"say":"<short question in the user's language>"}.`;
}

const normalizePlan = (plan, text) => ({
  transcript: text,
  actions: Array.isArray(plan?.actions) ? plan.actions : [],
  say: typeof plan?.say === 'string' ? plan.say : '',
});

// Structured-output tool the Anthropic router is forced to call → guaranteed JSON.
const PLAN_TOOL = {
  name: 'plan',
  description: 'The app-control plan for the utterance.',
  input_schema: {
    type: 'object',
    properties: {
      actions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string' },
            sessionId: { type: 'string' },
            tabId: { type: 'string' },
            url: { type: 'string' },
            title: { type: 'string' },
            text: { type: 'string' },
            mode: { type: 'string' },
            theme: { type: 'string' },
            dir: { type: 'string' },
          },
          required: ['type'],
          additionalProperties: true,
        },
      },
      say: { type: 'string' },
    },
    required: ['actions'],
  },
};

// Claude only accepts a Claude-Code OAuth token when the first system block
// carries the Claude Code identity (mirrors how the CLI itself calls the API).
const CC_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

// Sanitize the client-supplied conversation history into plain user/assistant
// text turns (defensive: cap length, coerce shape).
function priorTurns(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-8)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 600) }));
}

async function routeAnthropic(text, context, history) {
  const token = readToken();
  if (!token) throw new Error('voice router: no Claude Code credentials in keychain');
  const r = await fetch(ANTHROPIC, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'oauth-2025-04-20',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      model: cfg.anthropicRouterModel || 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      temperature: 0,
      system: [{ type: 'text', text: CC_IDENTITY }, { type: 'text', text: systemPrompt(context) }],
      tools: [PLAN_TOOL],
      tool_choice: { type: 'tool', name: 'plan' },
      messages: [...priorTurns(history), { role: 'user', content: text }],
    }),
  });
  if (!r.ok) throw new Error(`anthropic route ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j = await r.json();
  const block = (j.content || []).find((b) => b.type === 'tool_use' && b.name === 'plan');
  return normalizePlan(block?.input || {}, text);
}

async function routeGroq(text, context, history) {
  if (!apiKey()) throw new Error('voice disabled: no GROQ_API_KEY');
  const r = await fetch(`${GROQ}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: cfg.voiceRouterModel || 'llama-3.3-70b-versatile',
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt(context) },
        ...priorTurns(history),
        { role: 'user', content: text },
      ],
    }),
  });
  if (!r.ok) throw new Error(`groq route ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j = await r.json();
  let plan;
  try { plan = JSON.parse(j.choices?.[0]?.message?.content || '{}'); } catch { plan = {}; }
  return normalizePlan(plan, text);
}

export async function route({ transcript, context }) {
  const text = (transcript || '').trim();
  if (!text) return { actions: [], say: '' };
  const history = context?.history;
  return cfg.voiceRouterProvider === 'anthropic'
    ? routeAnthropic(text, context, history)
    : routeGroq(text, context, history);
}
