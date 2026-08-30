// Managed WhatsApp bridge — reads the status file written by the whatsapp-mcp
// process (whatsapp.ts) and exposes it via getBridgeStatus(). If no process is
// running, startBridge() spawns bridge-entry.ts to establish the connection.
//
// The status file (bridge-status.json) is the source of truth — written by
// whatsapp.ts on every state change, so both the Claude Code MCP instance and
// any Arigami-spawned instance share the same status channel.

import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

type WakeFn = (sessionId: string, text: string, key: string) => void;

import * as os from 'node:os';

// Where the whatsapp-mcp checkout lives (B2). Native installs keep the legacy
// ~/.local/lib/whatsapp-mcp; the Docker image clones it at build time into
// /opt/whatsapp-mcp and sets ARIGAMI_WA_MCP_DIR. The Baileys auth state is
// hardcoded upstream to <checkout>/auth_info, so in the image the entrypoint
// symlinks that directory onto the /data volume. The message DB + status file
// (WHATSAPP_MCP_DATA_DIR upstream) can be moved independently with
// ARIGAMI_WA_DATA_DIR — the image points it at /data/.arigami/whatsapp/data.
export const WA_MCP_DIR = process.env.ARIGAMI_WA_MCP_DIR
  || path.join(os.homedir(), '.local/lib/whatsapp-mcp');
export const WA_ENTRY = path.join(WA_MCP_DIR, 'src/bridge-entry.ts');
export const WA_AUTH_DIR = path.join(WA_MCP_DIR, 'auth_info');
export const WA_DATA_DIR = process.env.ARIGAMI_WA_DATA_DIR || path.join(WA_MCP_DIR, 'data');
export const WA_DB_PATH = path.join(WA_DATA_DIR, 'whatsapp.db');
const STATUS_FILE = path.join(WA_DATA_DIR, 'bridge-status.json');

const RESTART_DELAY_MS = 5_000;

export type BridgeStatus = 'disconnected' | 'starting' | 'qr' | 'connected';

// ---- status file ------------------------------------------------------------

interface StatusFile {
  status: BridgeStatus;
  user?: string | null;
  qrUrl?: string | null;
  pid?: number;
  ts?: number;
}

function readStatusFile(): StatusFile {
  try {
    const raw = fs.readFileSync(STATUS_FILE, 'utf8');
    return JSON.parse(raw) as StatusFile;
  } catch {
    return { status: 'disconnected' };
  }
}

export function getBridgeStatus(): { status: BridgeStatus; qrUrl: string | null; user: string | null } {
  const s = readStatusFile();
  // If PID from status file is dead, treat as disconnected
  if (s.pid && s.status !== 'disconnected') {
    try { process.kill(s.pid, 0); } catch { return { status: 'disconnected', qrUrl: null, user: null }; }
  }
  return { status: s.status, qrUrl: s.qrUrl ?? null, user: s.user ?? null };
}

// ---- process management -----------------------------------------------------

let proc: ChildProcess | null = null;
let stopping = false;
let _lastSessionId: string | null = null;
let _lastWakeFn: WakeFn | null = null;

export function isBridgeRunning(): boolean {
  if (proc && proc.exitCode === null) return true;
  const s = readStatusFile();
  if (!s.pid) return false;
  try { process.kill(s.pid, 0); return true; } catch { return false; }
}

export function isPaired(): boolean {
  return fs.existsSync(path.join(WA_AUTH_DIR, 'creds.json'));
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
      if (!_notifiedConnected && _lastWakeFn && _lastSessionId) {
        _notifiedConnected = true;
        _lastWakeFn(_lastSessionId, `✅ WhatsApp connected${user ? ` · ${user}` : ''} — listener is now watching for new messages.`, `wa:connected:${_lastSessionId}`);
      }
      // Keep polling — detect if the process dies later
    } else if (status === 'disconnected') {
      // Don't reset _notifiedConnected — avoid re-notifying on every reconnect cycle
      stopStatusPoll();
      if (!stopping && _lastSessionId && _lastWakeFn) {
        setTimeout(() => startBridge(_lastSessionId!, _lastWakeFn!), RESTART_DELAY_MS);
      }
    }
  }, 2000);
}

function stopStatusPoll(): void {
  if (_pollInterval) { clearInterval(_pollInterval); _pollInterval = null; }
}

export function startBridge(sessionId: string, wake: WakeFn): Promise<void> {
  if (sessionId !== _lastSessionId) _notifiedConnected = false; // new session → re-notify
  _lastSessionId = sessionId;
  _lastWakeFn = wake;

  if (isBridgeRunning()) {
    startStatusPoll();
    return Promise.resolve();
  }

  stopping = false;
  // Write starting state immediately so UI reflects it
  try {
    fs.mkdirSync(WA_DATA_DIR, { recursive: true });
    fs.writeFileSync(STATUS_FILE, JSON.stringify({ status: 'starting', pid: null, ts: Date.now() }));
  } catch {}
  _lastKnownStatus = 'starting';
  startStatusPoll();

  const child = spawn(
    'npx',
    ['tsx', WA_ENTRY],
    {
      cwd: WA_MCP_DIR,
      env: { ...process.env, WHATSAPP_MCP_DATA_DIR: WA_DATA_DIR },
      stdio: 'ignore',
      detached: false,
    }
  );

  proc = child;

  child.on('error', (err) => {
    proc = null;
    stopStatusPoll();
    console.error('[wa-bridge] spawn error:', err.message);
  });

  child.on('exit', (code, signal) => {
    proc = null;
    if (!stopping) {
      // code=0 means graceful exit (e.g. connectionReplaced) — another process took over,
      // give it extra time to write `connected` before deciding to restart.
      const delay = code === 0 ? RESTART_DELAY_MS * 3 : RESTART_DELAY_MS;
      console.error(`[wa-bridge] exited (code=${code}, signal=${signal}) — checking in ${delay / 1000}s`);
      setTimeout(() => {
        if (!stopping && _lastSessionId && _lastWakeFn && !isBridgeRunning())
          startBridge(_lastSessionId, _lastWakeFn);
      }, delay);
    }
  });

  return Promise.resolve();
}

export function stopBridge(): void {
  stopping = true;
  stopStatusPoll();
  proc?.kill('SIGTERM');
  proc = null;
  try { fs.writeFileSync(STATUS_FILE, JSON.stringify({ status: 'disconnected', ts: Date.now() })); } catch {}
}
