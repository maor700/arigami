// Managed WhatsApp bridge — the host owns the ONE WhatsApp process.
//
// BUGS1/B20 (single path). Before: three kinds of Baileys clients fought over
// the same auth_info — the bridge-entry the host spawned for listeners, a
// second `main.ts` the host's tool proxy spawned lazily, and one more `main.ts`
// per SESSION via the user-scope `mcpServers.whatsapp` in ~/.claude.json (that
// one ran in the session's cwd, which is where the stray wa-logs.txt /
// mcp-logs.txt came from — B17). WhatsApp allows one client per linked device,
// so every newcomer got "replaced"/conflict, exited, and was restarted:
// 1,114 conflicts + 912 logged-out in one wa-logs.txt.
//
// Now: the host spawns whatsapp-mcp's `main.ts` (Baileys connection + SQLite
// writer + MCP stdio server, all in one process) exactly once, as an MCP client
// over its stdio. Listeners read the DB it fills; the host-mcp `whatsapp` tool
// (whatsapp-proxy.ts) calls tools on that same process. The legacy per-session
// registration is retired by migrateLegacyMcpRegistration() at boot (backed
// up, idempotent). Nothing here touches auth_info — the pairing is untouched.
//
// The status file (bridge-status.json) written by whatsapp.ts on every state
// change stays the source of truth for "connected/qr/starting"; `pid` in it is
// the process that wrote it (used to detect a stale file and foreign owners).

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ARIGAMI_DIR } from './lib/instance.js';

type WakeFn = (sessionId: string, text: string, key: string) => void;

// Where the whatsapp-mcp checkout lives (B2). Native installs keep the legacy
// ~/.local/lib/whatsapp-mcp; the Docker image clones it at build time into
// /opt/whatsapp-mcp and sets ARIGAMI_WA_MCP_DIR. The Baileys auth state is
// hardcoded upstream to <checkout>/auth_info, so in the image the entrypoint
// symlinks that directory onto the /data volume. The message DB + status file
// (WHATSAPP_MCP_DATA_DIR upstream) can be moved independently with
// ARIGAMI_WA_DATA_DIR — the image points it at /data/.arigami/whatsapp/data.
export const WA_MCP_DIR = process.env.ARIGAMI_WA_MCP_DIR
  || path.join(os.homedir(), '.local/lib/whatsapp-mcp');
/** The one process: connection + DB + MCP over stdio (upstream's entry point). */
export const WA_MAIN = path.join(WA_MCP_DIR, 'src/main.ts');
/** Legacy connection-only entry (pre-B20); kept exported for callers, no longer spawned. */
export const WA_ENTRY = path.join(WA_MCP_DIR, 'src/bridge-entry.ts');
export const WA_AUTH_DIR = path.join(WA_MCP_DIR, 'auth_info');
export const WA_DATA_DIR = process.env.ARIGAMI_WA_DATA_DIR || path.join(WA_MCP_DIR, 'data');
export const WA_DB_PATH = path.join(WA_DATA_DIR, 'whatsapp.db');
const STATUS_FILE = path.join(WA_DATA_DIR, 'bridge-status.json');
// main.ts writes its fatal ("Connection closed. Reason: loggedOut") to these,
// never to stderr — the bridge reads them back to say WHY a process died (WA1).
const WA_LOG_FILE = path.join(WA_DATA_DIR, 'wa-logs.txt');
const MCP_LOG_FILE = path.join(WA_DATA_DIR, 'mcp-logs.txt');
const STDERR_MAX_LINES = 200; // of the child's stderr forwarded per spawn

// How the checkout is run: `npx tsx <main.ts>` natively and in the image (tsx is
// global there). Tests point this at `bun` with a fake main.ts.
const RUNNER = (process.env.ARIGAMI_WA_RUNNER || 'npx tsx').trim().split(/\s+/);

// Restart policy. A process that dies within FAST_EXIT_MS of its spawn is a
// "fast exit" (logged-out creds → 401 → exit 1; a conflict with a foreign
// client; a missing dependency). Three in a row → give up and say so in the
// status file instead of respawning a ~270MB tsx tree every 5s forever (the
// pre-B20 loop). An explicit startBridge() (UI connect, request_setup, a
// listener) resets the counter.
const RESTART_DELAY_MS = Math.max(50, Number(process.env.ARIGAMI_WA_RESTART_MS) || 5_000);
const FAST_EXIT_MS = Math.max(100, Number(process.env.ARIGAMI_WA_FAST_EXIT_MS) || 60_000);
const MAX_FAST_EXITS = 3;
const CONNECT_TIMEOUT_MS = 90_000; // main.ts fetches the Baileys version before it serves MCP

