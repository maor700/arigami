// BUGS1/B20 + B17 — one WhatsApp process, owned by the host.
//   · the host spawns whatsapp-mcp's main.ts ONCE and talks MCP to it; the
//     host-mcp `whatsapp` tool (whatsapp-proxy.callWhatsapp) reaches that same
//     process — no second client is ever spawned for a tool call
//   · logs land in the data dir (WHATSAPP_MCP_DATA_DIR), never in a cwd (B17)
//   · a process that keeps dying fast is NOT respawned forever: 3 strikes →
//     {status:'disconnected', reason:'crash-loop'}; an explicit start resets
//   · a live pid in the status file that belongs to someone else is left alone
//     (never a second client); an orphan is reclaimed
//   · ~/.claude.json: the legacy per-session `mcpServers.whatsapp` is retired,
//     backed up, idempotently; foreign `whatsapp` servers and everything else
//     are untouched
import { test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-B20-'));
const MCP_DIR = path.join(tmp, 'wa-mcp');
const DATA_DIR = path.join(tmp, 'wa-data');
const SPAWN_LOG = path.join(tmp, 'spawns.log');
fs.mkdirSync(path.join(MCP_DIR, 'src'), { recursive: true });
fs.mkdirSync(path.join(MCP_DIR, 'auth_info'), { recursive: true });
fs.writeFileSync(path.join(MCP_DIR, 'auth_info', 'creds.json'), '{}'); // "paired"
fs.copyFileSync(path.join(ROOT, 'test', '_fake-wa-mcp.ts'), path.join(MCP_DIR, 'src', 'main.ts'));
// the fake resolves the SDK from ROOT's node_modules
fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(MCP_DIR, 'node_modules'));

process.env.ARIGAMI_DIR = path.join(tmp, 'arigami');
process.env.ARIGAMI_WA_MCP_DIR = MCP_DIR;
process.env.ARIGAMI_WA_DATA_DIR = DATA_DIR;
process.env.ARIGAMI_WA_RUNNER = 'bun';
process.env.ARIGAMI_WA_RESTART_MS = '60';
process.env.FAKE_WA_SPAWN_LOG = SPAWN_LOG;

let wb: typeof import('../server/whatsapp-bridge.js');
let wp: typeof import('../server/whatsapp-proxy.js');
const until = async (f: () => boolean | Promise<boolean>, ms = 15000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await f()) return; await new Promise((r) => setTimeout(r, 50)); }
  throw new Error('timeout');
};
const spawns = () => (fs.existsSync(SPAWN_LOG) ? fs.readFileSync(SPAWN_LOG, 'utf8').trim().split('\n').filter(Boolean).length : 0);
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const wakes: string[] = [];
const wake = (_sid: string, text: string) => { wakes.push(text); };
// WA1: the bridge's console.error IS the host log (pm2 error log) — capture it.
const hostLog: string[] = [];
const realErr = console.error;
const captureLog = () => { hostLog.length = 0; console.error = (...a: unknown[]) => { hostLog.push(a.map(String).join(' ')); }; };
const releaseLog = () => { console.error = realErr; };

beforeAll(async () => {
  wb = await import('../server/whatsapp-bridge.js');
  wp = await import('../server/whatsapp-proxy.js');
});
afterAll(() => { try { wb.stopBridge(); } catch {} });

test('B20: one process — start, tool calls through the same pid, logs in the data dir (B17), stop', async () => {
  expect(wb.getBridgeStatus().status).toBe('disconnected');
  expect((await wp.callWhatsapp('list_chats', {}, 'read chats')) as any).toMatchObject({ needs_setup: 'whatsapp' });

  await wb.startBridge('sess_test', wake);
  await until(() => wb.getBridgeStatus().status === 'connected');
  const pid = wb.ownedPid()!;
  expect(pid).toBeGreaterThan(0);
  expect(JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'bridge-status.json'), 'utf8')).pid).toBe(pid);
  expect(wb.isBridgeRunning()).toBe(true);
  expect(spawns()).toBe(1);

  const r = (await wp.callWhatsapp('list_chats', { limit: 3 })) as any;
  expect(r.ok).toBe(true);
  const rows = JSON.parse(r.result[0].text);
  expect(rows[0].pid).toBe(pid); // served by THE process, not a second spawn
  expect(rows[0].limit).toBe(3);
  const bad = (await wp.callWhatsapp('send_message', { recipient: 'bad', message: 'x' })) as any;
  expect(bad).toEqual({ ok: false, error: 'Failed to send message' });
  expect(spawns()).toBe(1);

  // B17: the process logs next to its data, not in whatever cwd it was started from
  expect(fs.existsSync(path.join(DATA_DIR, 'wa-logs.txt'))).toBe(true);
  expect(fs.existsSync(path.join(MCP_DIR, 'wa-logs.txt'))).toBe(false);
  expect(fs.existsSync(path.join(ROOT, 'wa-logs.txt')) && fs.readFileSync(path.join(ROOT, 'wa-logs.txt'), 'utf8').includes(`pid=${pid}`)).toBe(false);

  // a second start is a no-op
  await wb.startBridge('sess_other', wake);
  expect(wb.ownedPid()).toBe(pid);
  expect(spawns()).toBe(1);
  await until(() => wakes.some((w) => w.includes('WhatsApp connected')));

  wb.stopBridge();
  await until(() => !alive(pid));
  expect(wb.ownedPid()).toBeNull();
  expect(wb.getBridgeStatus().status).toBe('disconnected');
  expect((await wp.callWhatsapp('list_chats')) as any).toMatchObject({ needs_setup: 'whatsapp' });
});

