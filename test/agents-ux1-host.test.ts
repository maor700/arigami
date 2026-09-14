// UX1 against an ISOLATED host (tmp ARIGAMI_DIR, own port, auth off, stub
// claude): the migration of a live install whose agents already have home
// chats, `agentHome` as a host-only stamp, and the per-session cost the new
// "runs" tab reads.
//
// The state file is SEEDED before the host boots — that is exactly the shape a
// user upgrading into this build has: sessions stamped `agentHome`, and (in the
// interesting case) an agent record that no longer points at one of them.
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

const OLD_HOME = 'sess_uxhome1'; // the real one — created first
const NEW_HOME = 'sess_uxhome2'; // a duplicate an older build left behind
const WORK = 'sess_uxwork';

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
async function until<T>(fn: () => Promise<T | null | undefined | false>, ms = 30000): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn();
    if (v) return v as T;
    await sleep(50);
  }
  throw new Error('condition not met in time');
}

const seedSession = (id: string, title: string, metadata: Record<string, unknown>, at: string) => ({
  id,
  title,
  color: '#1F9C82',
  status: 'In Progress',
  cwd: path.join(dir, 'workspace'),
  archived: false,
  createdAt: at,
  updatedAt: at,
  metadata,
  progress: null,
  action: null,
  tabs: [{ id: `tab_${id}`, type: 'session', title: 'Session' }],
  activeTabId: `tab_${id}`,
  claude: { sessionId: null, state: 'idle', permissionMode: 'bypassPermissions', accountId: null, modelChoice: null, effort: null },
  bg: [],
});

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-UX1-host-'));
  fs.mkdirSync(path.join(dir, 'workspace'), { recursive: true });
  // An agent whose record LOST its homeSessionId (an export/import round-trip
  // strips it — see backup.ts exportBundle) while two of its sessions are still
  // stamped as home.
  fs.mkdirSync(path.join(dir, 'agents', 'nili'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'agents', 'nili', 'agent.json'),
    JSON.stringify({ slug: 'nili', name: 'Nili', emoji: '🌿', color: '#1F9C82', skills: [], createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z' }, null, 2),
  );
  fs.writeFileSync(path.join(dir, 'agents', 'nili', 'persona.md'), 'You keep the garden.\n');
  fs.writeFileSync(
    path.join(dir, 'state.json'),
    JSON.stringify({
      colorIndex: 0,
      sessions: [
        seedSession(OLD_HOME, 'Nili', { agent: 'nili', agentHome: true }, '2026-08-02T09:00:00.000Z'),
        seedSession(NEW_HOME, 'Nili', { agent: 'nili', agentHome: true }, '2026-08-02T10:00:00.000Z'),
        seedSession(WORK, 'water the beds', { agent: 'nili' }, '2026-08-02T11:00:00.000Z'),
      ],
      listeners: [],
      folders: [],
    }, null, 2),
  );
  // Ledger lines the "runs" tab reads for per-session cost.
  fs.writeFileSync(
    path.join(dir, 'agents', 'nili', 'activity.jsonl'),
    [
      { ts: new Date().toISOString(), kind: 'session', sessionId: WORK },
      { ts: new Date().toISOString(), kind: 'turn', sessionId: WORK, tokens: 1200, costUsd: 0.02, model: 'sonnet' },
      { ts: new Date().toISOString(), kind: 'turn', sessionId: WORK, tokens: 800, costUsd: 0.01, model: 'sonnet' },
      { ts: new Date().toISOString(), kind: 'turn', sessionId: OLD_HOME, tokens: 300, costUsd: 0.005, model: 'sonnet' },
    ].map((e) => JSON.stringify(e)).join('\n') + '\n',
  );

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
      // Pin these explicitly: bun test shares one process, and an earlier suite
      // may have set them for its own scratch dir — the seeded state.json below
      // is the whole point of this file.
      ARIGAMI_STATE_FILE: path.join(dir, 'state.json'),
      ARIGAMI_CHAT_DIR: path.join(dir, 'chat'),
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
        return (await fetch(base + '/__api/config', { signal: AbortSignal.timeout(3000) })).ok;
      } catch {
        return false;
      }
    });
  } catch {
    throw new Error(`host did not come up: ${log.slice(-1500)}`);
  }
}, 60_000); // the host boot below waits up to 30s; bun caps hooks at 5s by default

afterAll(() => {
  try {
    host?.kill('SIGTERM');
  } catch {}
});

test('migration: a live home chat is adopted (not re-created) and an extra home is demoted, keeping its transcript', async () => {
  // Before the first /home call the seeded sessions are untouched.
  expect((await api('GET', '/__api/agents/nili')).json.homeSessionId).toBeFalsy();
  const h = await api('GET', '/__api/agents/nili/home');
  expect(h.status).toBe(200); // adopted, NOT created
  expect(h.json.created).toBe(false);
  expect(h.json.session.id).toBe(OLD_HOME); // the oldest one is "the" home
  expect((await api('GET', '/__api/agents/nili')).json.homeSessionId).toBe(OLD_HOME);
  const list = (await api('GET', '/__api/sessions')).json;
  const homes = list.filter((s: any) => s.metadata?.agentHome && s.metadata?.agent === 'nili');
  expect(homes.map((s: any) => s.id)).toEqual([OLD_HOME]); // exactly one home per agent
  // the demoted duplicate is still there — same id, still the agent's, now a work session
  const demoted = list.find((s: any) => s.id === NEW_HOME);
  expect(demoted).toBeTruthy();
  expect(demoted.metadata.agent).toBe('nili');
  expect(demoted.metadata.agentHome).toBeFalsy();
  // …and it kept its chat (nothing was re-created)
  expect((await api('GET', `/__api/sessions/${NEW_HOME}`)).status).toBe(200);
});

test('agentHome is the host’s stamp: neither POST /sessions nor PATCH can set it', async () => {
  const withAgent = await api('POST', '/__api/sessions', { agent: 'nili', title: 'not a home', metadata: { agentHome: true }, cwd: path.join(dir, 'workspace') });
  expect(withAgent.status).toBe(201);
  expect(withAgent.json.metadata.agent).toBe('nili');
  expect(withAgent.json.metadata.agentHome).toBeUndefined();
  const plain = await api('POST', '/__api/sessions', { title: 'plain', metadata: { agentHome: true }, cwd: path.join(dir, 'workspace') });
  expect(plain.json.metadata.agentHome).toBeUndefined();
  const patched = await api('PATCH', `/__api/sessions/${plain.json.id}`, { metadata: { agentHome: true, note: 'x' } });
  expect(patched.json.metadata.agentHome).toBeUndefined();
  expect(patched.json.metadata.note).toBe('x'); // the rest of the patch still lands
});

test('activity: every session of the agent carries its own tokens/cost, and the home is flagged', async () => {
  const a = (await api('GET', '/__api/agents/nili/activity?range=today')).json;
  const byId = Object.fromEntries(a.sessions.map((s: any) => [s.id, s]));
  expect(byId[WORK].tokens).toBe(2000);
  expect(byId[WORK].costUsd).toBeCloseTo(0.03, 6);
  expect(byId[WORK].turns).toBe(2);
  expect(byId[WORK].home).toBe(false);
  expect(byId[OLD_HOME].home).toBe(true); // the runs tab filters this one out
  expect(byId[OLD_HOME].tokens).toBe(300);
  expect(byId[NEW_HOME].tokens).toBe(0); // no turns of its own
});