export type BridgeStatus = 'disconnected' | 'starting' | 'qr' | 'connected';
/** Why the bridge is 'disconnected' and not trying: crash-loop (3 fast exits), logged-out (WhatsApp 401 — the pairing is dead), creds-corrupt (auth_info/creds.json is empty or not JSON — CONN1), not-installed. */
export type BridgeReason = 'crash-loop' | 'logged-out' | 'creds-corrupt' | 'not-installed';

// ---- status file ------------------------------------------------------------

interface StatusFile {
  status: BridgeStatus;
  user?: string | null;
  qrUrl?: string | null;
  pid?: number | null;
  ts?: number;
  reason?: BridgeReason | string;
}

function readStatusFile(): StatusFile {
  try {
    const raw = fs.readFileSync(STATUS_FILE, 'utf8');
    return JSON.parse(raw) as StatusFile;
  } catch {
    return { status: 'disconnected' };
  }
}

function writeStatusFile(s: StatusFile): void {
  try {
    fs.mkdirSync(WA_DATA_DIR, { recursive: true });
    fs.writeFileSync(STATUS_FILE, JSON.stringify({ ...s, ts: Date.now() }));
  } catch {}
}

function pidAlive(pid: number | null | undefined): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Parent pid (Linux /proc, `ps` elsewhere); null when unknown/dead. */
export function parentPid(pid: number): number | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const ppid = Number(after[1]);
    return Number.isFinite(ppid) ? ppid : null;
  } catch {}
  try {
    const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
    const out = execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    const ppid = Number(out);
    return Number.isFinite(ppid) ? ppid : null;
  } catch {
    return null;
  }
}

export function getBridgeStatus(): { status: BridgeStatus; qrUrl: string | null; qr: string | null; user: string | null; reason?: string } {
  const s = readStatusFile();
  // If the PID from the status file is dead, treat as disconnected
  if (s.pid && s.status !== 'disconnected' && !pidAlive(s.pid)) return { status: 'disconnected', qrUrl: null, qr: null, user: null };
  // `qr` (B3 wizard) is the same data-URL as `qrUrl` — the wizard renders it inline.
  const qr = s.qrUrl ?? null;
  return { status: s.status, qrUrl: qr, qr, user: s.user ?? null, ...(s.reason ? { reason: s.reason } : {}) };
}

// ---- process management -----------------------------------------------------

let transport: any = null; // StdioClientTransport of OUR main.ts
let clientReady: Promise<any> | null = null; // resolves to the MCP Client once initialised
let spawnedAt = 0;
let fastExits = 0;
let stopping = false;
let restartTimer: ReturnType<typeof setTimeout> | null = null;
let _lastSessionId: string | null = null;
let _lastWakeFn: WakeFn | null = null;
const ownPids = new Set<number>(); // every pid this host ever spawned — never "foreign"

/** pid of the main.ts THIS host spawned (null when none). */
export function ownedPid(): number | null {
  return transport?.pid ?? null;
}

export function isBridgeRunning(): boolean {
  if (ownedPid()) return true;
  const s = readStatusFile();
  return pidAlive(s.pid);
}

const CREDS_FILE = path.join(WA_AUTH_DIR, 'creds.json');

/**
 * CONN1: a creds.json that exists but is empty or not a JSON object. Seen live on
 * 2026-09-02 20:06Z: several WhatsApp processes (the pre-B20 per-session trees)
 * wrote the same Baileys auth_info at once and left a 0-byte creds.json. Baileys
 * then treats the device as unregistered — every start since sat on a QR that
 * nobody was told to scan, while isPaired() (file exists) kept saying "paired".
 */
export function credsCorrupt(): boolean {
  let raw: string;
  try {
    raw = fs.readFileSync(CREDS_FILE, 'utf8');
  } catch {
    return false; // no file = plain unpaired, not corrupt
  }
  if (!raw.trim()) return true;
  try {
    const j = JSON.parse(raw);
    return !j || typeof j !== 'object';
  } catch {
    return true;
  }
}

