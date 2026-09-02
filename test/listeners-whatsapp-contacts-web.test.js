// WAFILT1 web: the session's listener chip shows the contact names the host
// resolved (label), its tooltip carries raw → JIDs, and listenerContacts()
// normalises a legacy single `contact`/`from` string into a one-element list.
import { test, expect, beforeAll } from 'bun:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = (p) => path.join(ROOT, 'web/src', p);

let React, render, store, ListenerChips, listenerContacts;
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
  globalThis.fetch = async (url) => ({ ok: true, status: 200, url: String(url), json: async () => ({}), text: async () => '' });
  React = (await import(path.join(ROOT, 'web/node_modules/react/index.js'))).default;
  ({ renderToStaticMarkup: render } = await import(path.join(ROOT, 'web/node_modules/react-dom/server.js')));
  store = await import(web('lib/store.js'));
  ({ ListenerChips, listenerContacts } = await import(web('components/SessionView.jsx')));
});

const LID = '73100494372867@lid';
const PHONE = '972501234567@s.whatsapp.net';
const GROUP = '120363412808577334@g.us';

test('chip shows the resolved contact names and its tooltip lists raw → JIDs', () => {
  store.getState().listeners.push({
    id: 'lsn_wa1', sessionId: 's1', type: 'whatsapp', status: 'watching', firedCount: 0, intervalSec: 10,
    label: 'WhatsApp: אבא, משפחת אלימלך',
    params: { dbPath: '/x', groupJid: null, contacts: [
      { raw: '+972501234567', jids: [PHONE, LID], name: 'אבא' },
      { raw: 'אלימלך', jids: [GROUP], name: 'משפחת אלימלך' },
    ] },
  });
  const html = render(h(ListenerChips, { session: { id: 's1' } }));
  expect(html).toContain('WhatsApp: אבא, משפחת אלימלך');
  expect(html).toContain('contacts:');
  expect(html).toContain(LID);
  expect(html).toContain(GROUP);
  // another session's chips don't leak in
  expect(render(h(ListenerChips, { session: { id: 's2' } }))).toBe('');
});

test('listenerContacts: array as stored; legacy contact/from → one-element list; none → []', () => {
  expect(listenerContacts({ params: { contacts: [{ raw: LID, jids: [LID], name: 'אבא' }] } })).toEqual([{ raw: LID, jids: [LID], name: 'אבא' }]);
  expect(listenerContacts({ params: { contacts: [LID] } })).toEqual([{ raw: LID, jids: [LID], name: null }]);
  expect(listenerContacts({ params: { contact: LID } })).toEqual([{ raw: LID, jids: [LID], name: null }]);
  expect(listenerContacts({ params: { from: ' +972501234567 ' } })).toEqual([{ raw: '+972501234567', jids: ['+972501234567'], name: null }]);
  expect(listenerContacts({ params: { groupJid: GROUP } })).toEqual([]);
  expect(listenerContacts({ params: { contacts: [] } })).toEqual([]);
  expect(listenerContacts({})).toEqual([]);
});
