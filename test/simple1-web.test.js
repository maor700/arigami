// SIMPLE1 web: the "Simple" chat view.
//   · chatModeOf: stored mode wins; unset → terminal on desktop, simple on a phone
//   · hiddenInSimple: tool calls / results / thinking / status fold; prose,
//     questions, permissions, cards, errors stay
//   · ChatPane in simple mode folds one turn's activity into ONE
//     "behind the scenes · N actions" line and hides the tool rows; the
//     terminal mode still renders them
//   · the header toggle shows both segments with the active one pressed
import { test, expect, beforeAll, afterAll } from 'bun:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = (p) => path.join(ROOT, 'web/src', p);

let React, render, prefs, chatMode, ChatPane, ChatModeToggle, origFetch;
const h = (...a) => React.createElement(...a);

beforeAll(async () => {
  const mem = new Map();
  globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  globalThis.window = globalThis;
  globalThis.location = { origin: 'http://host.test', port: '', pathname: '/', hash: '' };
  globalThis.document = {
    documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} }, setAttribute() {}, classList: { add() {}, remove() {} }, dir: 'ltr' },
    body: {}, querySelector: () => null, addEventListener() {}, removeEventListener() {},
  };
  globalThis.navigator = { language: 'en-US', userAgent: 'test' };
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  globalThis.WebSocket = class { close() {} };
  globalThis.MutationObserver = class { observe() {} disconnect() {} takeRecords() { return []; } };
  origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => ({ ok: true, status: 200, url: String(url), json: async () => ({}), text: async () => '' });
  React = (await import(path.join(ROOT, 'web/node_modules/react/index.js'))).default;
  ({ renderToStaticMarkup: render } = await import(path.join(ROOT, 'web/node_modules/react-dom/server.js')));
  prefs = await import(web('lib/prefs.js'));
  chatMode = await import(web('lib/chatMode.js'));
  ({ default: ChatPane } = await import(web('components/ChatPane.jsx')));
  ({ ChatModeToggle } = await import(web('components/SessionView.jsx')));
});

afterAll(() => {
  globalThis.fetch = origFetch;
});

test('chatModeOf: the stored mode wins; unset is terminal on desktop and simple on a phone', () => {
  const { chatModeOf } = chatMode;
  expect(chatModeOf({ metadata: { chatMode: 'simple' } }, true)).toBe('simple');
  expect(chatModeOf({ metadata: { chatMode: 'full' } }, false)).toBe('full');
  expect(chatModeOf({ metadata: {} }, true)).toBe('full');
  expect(chatModeOf({ metadata: {} }, false)).toBe('simple');
  expect(chatModeOf(null, true)).toBe('full');
  expect(chatModeOf({ metadata: { chatMode: 'bogus' } }, true)).toBe('full');
});

test('hiddenInSimple: activity folds, the conversation and anything needing the human stays', () => {
  const { hiddenInSimple, isAction } = chatMode;
  const folded = [
    { kind: 'thinking', text: 'hmm' },
    { kind: 'tool-use', name: 'Bash', input: { command: 'ls' } },
    { kind: 'tool-result', text: 'a b c' },
    { kind: 'result', subtype: 'success' },
    { kind: 'system', text: 'session restarted' },
    { kind: 'action-auto' },
    { kind: 'delegated' },
    { kind: 'agent-adopt' },
  ];
  for (const e of folded) expect(hiddenInSimple(e)).toBe(true);
  const kept = [
    { kind: 'user', text: 'hi' },
    { kind: 'assistant-text', text: 'done.' },
    { kind: 'assistant', text: 'done.' },
    { kind: 'tool-use', name: 'AskUserQuestion', input: { questions: [] } },
    { kind: 'permission-request', toolName: 'Bash' },
    { kind: 'screen-request' },
    { kind: 'screenshot' },
    { kind: 'artifact' },
    { kind: 'setup' },
    { kind: 'merge' },
    { kind: 'agent-card' },
    { kind: 'error', text: 'boom' },
    { kind: 'result', is_error: true, text: 'failed' },
  ];
  for (const e of kept) expect(hiddenInSimple(e)).toBe(false);
  // the counter counts tool CALLS only
  expect(isAction({ kind: 'tool-use', name: 'Edit' })).toBe(true);
  expect(isAction({ kind: 'tool-use', name: 'AskUserQuestion' })).toBe(false);
  expect(isAction({ kind: 'tool-result' })).toBe(false);
  expect(isAction({ kind: 'thinking' })).toBe(false);
});

