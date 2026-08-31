// A1 agents end-to-end against an ISOLATED host (tmp ARIGAMI_DIR, own port,
// auth off, stub claude): REST CRUD, create_session({agent}) inheritance
// (model, metadata.agent, color), unknown agent refused, home get-or-create,
// the MCP agent-card flow (pending → confirm → created / cancel), memory
// namespace over REST, activity endpoint, and the slim sessions list carrying
// the agent slug.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let host: ChildProcess;
let dir: string;
let base: string;

const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });

async function api(method: string, p: string, body?: unknown): Promise<any> {
  const r = await fetch(base + p, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  try {
    return { status: r.status, json: JSON.parse(text) };
  } catch {
    return { status: r.status, json: { raw: text } };
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T | null | undefined | false>, ms = 8000): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn();
    if (v) return v as T;
    await sleep(50);
  }
  throw new Error('condition not met in time');
}
const chat = async (sid: string): Promise<any[]> => (await api('GET', `/__api/sessions/${sid}/chat`)).json;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-A1-host-'));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  const stub = path.join(dir, 'claude-stub.sh');
  fs.writeFileSync(stub, '#!/bin/sh\nexec sleep 3600\n', { mode: 0o755 });
  host = spawn('bun', ['server/index.ts'], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOME: home,
      ARIGAMI_DIR: dir,
      ARIGAMI_PORT: String(port),
      ARIGAMI_AUTH: 'off',
      ARIGAMI_SCREEN_ENABLED: '0',
      ARIGAMI_CLAUDE_BIN: stub,
      ARIGAMI_WA_DATA_DIR: path.join(dir, 'wa'),
      ARIGAMI_TELEMETRY: '0',
      ARIGAMI_DEFAULT_CWD: path.join(dir, 'workspace'),
      COMPOSIO_API_KEY: '',
      GH_TOKEN: '',
      GITHUB_TOKEN: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  host.stdout!.on('data', (d) => (log += d));
  host.stderr!.on('data', (d) => (log += d));
  try {
    await until(async () => {
      try {
        return (await fetch(base + '/__api/config')).ok;
      } catch {
        return false;
      }
    }, 30000);
  } catch {
    throw new Error(`host did not come up: ${log.slice(-1500)}`);
  }
});

afterAll(() => {
  try {
    host?.kill('SIGTERM');
  } catch {}
});

test('REST: empty list → create → get → patch persona → list carries it', async () => {
  expect((await api('GET', '/__api/agents')).json.agents).toEqual([]);
  const c = await api('POST', '/__api/agents', { name: 'Marketing Lead', emoji: '📣', model: 'sonnet', persona: 'You write posts.', skills: ['dispatch'], budget: { tokensPerDay: 20000 } });
  expect(c.status).toBe(201);
  expect(c.json.slug).toBe('marketing-lead');
  const g = await api('GET', '/__api/agents/marketing-lead');
  expect(g.status).toBe(200);
  expect(g.json.persona).toBe('You write posts.');
  const p = await api('PATCH', '/__api/agents/marketing-lead', { persona: 'You write short posts.', tools: ['whatsapp'] });
  expect(p.status).toBe(200);
  expect(p.json.tools).toEqual(['whatsapp']);
  expect((await api('GET', '/__api/agents')).json.agents.map((a: any) => a.slug)).toEqual(['marketing-lead']);
  expect((await api('POST', '/__api/agents', { name: 'x', slug: 'marketing-lead' })).status).toBe(409);
  expect((await api('POST', '/__api/agents', { name: 'y', slug: 'y', skills: ['nope-zzz'] })).status).toBe(400);
  expect((await api('GET', '/__api/agents/ghost')).status).toBe(404);
});

test('create_session({agent}): inherits model + color, stamps metadata.agent, title defaults to the agent name; unknown agent → 404', async () => {
  const a = (await api('GET', '/__api/agents/marketing-lead')).json;
  const r = await api('POST', '/__api/sessions', { agent: 'marketing-lead', cwd: path.join(dir, 'workspace') });
  expect(r.status).toBe(201);
  expect(r.json.metadata.agent).toBe('marketing-lead');
  expect(r.json.claude.modelChoice).toBe('sonnet');
  expect(r.json.color).toBe(a.color);
  expect(r.json.title).toBe('Marketing Lead');
  // explicit model wins over the agent default
  const r2 = await api('POST', '/__api/sessions', { agent: 'marketing-lead', model: 'opus', title: 'custom', cwd: path.join(dir, 'workspace') });
  expect(r2.json.claude.modelChoice).toBe('opus');
  expect(r2.json.title).toBe('custom');
  expect(r2.json.metadata.agent).toBe('marketing-lead');
  // the slim list (what the rail reads) carries the slug
  const list = (await api('GET', '/__api/sessions')).json;
  expect(list.find((s: any) => s.id === r.json.id).metadata.agent).toBe('marketing-lead');
  const bad = await api('POST', '/__api/sessions', { agent: 'ghost', cwd: path.join(dir, 'workspace') });
  expect(bad.status).toBe(404);
  expect(bad.json.error).toMatch(/unknown agent/);
});