/** A usable pairing: creds.json exists AND is not corrupt. */
export function isPaired(): boolean {
  return fs.existsSync(CREDS_FILE) && !credsCorrupt();
}

// CONN1: Baileys rewrites creds.json with a plain (truncate-then-write) writeFile
// on every key rotation (~every 10 min while connected). A host restart that
// kills the process mid-write — 2026-09-02 17:06Z, the good process had just
// logged "Credentials saved." when the host went down — leaves a 0-byte file and
// the pairing is gone for good. So every time the bridge sees 'connected' it
// keeps a copy of the last known-good creds.json next to the auth dir, and a
// start that finds the live file damaged restores that copy instead of asking
// the human to scan again. (Slightly stale creds are fine for Baileys: pre-key
// counters re-sync; a truly revoked pairing still ends in the logged-out path.)
const CREDS_SNAPSHOT = path.join(WA_MCP_DIR, 'auth_info.creds.last-good.json');

/** Copy a valid creds.json aside (no-op when the live file is empty/not JSON or unchanged). */
export function snapshotCreds(): boolean {
  if (credsCorrupt() || !fs.existsSync(CREDS_FILE)) return false;
  try {
    const raw = fs.readFileSync(CREDS_FILE, 'utf8');
    if (fs.existsSync(CREDS_SNAPSHOT) && fs.readFileSync(CREDS_SNAPSHOT, 'utf8') === raw) return true;
    fs.writeFileSync(`${CREDS_SNAPSHOT}.tmp`, raw, { mode: 0o600 });
    fs.renameSync(`${CREDS_SNAPSHOT}.tmp`, CREDS_SNAPSHOT); // atomic — never a half-written snapshot
    return true;
  } catch (e) {
    console.error(`[wa-bridge] could not snapshot creds.json: ${(e as Error).message}`);
    return false;
  }
}

/** Is there a usable snapshot to restore a damaged creds.json from? */
export function credsSnapshotUsable(): boolean {
  try {
    const j = JSON.parse(fs.readFileSync(CREDS_SNAPSHOT, 'utf8'));
    return !!j && typeof j === 'object';
  } catch {
    return false;
  }
}

/**
 * Damaged live creds.json + a usable snapshot → put the snapshot back (the damaged
 * file is kept as creds.json.damaged-<ts> for forensics). false = nothing restored.
 */
export function restoreCredsFromSnapshot(): boolean {
  if (!credsCorrupt() || !credsSnapshotUsable()) return false;
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    try { fs.renameSync(CREDS_FILE, `${CREDS_FILE}.damaged-${stamp}`); } catch {}
    fs.copyFileSync(CREDS_SNAPSHOT, CREDS_FILE);
    console.error(`[wa-bridge] auth_info/creds.json was empty/not JSON — restored the last known-good copy (${CREDS_SNAPSHOT}); the damaged file is kept as creds.json.damaged-${stamp}`);
    return true;
  } catch (e) {
    console.error(`[wa-bridge] could not restore creds.json from the snapshot: ${(e as Error).message}`);
    return false;
  }
}

/** Last ~64KB of a file ('' when unreadable). */
function tailOf(file: string, bytes = 64 * 1024): string {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, bytes);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      return buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

/**
 * Why the WhatsApp process (pid) died, from ITS pino logs in the data dir —
 * main.ts exits on `Connection closed. Reason: loggedOut` / `connectionReplaced`
 * with nothing on stderr, so this is the only place the reason exists.
 * Returns the Baileys DisconnectReason name ('loggedOut', 'connectionReplaced',
 * …) or the last fatal message; null when the logs say nothing for that pid.
 */
