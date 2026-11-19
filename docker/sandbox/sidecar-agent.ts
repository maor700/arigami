#!/usr/bin/env bun
// The sandbox SIDECAR's agent (docs/SANDBOX.md § Kubernetes): runs in the pod's `sandbox` container and starts the
// engines of restricted sessions there, for the host container next to it.
//
//   bun sidecar-agent.ts            (env SANDBOX_AGENT_LISTEN=127.0.0.1:3299, SANDBOX_WORK_ROOTS=/a,/b)
//
// The host's launcher (server/lib/sandbox-sidecar-launch.ts) connects over the pod's loopback, sends ONE header line
// (JSON: argv, env, cwd) and then frames; the engine's stdin/stdout/stderr, its signals and its exit code travel over
// that one connection, so the engine driver on the host sees exactly the stream of a local child. The engine gets
// the env the host sent and nothing of this process's own (which holds nothing anyway: the container has no secrets).
//
// Who may connect: the pod's loopback only. The container's processes themselves cannot (their network is limited to
// the host's API port and the egress proxy by the pod's own packet filter), so a sandboxed session cannot start
// processes through here — and from the host container only the host and its Full sessions can, which already run
// with more than this container has.
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { FRAME, encodeFrame, FrameReader } from './sidecar-frames.ts';

const [bindHost, bindPort] = (process.env.SANDBOX_AGENT_LISTEN || '127.0.0.1:3299').split(':');
const roots = String(process.env.SANDBOX_WORK_ROOTS || '').split(',').map((r) => r.trim()).filter((r) => r.startsWith('/'));
const log = (m: string) => process.stderr.write(`[sandbox-agent] ${m}\n`);

/**
 * Every process of one session, wherever it went: the engine runs in its own process group, but a tool can start
 * something in a group of its own (`setsid`, a dev server, a browser). They all inherit the session's env, so the
 * session id in /proc/<pid>/environ finds them (same uid: readable). Never this agent itself.
 */
export function sessionPids(sessionId: string, procDir = '/proc', self = process.pid): number[] {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(sessionId)) return [];
  const want = Buffer.from(`ARIGAMI_SESSION_ID=${sessionId}\0`);
  const out: number[] = [];
  let entries: string[] = [];
  try { entries = fs.readdirSync(procDir); } catch { return out; }
  for (const e of entries) {
    const pid = Number(e);
    if (!Number.isInteger(pid) || pid <= 1 || pid === self) continue;
    try {
      const env = fs.readFileSync(path.join(procDir, e, 'environ'));
      if (env.indexOf(want) === 0 || env.indexOf(Buffer.concat([Buffer.from('\0'), want])) >= 0) out.push(pid);
    } catch { /* gone, or not ours */ }
  }
  return out;
}

/** End every process of the session: SIGTERM, then SIGKILL what is left after `graceMs`. */
export async function endSession(sessionId: string, graceMs = 3000): Promise<number> {
  const first = sessionPids(sessionId);
  for (const pid of first) try { process.kill(pid, 'SIGTERM'); } catch {}
  if (!first.length) return 0;
  const t0 = Date.now();
  while (Date.now() - t0 < graceMs && sessionPids(sessionId).length) await new Promise((r) => setTimeout(r, 100));
  for (const pid of sessionPids(sessionId)) try { process.kill(pid, 'SIGKILL'); } catch {}
  return first.length;
}

const within = (p: string, dir: string) => p === dir || p.startsWith(dir.endsWith('/') ? dir : dir + '/');

/** The checks this side makes on a start request, whatever the host already checked. */
export function startError(h: { argv?: unknown; env?: unknown; cwd?: unknown }, workRoots: string[]): string | null {
  if (!Array.isArray(h.argv) || !h.argv.length || !h.argv.every((a) => typeof a === 'string')) return 'argv must be a non-empty string list';
  if (!h.env || typeof h.env !== 'object' || Array.isArray(h.env)) return 'env must be an object';
  if (typeof h.cwd !== 'string' || !path.isAbsolute(h.cwd)) return 'cwd must be an absolute path';
  let real = h.cwd;
  try { real = fs.realpathSync(h.cwd); } catch { return `cwd ${h.cwd} does not exist in the sandbox`; }
  if (workRoots.length && !workRoots.some((r) => within(real, r))) return `cwd ${real} is outside the shared work roots`;
  return null;
}