test('home: get-or-create is stable across calls and survives archiving', async () => {
  const h1 = await api('GET', '/__api/agents/marketing-lead/home');
  expect(h1.status).toBe(201);
  expect(h1.json.created).toBe(true);
  expect(h1.json.session.metadata.agent).toBe('marketing-lead');
  expect(h1.json.session.metadata.agentHome).toBe(true);
  const h2 = await api('GET', '/__api/agents/marketing-lead/home');
  expect(h2.status).toBe(200);
  expect(h2.json.created).toBe(false);
  expect(h2.json.session.id).toBe(h1.json.session.id);
  expect((await api('GET', '/__api/agents/marketing-lead')).json.homeSessionId).toBe(h1.json.session.id);
  await api('PATCH', `/__api/sessions/${h1.json.session.id}`, { archived: true });
  const h3 = await api('GET', '/__api/agents/marketing-lead/home');
  expect(h3.json.session.id).toBe(h1.json.session.id);
  expect(h3.json.session.archived).toBe(false);
});

test('MCP agent-card: confirm:true posts a pending card, nothing written; confirm from the web creates + patches the card and notes the session', async () => {
  const s = (await api('POST', '/__api/sessions', { title: 'pm', cwd: path.join(dir, 'workspace') })).json;
  const card = await api('POST', '/__mcp/agent-card', { session_id: s.id, action: 'create', confirm: true, draft: { name: 'Ops Bot', emoji: '🛠️', persona: 'Keep it up.' } });
  expect(card.status).toBe(200);
  expect(card.json.card).toBe(true);
  expect(card.json.state).toBe('pending');
  expect(card.json.slug).toBe('ops-bot');
  expect((await api('GET', '/__api/agents/ops-bot')).status).toBe(404);
  const ev = (await chat(s.id)).find((e) => e.kind === 'agent-card');
  expect(ev.state).toBe('pending');
  expect(ev.draft.name).toBe('Ops Bot');
  // the human edits the emoji and confirms
  const conf = await api('POST', '/__api/agents', { ...ev.draft, emoji: '🧰', cardId: ev.cardId, sessionId: s.id });
  expect(conf.status).toBe(201);
  expect(conf.json.emoji).toBe('🧰');
  const upd = await until(async () => (await chat(s.id)).find((e) => e.kind === 'agent-card-update' && e.cardId === ev.cardId));
  expect(upd.state).toBe('created');
  expect(upd.agent.slug).toBe('ops-bot');
  const note = await until(async () => (await chat(s.id)).find((e) => e.kind === 'user' && /confirmed the Agent card/.test(e.text || '')));
  expect(note.text).toContain('ops-bot');
  // duplicate draft is refused up front (no card)
  expect((await api('POST', '/__mcp/agent-card', { session_id: s.id, action: 'create', confirm: true, draft: { name: 'Ops Bot' } })).status).toBe(409);
  // cancel path
  const card2 = await api('POST', '/__mcp/agent-card', { session_id: s.id, action: 'create', confirm: true, draft: { name: 'Temp', slug: 'temp' } });
  await api('POST', `/__api/agents/cards/${card2.json.cardId}/cancel`, { sessionId: s.id });
  const canc = await until(async () => (await chat(s.id)).find((e) => e.kind === 'agent-card-update' && e.cardId === card2.json.cardId));
  expect(canc.state).toBe('cancelled');
  expect((await api('GET', '/__api/agents/temp')).status).toBe(404);
  // confirm:false creates at once; update_agent posts an "updated" card
  const now = await api('POST', '/__mcp/agent-card', { session_id: s.id, action: 'create', confirm: false, draft: { name: 'Quick', slug: 'quick' } });
  expect(now.json.state).toBe('created');
  expect((await api('GET', '/__api/agents/quick')).status).toBe(200);
  const up = await api('POST', '/__mcp/agent-card', { session_id: s.id, action: 'update', slug: 'quick', draft: { emoji: '⚡' } });
  expect(up.json.state).toBe('updated');
  expect(up.json.agent.emoji).toBe('⚡');
  expect((await api('POST', '/__mcp/agent-card', { session_id: 'sess_nope', action: 'create', draft: { name: 'x' } })).status).toBe(400);
});