export function childExitReason(pid: number | null, since = 0): string | null {
  // Under `npx tsx` the pid we hold is the wrapper's; pino logs the node
  // grandchild's — so the pid alone cannot select the lines. Lines written
  // since this spawn (same box, same clock) are ours; the pid is a bonus.
  const mine = (l: string) => {
    if (pid && (l.includes(`"pid":${pid},`) || l.includes(`"pid":${pid}}`))) return true;
    const m = /"time":"([^"]+)"/.exec(l);
    return !!m && Date.parse(m[1]) >= since - 2000;
  };
  let reason: string | null = null;
  for (const l of [...tailOf(WA_LOG_FILE).split('\n'), ...tailOf(MCP_LOG_FILE).split('\n')]) {
    if (!mine(l)) continue;
    const m = /Connection closed\. Reason: (\w+)/.exec(l);
    if (m) reason = m[1];
    else if (/"level":60/.test(l)) { try { reason = String(JSON.parse(l).msg || reason); } catch {} }
  }
  return reason;
}

/**
 * The last process reported WhatsApp logged this device out (401) and nobody
 * paired again since (creds.json is not newer than that verdict). A dead
 * pairing is never retried — WhatsApp will answer 401 forever.
 */
export function pairingLoggedOut(): boolean {
  const s = readStatusFile();
  if (s.reason !== 'logged-out') return false;
  try {
    const m = fs.statSync(path.join(WA_AUTH_DIR, 'creds.json')).mtimeMs;
    return !(s.ts && m > s.ts);
  } catch {
    return false; // no creds at all → plain "unpaired", the QR path handles it
  }
}

/**
 * Move a logged-out auth_info aside (timestamped, kept — never deleted) so the
 * next main.ts has no creds and pairs afresh, i.e. shows a QR. Only called for
 * an explicit human/UI start ({repair:true}); never by a restart or autostart.
 */
