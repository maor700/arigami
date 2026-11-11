// RESUME — the host half's pure parts: the v2 list diet (slimHeavy), the
// reconnect cursor (RevTracker: delta, tombstones, boot/floor fallbacks to a
// full snapshot) and the response-compression negotiation.
import { test, expect } from 'bun:test';
import zlib from 'node:zlib';
import { slimHeavy, slimMessage, sessionIdOf, mcpSig, RevTracker } from '../server/lib/wire-resume.ts';
import { pickEncoding, compress, compressibleType } from '../server/lib/http-compress.ts';

const heavy = () => ({
  id: 's1',
  title: 'one',
  claude: {
    state: 'idle',
    capabilities: { slim: true, model: 'opus', skills: ['a', 'b', 'c'], mcpServers: [{ name: 'x', status: 'connected' }], counts: { tools: 9 } },
    mcp: { checkedAt: 5, servers: { x: { status: 'connected', statusText: 'ready', at: 1 }, y: { status: 'failed', at: 2 } } },
    mcpLoaded: { at: 7, servers: [{ name: 'x', via: 'gateway', kind: 'extension' }] },
  },
  changesExplanations: {
    pr: { generatedAt: '2026-10-01T00:00:00Z', mode: 'pr', files: [{ path: 'a' }], features: [] },
    uncommitted: { generatedAt: '2026-10-02T00:00:00Z', mode: 'uncommitted', files: [], features: [] },
  },
  metadata: { pr: 12 },
});

test('slimHeavy drops what the rail never renders and leaves stamps in its place', () => {
  const s = heavy();
  const out = slimHeavy(s);
  expect(out.claude.capabilities).toEqual({ slim: true, model: 'opus', counts: { tools: 9, skills: 3, mcpServers: 1 } });
  expect(out.claude.mcp).toEqual({ checkedAt: 5, slim: true, sig: mcpSig(s.claude.mcp.servers), count: 2 });
  expect(out.claude.mcpLoaded).toEqual({ at: 7, count: 1, slim: true });
  expect((out as any).changesExplanations).toBeUndefined();
  expect((out as any).changesExplained).toEqual({ pr: '2026-10-01T00:00:00Z', uncommitted: '2026-10-02T00:00:00Z' });
  // everything else is untouched, and the input is not mutated
  expect(out.title).toBe('one');
  expect(out.metadata).toBe(s.metadata);
  expect(s.claude.capabilities.skills).toHaveLength(3);
  expect(s.changesExplanations.pr.files).toHaveLength(1);
});

test('slimHeavy is the identity for a session with nothing heavy (and for non-objects)', () => {
  const s = { id: 's2', claude: { state: 'idle', capabilities: { slim: true, counts: {} } } };
  expect(slimHeavy(s)).toBe(s);
  expect(slimHeavy(null as any)).toBe(null);
});

test('mcpSig moves with a status or a timestamp, not with key order', () => {
  const a = mcpSig({ x: { status: 'connected', at: 1 }, y: { status: 'failed', at: 2 } });
  expect(mcpSig({ y: { status: 'failed', at: 2 }, x: { status: 'connected', at: 1 } })).toBe(a);
  expect(mcpSig({ x: { status: 'failed', at: 1 }, y: { status: 'failed', at: 2 } })).not.toBe(a);
  expect(mcpSig({ x: { status: 'connected', at: 3 }, y: { status: 'failed', at: 2 } })).not.toBe(a);
});

test('slimMessage slims an embedded session only', () => {
  const m = { type: 'session-updated', session: heavy() };
  const out = slimMessage(m);
  expect(out.session.changesExplained).toBeDefined();
  expect(out.session.changesExplanations).toBeUndefined();
  const chat = { type: 'chat', sessionId: 's1', event: { kind: 'user', text: 'x' } };
  expect(slimMessage(chat)).toBe(chat);
});

