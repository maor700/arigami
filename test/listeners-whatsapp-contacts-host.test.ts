// WAFILT1 end-to-end against an ISOLATED host (tmp ARIGAMI_DIR, own port, auth
// off, stub claude, a stub whatsapp.db + a "connected" bridge status file whose
// pid is this test process, so the host never spawns a real bridge):
//   · POST a whatsapp listener with contacts:[phone, LID, name-substring, group]
//     → 201 with params.contacts = [{raw, jids (resolved), name}], the label
//     names the contacts, the group entry landed in group_subscriptions
//   · GET it back → same resolved shape (persisted, not just echoed)
//   · a legacy single `contact` string → one-element contacts array
//   · contacts as a plain string / non-string entries → 400
//   · an unresolvable name → 400
//   · DELETE removes the listener and the group subscription
import { test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let host: ChildProcess;
let dir: string;
let base: string;
let dbPath: string;

const PHONE = '972500000000@s.whatsapp.net';
const LID = '1234567890@lid';
const GROUP = '120363000000000000@g.us';
const OTHER = '972500000001@s.whatsapp.net';

const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
async function api(method: string, p: string, body?: unknown): Promise<any> {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  try { return { status: r.status, json: JSON.parse(text) }; } catch { return { status: r.status, json: { raw: text } }; }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T | null | undefined | false>, ms = 8000): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v as T; await sleep(50); }
  throw new Error('condition not met in time');
}
const subs = (): string[] => {
  const db = new DatabaseSync(dbPath, { open: true });
  try { return (db.prepare(`SELECT jid FROM group_subscriptions ORDER BY jid`).all() as any[]).map((r) => r.jid); }
  catch { return []; } finally { db.close(); }
};

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-WAFILT1-host-'));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const home = path.join(dir, 'home');
  const wa = path.join(dir, 'wa');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(wa, { recursive: true });
  fs.mkdirSync(path.join(dir, 'workspace'), { recursive: true });
  const stub = path.join(dir, 'claude-stub.sh');
  fs.writeFileSync(stub, '#!/bin/sh\nexec sleep 3600\n', { mode: 0o755 });
  // stub whatsapp.db (same schema the Baileys process writes)
  dbPath = path.join(wa, 'whatsapp.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE chats (jid TEXT PRIMARY KEY, name TEXT, last_message_time TEXT);
    CREATE TABLE messages (id TEXT, chat_jid TEXT, sender TEXT, content TEXT, timestamp TEXT, is_from_me INTEGER, PRIMARY KEY (id, chat_jid));
    CREATE TABLE contacts (jid TEXT PRIMARY KEY, name TEXT, notify TEXT, phone_number TEXT);
    INSERT INTO chats VALUES ('${LID}', NULL, '2026-09-01T10:00:00.000Z');
    INSERT INTO chats VALUES ('${OTHER}', NULL, '2026-09-01T10:00:00.000Z');
    INSERT INTO chats VALUES ('${GROUP}', 'צוות הפיתוח', '2026-09-01T10:00:00.000Z');
    INSERT INTO contacts VALUES ('${LID}', 'דנה', 'Dana', '972500000000');
    INSERT INTO contacts VALUES ('${OTHER}', 'שכן', NULL, NULL);
    INSERT INTO messages VALUES ('m0', '${LID}', '${LID}', 'old', '2026-09-01T10:00:00.000Z', 0);
  `);
  db.close();
  // "connected" bridge owned by a live pid (this test) → the host neither
  // answers needs_setup nor spawns a bridge of its own.
  fs.writeFileSync(path.join(wa, 'bridge-status.json'), JSON.stringify({ status: 'connected', pid: process.pid, user: 'test', ts: Date.now() }));
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
      ARIGAMI_WA_DATA_DIR: wa,
      ARIGAMI_WA_AUTOSTART: '0',
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
    await until(async () => { try { return (await fetch(base + '/__api/config')).ok; } catch { return false; } }, 30000);
  } catch {
    throw new Error(`host did not come up: ${log.slice(-1500)}`);
  }
});

afterAll(() => { try { host?.kill('SIGTERM'); } catch {} });

let sid = '';

test('register with contacts[] → resolved JIDs + names round-trip through POST and GET; group entry is subscribed', async () => {
  sid = (await api('POST', '/__api/sessions', { title: 'audit-wafilt1', cwd: path.join(dir, 'workspace') })).json.id;
  expect(sid).toBeTruthy();
  const r = await api('POST', `/__api/sessions/${sid}/listeners`, {
    type: 'whatsapp', contacts: ['+972 50-000 0000', LID, 'הפיתוח'], interval_sec: 3600,
  });
  expect(r.status).toBe(201);
  const l = r.json;
  expect(l.type).toBe('whatsapp');
  expect(l.label).toBe('WhatsApp: דנה, דנה, צוות הפיתוח');
  const cs = l.params.contacts;
  expect(cs).toHaveLength(3);
  expect(cs[0].raw).toBe('+972 50-000 0000');
  expect([...cs[0].jids].sort()).toEqual([PHONE, LID].sort());
  expect(cs[0].name).toBe('דנה');
  expect(cs[1]).toEqual({ raw: LID, jids: [LID], name: 'דנה' });
  expect(cs[2]).toEqual({ raw: 'הפיתוח', jids: [GROUP], name: 'צוות הפיתוח' });
  expect(subs()).toEqual([GROUP]);

  const g = await api('GET', `/__api/sessions/${sid}/listeners/${l.id}`);
  expect(g.status).toBe(200);
  expect(g.json.params.contacts).toEqual(cs);
  expect(g.json.log.some((e: any) => /contacts:/.test(e.text || e.msg || JSON.stringify(e)))).toBe(true);

  const list = await api('GET', `/__api/sessions/${sid}/listeners`);
  expect(list.json.find((x: any) => x.id === l.id)?.params.contacts).toEqual(cs);

  const d = await api('DELETE', `/__api/sessions/${sid}/listeners/${l.id}`);
  expect(d.json.ok).toBe(true);
  expect(subs()).toEqual([]);
});

test('legacy single `contact` string → one-element contacts array; group_jid + contacts coexist', async () => {
  const r = await api('POST', `/__api/sessions/${sid}/listeners`, { type: 'whatsapp', contact: '+972500000000', group_jid: GROUP, interval_sec: 3600 });
  expect(r.status).toBe(201);
  expect(r.json.params.contacts).toHaveLength(1);
  expect(r.json.params.contacts[0].jids).toContain(LID);
  expect(r.json.params.groupJid).toBe(GROUP);
  expect(r.json.label).toBe(`WhatsApp: דנה in ${GROUP}`);
  expect(subs()).toEqual([GROUP]);
  await api('DELETE', `/__api/sessions/${sid}/listeners/${r.json.id}`);
  expect(subs()).toEqual([]);
});

test('bad shapes are 400: string contacts, non-string entries, unresolvable name; empty array = no filter', async () => {
  const s1 = await api('POST', `/__api/sessions/${sid}/listeners`, { type: 'whatsapp', contacts: '+972500000000' });
  expect(s1.status).toBe(400);
  expect(String(s1.json.error || s1.json.raw)).toMatch(/one-element array/);
  const s2 = await api('POST', `/__api/sessions/${sid}/listeners`, { type: 'whatsapp', contacts: [123] });
  expect(s2.status).toBe(400);
  const s3 = await api('POST', `/__api/sessions/${sid}/listeners`, { type: 'whatsapp', contacts: ['nobody-here-xyz'] });
  expect(s3.status).toBe(400);
  expect(String(s3.json.error || s3.json.raw)).toMatch(/could not resolve/);
  const ok = await api('POST', `/__api/sessions/${sid}/listeners`, { type: 'whatsapp', contacts: [], interval_sec: 3600 });
  expect(ok.status).toBe(201);
  expect(ok.json.params.contacts).toEqual([]);
  expect(ok.json.label).toBe('WhatsApp messages');
  await api('DELETE', `/__api/sessions/${sid}/listeners/${ok.json.id}`);
  await api('DELETE', `/__api/sessions/${sid}`);
});
