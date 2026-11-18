// S15 caps for restricted sessions (server/profile-limits.ts) and the profile fields behind them and the sandbox's
// egress (server/session-profile.ts): narrowing never widens; the concurrency queue; the spend trip — no host.
import { test, expect, describe, beforeEach } from 'bun:test';
import * as sp from '../server/session-profile.ts';
import * as lim from '../server/profile-limits.ts';

describe('profile fields: egress and limits narrow, never widen', () => {
  const parent = sp.fromSpec({ name: 'p', tools: ['git'], egress: ['npm', 'pypi', 'example.com'], limits: { concurrent: 3, spendUsd: 5 }, maySpawn: true });
  test('normalize: bad egress entries and non-positive limits drop', () => {
    const n = sp.normalizeSpec({ egress: ['npm', 'http://x', 'A.B', ''], limits: { concurrent: 0, spendUsd: -1, tokens: 2.7 } as any });
    expect(n.egress).toEqual(['npm', 'a.b']);
    expect(n.limits).toEqual({ tokens: 2 });
  });
  test('a child asking for more egress or higher caps gets the intersection / the lower cap', () => {
    const kid = sp.narrow(parent, { tools: ['git'], egress: ['npm', 'github'], limits: { concurrent: 10, spendUsd: 1, tokens: 100 }, maySpawn: true }, 'p')!;
    expect(kid.egress).toEqual(['npm']);
    expect(kid.limits).toEqual({ concurrent: 3, spendUsd: 1, tokens: 100 });
    expect(sp.isWithin(kid, parent)).toBe(true);
  });
  test('a profile without limits inherits the parent caps; one that drops a cap is not within', () => {
    const kid = sp.narrow(parent, { tools: ['git'], egress: ['npm'], maySpawn: true }, 'p')!;
    expect(kid.limits).toEqual({ concurrent: 3, spendUsd: 5 });
    expect(sp.isWithin({ ...kid, limits: { concurrent: 3 } }, parent)).toBe(false);
    expect(sp.isWithin({ ...kid, egress: ['npm', 'github'] }, parent)).toBe(false);
  });
  test('absent egress = none (a stored profile from before the field opens nothing)', () => {
    expect(sp.fromSpec({ tools: ['git'] }).egress).toEqual([]);
    expect(sp.egressOf({} as any)).toEqual([]);
  });
});

