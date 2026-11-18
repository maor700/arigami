// The process the host spawns in place of a sandboxed session's engine (server/lib/sandbox.ts wrapSpawn):
//   bun sandbox-launch.ts <spec.json>
// It reads (and deletes) the launch spec, makes sure the networks and the egress container are up, and runs
// `docker run -i` with the engine's own argv — the host's stdin/stdout/stderr pipes go straight through, so the
// engine driver sees exactly the stream it would see from a local process. Signals become `docker kill`, and the
// container is removed whatever way this process ends.
//
// This process carries no session env (no ARIGAMI_SESSION_ID, no token): the engine's env goes to docker through an
// env file that lives only until the container exists.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import * as infra from './sandbox-infra.js';
import type { LaunchSpec } from './sandbox.js';

let ephemeral: string[] = [];
const dropEphemeral = () => { for (const f of ephemeral) try { fs.rmSync(f, { force: true }); } catch {} };
const fail = (msg: string): never => {
  dropEphemeral();
  process.stderr.write(`sandbox: ${msg}\n`);
  process.exit(1);
};

const specFile = process.argv[2];
if (!specFile) fail('no launch spec');
let spec: LaunchSpec;
try {
  spec = JSON.parse(fs.readFileSync(specFile, 'utf8'));
} catch (e) {
  fail(`unreadable launch spec: ${(e as Error).message}`);
}
try { fs.rmSync(specFile, { force: true }); } catch {}
ephemeral = spec!.ephemeral || [];
if (spec!.error) fail(spec!.error);
const S = spec!;
const D = S.infra.docker;
const runDir = path.dirname(specFile);

// 1. infra: networks + egress container (idempotent), and the host relay's address must be known.
try {
  infra.withLock(S.infra.egressDir, () => {
    infra.ensureNetworks(S.infra);
    infra.ensureEgress(S.infra);
  });
} catch (e) {
  fail((e as Error).message);
}
{
  const t0 = Date.now();
  for (;;) {
    try {
      if (JSON.parse(fs.readFileSync(path.join(S.infra.egressDir, 'config.json'), 'utf8')).hostTarget) break;
    } catch {}
    if (Date.now() - t0 > 30_000) fail("the host's sandbox listener is not up (see the host log: [sandbox])");
    Bun.sleepSync(250);
  }
}

// 2. the env file (0600, removed as soon as the container exists)
const envFile = path.join(runDir, `${S.name}.${process.pid}.env`);
const cidFile = path.join(runDir, `${S.name}.${process.pid}.cid`);
const lines: string[] = [];
for (const [k, v] of Object.entries(S.env)) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || /[\r\n]/.test(v)) continue; // docker env files are one line per var
  lines.push(`${k}=${v}`);
}
fs.writeFileSync(envFile, lines.join('\n') + '\n', { mode: 0o600 });
// THIS run's container id (from --cidfile). Kill/remove by id, never by name: after a restart the same name already
// belongs to the session's NEXT container, which this (old) launcher must not touch.
let cid = '';
const readCid = () => {
  if (!cid) try { cid = fs.readFileSync(cidFile, 'utf8').trim(); } catch {}
  return cid;
};
let cleaned = false;
const cleanup = () => {
  if (cleaned) return;
  cleaned = true;
  const id = readCid();
  for (const f of [envFile, cidFile]) try { fs.rmSync(f, { force: true }); } catch {}
  if (id) infra.docker(D, ['rm', '-f', id], 20_000);
  dropEphemeral(); // the staged credential of THIS run (unique name: a restart's new copy is untouched)
};

// A previous run of the same session that did not go away.
infra.docker(D, ['rm', '-f', S.name], 20_000);

const csv = (v: string) => (/[",]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const args = [
  'run', '-i', '--rm', '--init',
  '--name', S.name, '--cidfile', cidFile, '--env-file', envFile,
  '--network', S.infra.internal, '--hostname', 'sandbox',
  '--user', S.user, '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
  '--pids-limit', String(S.limits.pids), '--memory', S.limits.memory, '--cpus', S.limits.cpus,
  '--label', 'arigami.sandbox=1', '--label', `arigami.sandbox.instance=${S.infra.tag}`, '--label', 'arigami.sandbox.role=session',
  '--label', `arigami.session=${S.sessionId}`,
  '--tmpfs', '/tmp:rw,nosuid,nodev,size=1g',
  '--mount', `type=bind,source=${csv(S.infra.codeDirSource)},target=${infra.CODE_MOUNT},readonly`,
  ...S.mounts.flatMap((m) => ['--mount', `type=bind,${csv(`source=${m.source}`)},${csv(`target=${m.target}`)}${m.ro ? ',readonly' : ''}`]),
  '--workdir', S.cwd,
  '--entrypoint', 'bun',
  S.image, `${infra.CODE_MOUNT}/init.ts`, '--forward', String(S.forwardPort), '--relay', `${infra.RELAY_ALIAS}:${infra.RELAY_PORT}`, '--',
  ...S.argv,
];

const child = spawn(D, args, { stdio: 'inherit' });
// The env file is read before the container is created; the cid file appears once it is.
const watch = setInterval(() => {
  if (readCid()) {
    try { fs.rmSync(envFile, { force: true }); } catch {}
    clearInterval(watch);
  }
}, 100);
setTimeout(() => { try { fs.rmSync(envFile, { force: true }); } catch {} clearInterval(watch); }, 30_000).unref();

const forward = (sig: NodeJS.Signals) => () => {
  // SIGINT is an interrupt (the engine keeps running); anything else ends the session's container.
  const id = readCid();
  if (id) infra.docker(D, ['kill', '--signal', sig === 'SIGINT' ? 'INT' : 'TERM', id], 10_000);
  else if (sig !== 'SIGINT') { try { child.kill('SIGTERM'); } catch {} } // not created yet: stop the CLI itself
  if (sig !== 'SIGINT') setTimeout(() => { cleanup(); process.exit(143); }, 10_000).unref();
};
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as NodeJS.Signals[]) process.on(sig, forward(sig));
child.on('error', (e) => { cleanup(); fail(`cannot run docker: ${e.message}`); });
child.on('exit', (code, signal) => {
  clearInterval(watch);
  cleanup();
  process.exit(code ?? (signal ? 128 : 1));
});
