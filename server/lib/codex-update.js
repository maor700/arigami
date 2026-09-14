// P1-10 — the `codex` CLI row in Settings › Host: installed / latest / "update now" (`codex update`). No auto-update.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createUpdater, parseVersion, DEFAULT_MIN_FREE_MB, APPLY_TIMEOUT_MS } from './claude-update.js';

export const RELEASES_URL = 'https://api.github.com/repos/openai/codex/releases/latest';

const codexBin = () => process.env.ARIGAMI_CODEX_BIN || 'codex';

function run(args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(codexBin(), args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, CI: '1', NO_COLOR: '1' } }, (err, stdout, stderr) => {
      const output = `${stdout || ''}${stderr ? `\n${stderr}` : ''}`.trim();
      resolve({ code: err ? (err.code === undefined || typeof err.code === 'string' ? 1 : err.code) : 0, timedOut: !!err?.killed, output, error: err ? err.message : null });
    });
  });
}

/** "↑ updates  0.154.0 available (current 0.153.4)" → "0.154.0"; null when doctor reports no update. */
export function parseDoctorUpdate(out) {
  const m = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\s+available/i.exec(String(out || ''));
  return m ? m[1] : null;
}

export async function codexInstalled() {
  const r = await run(['--version'], 10_000);
  return r.code === 0 ? parseVersion(r.output) : null;
}

// `codex doctor`'s update line, else the GitHub latest release tag (rust-v0.154.0), else the installed version.
export async function codexLatest({ doctor = () => run(['doctor'], 60_000), github = fetchGithubLatest, installed = codexInstalled } = {}) {
  const d = await doctor().catch(() => null);
  const fromDoctor = d && parseDoctorUpdate(d.output);
  if (fromDoctor) return fromDoctor;
  const gh = await github().catch(() => null);
  if (gh) return gh;
  const cur = await installed();
  if (d?.code === 0 && cur) return cur;
  throw new Error('could not determine the latest codex version');
}

async function fetchGithubLatest() {
  const r = await fetch(RELEASES_URL, { signal: AbortSignal.timeout(15_000), headers: { 'user-agent': 'arigami-host', accept: 'application/vnd.github+json' } });
  if (!r.ok) throw new Error(`${RELEASES_URL} → HTTP ${r.status}`);
  return parseVersion((await r.json())?.tag_name);
}

let singleton = null;

export async function codexUpdater() {
  if (singleton) return singleton;
  const { cfg } = await import('../state.js');
  const bus = await import('../bus.js');
  const logFile = path.join(cfg.logsDir || path.join(cfg.configDir, 'logs'), 'codex-update.log');
  singleton = createUpdater({
    name: 'codex',
    source: RELEASES_URL,
    store: path.join(cfg.configDir, 'codex-update.json'),
    installed: codexInstalled,
    fetchLatest: () => codexLatest(),
    run: () => run(['update'], APPLY_TIMEOUT_MS),
    minFreeMb: Number(cfg.host?.claudeUpdateMinFreeMb) > 0 ? Number(cfg.host.claudeUpdateMinFreeMb) : DEFAULT_MIN_FREE_MB,
    auto: () => false,
    emit: (event) => bus.broadcast({ type: 'host', event }),
    log: (line) => {
      console.log(`[codex-update] ${line}`);
      try { fs.mkdirSync(path.dirname(logFile), { recursive: true }); fs.appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`); } catch {}
    },
  });
  return singleton;
}
