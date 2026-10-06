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

// ---- the action card is part of the conversation, not a pinned bar ----------------------------

const ACT = { id: 'act_7', prompt: 'Ship it?', buttons: [{ label: 'Go', value: 'go', style: 'primary' }, { label: 'Wait', value: 'wait' }] };
const actPane = (events, action) =>
  render(h(ChatPane, { session: { id: 'sess_t', metadata: { chatMode: 'full' }, claude: { state: 'idle' } }, events, action, chatLoaded: true }));
const user = (id, text, ts) => ({ id, kind: 'user', text, ts });

test('action card: renders where it was raised, so it scrolls up with the conversation', () => {
  const html = actPane(
    [user('u1', 'MSG-BEFORE', 1), { id: 'ar1', kind: 'action-request', actionId: 'act_7', prompt: 'Ship it?', ts: 2 }, user('u2', 'MSG-AFTER', 3)],
    ACT
  );
  const card = html.indexOf('Ship it?');
  expect(card).toBeGreaterThan(html.indexOf('MSG-BEFORE'));
  expect(card).toBeLessThan(html.indexOf('MSG-AFTER')); // not pinned below the later message
  expect(html.split('Ship it?').length - 1).toBe(1); // once, not inline AND pinned
});

test('action card: once it is no longer the current action it collapses to a one-line record', () => {
  const html = actPane([{ id: 'ar1', kind: 'action-request', actionId: 'act_7', prompt: 'Ship it?', ts: 2 }], null);
  expect(html).toContain('data-action-record');
  expect(html).toContain('Ship it?');
  expect(html).not.toContain('>Go<'); // no live buttons
});

test('action card: a current action with no record in the transcript is still answerable (shown last)', () => {
  const html = actPane([user('u1', 'hello', 1)], ACT);
  expect(html).toContain('Ship it?');
  expect(html.indexOf('Ship it?')).toBeGreaterThan(html.indexOf('hello'));
});

// ---- the merge offer is part of the conversation too, and dismissable --------------------------

const APPROVED = { id: 'sess_t', metadata: { chatMode: 'full', branch: 'feat/x', base: 'main', review: { state: 'approved', at: 'T1', by: 'me' } }, claude: { state: 'idle' } };
const mergePane = (events) => render(h(ChatPane, { sessionId: 'sess_t', events, chatLoaded: true }));
const offer = { id: 'mo1', kind: 'merge-offer', approvedAt: 'T1', branch: 'feat/x', ts: 2 };

test('merge offer: live inline with a dismiss button while approved; a one-line record once dismissed or merged', async () => {
  const store = await import(web('lib/store.js'));
  const seed = (md) => { store.getState().sessions = [{ ...APPROVED, metadata: { ...APPROVED.metadata, ...md } }]; };
  const sess = () => store.getState().sessions[0];

  seed({});
  let html = mergePane([user('u1', 'MSG-BEFORE', 1), offer, user('u2', 'MSG-AFTER', 3)]);
  expect(html).toContain('data-merge-panel');
  expect(html).toContain('data-merge-dismiss');
  expect(html.indexOf('data-merge-panel')).toBeGreaterThan(html.indexOf('MSG-BEFORE'));
  expect(html.indexOf('data-merge-panel')).toBeLessThan(html.indexOf('MSG-AFTER')); // not pinned below the later message
  expect(html.split('data-merge-panel').length - 1).toBe(1); // once

  seed({ mergeOfferDismissedAt: 'T1' });
  html = mergePane([user('u1', 'MSG-BEFORE', 1), offer]);
  expect(html).not.toContain('data-merge-panel');
  expect(html).toContain('data-merge-offer-record');

  seed({ merged: { sha: 'abc1234', base: 'main', at: 'T2' } });
  html = mergePane([offer]);
  expect(html).not.toContain('data-merge-panel');
  expect(html).toContain('data-merge-offer-record');

  // approved before offers were recorded: still offered (last), still dismissable
  seed({});
  html = mergePane([user('u1', 'old chat', 1)]);
  expect(html).toContain('data-merge-panel');
  expect(html.indexOf('data-merge-panel')).toBeGreaterThan(html.indexOf('old chat'));
  seed({ mergeOfferDismissedAt: 'T1' });
  expect(mergePane([user('u1', 'old chat', 1)])).not.toContain('data-merge-panel');
});

// ---- usage in the rail: one line on a phone, with the engine's name ---------------------------

test('usage mini: on a phone it is ONE row (engine, title, bar, %, expander); the week opens only when expanded', async () => {
  const { UsageMini } = await import(web('components/Usage.jsx'));
  const usage = { available: true, session: { pct: 42, resetsAt: Date.now() + 3600_000 }, week: { pct: 10, resetsAt: Date.now() + 86400_000 } };
  const phone = render(h(UsageMini, { usage, provider: 'codex' }));
  expect(phone).toContain('data-usage-mini-phone');
  expect(phone).toContain('Codex');
  expect(phone).toContain('42%');
  expect(phone.split('<button').length - 1).toBe(1); // title + bar + expander share one button/row
  expect(phone).not.toContain('10%'); // the week bar is collapsed away
  expect(render(h(UsageMini, { usage, provider: 'claude' }))).toContain('Claude');

  // desktop keeps the two-part panel
  const was = globalThis.matchMedia;
  globalThis.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  try {
    const desk = render(h(UsageMini, { usage, provider: 'claude' }));
    expect(desk).not.toContain('data-usage-mini-phone');
    expect(desk).toContain('Usage spent');
  } finally {
    globalThis.matchMedia = was;
  }
});
