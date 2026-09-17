// P4-6 — boot probe: can codex's own sandbox (bwrap on Linux, seatbelt on macOS) start here? Spawn flags never change on the result.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ARIGAMI_DIR } from './instance.js';

export const SANDBOX_FILE = path.join(ARIGAMI_DIR, 'codex-sandbox.json');
const PROBE_TIMEOUT_MS = 20_000;

export interface SandboxStatus {
  available: boolean | null; // null = codex not installed / probe could not run
  detail: string;
  checkedAt: string;
}

export interface RunResult {
  code: number;
  output: string;
  missing?: boolean;
}

type Runner = () => Promise<RunResult>;

const codexBin = (): string => process.env.ARIGAMI_CODEX_BIN || 'codex';

// spawn, not execFile: the probe never has input to give, and a child that
// (mistakenly, or because it's a test double built for a different codex
// subcommand) waits to read stdin before it does anything would otherwise
// hang for the full PROBE_TIMEOUT_MS with its stdin pipe just sitting open.
// An explicitly closed stdin makes that class of hang impossible instead of
// merely unlikely.
const runProbe: Runner = () =>
  new Promise((resolve) => {
    let child;
    try {
      child = spawn(codexBin(), ['sandbox', '--', '/bin/true'], {
        cwd: os.tmpdir(),
        env: { ...process.env, NO_COLOR: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e: any) {
      return resolve({ code: 127, output: String(e?.message || e), missing: e?.code === 'ENOENT' });
    }
    let output = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve({ code: 1, output: `timed out after ${PROBE_TIMEOUT_MS}ms` });
    }, PROBE_TIMEOUT_MS);
    child.stdout?.on('data', (d) => (output += d));
    child.stderr?.on('data', (d) => (output += d));
    child.once('error', (err: any) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: 127, output: String(err?.message || err), missing: err?.code === 'ENOENT' });
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? 1, output: output.trim() });
    });
  });

/** First `bwrap:`/`sandbox` line of the failure output, else its last line; one line, ≤160 chars. */
export function failureDetail(output: string): string {
  const lines = String(output || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const line = lines.find((l) => /bwrap:|sandbox/i.test(l)) || lines[lines.length - 1] || 'exit non-zero';
  return line.slice(0, 160);
}

export async function probeCodexSandbox(opts: { run?: Runner; file?: string; now?: Date; log?: (l: string) => void } = {}): Promise<SandboxStatus> {
  const { run = runProbe, file = SANDBOX_FILE, now = new Date(), log = (l: string) => console.log(`[codex-sandbox] ${l}`) } = opts;
  let r: RunResult;
  try {
    r = await run();
  } catch (e) {
    r = { code: 1, output: (e as Error).message };
  }
  const st: SandboxStatus = r.missing
    ? { available: null, detail: 'codex not installed', checkedAt: now.toISOString() }
    : r.code === 0
      ? { available: true, detail: 'ok', checkedAt: now.toISOString() }
      : { available: false, detail: failureDetail(r.output), checkedAt: now.toISOString() };
  if (st.available) log('available — a sandboxed codex mode is possible; spawn still uses --dangerously-bypass-approvals-and-sandbox');
  else if (st.available === false) log(`unavailable (${st.detail}) — spawn keeps --dangerously-bypass-approvals-and-sandbox`);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(st, null, 2) + '\n');
  } catch {}
  return st;
}

/** The cached probe result, or null before the first probe. */
export function readCodexSandbox(file = SANDBOX_FILE): SandboxStatus | null {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return j && typeof j === 'object' && 'available' in j ? (j as SandboxStatus) : null;
  } catch {
    return null;
  }
}
