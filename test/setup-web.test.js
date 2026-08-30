// S2 — component render for every manual.kind + SetupCard state transitions.
// No DOM test harness in this repo, so we render with react-dom/server
// (renderToStaticMarkup) against a tiny window/localStorage stub: enough to
// prove each step mounts in both locales and the card shows the right
// controls per phase. Interaction is covered by the pure helpers
// (derivePhase / defaultMode) + the store's setup-update patching.
import { test, expect, beforeAll } from 'bun:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = (p) => path.join(ROOT, 'web/src', p);

let React, render, i18n, prefs, setup, SetupCard, derivePhase, defaultMode, store, registry;

beforeAll(async () => {
  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
  };
  globalThis.window = globalThis; // hostUrl.js reads window.location
  globalThis.location = { origin: 'http://host.test', port: '', pathname: '/', hash: '' };
  globalThis.document = {
    documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} }, setAttribute() {}, classList: { add() {}, remove() {} } },
    querySelector: () => null,
    addEventListener() {},
    removeEventListener() {},
  };
  globalThis.navigator = { language: 'en-US', userAgent: 'test' };
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  globalThis.WebSocket = class { close() {} };
  React = (await import(path.join(ROOT, 'web/node_modules/react/index.js'))).default;
  ({ renderToStaticMarkup: render } = await import(path.join(ROOT, 'web/node_modules/react-dom/server.js')));
  i18n = await import(web('lib/i18n.js'));
  prefs = await import(web('lib/prefs.js'));
  setup = await import(web('components/setup/index.js'));
  registry = await import(web('components/setup/registry.js'));
  ({ default: SetupCard, derivePhase, defaultMode } = await import(web('components/setup/SetupCard.jsx')));
  store = await import(web('lib/store.js'));
});

const h = (C, props) => React.createElement(C, props);

test('registry: families, args, titles in both locales', () => {
  expect(registry.capFamily('composio:gmail')).toBe('composio');
  expect(registry.capArg('composio:gmail')).toBe('gmail');
  expect(registry.manualFor('whatsapp').manual.kind).toBe('qr');
  expect(registry.manualFor('identity').manual.kind).toBe('takeover');
  expect(registry.manualFor('repo:app').manual.kind).toBe('repo');
  expect(registry.manualFor('composio:gmail').autoCapable).toBe(true);
  expect(registry.consentKeys('composio:gmail').length).toBe(4);
  expect(registry.consentKeys('whatsapp').length).toBe(0);
  for (const lang of ['en', 'he']) {
    prefs.setPrefs({ language: lang });
    const title = registry.capTitle(i18n.t, 'composio:gmail');
    expect(title).toContain('gmail');
    expect(title).not.toContain('setup.cap');
  }
});

test('one component per manual.kind renders (en + he)', () => {
  const cases = [
    ['token', { capability: 'git' }],
    ['oauth', { capability: 'claude', manual: { kind: 'oauth', flow: 'pkce', token: true } }],
    ['oauth', { capability: 'git', manual: { kind: 'oauth', flow: 'device', token: true } }],
    ['oauth', { capability: 'composio:gmail', manual: { kind: 'oauth', flow: 'redirect' } }],
    ['repo', { capability: 'repo', have: ['app'] }],
    ['qr', { capability: 'whatsapp', initial: { status: 'qr', qr: 'data:image/png;base64,AA==' } }],
    ['toggle', { capability: 'telemetry', enabled: false }],
    ['toggle', { capability: 'push', enabled: true }],
    ['takeover', { capability: 'identity' }],
  ];
  for (const lang of ['en', 'he']) {
    prefs.setPrefs({ language: lang });
    for (const [kind, props] of cases) {
      const C = setup.stepFor(kind);
      expect(C).toBe(setup.STEP_FOR[kind]);
      const html = render(h(C, props));
      expect(html.length).toBeGreaterThan(40);
      expect(html).not.toMatch(/setup\.[a-z]+\.[a-zA-Z.]+/); // no raw i18n keys
    }
  }
  // kind-specific evidence
  prefs.setPrefs({ language: 'en' });
  expect(render(h(setup.stepFor('qr'), { capability: 'whatsapp', initial: { status: 'qr', qr: 'data:image/png;base64,AA==' } }))).toContain('<img');
  expect(render(h(setup.stepFor('oauth'), { capability: 'git', manual: { flow: 'device' } }))).toContain('device code');
  expect(render(h(setup.stepFor('token'), { capability: 'claude' }))).toContain('type="password"');
  expect(render(h(setup.stepFor('takeover'), { capability: 'identity' }))).toContain('Open the agent');
  expect(render(h(setup.stepFor('repo'), { capability: 'repo', have: ['app'] }))).toContain('app');
  expect(render(h(setup.AutoConnect, { state: 'auto', lines: ['Opening Composio…'], sessionId: 's1' }))).toContain('Opening Composio…');
  expect(render(h(setup.AutoConnect, { state: 'done', evidence: '/__artifacts/abc/', sessionId: 's1' }))).toContain('href="/__artifacts/abc/"');
});

