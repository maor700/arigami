// BUGS1 (QA audit fixes) — web side, pure helpers.
//   B11: `/__host/?session=<id>` (the url create_session returns) must resolve to
//        the same route as `#/session/<id>`; the hash stays authoritative.
import { test, expect } from 'bun:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { parseHash, parseLocation, routeFromState, sessionFromSearch } = await import(path.join(ROOT, 'web/src/lib/route.js'));

test('B11: ?session=<id> resolves like #/session/<id>', () => {
  const viaHash = parseHash('#/session/sess_MMfEnwxx9YI');
  const viaQuery = parseLocation({ hash: '', search: '?session=sess_MMfEnwxx9YI' });
  expect(viaHash).toEqual({ view: 'session', id: 'sess_MMfEnwxx9YI' });
  expect(viaQuery).toMatchObject({ view: 'session', id: 'sess_MMfEnwxx9YI', fromQuery: true });
  // bare hashes (`#`, `#/`) still defer to the query
  expect(parseLocation({ hash: '#', search: '?session=sess_a' })).toMatchObject({ view: 'session', id: 'sess_a' });
  expect(parseLocation({ hash: '#/', search: '?session=sess_a' })).toMatchObject({ view: 'session', id: 'sess_a' });
  // encoded ids round-trip
  expect(parseLocation({ hash: '', search: '?session=' + encodeURIComponent('sess_x/y') }).id).toBe('sess_x/y');
  // and the canonical hash we rewrite to is the #/session form
  expect(routeFromState({ selectedId: 'sess_MMfEnwxx9YI' })).toBe('#/session/sess_MMfEnwxx9YI');
});

test('B11: the hash wins over the query; no query → plain hash routing', () => {
  expect(parseLocation({ hash: '#/session/sess_hash', search: '?session=sess_query' })).toEqual({ view: 'session', id: 'sess_hash' });
  expect(parseLocation({ hash: '#/settings/host', search: '?session=sess_query' })).toMatchObject({ view: 'settings', cat: 'host' });
  expect(parseLocation({ hash: '', search: '' })).toEqual({ view: 'home' });
  expect(parseLocation({ hash: '', search: '?foo=bar' })).toEqual({ view: 'home' });
  expect(parseLocation(undefined)).toEqual({ view: 'home' });
  expect(sessionFromSearch('?a=1&session=sess_z')).toBe('sess_z');
  expect(sessionFromSearch('')).toBe('');
});
