// RES1: the `health` bus event only fires when the queue CHANGES. If it emptied
// while the socket was down, nothing ever re-announces it — so the rail kept
// rendering a waiting badge for something already resolved until a full page
// reload. The store must re-pull /health on a genuine reconnect.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolate } from './_isolate.js';
isolate(); // restore globalThis/process.env after this file (bun test shares them)

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = (p) => path.join(ROOT, 'web/src', p);

let store;

// What GET /health answers, and how many times it was asked.
let HEALTH = { sessions: [], waiting: [] };
let healthCalls = 0;
// The fake socket the store opened, so the test can drive its lifecycle.
let socket = null;

beforeAll(async () => {
  const mem = new Map();
  globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  globalThis.window = globalThis;
  globalThis.location = { origin: 'http://host.test', port: '', pathname: '/', hash: '', protocol: 'http:', host: 'host.test' };
  globalThis.document = {
    documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} }, setAttribute() {}, classList: { add() {}, remove() {} }, dir: 'ltr' },
    body: {}, querySelector: () => null, addEventListener() {}, removeEventListener() {},
  };
  globalThis.navigator = { language: 'en-US', userAgent: 'test' };
  globalThis.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  globalThis.WebSocket = class {
    constructor() {
      socket = this;
    }
    close() {}
  };
  globalThis.fetch = async (url) => {
    const u = String(url);
    let body = {};
    if (u.includes('/auth/me')) body = { user: 'tester', authMode: 'off', hasAdmin: false, oidc: null };
    else if (u.includes('/health')) {
      healthCalls += 1;
      body = HEALTH;
    } else if (u.includes('/sessions')) body = [];
    else if (u.includes('/folders') || u.includes('/agents')) body = [];
    return { ok: true, status: 200, url: u, json: async () => body, text: async () => JSON.stringify(body) };
  };
  store = await import(web('lib/store.js'));
});

const tick = () => new Promise((r) => setTimeout(r, 10));

test('a reconnect re-pulls /health, so a queue that emptied offline stops showing', async () => {
  HEALTH = {
    sessions: [{ sessionId: 's1', title: 'one', state: 'WAITING_HUMAN', reason: 'review-requested', dot: 'amber', since: new Date().toISOString() }],
    waiting: [{ sessionId: 's1', title: 'one', kind: 'review', unblock: 'approve', since: new Date().toISOString(), agent: null }],
  };

  await store.afterLogin();
  await tick();
  expect(healthCalls).toBe(1);
  expect(store.getState().waiting).toHaveLength(1);
  expect(socket).not.toBeNull();

  // First open is the initial connection — nothing to re-sync yet.
  socket.onopen?.();
  await tick();
  expect(healthCalls).toBe(1);

  // The human resolves it (status leaves "In Review") while the socket is down,
  // so the clearing `health` broadcast never reaches this client.
  HEALTH = { sessions: [], waiting: [] };
  expect(store.getState().waiting).toHaveLength(1); // still stale, as before the fix

  // Reconnect: the store must re-pull the snapshot rather than trust the bus.
  socket.onopen?.();
  await tick();
  expect(healthCalls).toBe(2);
  expect(store.getState().waiting).toHaveLength(0);
});