test('B20: a fast-dying process is restarted with backoff, then given up on (no infinite respawn)', async () => {
  const before = spawns();
  process.env.FAKE_WA_MODE = 'crash';
  captureLog();
  try {
    await wb.startBridge('sess_test', wake);
    await until(() => wb.getBridgeStatus().reason === 'crash-loop', 20000);
    expect(spawns() - before).toBe(3);
    await new Promise((r) => setTimeout(r, 400));
    expect(spawns() - before).toBe(3); // and stays there
    expect(wb.ownedPid()).toBeNull();
    expect(wb.getBridgeStatus().status).toBe('disconnected');
    expect((await wp.callWhatsapp('list_chats')) as any).toMatchObject({ needs_setup: 'whatsapp' });
    // WA1: the child's stderr and its exit code reach the host log — before, the
    // bridge spawned with stderr:'ignore' and logged only "exited after Ns".
    expect(hostLog.filter((l) => l.includes('[wa-mcp] fake main.ts: crashing on purpose')).length).toBe(3);
    expect(hostLog.filter((l) => l.includes('[wa-bridge]') && l.includes('exit code 1')).length).toBe(3);
  } finally {
    releaseLog();
    delete process.env.FAKE_WA_MODE;
  }
  // an explicit start resets the strike count and recovers once the cause is gone
  await wb.startBridge('sess_test', wake);
  await until(() => wb.getBridgeStatus().status === 'connected');
  expect(wb.getBridgeStatus().reason).toBeUndefined();
  wb.stopBridge();
  await until(() => wb.getBridgeStatus().status === 'disconnected');
});

