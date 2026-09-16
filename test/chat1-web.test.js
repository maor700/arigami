// CHAT1 web: the cards say what happened to an answer.
//   · chat-merge folds permission-answer onto the permission-request AND onto
//     the AskUserQuestion tool-use (with the picks), and screen-request-answer
//     onto its screen-request — so a reloaded page / the other device shows
//     answered cards, not live buttons over nothing
//   · the "Question for you" card renders the host-echoed picks as settled,
//     and a card the host closed without an answer says so and takes no clicks
//   · the answer POST carries structured answers; a failed POST shows the
//     failure and puts the buttons back; delivered:'message' shows its note
//   · the action card shows a refused answer instead of swallowing it
import { test, expect, beforeAll, afterAll } from 'bun:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolate } from './_isolate.js';
isolate(); // restore globalThis/process.env after this file (bun test shares them)

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = (p) => path.join(ROOT, 'web/src', p);

let React, render, act, createRoot, merge, ChatPane, ActionCard;
const h = (...a) => React.createElement(...a);
let posts = [];
let origFetch;
let failNext = null; // {status, error} → the next fetch rejects like api.js does

beforeAll(async () => {
  const mem = new Map();
  globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  globalThis.window = globalThis;
  globalThis.location = { origin: 'http://host.test', port: '', pathname: '/', hash: '' };
  globalThis.navigator = { language: 'en-US', userAgent: 'test' };
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  globalThis.WebSocket = class { close() {} };
  globalThis.MutationObserver = class { observe() {} disconnect() {} takeRecords() { return []; } };
  globalThis.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init?.detail; } };
  origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    posts.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null });
    if (failNext) {
      const f = failNext;
      failNext = null;
      return { ok: false, status: f.status, url: String(url), json: async () => ({ error: f.error }), text: async () => JSON.stringify({ error: f.error }), headers: { get: () => 'application/json' } };
    }
    const body = init.body ? JSON.parse(init.body) : {};
    const reply = body.toolUseId === 'tu_gone' ? { ok: true, delivered: 'message' } : { ok: true, delivered: 'tool' };
    return { ok: true, status: 200, url: String(url), json: async () => reply, text: async () => JSON.stringify(reply), headers: { get: () => 'application/json' } };
  };
  // A minimal DOM for react-dom/client (happy-dom is not a dependency here):
  // components under test only need createElement/appendChild/querySelector.
  const { Window } = await import(path.join(ROOT, 'web/node_modules/happy-dom/lib/index.js')).catch(() => ({ Window: null }));
  if (Window) {
    const w = new Window();
    globalThis.document = w.document;
    globalThis.HTMLElement = w.HTMLElement;
    globalThis.Node = w.Node;
    globalThis.HTMLIFrameElement = w.HTMLIFrameElement; // react-dom's commit-time focus check needs it
    globalThis.Event = w.Event;
    globalThis.CustomEvent = w.CustomEvent;
    globalThis.getComputedStyle = w.getComputedStyle.bind(w);
    globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
    globalThis.dispatchEvent = (e) => w.dispatchEvent(e);
    globalThis.addEventListener = (...a) => w.addEventListener(...a);
    globalThis.removeEventListener = (...a) => w.removeEventListener(...a);
  } else {
    globalThis.document = {
      documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} }, setAttribute() {}, classList: { add() {}, remove() {} }, dir: 'ltr' },
      body: {}, querySelector: () => null, addEventListener() {}, removeEventListener() {},
    };
  }
  React = (await import(path.join(ROOT, 'web/node_modules/react/index.js'))).default;
  ({ renderToStaticMarkup: render } = await import(path.join(ROOT, 'web/node_modules/react-dom/server.js')));
  merge = await import(web('lib/chat-merge.js'));
  ({ default: ChatPane } = await import(web('components/ChatPane.jsx')));
  ({ ActionCard } = await import(web('components/ActionCard.jsx')));
  if (Window) {
    ({ act } = await import(path.join(ROOT, 'web/node_modules/react/index.js')));
    ({ createRoot } = await import(path.join(ROOT, 'web/node_modules/react-dom/client.js')));
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  }
});

// The stubbed fetch must not leak into other files of the same `bun test` run
// (the host tests talk to a real isolated server through fetch).
afterAll(() => {
  if (origFetch) globalThis.fetch = origFetch;
});

const question = (extra = {}) => ({
  id: 'q1', kind: 'tool-use', name: 'AskUserQuestion', toolUseId: 'tu_1', ts: 10,
  input: { questions: [{ question: 'Which color?', header: 'Color', options: [{ label: 'Red' }, { label: 'Blue' }] }] },
  ...extra,
});

test('chat-merge: answers fold onto their cards (permission, question tool-use, screen)', () => {
  const evs = [
    { id: 'p1', kind: 'permission-request', requestId: 'perm_1', toolName: 'AskUserQuestion', toolUseId: 'tu_1', ts: 11 },
    question(),
    { id: 'a1', kind: 'permission-answer', requestId: 'perm_1', toolUseId: 'tu_1', behavior: 'allow', message: 'Which color?: Red', answers: { 'Which color?': 'Red' }, ts: 12 },
    { id: 's1', kind: 'screen-request', requestId: 'scrn_1', prompt: 'log in', ts: 13 },
    { id: 's2', kind: 'screen-request-answer', requestId: 'scrn_1', note: 'done', takenOver: true, ts: 14 },
    { id: 'p2', kind: 'permission-request', requestId: 'perm_2', toolName: 'Bash', ts: 15 },
    { id: 'a2', kind: 'permission-answer', requestId: 'perm_2', behavior: 'deny', message: 'timed out', ts: 16 },
  ];
  const out = merge.foldSetupUpdates(evs);
  expect(out.map((e) => e.kind)).toEqual(['permission-request', 'tool-use', 'screen-request', 'permission-request']);
  expect(out[0]).toMatchObject({ answered: 'allow', answeredMessage: 'Which color?: Red' });
  expect(out[1]).toMatchObject({ answered: 'allow', answers: { 'Which color?': 'Red' } });
  expect(out[2]).toMatchObject({ answered: true, note: 'done', takenOver: true });
  expect(out[3]).toMatchObject({ answered: 'deny', answeredMessage: 'timed out' });
  // Untouched lists come back as-is (no answers → nothing to fold).
  const plain = [question(), { id: 'u', kind: 'user', text: 'hi', ts: 1 }];
  expect(merge.foldSetupUpdates(plain)).toBe(plain);
});