test('SetupCard: phase + default mode helpers', () => {
  expect(derivePhase({})).toBe('pending');
  expect(derivePhase({ state: 'running' })).toBe('auto');
  expect(derivePhase({ state: 'auto' })).toBe('auto');
  expect(derivePhase({ state: 'pending' }, 'done')).toBe('done'); // optimistic local override
  expect(derivePhase({ state: 'bogus' })).toBe('pending');
  expect(defaultMode({ capability: 'composio:gmail', identity: { email: 'a@b' } })).toBe('auto');
  expect(defaultMode({ capability: 'composio:gmail', identity: null })).toBe('manual');
  expect(defaultMode({ capability: 'whatsapp', identity: { email: 'a@b' } })).toBe('manual');
  expect(defaultMode({ capability: 'composio:gmail', identity: { email: 'a@b' }, mode: 'manual' })).toBe('manual');
});

test('SetupCard: pending(auto) → auto-running → done with evidence; failed → manual; skipped', () => {
  prefs.setPrefs({ language: 'en' });
  const base = { kind: 'setup', requestId: 'r1', capability: 'composio:gmail', why: 'read your inbox', autoCapable: true, identity: { email: 'user@example.test' } };
  const pending = render(h(SetupCard, { sessionId: 's1', event: { ...base, state: 'pending' } }));
  expect(pending).toContain('data-setup-phase="pending"');
  expect(pending).toContain('The agent needs gmail (via Composio)');
  expect(pending).toContain('read your inbox');
  expect(pending).toContain('role="radiogroup"');
  expect(pending).toContain('When you click Connect, the agent will:'); // consent
  expect(pending).toContain('user@example.test');
  expect(pending).toContain('Connect automatically');
  expect(pending).toContain('Not now');

  const running = render(h(SetupCard, { sessionId: 's1', event: { ...base, state: 'auto', lines: ['Opening Composio…', 'Consent approved'] } }));
  expect(running).toContain('data-setup-phase="auto"');
  expect(running).toContain('The agent is connecting');
  expect(running).toContain('Consent approved');
  expect(running).not.toContain('Connect automatically');

  const done = render(h(SetupCard, { sessionId: 's1', event: { ...base, state: 'done', evidence: '/__artifacts/ev1/' } }));
  expect(done).toContain('data-setup-phase="done"');
  expect(done).toContain('gmail (via Composio) connected');
  expect(done).toContain('href="/__artifacts/ev1/"'); // relative — works from the phone
  expect(done).not.toContain('http://');
  expect(done).not.toContain('role="radiogroup"');

  const failed = render(h(SetupCard, { sessionId: 's1', event: { ...base, state: 'failed', detail: 'consent page timed out' } }));
  expect(failed).toContain('data-setup-phase="failed"');
  expect(failed).toContain('consent page timed out');
  expect(failed).toContain('finish it manually'); // rule 5: falls back to manual
  expect(failed).toContain('Open the consent page'); // the manual oauth step is mounted

  const skipped = render(h(SetupCard, { sessionId: 's1', event: { ...base, state: 'skipped' } }));
  expect(skipped).toContain('data-setup-phase="skipped"');
  expect(skipped).toContain('suggest an alternative');

  // No identity → manual by default, auto disabled with the hint.
  const noId = render(h(SetupCard, { sessionId: 's1', event: { ...base, identity: null, state: 'pending' } }));
  expect(noId).toContain('needs a Google identity');
  expect(noId).toContain('Open the consent page');
  expect(noId).not.toContain('Connect automatically');

  // identity card → takeover step + intro
  const idCard = render(h(SetupCard, { sessionId: 's1', event: { kind: 'setup', requestId: 'r2', capability: 'identity', why: 'first sign-in', state: 'pending' } }));
  expect(idCard).toContain('Sign in to Google once');
  expect(idCard).toContain('Open the agent');

  // Hebrew header
  prefs.setPrefs({ language: 'he' });
  expect(render(h(SetupCard, { sessionId: 's1', event: { ...base, state: 'pending' } }))).toContain('הסוכן צריך');
  prefs.setPrefs({ language: 'en' });
});