test('B20: a live foreign owner is respected; an orphan is reclaimed', async () => {
  // foreign: a child of THIS process holds the status file → no second client
  const foreign = spawn('sleep', ['30']);
  await until(() => !!foreign.pid);
  fs.writeFileSync(path.join(DATA_DIR, 'bridge-status.json'), JSON.stringify({ status: 'connected', user: 'someone', pid: foreign.pid, ts: Date.now() }));
  const before = spawns();
  try {
    await wb.startBridge('sess_test', wake);
    expect(wb.ownedPid()).toBeNull();
    expect(spawns()).toBe(before);
    expect(wb.getBridgeStatus()).toMatchObject({ status: 'connected', user: 'someone' });
    const r = (await wp.callWhatsapp('list_chats')) as any;
    expect(r.ok).toBe(false);
    expect(r.error).toContain(String(foreign.pid));
    expect(alive(foreign.pid!)).toBe(true);
  } finally {
    foreign.kill('SIGKILL');
  }
  await until(() => !alive(foreign.pid!));

  // orphan: parent gone (double fork) → reclaimed, our process takes over
  const sh = spawn('sh', ['-c', 'sleep 30 & echo $!'], { stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  sh.stdout.on('data', (d) => (out += d));
  await until(() => sh.exitCode !== null);
  const orphan = Number(out.trim());
  expect(alive(orphan)).toBe(true);
  await until(() => { const p = wb.parentPid(orphan); return p === null || p === 1 || !alive(p); });
  fs.writeFileSync(path.join(DATA_DIR, 'bridge-status.json'), JSON.stringify({ status: 'connected', user: 'ghost', pid: orphan, ts: Date.now() }));
  await wb.startBridge('sess_test', wake);
  await until(() => wb.getBridgeStatus().status === 'connected' && wb.ownedPid() !== null);
  expect(alive(orphan)).toBe(false);
  expect(spawns()).toBe(before + 1);
  wb.stopBridge();
  await until(() => wb.getBridgeStatus().status === 'disconnected');
});

test('B20: autoStartBridge only with a checkout + pairing; ARIGAMI_WA_AUTOSTART=0 opts out', async () => {
  process.env.ARIGAMI_WA_AUTOSTART = '0';
  expect(await wb.autoStartBridge()).toEqual({ started: false, reason: 'ARIGAMI_WA_AUTOSTART=0' });
  delete process.env.ARIGAMI_WA_AUTOSTART;
  fs.renameSync(path.join(MCP_DIR, 'auth_info', 'creds.json'), path.join(MCP_DIR, 'auth_info', 'creds.bak'));
  expect(await wb.autoStartBridge()).toEqual({ started: false, reason: 'not paired' });
  fs.renameSync(path.join(MCP_DIR, 'auth_info', 'creds.bak'), path.join(MCP_DIR, 'auth_info', 'creds.json'));
  const r = await wb.autoStartBridge();
  expect(r.started).toBe(true);
  await until(() => wb.getBridgeStatus().status === 'connected');
  wb.stopBridge();
  await until(() => wb.getBridgeStatus().status === 'disconnected');
});

test('B20: ~/.claude.json legacy per-session registration is retired once, backed up, others untouched', () => {
  const file = path.join(tmp, 'claude.json');
  const legacy = { command: 'npx', args: ['tsx', '/home/x/.local/lib/whatsapp-mcp/src/main.ts'], env: { NODE_PATH: '/home/x/.local/lib/whatsapp-mcp/node_modules' } };
  const cfg = {
    numStartups: 3,
    mcpServers: { 'composio-mcp': { command: 'node', args: ['/x/composio'] }, whatsapp: legacy, linear: { type: 'http', url: 'https://mcp.linear.app/mcp' } },
    projects: {
      '/home/x/repos': { allowedTools: [], mcpServers: { whatsapp: { command: 'npx', args: ['tsx', '/opt/whatsapp-mcp/src/main.ts'] } } },
      '/home/x/other': { mcpServers: { whatsapp: { type: 'http', url: 'https://example.com/wa' } } },
    },
  };
  fs.writeFileSync(file, JSON.stringify(cfg), { mode: 0o600 });
  const backupDir = path.join(tmp, 'backup');
  const logs: string[] = [];
  const r = wb.migrateLegacyMcpRegistration({ file, backupDir, log: (m) => logs.push(m) });
  expect(r).toMatchObject({ migrated: true, removed: ['user', 'project:/home/x/repos'] });
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  expect(after.mcpServers.whatsapp).toBeUndefined();
  expect(after.mcpServers['composio-mcp']).toEqual(cfg.mcpServers['composio-mcp']);
  expect(after.mcpServers.linear).toEqual(cfg.mcpServers.linear);
  expect(after.numStartups).toBe(3);
  expect(after.projects['/home/x/repos'].mcpServers.whatsapp).toBeUndefined();
  expect(after.projects['/home/x/repos'].allowedTools).toEqual([]);
  expect(after.projects['/home/x/other'].mcpServers.whatsapp).toEqual({ type: 'http', url: 'https://example.com/wa' }); // not ours → kept
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  const bk = JSON.parse(fs.readFileSync(r.backup!, 'utf8'));
  expect(bk.user).toEqual(legacy);
  expect(bk.projects['/home/x/repos'].args[1]).toBe('/opt/whatsapp-mcp/src/main.ts');
  expect(logs.join('\n')).toMatch(/retired the per-session WhatsApp MCP registration/);
  // idempotent
  expect(wb.migrateLegacyMcpRegistration({ file, backupDir })).toEqual({ migrated: false, removed: [] });
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(after);
  // missing / broken file → nothing written, no throw
  expect(wb.migrateLegacyMcpRegistration({ file: path.join(tmp, 'nope.json'), backupDir })).toEqual({ migrated: false, removed: [] });
  fs.writeFileSync(path.join(tmp, 'broken.json'), '{not json');
  expect(wb.migrateLegacyMcpRegistration({ file: path.join(tmp, 'broken.json'), backupDir }).error).toMatch(/unparsable/);
  expect(fs.readFileSync(path.join(tmp, 'broken.json'), 'utf8')).toBe('{not json');
  // the detector
  expect(wb.isLegacyWhatsappServer({ command: 'npx', args: ['tsx', 'C:\\Users\\x\\whatsapp-mcp\\src\\main.ts'] })).toBe(true);
  expect(wb.isLegacyWhatsappServer({ command: 'npx', args: ['tsx', '/x/whatsapp-mcp/src/bridge-entry.ts'] })).toBe(true);
  expect(wb.isLegacyWhatsappServer({ command: 'node', args: ['/x/some-other-mcp/main.ts'] })).toBe(false);
  expect(wb.isLegacyWhatsappServer({ type: 'http', url: 'https://x' })).toBe(false);
  expect(wb.isLegacyWhatsappServer(null)).toBe(false);
});

test('WA1: a logged-out pairing (WhatsApp 401) is not retried; Connect/Show QR moves it aside and shows a QR; a scan → connected for every session', async () => {
  // Regression for 2026-09-02: the host respawned main.ts against creds WhatsApp
  // had unlinked (401 on every login), main.ts exits before the QR step, the
  // reason was in wa-logs.txt only, and "Show QR" showed nothing.
  const creds = path.join(MCP_DIR, 'auth_info', 'creds.json');
  expect(fs.existsSync(creds)).toBe(true);
  const before = spawns();
  process.env.FAKE_WA_MODE = 'logged-out';
  captureLog();
  try {
    await wb.startBridge('sess_test', wake);
    await until(() => wb.getBridgeStatus().reason === 'logged-out', 20000);
    await new Promise((r) => setTimeout(r, 400));
    expect(spawns() - before).toBe(1); // ONE attempt — a dead pairing is never retried
    expect(wb.ownedPid()).toBeNull();
    expect(wb.getBridgeStatus()).toMatchObject({ status: 'disconnected', reason: 'logged-out' });
    expect(wb.pairingLoggedOut()).toBe(true);
    expect(fs.existsSync(creds)).toBe(true); // nothing touched auth_info by itself
    // the reason is in the host log, read back from the child's own log for that pid
    expect(hostLog.some((l) => l.includes('[wa-bridge]') && l.includes('reason: loggedOut') && l.includes('logged this device out'))).toBe(true);
    expect(wakes.some((w) => w.includes('logged this device out'))).toBe(true);
    // the capability every session reads says why, and the tool says needs_setup
    const caps = await import('../server/capabilities.js');
    const st = await caps.statusOf(caps.getCapability('whatsapp')!);
    expect(st.ok).toBe(false);
    expect(st.detail).toContain('Show QR');
    expect((st as any).data?.reason).toBe('logged-out');
    expect((await wp.callWhatsapp('list_chats')) as any).toMatchObject({ needs_setup: 'whatsapp' });
    // boot and internal restarts do not touch it either
    expect((await wb.autoStartBridge()).started).toBe(false);
    expect((await wb.autoStartBridge()).reason).toMatch(/^logged-out/);
    await wb.startBridge('sess_test', wake, { internal: true });
    await until(() => wb.getBridgeStatus().reason === 'logged-out', 20000);
    expect(spawns() - before).toBe(2);
    expect(fs.existsSync(creds)).toBe(true);
  } finally {
    releaseLog();
    delete process.env.FAKE_WA_MODE;
  }

  // Settings → Connections → Show QR (POST /whatsapp/connect → startBridge {repair:true}):
  // the dead auth_info is moved aside (kept), main.ts pairs afresh → QR
  wakes.length = 0;
  await wb.startBridge('sess_ui', wake, { repair: true });
  await until(() => wb.getBridgeStatus().status === 'qr', 20000);
  const backups = fs.readdirSync(MCP_DIR).filter((n) => n.startsWith('auth_info.logged-out-'));
  expect(backups.length).toBe(1);
  expect(fs.existsSync(path.join(MCP_DIR, backups[0], 'creds.json'))).toBe(true); // kept, not deleted
  expect(fs.existsSync(creds)).toBe(false);
  expect(wb.isPaired()).toBe(false);
  const q = wb.getBridgeStatus();
  expect(q.qr).toMatch(/^https:\/\/quickchart\.io\/qr\?text=fake-qr-/);
  expect(q.qrUrl).toBe(q.qr);
  expect(q.reason).toBeUndefined();
  await until(() => wakes.some((w) => w.includes('QR ready')));
  expect(spawns() - before).toBe(3);
  const caps = await import('../server/capabilities.js');
  expect((await caps.statusOf(caps.getCapability('whatsapp')!)).detail).toContain('scan the QR');

  // the human scans → connected; a NEW session's capability probe reads connected (no re-pair)
  fs.writeFileSync(path.join(DATA_DIR, 'fake-scanned'), '');
  await until(() => wb.getBridgeStatus().status === 'connected');
  expect(fs.existsSync(creds)).toBe(true);
  expect(wb.isPaired()).toBe(true);
  expect(wb.pairingLoggedOut()).toBe(false);
  const fresh = await caps.statusOf(caps.getCapability('whatsapp')!);
  expect(fresh.ok).toBe(true);
  expect(fresh.detail).toContain('Fake User');
  expect(((await wp.callWhatsapp('list_chats', { limit: 1 })) as any).ok).toBe(true);
  expect(spawns() - before).toBe(3); // still the one process

  wb.stopBridge();
  await until(() => wb.getBridgeStatus().status === 'disconnected');
  fs.rmSync(path.join(DATA_DIR, 'fake-scanned'), { force: true });
  for (const b of backups) fs.rmSync(path.join(MCP_DIR, b), { recursive: true, force: true });
});