test('sessionIdOf reads every shape the bus uses', () => {
  expect(sessionIdOf({ type: 'session-updated', session: { id: 'a' } })).toBe('a');
  expect(sessionIdOf({ type: 'chat', sessionId: 'b' })).toBe('b');
  expect(sessionIdOf({ type: 'chat:c' })).toBe('c');
  expect(sessionIdOf({ type: 'progress', payload: { sessionId: 'd' } })).toBe('d');
  expect(sessionIdOf({ type: 'session-deleted', id: 'e' })).toBe('e');
  expect(sessionIdOf({ type: 'session-deleted', payload: 'f' })).toBe('f');
  expect(sessionIdOf({ type: 'health', health: [] })).toBe(null);
  expect(sessionIdOf({ type: 'folders-updated', folders: [] })).toBe(null);
});

test('RevTracker: a known cursor gets only what changed since, deletes included', () => {
  const t = new RevTracker('boot1');
  t.note({ type: 'session-updated', session: { id: 'a' } }); // 1
  t.note({ type: 'session-updated', session: { id: 'b' } }); // 2
  expect(t.note({ type: 'health', health: [] })).toBe(null); // not about a session: no bump
  const cur = t.rev;
  expect(cur).toBe(2);
  t.note({ type: 'chat', sessionId: 'a' }); // 3
  t.note({ type: 'session-created', session: { id: 'c' } }); // 4
  t.note({ type: 'session-deleted', id: 'b' }); // 5
  expect(t.since(cur, 'boot1')).toEqual({ full: false, changed: ['a', 'c'], deleted: ['b'] });
  expect(t.since(String(t.rev), 'boot1')).toEqual({ full: false, changed: [], deleted: [] });
  // a session deleted and then re-created comes back as changed, not deleted
  t.note({ type: 'session-created', session: { id: 'b' } });
  expect(t.since(cur, 'boot1')).toEqual({ full: false, changed: ['a', 'c', 'b'], deleted: [] });
});

test('RevTracker: unknown boot, bad or future cursor, or a forgotten tombstone → full snapshot', () => {
  const t = new RevTracker('boot1', 2);
  t.note({ type: 'session-updated', session: { id: 'a' } });
  expect(t.since(1, 'other-boot')).toEqual({ full: true });
  expect(t.since(99, 'boot1')).toEqual({ full: true });
  expect(t.since(-1, 'boot1')).toEqual({ full: true });
  expect(t.since('x', 'boot1')).toEqual({ full: true });
  expect(t.since(undefined, 'boot1')).toEqual({ full: true });
  // three deletes with room for two tombstones: the oldest is forgotten, so a
  // cursor from before it can no longer be served a delta
  t.note({ type: 'session-deleted', id: 'x' }); // 2
  t.note({ type: 'session-deleted', id: 'y' }); // 3
  t.note({ type: 'session-deleted', id: 'z' }); // 4 → drops x (rev 2)
  expect(t.since(1, 'boot1')).toEqual({ full: true });
  expect(t.since(2, 'boot1')).toEqual({ full: false, changed: [], deleted: ['y', 'z'] });
});

test('pickEncoding: br over gzip, q=0 refuses, nothing asked → identity', () => {
  expect(pickEncoding('gzip, deflate, br')).toBe('br');
  expect(pickEncoding('gzip')).toBe('gzip');
  expect(pickEncoding('br;q=0, gzip')).toBe('gzip');
  expect(pickEncoding('gzip;q=0')).toBe(null);
  expect(pickEncoding('*')).toBe('gzip');
  expect(pickEncoding('identity')).toBe(null);
  expect(pickEncoding(undefined)).toBe(null);
  expect(pickEncoding(['gzip', 'br'])).toBe('br');
});

test('compress round-trips and only text-ish types qualify', () => {
  const body = JSON.stringify({ sessions: Array.from({ length: 50 }, (_, i) => ({ id: `s${i}`, title: 'same title again' })) });
  expect(zlib.gunzipSync(compress(body, 'gzip')!).toString()).toBe(body);
  expect(zlib.brotliDecompressSync(compress(body, 'br', 'max')!).toString()).toBe(body);
  expect(compress(body, 'gzip')!.length).toBeLessThan(body.length / 4);
  expect(compress(body, null)).toBe(null);
  expect(compressibleType('text/javascript; charset=utf-8')).toBe(true);
  expect(compressibleType('application/json')).toBe(true);
  expect(compressibleType('image/svg+xml')).toBe(true);
  expect(compressibleType('font/woff2')).toBe(false);
  expect(compressibleType('image/png')).toBe(false);
});