const pane = (events, session = {}) =>
  render(h(ChatPane, { session: { id: 'sess_t', metadata: { chatMode: 'full' }, claude: { state: 'idle' }, ...session }, events, chatLoaded: true }));

test('question card: host-echoed picks render settled; a closed card says so', () => {
  const answered = pane([question({ answered: 'allow', answers: { 'Which color?': 'Red' } })]);
  expect(answered).toContain('Red');
  // Settled: no option is a live pick any more (number hints only show on live options).
  expect(answered).not.toMatch(/>1<\/span>/);
  expect(answered).not.toContain('data-question-closed');
  const closed = pane([question({ answered: 'deny' })]);
  expect(closed).toContain('data-question-closed');
  const fresh = pane([question()]);
  expect(fresh).not.toContain('data-question-closed');
  expect(fresh).not.toContain('data-question-error');
});

test('question card: the POST carries structured answers; a refused POST is shown and the buttons come back', async () => {
  if (!createRoot) return; // no DOM available in this environment — the SSR checks above still ran
  posts = [];
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const events = [question()];
  await act(async () => root.render(h(ChatPane, { session: { id: 'sess_t', metadata: { chatMode: 'full' }, claude: { state: 'awaiting-input' } }, events, chatLoaded: true })));
  const red = [...host.querySelectorAll('button')].find((b) => /Red/.test(b.textContent));
  expect(red).toBeTruthy();
  await act(async () => { red.click(); await new Promise((r) => setTimeout(r, 20)); });
  const post = posts.find((p) => p.url.includes('/question/answer'));
  expect(post.body).toEqual({ toolUseId: 'tu_1', content: 'Which color?: Red', answers: [{ question: 'Which color?', answer: 'Red' }] });
  expect(host.innerHTML).not.toContain('data-question-error');
  // Refused: the failure is on the card and the options are live again.
  await act(async () => root.unmount());
  const host2 = document.createElement('div');
  document.body.appendChild(host2);
  const root2 = createRoot(host2);
  await act(async () => root2.render(h(ChatPane, { session: { id: 'sess_t', metadata: { chatMode: 'full' }, claude: { state: 'awaiting-input' } }, events: [question({ id: 'q2', toolUseId: 'tu_2' })], chatLoaded: true })));
  failNext = { status: 500, error: 'session sess_t is archived' };
  const blue = [...host2.querySelectorAll('button')].find((b) => /Blue/.test(b.textContent));
  await act(async () => { blue.click(); await new Promise((r) => setTimeout(r, 20)); });
  expect(host2.innerHTML).toContain('data-question-error');
  expect(host2.innerHTML).toContain('session sess_t is archived');
  expect([...host2.querySelectorAll('button')].find((b) => /Blue/.test(b.textContent)).disabled).toBe(false);
  // delivered:'message' → the note.
  await act(async () => root2.unmount());
  const host3 = document.createElement('div');
  document.body.appendChild(host3);
  const root3 = createRoot(host3);
  await act(async () => root3.render(h(ChatPane, { session: { id: 'sess_t', metadata: { chatMode: 'full' }, claude: { state: 'idle' } }, events: [question({ id: 'q3', toolUseId: 'tu_gone', answered: 'deny' })], chatLoaded: true })));
  expect(host3.innerHTML).toContain('data-question-closed');
  // OPENUI phase 3: a closed card accepts no answer — the options are frozen
  // (the old "send it as a plain message" fallback answered a question nothing
  // was waiting on).
  const red3 = [...host3.querySelectorAll('button')].find((b) => /Red/.test(b.textContent));
  expect(red3.disabled).toBe(true);
  posts = [];
  await act(async () => { red3.click(); await new Promise((r) => setTimeout(r, 20)); });
  expect(posts.length).toBe(0);
  expect(host3.innerHTML).toContain('data-question-closed');
  await act(async () => root3.unmount());
});

test('action card: a refused answer is shown on the card', async () => {
  const action = { id: 'act_1', prompt: 'Merge?', buttons: [{ label: 'Yes', value: 'yes', style: 'primary' }, { label: 'No', value: 'no' }] };
  const html = render(h(ActionCard, { sessionId: 'sess_t', action }));
  expect(html).toContain('Merge?');
  expect(html).not.toContain('data-action-error');
  if (!createRoot) return;
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(h(ActionCard, { sessionId: 'sess_t', action })));
  failNext = { status: 429, error: 'daily budget spent' };
  const yes = [...host.querySelectorAll('button')].find((b) => /Yes/.test(b.textContent));
  await act(async () => { yes.click(); await new Promise((r) => setTimeout(r, 20)); });
  expect(host.innerHTML).toContain('data-action-error');
  expect(host.innerHTML).toContain('daily budget spent');
  expect(yes.disabled).toBe(false);
  await act(async () => root.unmount());
});
