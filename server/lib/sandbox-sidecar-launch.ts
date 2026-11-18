// The process the host spawns in place of a sandboxed session's engine when the sandbox is a SIDECAR container of
// the same pod (server/lib/sandbox.ts wrapSpawn, sandbox.mode 'sidecar'):
//   bun sandbox-sidecar-launch.ts <spec.json>
// It reads (and deletes) the launch spec, connects to the sandbox agent on the pod's loopback
// (docker/sandbox/sidecar-agent.ts), hands it the engine's argv/env/cwd and relays stdin/stdout/stderr, signals and
// the exit code — the engine driver sees exactly the stream of a local child. This process carries no session env of
// its own; the engine's env (its one credential included) exists only in the spec file, which is gone before the
// engine starts, and on the loopback connection.
import fs from 'node:fs';
import net from 'node:net';
import { FRAME, encodeFrame, FrameReader } from '../../docker/sandbox/sidecar-frames.js';

export interface SidecarSpec {
  v: 1;
  sessionId: string;
  agent: string;
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  ephemeral?: string[];
  error?: string;
}

let ephemeral: string[] = [];
const dropEphemeral = () => { for (const f of ephemeral) try { fs.rmSync(f, { force: true }); } catch {} };
const fail = (msg: string): never => {
  dropEphemeral();
  process.stderr.write(`sandbox: ${msg}\n`);
  process.exit(1);
};

if (import.meta.main) {
  const specFile = process.argv[2];
  if (!specFile) fail('no launch spec');
  let spec: SidecarSpec;
  try {
    spec = JSON.parse(fs.readFileSync(specFile, 'utf8'));
  } catch (e) {
    fail(`unreadable launch spec: ${(e as Error).message}`);
  }
  try { fs.rmSync(specFile, { force: true }); } catch {}
  ephemeral = spec!.ephemeral || [];
  if (spec!.error) fail(spec!.error);
  const S = spec!;
  const m = /^(.+):(\d+)$/.exec(S.agent);
  if (!m) fail(`bad sandbox agent address ${S.agent}`);
  const sock = net.connect(Number(m![2]), m![1]);
  let started = false;
  let exitCode: number | null = null;
  const reader = new FrameReader();
  sock.on('connect', () => {
    started = true;
    sock.write(JSON.stringify({ argv: S.argv, env: S.env, cwd: S.cwd }) + '\n');
    process.stdin.on('data', (d: Buffer) => sock.write(encodeFrame(FRAME.STDIN, d)));
    process.stdin.on('end', () => sock.write(encodeFrame(FRAME.STDIN_END, '')));
  });
  sock.on('data', (d: Buffer) => {
    reader.push(d);
    for (const f of reader.drain()) {
      if (f.type === FRAME.STDOUT) process.stdout.write(f.payload);
      else if (f.type === FRAME.STDERR) process.stderr.write(f.payload);
      else if (f.type === FRAME.ERROR) process.stderr.write(`sandbox: ${f.payload.toString('utf8')}\n`);
      else if (f.type === FRAME.EXIT) {
        try {
          const x = JSON.parse(f.payload.toString('utf8'));
          exitCode = typeof x.code === 'number' ? x.code : x.signal ? 128 : 1;
        } catch { exitCode = 1; }
      }
    }
  });
  const done = () => {
    dropEphemeral();
    // stdout must be flushed before exiting: it is the engine's protocol stream
    process.stdout.write('', () => process.exit(exitCode ?? 1));
  };
  sock.on('close', done);
  sock.on('error', (e) => {
    if (!started) fail(`the sandbox sidecar is not reachable at ${S.agent} (${e.message})`);
  });
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as NodeJS.Signals[]) {
    process.on(sig, () => {
      try { sock.write(encodeFrame(FRAME.SIGNAL, sig)); } catch {}
      if (sig !== 'SIGINT') setTimeout(() => { try { sock.destroy(); } catch {} done(); }, 10_000).unref();
    });
  }
}