function serve(sock: net.Socket): void {
  const reader = new FrameReader();
  let child: ChildProcess | null = null;
  let sessionId = '';
  let ended = false;
  // When the engine is gone, so is everything the session started (a container per session gets this from docker).
  const endAll = () => {
    if (ended || !sessionId) return;
    ended = true;
    void endSession(sessionId).then((n) => { if (n) log(`session ${sessionId}: ended ${n} leftover process(es)`); });
  };
  let header = '';
  let headed = false;
  const send = (type: number, payload: Buffer | string) => { if (!sock.destroyed) sock.write(encodeFrame(type, payload)); };
  const fail = (msg: string) => { send(FRAME.ERROR, msg); sock.end(); };
  const killTree = (sig: NodeJS.Signals) => {
    if (!child?.pid) return;
    try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch {} }
  };
  sock.on('data', (d: Buffer) => {
    if (!headed) {
      header += d.toString('utf8');
      const nl = header.indexOf('\n');
      if (nl < 0) { if (header.length > 4 * 1024 * 1024) fail('header too large'); return; }
      headed = true;
      const rest = Buffer.from(header.slice(nl + 1), 'utf8');
      let h: { argv: string[]; env: Record<string, string>; cwd: string };
      try { h = JSON.parse(header.slice(0, nl)); } catch { return fail('bad header'); }
      header = '';
      const why = startError(h, roots);
      if (why) return fail(why);
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(h.env)) if (typeof v === 'string') env[k] = v;
      sessionId = env.ARIGAMI_SESSION_ID || '';
      // its own process group, so a signal reaches the engine's tool processes too
      child = spawn(h.argv[0], h.argv.slice(1), { cwd: h.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
      child.stdout!.on('data', (b: Buffer) => send(FRAME.STDOUT, b));
      child.stderr!.on('data', (b: Buffer) => send(FRAME.STDERR, b));
      child.stdin!.on('error', () => {});
      child.on('error', (e) => fail(`cannot start ${h.argv[0]}: ${e.message}`));
      child.on('exit', (code, signal) => {
        endAll();
        send(FRAME.EXIT, JSON.stringify({ code, signal }));
        sock.end();
      });
      if (rest.length) reader.push(rest);
    } else reader.push(d);
    for (const f of reader.drain()) {
      if (!child) continue;
      if (f.type === FRAME.STDIN) child.stdin!.write(f.payload);
      else if (f.type === FRAME.STDIN_END) child.stdin!.end();
      else if (f.type === FRAME.SIGNAL) {
        const sig = f.payload.toString('utf8') as NodeJS.Signals;
        if (['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGKILL'].includes(sig)) {
          // SIGINT interrupts the engine only (its turn), like a terminal ^C; the others end the whole group
          if (sig === 'SIGINT') { try { child.kill('SIGINT'); } catch {} } else killTree(sig);
        }
      }
    }
  });
  // the host side went away: the session's engine must not outlive its launcher
  const gone = () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      killTree('SIGTERM');
      setTimeout(() => killTree('SIGKILL'), 5000).unref();
    }
    endAll();
  };
  sock.on('close', gone);
  sock.on('error', () => sock.destroy());
}

if (import.meta.main) {
  const srv = net.createServer(serve);
  srv.listen(Number(bindPort || 3299), bindHost || '127.0.0.1', () => log(`listening on ${bindHost}:${bindPort}; work roots ${roots.join(', ') || '(any)'}`));
  for (const sig of ['SIGTERM', 'SIGINT'] as NodeJS.Signals[]) process.on(sig, () => { srv.close(); process.exit(0); });
}