test('memory REST: agent param namespaces writes/search/list; shared view stays clean', async () => {
  expect((await api('POST', '/__api/memory/write', { target: 'memory', action: 'add', content: 'Campaign OBSIDIAN ships in June', agent: 'marketing-lead' })).status).toBe(200);
  expect((await api('POST', '/__api/memory/write', { target: 'memory', action: 'add', content: 'Shared: office closed on Sunday' })).status).toBe(200);
  expect((await api('GET', '/__api/memory/search?query=OBSIDIAN')).json.hits).toEqual([]);
  const mine = (await api('GET', '/__api/memory/search?query=OBSIDIAN&agent=marketing-lead')).json.hits;
  expect(mine.length).toBe(1);
  expect(mine[0].scope).toBe('agent:marketing-lead');
  expect((await api('GET', '/__api/memory/search?query=Sunday&agent=marketing-lead')).json.hits).toEqual([]);
  const l = (await api('GET', '/__api/memory?agent=marketing-lead')).json;
  expect(l.files[0].path).toBe('agents/marketing-lead/MEMORY.md');
  expect(l.bootstrap.agentMd).toContain('OBSIDIAN');
  expect((await api('GET', '/__api/memory/get?path=agents/marketing-lead/MEMORY.md')).json.content).toContain('OBSIDIAN');
  expect(fs.existsSync(path.join(dir, 'agents/marketing-lead/memory/MEMORY.md'))).toBe(true);
});

test('activity lists the agent sessions (home flagged); delete removes the dir and keeps sessions', async () => {
  const act = (await api('GET', '/__api/agents/marketing-lead/activity')).json;
  expect(act.sessions.length).toBeGreaterThanOrEqual(3);
  expect(act.sessions.some((s: any) => s.home)).toBe(true);
  expect(Array.isArray(act.episodes)).toBe(true);
  expect((await api('DELETE', '/__api/agents/quick')).json.ok).toBe(true);
  expect(fs.existsSync(path.join(dir, 'agents/quick'))).toBe(false);
  expect((await api('GET', '/__api/agents/quick')).status).toBe(404);
  // sessions of a deleted agent are still there (they just lose the badge)
  const list = (await api('GET', '/__api/sessions?archived=true')).json;
  expect(list.some((s: any) => s.metadata?.agent === 'marketing-lead')).toBe(true);
});

// UX4: "can't delete an existing agent" — the rail's Team menu and the surface
// header both now call this same endpoint. Its job grew from "remove the
// dir" to also tearing down the two things that don't get to outlive the
// agent: the home chat (unreachable without the agent surface to open it
// from) and cron jobs born from it (which would otherwise throw "unknown
// agent" out of applyAgentToSession on every future fire — see fireCron).
test('delete: also removes the home chat session and cron jobs born from the agent; a work session survives, still carrying the (now stale) agent slug', async () => {
  const c = await api('POST', '/__api/agents', { name: 'Gone', slug: 'gone', persona: 'x' });
  expect(c.status).toBe(201);
  const home = await api('GET', '/__api/agents/gone/home');
  expect(home.status).toBe(201);
  const homeId = home.json.session.id;
  const work = await api('POST', '/__api/sessions', { agent: 'gone', cwd: path.join(dir, 'workspace') });
  expect(work.status).toBe(201);
  const workId = work.json.id;
  const cron = await api('POST', '/__api/triggers', {
    type: 'cron', name: 'gone cron', prompt: 'x', schedule: { kind: 'interval', value: '1d' }, agent: 'gone',
  });
  expect(cron.status).toBe(201);
  const otherCron = await api('POST', '/__api/triggers', {
    type: 'cron', name: 'unrelated', prompt: 'x', schedule: { kind: 'interval', value: '1d' },
  });
  expect(otherCron.status).toBe(201);

  const del = await api('DELETE', '/__api/agents/gone');
  expect(del.json.ok).toBe(true);
  expect(fs.existsSync(path.join(dir, 'agents/gone'))).toBe(false);

  expect((await api('GET', `/__api/sessions/${homeId}`)).status).toBe(404);
  const triggers = (await api('GET', '/__api/triggers')).json;
  expect(triggers.some((t: any) => t.id === cron.json.id)).toBe(false);
  expect(triggers.some((t: any) => t.id === otherCron.json.id)).toBe(true); // untouched, no agent

  const w = await api('GET', `/__api/sessions/${workId}`);
  expect(w.status).toBe(200);
  expect(w.json.metadata.agent).toBe('gone');

  // deleting an unknown agent still 404s (no side effects to worry about)
  expect((await api('DELETE', '/__api/agents/gone')).status).toBe(404);
});