test('store: setup-update patches the card in place and appends narration lines', () => {
  store.injectLocalChat('sess', { kind: 'setup', requestId: 'q1', capability: 'git', state: 'pending' });
  store.patchLocalChat('sess', 'setup', 'q1', { state: 'auto', lines: ['gh auth login'] });
  store.patchLocalChat('sess', 'setup', 'q1', { lines: ['authorized'] });
  store.patchLocalChat('sess', 'setup', 'q1', { state: 'done', evidence: '/__artifacts/x/' });
  const chat = store.getState().chats.sess;
  expect(chat.length).toBe(1);
  expect(chat[0].state).toBe('done');
  expect(chat[0].evidence).toBe('/__artifacts/x/');
  expect(chat[0].lines).toEqual(['gh auth login', 'authorized']);
  expect(store.getState().setupTick).toBeGreaterThan(0);
  // unknown requestId → no-op
  store.patchLocalChat('sess', 'setup', 'nope', { state: 'done' });
  expect(store.getState().chats.sess.length).toBe(1);
});

// F6 — the live status line + waiting pulse, and the identity card's "when to
// click Done" hint, in both locales; done shows "Completed", never a pulse.
test('SetupCard (F6): status line per phase, waiting pulse, identity Done hint (he/en)', () => {
  for (const [lang, waiting, connecting, completed, hint] of [
    ['en', 'The agent is waiting for you', 'The agent is connecting…', 'Completed', 'When you see your Google Account page with your name — click Done.'],
    ['he', 'הסוכן ממתין לך', 'הסוכן מחבר…', 'הושלם', 'כשאתה רואה את דף החשבון עם השם שלך — לחץ Done.'],
  ]) {
    prefs.setPrefs({ language: lang });
    const id = { kind: 'setup', requestId: 'r9', capability: 'identity', why: 'sign in', autoCapable: false, identity: null, manual: { kind: 'takeover' } };
    const pending = render(h(SetupCard, { sessionId: 's1', event: { ...id, state: 'pending' } }));
    expect(pending).toContain('setup-waiting');
    expect(pending).toContain('data-setup-status="pending"');
    expect(pending).toContain(waiting);
    expect(pending).toContain(hint);
    const gm = { kind: 'setup', requestId: 'r10', capability: 'composio:gmail', why: 'inbox', autoCapable: true, identity: { email: 'u@x.test' } };
    const auto = render(h(SetupCard, { sessionId: 's1', event: { ...gm, state: 'auto', lines: ['Opening Composio…'] } }));
    expect(auto).toContain('data-setup-status="auto"');
    expect(auto).toContain(connecting);
    expect(auto).toContain('Opening Composio…');
    expect(auto).not.toContain('setup-waiting');
    const done = render(h(SetupCard, { sessionId: 's1', event: { ...gm, state: 'done' } }));
    expect(done).toContain('data-setup-status="done"');
    expect(done).toContain(completed);
    expect(done).not.toContain('setup-waiting');
    expect(done).not.toContain(hint);
    const skipped = render(h(SetupCard, { sessionId: 's1', event: { ...id, state: 'skipped' } }));
    expect(skipped).not.toContain('data-setup-status=');
    expect(skipped).not.toContain('setup-waiting');
  }
});

// F6 — setup-update carries the FULL narration list; the store must not
// duplicate it (a delta from an old host is still appended).
test('store: setup-update lines replace when the host sends the full list, append for a delta', () => {
  const sid = 'lines-1';
  store.injectLocalChat(sid, { kind: 'setup', ts: 1, requestId: 'L1', capability: 'composio:gmail', state: 'auto', lines: [] });
  store.patchLocalChat(sid, 'setup', 'L1', { lines: ['a'] });
  store.patchLocalChat(sid, 'setup', 'L1', { lines: ['a', 'b'] });
  store.patchLocalChat(sid, 'setup', 'L1', { lines: ['a', 'b'] }); // repeated full list → no dup
  store.patchLocalChat(sid, 'setup', 'L1', { lines: ['c'] }); // delta
  const card = store.getState().chats[sid].find((e) => e.requestId === 'L1');
  expect(card.lines).toEqual(['a', 'b', 'c']);
});