export function retirePairing(why: 'logged-out' | 'corrupt' = 'logged-out'): string | null {
  if (!fs.existsSync(WA_AUTH_DIR)) return null;
  const dest = `${WA_AUTH_DIR}.${why}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.renameSync(WA_AUTH_DIR, dest);
  const what = why === 'corrupt' ? 'the saved pairing is damaged (creds.json empty/not JSON)' : 'the pairing was logged out by WhatsApp';
  console.error(`[wa-bridge] ${what} — moved ${WA_AUTH_DIR} to ${dest} (kept, not deleted); the next start pairs afresh (QR)`);
  return dest;
}

export function whatsappMcpInstalled(): boolean {
  return fs.existsSync(WA_MAIN);
}

// Poll status file for transitions and wake session accordingly
let _pollInterval: ReturnType<typeof setInterval> | null = null;
let _lastKnownStatus: BridgeStatus = 'disconnected';
let _notifiedConnected = false;

function startStatusPoll(): void {
  if (_pollInterval) return;
  _pollInterval = setInterval(() => {
    const { status, qrUrl, user } = getBridgeStatus();
    if (status === _lastKnownStatus) return;
    _lastKnownStatus = status;

    if (status === 'qr' && qrUrl && _lastWakeFn && _lastSessionId) {
      _notifiedConnected = false; // new pairing = reset
      _lastWakeFn(_lastSessionId, `📱 WhatsApp QR ready — scan to pair: ${qrUrl}`, `wa:qr:${_lastSessionId}`);
    } else if (status === 'connected') {
      fastExits = 0; // a real connection: the process is healthy, forget earlier stumbles
      snapshotCreds(); // CONN1: keep the last known-good pairing for a truncated-file restore
      if (!_notifiedConnected && _lastWakeFn && _lastSessionId) {
        _notifiedConnected = true;
        _lastWakeFn(_lastSessionId, `✅ WhatsApp connected${user ? ` · ${user}` : ''} — listener is now watching for new messages.`, `wa:connected:${_lastSessionId}`);
      }
    }
    // 'disconnected' with a dead pid is handled by the transport's onclose (our
    // process) — nothing to do here for a foreign one.
  }, 2000);
  if (_pollInterval.unref) _pollInterval.unref();
}

function stopStatusPoll(): void {
  if (_pollInterval) { clearInterval(_pollInterval); _pollInterval = null; }
}

/**
 * A live pid in the status file that is not ours. An ORPHAN (its parent is
 * gone — typically the previous host's child that survived a restart) is ours
 * to reclaim: kill it and take over. Anything else (a legacy per-session tree
 * still running under an old claude) is left alone and reported, so we never
 * add a second client to the fight.
 */
function foreignOwner(): { pid: number; orphan: boolean } | null {
  const s = readStatusFile();
  if (s.status === 'disconnected') return null; // nobody holds the connection
  if (!s.pid || s.pid === ownedPid() || !pidAlive(s.pid)) return null;
  if (ownPids.has(s.pid)) return { pid: s.pid, orphan: true }; // ours, still winding down → wait/reclaim, not foreign
  const ppid = parentPid(s.pid);
  const orphan = ppid === null || ppid === 1 || !pidAlive(ppid);
  return { pid: s.pid, orphan };
}

async function waitDead(pid: number, ms: number): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (!pidAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !pidAlive(pid);
}

async function reclaimOrphan(pid: number): Promise<void> {
  console.error(`[wa-bridge] reclaiming orphaned WhatsApp process pid ${pid}`);
  try { process.kill(pid, 'SIGTERM'); } catch {}
  if (!(await waitDead(pid, 3000))) { try { process.kill(pid, 'SIGKILL'); } catch {} await waitDead(pid, 1000); }
}

function scheduleRestart(delay: number): void {
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    if (!stopping && _lastSessionId && _lastWakeFn && !ownedPid()) startBridge(_lastSessionId, _lastWakeFn, { internal: true }).catch(console.error);
  }, delay);
  if (restartTimer.unref) restartTimer.unref();
}

type ExitInfo = { code: number | null; signal: string | null } | null;

function onProcessGone(pid: number | null, exit: ExitInfo): void {
  transport = null;
  clientReady = null;
  if (stopping) return;
  const lived = Date.now() - spawnedAt;
  const reason = childExitReason(pid, spawnedAt);
  const how = `pid ${pid ?? '?'}, ${exit ? (exit.signal ? `signal ${exit.signal}` : `exit code ${exit.code}`) : 'exit'}${reason ? `, reason: ${reason}` : ''}, after ${Math.round(lived / 1000)}s`;
  if (reason === 'loggedOut') {
    // WhatsApp answered 401: the phone unlinked this device (or the server
    // revoked it). The creds are dead — respawning just repeats the 401 every
    // 5s. Stop, say so, and wait for a human to pair again (Show QR).
    fastExits = 0;
    console.error(`[wa-bridge] WhatsApp process exited (${how}) — WhatsApp logged this device out; NOT retrying the dead pairing. Re-pair from Settings → Connections (Show QR) or call request_setup`);
    writeStatusFile({ status: 'disconnected', pid: null, reason: 'logged-out' });
    _lastKnownStatus = 'disconnected';
    stopStatusPoll();
    if (_lastWakeFn && _lastSessionId) _lastWakeFn(_lastSessionId, '⚠️ WhatsApp logged this device out — the pairing must be redone (Settings → Connections → Show QR, or request_setup).', `wa:logged-out:${_lastSessionId}`);
    return;
  }
  if (lived < FAST_EXIT_MS) fastExits += 1; else fastExits = 0;
  if (fastExits >= MAX_FAST_EXITS) {
    // A conflicting foreign client, a broken checkout, a missing dependency —
    // a restart will not fix any of these. Say so and wait for a human/agent.
    console.error(`[wa-bridge] WhatsApp process exited (${how}) — ${fastExits}× within ${Math.round(FAST_EXIT_MS / 1000)}s of starting, giving up (re-pair from Settings → Connections or call request_setup)`);
    writeStatusFile({ status: 'disconnected', pid: null, reason: 'crash-loop' });
    stopStatusPoll();
    return;
  }
  const delay = RESTART_DELAY_MS * 3 ** (fastExits ? fastExits - 1 : 0);
  console.error(`[wa-bridge] WhatsApp process exited (${how}) — restarting in ${Math.round(delay / 1000)}s`);
  scheduleRestart(delay);
}

/**
 * Bring the one WhatsApp process up (no-op when it is already ours). Never
 * throws for the usual reasons; the status file / getBridgeStatus() carries
 * the outcome ({status:'disconnected', reason}).
 */
export function startBridge(sessionId: string, wake: WakeFn, opts: { internal?: boolean; repair?: boolean } = {}): Promise<void> {
  if (sessionId !== _lastSessionId) _notifiedConnected = false; // new session → re-notify
  _lastSessionId = sessionId;
  _lastWakeFn = wake;
  if (!opts.internal) { fastExits = 0; if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; } }

  if (ownedPid()) {
    startStatusPoll();
    return Promise.resolve();
  }
  stopping = false;
  return (async () => {
    const foreign = foreignOwner();
    if (foreign) {
      if (!foreign.orphan) {
        console.error(`[wa-bridge] WhatsApp is held by a foreign process (pid ${foreign.pid}, not spawned by this host) — not starting a second client`);
        startStatusPoll();
        return;
      }
      await reclaimOrphan(foreign.pid);
    }
    if (!whatsappMcpInstalled()) {
      writeStatusFile({ status: 'disconnected', pid: null, reason: 'not-installed' });
      console.error(`[wa-bridge] whatsapp-mcp not installed at ${WA_MCP_DIR} (ARIGAMI_WA_MCP_DIR)`);
      return;
    }
    if (ownedPid()) return; // raced with a concurrent start
    // An explicit human start on a pairing WhatsApp has logged out: move it
    // aside so this process pairs afresh and the QR shows. Internal restarts
    // and the boot autostart never do this — only the Connect / Show QR path.
    if (credsCorrupt()) restoreCredsFromSnapshot(); // CONN1: self-heal a truncated creds.json first
    if (opts.repair && (pairingLoggedOut() || credsCorrupt())) {
      const why = credsCorrupt() ? 'corrupt' : 'logged-out';
      try { retirePairing(why); } catch (e) { console.error(`[wa-bridge] could not move the ${why} auth_info aside: ${(e as Error).message}`); }
    } else if (credsCorrupt()) {
      // CONN1: an internal restart / boot autostart never touches auth_info, but it
      // must not spawn against a damaged creds.json either — that only yields an
      // unexplained QR loop. Say why and wait for Connect / Show QR.
      console.error(`[wa-bridge] auth_info/creds.json is empty or not JSON — the saved WhatsApp pairing is damaged; NOT starting. Re-pair from Settings → Connections (Show QR) or call request_setup`);
      writeStatusFile({ status: 'disconnected', pid: null, reason: 'creds-corrupt' });
      _lastKnownStatus = 'disconnected';
      return;
    }
    // Write starting state immediately so the UI reflects it
    writeStatusFile({ status: 'starting', pid: null });
    _lastKnownStatus = 'starting';
    startStatusPoll();

    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    const t = new StdioClientTransport({
      command: RUNNER[0],
      args: [...RUNNER.slice(1), WA_MAIN],
      env: { ...(process.env as Record<string, string>), WHATSAPP_MCP_DATA_DIR: WA_DATA_DIR, NODE_PATH: path.join(WA_MCP_DIR, 'node_modules') },
      cwd: WA_MCP_DIR,
      stderr: 'pipe',
    });
    // The child's stderr goes to the host log (pm2 error log), line by line,
    // capped per spawn so a chatty process cannot flood it.
    let stderrLines = 0;
    let stderrRest = '';
    t.stderr?.on('data', (chunk: Buffer | string) => {
      stderrRest += String(chunk);
      const parts = stderrRest.split('\n');
      stderrRest = parts.pop() || '';
      for (const line of parts) {
        if (!line.trim()) continue;
        stderrLines += 1;
        if (stderrLines <= STDERR_MAX_LINES) console.error(`[wa-mcp] ${line.slice(0, 2000)}`);
        else if (stderrLines === STDERR_MAX_LINES + 1) console.error('[wa-mcp] … further stderr from this process suppressed');
      }
    });
    const c = new Client({ name: 'arigami-host', version: '0.2.0' });
    transport = t;
    spawnedAt = Date.now();
    let exitInfo: ExitInfo = null;
    let childPid: number | null = null;
    c.onclose = () => {
      if (stderrRest.trim() && stderrLines < STDERR_MAX_LINES) console.error(`[wa-mcp] ${stderrRest.slice(0, 2000)}`);
      if (transport === t) onProcessGone(childPid ?? t.pid, exitInfo);
    };
    t.onerror = () => {};
    c.onerror = () => {};
    clientReady = (async () => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      try {
        await Promise.race([
          c.connect(t),
          new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('MCP initialise timed out')), CONNECT_TIMEOUT_MS); if (timer.unref) timer.unref(); }),
        ]);
      } catch (e) {
        console.error(`[wa-bridge] MCP handshake with WhatsApp process failed: ${(e as Error).message}`);
        if (transport === t) { try { await t.close(); } catch {} }
        throw e;
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (t.pid) ownPids.add(t.pid);
      return c;
    })();
    // the pid is known as soon as the transport started (connect() spawns synchronously)
    const hook = () => {
      if (!t.pid) return;
      childPid = t.pid;
      ownPids.add(t.pid);
      // exit code/signal for the host log: the SDK only surfaces 'close', so read
      // its child directly (best effort — a missing field just logs "exit").
      const proc = (t as any)._process as import('node:child_process').ChildProcess | undefined;
      proc?.once?.('exit', (code: number | null, signal: string | null) => { exitInfo = { code, signal }; });
    };
    hook();
    queueMicrotask(hook);
    clientReady.catch(() => {});
  })();
}

/** The MCP client for the WhatsApp process (throws with a human-readable reason when there is none). */
export async function mcpClient(): Promise<any> {
  if (clientReady) return clientReady;
  const foreign = foreignOwner();
  if (foreign && !foreign.orphan) throw new Error(`WhatsApp is held by another process (pid ${foreign.pid}) — restart that session or the host so the host owns the single WhatsApp connection`);
  if (_lastSessionId && _lastWakeFn) {
    // e.g. the process died and we are between restarts — bring it up now.
    await startBridge(_lastSessionId, _lastWakeFn, { internal: true });
    if (clientReady) return clientReady;
  }
  throw new Error('WhatsApp bridge is not running');
}

/** One tool call on the WhatsApp process. */
export async function callTool(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const c = await mcpClient();
  return c.callTool({ name, arguments: args });
}

export function stopBridge(): void {
  stopping = true;
  stopStatusPoll();
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  const t = transport;
  const pid = ownedPid();
  transport = null;
  clientReady = null;
  // SIGTERM synchronously (shutdown() exits right after us); the SDK close()
  // then escalates to SIGKILL if it lingers.
  if (pid) { try { process.kill(pid, 'SIGTERM'); } catch {} }
  if (t) t.close().catch(() => {});
  // An orphan from a previous host is ours too — a "disconnect" must really disconnect.
  const foreign = foreignOwner();
  if (foreign?.orphan) reclaimOrphan(foreign.pid).catch(() => {});
  writeStatusFile({ status: 'disconnected', pid: null });
}

/**
 * Boot: with the per-session trees gone, the host is the only thing that can
 * keep WhatsApp connected — so bring it up when a pairing exists. Never on a
 * box without the checkout or a pairing (nothing to connect), and opt-out with
 * ARIGAMI_WA_AUTOSTART=0.
 */
export function autoStartBridge(wake: WakeFn = () => {}): Promise<{ started: boolean; reason: string }> {
  if (process.env.ARIGAMI_WA_AUTOSTART === '0') return Promise.resolve({ started: false, reason: 'ARIGAMI_WA_AUTOSTART=0' });
  if (!whatsappMcpInstalled()) return Promise.resolve({ started: false, reason: 'whatsapp-mcp not installed' });
  if (credsCorrupt()) restoreCredsFromSnapshot(); // CONN1: self-heal a truncated creds.json first
  if (credsCorrupt()) {
    // CONN1: say so in the status file the capability probe reads (instead of a
    // silent "not paired") — the Connections card then explains what to do.
    console.error('[wa-bridge] auth_info/creds.json is empty or not JSON — the saved WhatsApp pairing is damaged; not auto-starting. Re-pair from Settings → Connections (Show QR)');
    writeStatusFile({ status: 'disconnected', pid: null, reason: 'creds-corrupt' });
    return Promise.resolve({ started: false, reason: 'creds-corrupt — the saved pairing is damaged (creds.json empty/not JSON); re-pair from Settings → Connections (Show QR)' });
  }
  if (!isPaired()) return Promise.resolve({ started: false, reason: 'not paired' });
  // The last verdict was WhatsApp's 401 and nobody paired since: a start would
  // only repeat it. The UI's Connect / Show QR ({repair:true}) is the way out.
  if (pairingLoggedOut()) return Promise.resolve({ started: false, reason: 'logged-out — WhatsApp unlinked this device; re-pair from Settings → Connections (Show QR)' });
  return startBridge('ui', wake).then(() => ({ started: !!ownedPid(), reason: ownedPid() ? 'spawned' : (getBridgeStatus().reason || 'held by another process') }));
}

// ---- legacy per-session registration (~/.claude.json) ----------------------

/** Path of Claude Code's user config (`$CLAUDE_CONFIG_DIR/.claude.json` or `~/.claude.json`). */
export function claudeJsonPath(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR;
  return dir ? path.join(dir, '.claude.json') : path.join(os.homedir(), '.claude.json');
}

/** Is this `mcpServers.<name>` entry the whatsapp-mcp checkout run per session (the thing B20 retires)? */
export function isLegacyWhatsappServer(entry: unknown): boolean {
  if (!entry || typeof entry !== 'object') return false;
  const e = entry as { command?: unknown; args?: unknown; type?: unknown; url?: unknown };
  if (e.url || (e.type && e.type !== 'stdio')) return false; // a remote server the user chose — not ours
  const line = [e.command, ...(Array.isArray(e.args) ? e.args : [])].map((x) => String(x ?? '')).join(' ');
  return /whatsapp-mcp[\\/]src[\\/](main|bridge-entry)\.ts/.test(line) || line.includes(WA_MAIN);
}

/**
 * Retire the user-scope (and any project-scope) `mcpServers.whatsapp` that
 * spawned a whole whatsapp-mcp tree inside every session. Idempotent: no
 * matching entry → nothing written. The removed entries are saved next to the
 * host's WhatsApp state so the change is reversible by hand. Only this exact
 * legacy shape is touched — a `whatsapp` server the user pointed elsewhere
 * (http, another command) stays.
 */
export function migrateLegacyMcpRegistration(opts: { file?: string; backupDir?: string; log?: (m: string) => void } = {}):
  { migrated: boolean; removed: string[]; backup?: string; error?: string } {
  const file = opts.file || claudeJsonPath();
  const log = opts.log || ((m: string) => console.log(m));
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { migrated: false, removed: [] }; // no config yet — nothing to retire
  }
  let cfg: any;
  try {
    cfg = JSON.parse(raw);
  } catch (e) {
    return { migrated: false, removed: [], error: `unparsable ${file}: ${(e as Error).message}` };
  }
  if (!cfg || typeof cfg !== 'object') return { migrated: false, removed: [] };
  const removed: string[] = [];
  const saved: { user?: unknown; projects: Record<string, unknown> } = { projects: {} };
  if (isLegacyWhatsappServer(cfg.mcpServers?.whatsapp)) {
    saved.user = cfg.mcpServers.whatsapp;
    delete cfg.mcpServers.whatsapp;
    removed.push('user');
  }
  for (const [dir, proj] of Object.entries((cfg.projects || {}) as Record<string, any>)) {
    if (isLegacyWhatsappServer(proj?.mcpServers?.whatsapp)) {
      saved.projects[dir] = proj.mcpServers.whatsapp;
      delete proj.mcpServers.whatsapp;
      removed.push(`project:${dir}`);
    }
  }
  if (!removed.length) return { migrated: false, removed };
  const backupDir = opts.backupDir || path.join(ARIGAMI_DIR, 'whatsapp');
  let backup: string | undefined;
  try {
    fs.mkdirSync(backupDir, { recursive: true });
    backup = path.join(backupDir, 'legacy-claude-mcp-whatsapp.json');
    fs.writeFileSync(backup, JSON.stringify({ removedAt: new Date().toISOString(), from: file, ...saved }, null, 2));
  } catch (e) {
    return { migrated: false, removed: [], error: `could not back up the legacy entry: ${(e as Error).message}` };
  }
  try {
    const tmp = `${file}.arigami-${process.pid}.tmp`;
    let mode = 0o600;
    try { mode = fs.statSync(file).mode & 0o777; } catch {}
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode });
    fs.renameSync(tmp, file);
  } catch (e) {
    return { migrated: false, removed: [], backup, error: `could not rewrite ${file}: ${(e as Error).message}` };
  }
  log(`[wa-bridge] retired the per-session WhatsApp MCP registration (${removed.join(', ')}) from ${file} — sessions use the host's single WhatsApp path (the \`whatsapp\` tool); backup at ${backup}`);
  return { migrated: true, removed, backup };
}