const EVENTS = [
  { id: 'u1', kind: 'user', text: 'fix the typo', ts: 1 },
  { id: 't1', kind: 'thinking', text: 'the file is probably README', ts: 2 },
  { id: 'c1', kind: 'tool-use', name: 'Grep', toolUseId: 'x1', input: { pattern: 'teh' }, ts: 3 },
  { id: 'r1', kind: 'tool-result', toolUseId: 'x1', text: 'README.md:3:teh', ts: 4 },
  { id: 'c2', kind: 'tool-use', name: 'Edit', toolUseId: 'x2', input: { file_path: 'README.md', old_string: 'teh', new_string: 'the' }, ts: 5 },
  { id: 'r2', kind: 'tool-result', toolUseId: 'x2', text: 'ok', ts: 6 },
  { id: 'a1', kind: 'assistant-text', text: 'Fixed the typo in the README.', ts: 7 },
  { id: 'd1', kind: 'result', subtype: 'success', numTurns: 3, durationMs: 1200, ts: 8 },
];

test('ChatPane in simple mode folds the turn into one line; terminal mode shows every row', () => {
  prefs.setPrefs({ language: 'en' });
  const simple = render(h(ChatPane, { sessionId: 'sess_x', events: EVENTS, mode: 'simple' }));
  expect(simple).toContain('data-chat-mode="simple"');
  expect(simple).toContain('fix the typo');
  expect(simple).toContain('Fixed the typo in the README.');
  // one folded group holding thinking + 2 calls + 2 results + the done marker, counting 2 actions
  expect(simple).toContain('data-behind-scenes="6"');
  expect(simple).toContain('data-actions="2"');
  expect(simple).toContain('What happened behind the scenes · 2 actions');
  expect(simple).not.toContain('README.md:3:teh'); // tool result folded
  expect(simple).not.toContain('>Grep<'); // tool row folded
  expect(simple).not.toContain('thinking'); // thinking folded
  expect(simple).not.toContain('>done<'); // end-of-turn marker folded

  const full = render(h(ChatPane, { sessionId: 'sess_x', events: EVENTS, mode: 'full' }));
  expect(full).toContain('data-chat-mode="full"');
  expect(full).not.toContain('data-behind-scenes');
  expect(full).toContain('README.md:3:teh');
  expect(full).toContain('>Grep<');
  expect(full).toContain('Fixed the typo in the README.');

  // the default (no mode prop) is the terminal view — nothing changes for existing callers
  const dflt = render(h(ChatPane, { sessionId: 'sess_x', events: EVENTS }));
  expect(dflt).toContain('data-chat-mode="full"');
});

test('simple mode: one line PER TURN, a question card still shows, a plain "done" group renders nothing', () => {
  prefs.setPrefs({ language: 'he' });
  const events = [
    ...EVENTS,
    { id: 'u2', kind: 'user', text: 'and the second one?', ts: 9 },
    { id: 'c3', kind: 'tool-use', name: 'Read', toolUseId: 'x3', input: { file_path: 'a.md' }, ts: 10 },
    { id: 'q1', kind: 'tool-use', name: 'AskUserQuestion', toolUseId: 'x4', input: { questions: [{ question: 'Which file?', header: 'File', options: [{ label: 'a.md' }, { label: 'b.md' }] }] }, ts: 11 },
    { id: 'u3', kind: 'user', text: 'a.md', ts: 12 },
    { id: 'a3', kind: 'assistant-text', text: 'Done, a.md too.', ts: 13 },
    { id: 'd3', kind: 'result', subtype: 'success', ts: 14 },
  ];
  const html = render(h(ChatPane, { sessionId: 'sess_x', events, mode: 'simple' }));
  // turn 1: 2 actions; turn 2: 1 action; turn 3: only a "done" marker → no line
  expect(html).toContain('data-actions="2"');
  expect(html).toContain('data-actions="1"');
  expect(html).toContain('מה קרה מאחורי הקלעים · 2 פעולות');
  expect(html).toContain('מה קרה מאחורי הקלעים · פעולה אחת');
  expect((html.match(/data-behind-scenes=/g) || []).length).toBe(2);
  expect(html).toContain('Which file?'); // the question card is for the human — never folded
  expect(html).toContain('Done, a.md too.');
});

test('the header toggle renders פשוט | טרמינל with the active segment pressed', () => {
  prefs.setPrefs({ language: 'he' });
  const s = { id: 'sess_x', metadata: { chatMode: 'simple' }, claude: { state: 'idle' } };
  const html = render(h(ChatModeToggle, { session: s }));
  expect(html).toContain('data-chat-mode-toggle="simple"');
  expect(html).toContain('>פשוט<');
  expect(html).toContain('>טרמינל<');
  expect(html).toMatch(/data-chat-mode-btn="simple" aria-pressed="true"/);
  expect(html).toMatch(/data-chat-mode-btn="full" aria-pressed="false"/);
  const full = render(h(ChatModeToggle, { session: { ...s, metadata: { chatMode: 'full' } } }));
  expect(full).toMatch(/data-chat-mode-btn="full" aria-pressed="true"/);
});