type S = { id: string; engine?: string; archived?: boolean; title?: string; profile?: any; claude?: any };
describe('concurrency queue and spend trip', () => {
  let sessions: Map<string, S>;
  let sent: string[];
  let chat: Record<string, any[]>;
  let notes: any[];
  let interrupted: string[];
  const prof = (parent: string | null, limits: any) => ({ ...sp.fromSpec({ name: 'capped', tools: ['git'], limits }), parent });
  beforeEach(() => {
    lim._reset();
    sessions = new Map();
    sent = []; chat = {}; notes = []; interrupted = [];
    lim.wire({
      getSession: (id) => sessions.get(id) || null,
      listSessions: () => [...sessions.values()],
      send: (id) => { sent.push(id); sessions.get(id)!.claude = { state: 'working' }; },
      interrupt: (id) => { interrupted.push(id); sessions.get(id)!.claude = { state: 'idle' }; },
      kill: () => {},
      appendChat: (id, ev) => { (chat[id] ||= []).push(ev); },
      notify: (p) => { notes.push(p); },
    });
  });
  const add = (id: string, parent: string | null, limits: any, state = 'idle', engine = 'claude') => sessions.set(id, { id, engine, profile: prof(parent, limits), claude: { state, model: 'claude-haiku-x' } });

  test('a Full session is never gated or metered', () => {
    sessions.set('f', { id: 'f', claude: { state: 'idle' } });
    expect(lim.admit('f')).toEqual({ ok: true });
    lim.noteUsage('f', { output_tokens: 1e9 });
    expect(lim.usageOf('f')).toBe(null);
  });
  test('beyond the cap a turn waits; it starts when a slot frees; a mid-turn message adds no slot', () => {
    add('r', null, { concurrent: 1 }, 'working');
    add('k', 'r', { concurrent: 1 });
    expect(lim.admit('r')).toEqual({ ok: true }); // already working
    const a = lim.admit('k');
    expect(a.ok).toBe(false);
    if (!a.ok && a.queued) lim.enqueue('k', 'go', [], {}, a.note);
    expect(chat.k[0].text).toMatch(/waiting for a free slot/);
    lim.drain();
    expect(sent).toEqual([]);
    sessions.get('r')!.claude.state = 'idle';
    lim.drain();
    expect(sent).toEqual(['k']);
  });
  test('the tree is metered; over the cap every session gets a budget line, working ones stop, the owner is alerted, turns are refused', () => {
    add('r', null, { spendUsd: 1 });
    add('k1', 'r', { spendUsd: 1 }, 'working');
    add('k2', 'k1', { spendUsd: 1 });
    add('other', null, { spendUsd: 1 });
    lim.noteResult('k1', 0.4);
    lim.noteResult('k1', 0.7); // running total → +0.3
    expect(lim.usageOf('r')!.treeUsd).toBeCloseTo(0.7, 5);
    lim.noteUsage('k2', { output_tokens: 70_000 }, 'm1'); // haiku: $0.35 → 1.05
    expect(lim.usageOf('k2')!.tripped).toBeTruthy();
    for (const id of ['r', 'k1', 'k2']) expect(chat[id].some((e) => e.budget === true)).toBe(true);
    expect(chat.other).toBeUndefined();
    expect(interrupted).toEqual(['k1']);
    expect(notes.length).toBe(1);
    const a = lim.admit('k2');
    expect(a.ok === false && a.queued === false && a.error.status).toBe(429);
    expect(lim.admit('other')).toEqual({ ok: true });
  });
  test("a message's repeated usage (one event per content block) counts once; the engine's figure replaces the estimate", () => {
    add('r', null, { spendUsd: 100 });
    for (let i = 0; i < 5; i++) lim.noteUsage('r', { output_tokens: 1000 }, 'msg-1');
    expect(lim.usageOf('r')!.treeTokens).toBe(1000);
    lim.noteResult('r', 0.001);
    expect(lim.usageOf('r')!.treeUsd).toBeCloseTo(0.001, 6);
  });
  test('a child that names its own profile stays in its tree\'s concurrency bucket', () => {
    add('r', null, { concurrent: 1 }, 'working');
    sessions.set('k', { id: 'k', engine: 'claude', profile: { ...sp.fromSpec({ name: 'renamed', tools: ['git'], limits: { concurrent: 5 } }), limits: { concurrent: 1 }, parent: 'r' }, claude: { state: 'idle' } });
    const a = lim.admit('k');
    expect(a.ok).toBe(false);
  });
  test("a child's own lower cap trips its subtree only; the parent's cap still covers the child", () => {
    add('r', null, { spendUsd: 10 });
    add('k', 'r', { spendUsd: 0.1 }, 'working');
    lim.noteResult('k', 0.2);
    expect(lim.admit('k').ok).toBe(false);
    expect(lim.admit('r').ok).toBe(true);
    add('k2', 'r', { spendUsd: 10 });
    lim.noteResult('k2', 10);
    expect(lim.admit('r').ok).toBe(false);
  });
  test('codex: tokens only, against the token cap', () => {
    add('c', null, { tokens: 1000, spendUsd: 0.0001 }, 'idle', 'codex');
    lim.noteUsage('c', { input_tokens: 600 });
    lim.noteResult('c', null);
    expect(lim.usageOf('c')!.tripped).toBe(null);
    lim.noteUsage('c', { input_tokens: 500 });
    expect(lim.usageOf('c')!.tripped!.why).toMatch(/tokens/);
  });
});
