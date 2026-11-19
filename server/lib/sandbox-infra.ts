// The docker side of the restricted-session sandbox (docs/SANDBOX.md): two networks and one egress container per
// host instance. No imports beyond node built-ins, on purpose — the launcher (sandbox-launch.ts, a separate process)
// and the host both use it, and the launcher must not load the host's config/state modules.
//
//   <prefix>-int     --internal bridge. The session containers live here, and nothing on it routes anywhere.
//   <prefix>-out     a normal bridge (or cfg.sandbox.outsideNetwork) — the egress container's way out.
//   <prefix>-egress  the egress container, on both: on -int it answers as `arigami-egress` (the forward proxy,
//                    :3128, allowlist + deny log) and `arigami-host` (a TCP relay, :8080, to the host's sandbox
//                    listener and nowhere else).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const PROXY_PORT = 3128;
export const RELAY_PORT = 8080;
export const PROXY_ALIAS = 'arigami-egress';
export const RELAY_ALIAS = 'arigami-host';
/** In-container path of docker/sandbox (mounted read-only from the host's checkout). */
export const CODE_MOUNT = '/opt/arigami-sandbox';

export interface InfraSpec {
  docker: string;
  /** `arigami-sbx-<tag>` — every name this instance owns starts with it. */
  prefix: string;
  /** Instance tag (label value); the sweep removes only containers carrying it. */
  tag: string;
  image: string;
  internal: string;
  outside: string;
  /** true = outside is an existing network the host does not create (cfg.sandbox.outsideNetwork). */
  outsideExternal: boolean;
  subnet?: string;
  egress: string;
  /** The egress dir as the HOST sees it (config.json, key, policies/, proxy.log). */
  egressDir: string;
  /** The same dir as the docker DAEMON sees it (= egressDir unless the host runs in a container). */
  egressDirSource: string;
  /** docker/sandbox of the checkout, as the daemon sees it. */
  codeDirSource: string;
  user: string;
  dns?: string[];
}

export interface Exec { code: number; out: string; err: string }

export function docker(d: string, args: string[], timeoutMs = 60_000): Exec {
  const r = spawnSync(d, args, { encoding: 'utf8', timeout: timeoutMs, env: process.env });
  return { code: r.status ?? (r.error ? 127 : 1), out: String(r.stdout || '').trim(), err: String(r.stderr || r.error?.message || '').trim() };
}

const exists = (d: string, kind: 'network' | 'container', name: string) => docker(d, [kind, 'inspect', name], 15_000).code === 0;

/** A mkdir lock (works on every OS): concurrent launchers must not create the same network twice. */
export function withLock<T>(dir: string, fn: () => T, waitMs = 30_000): T {
  const lock = path.join(dir, '.infra.lock');
  const t0 = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch {
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 60_000) fs.rmSync(lock, { recursive: true, force: true }); // stale
      } catch {}
      if (Date.now() - t0 > waitMs) throw new Error('sandbox: timed out waiting for the infra lock');
      Bun.sleepSync(150);
    }
  }
  try {
    return fn();
  } finally {
    try { fs.rmSync(lock, { recursive: true, force: true }); } catch {}
  }
}

const labels = (spec: InfraSpec, role: string) => ['--label', 'arigami.sandbox=1', '--label', `arigami.sandbox.instance=${spec.tag}`, '--label', `arigami.sandbox.role=${role}`];

/** Both networks exist (idempotent). Throws with docker's own words when it cannot. */
export function ensureNetworks(spec: InfraSpec): void {
  if (!exists(spec.docker, 'network', spec.internal)) {
    const r = docker(spec.docker, ['network', 'create', '--driver', 'bridge', '--internal', ...(spec.subnet ? ['--subnet', spec.subnet] : []), ...labels(spec, 'net-internal'), spec.internal]);
    if (r.code !== 0 && !/already exists/i.test(r.err)) throw new Error(`sandbox: cannot create network ${spec.internal}: ${r.err}`);
  }
  if (!spec.outsideExternal && !exists(spec.docker, 'network', spec.outside)) {
    const r = docker(spec.docker, ['network', 'create', '--driver', 'bridge', ...labels(spec, 'net-outside'), spec.outside]);
    if (r.code !== 0 && !/already exists/i.test(r.err)) throw new Error(`sandbox: cannot create network ${spec.outside}: ${r.err}`);
  }
}

/** The outside network's gateway — on a Linux host, the host's own address on that bridge. */
export function outsideGateway(spec: InfraSpec): string | null {
  const r = docker(spec.docker, ['network', 'inspect', '-f', '{{range .IPAM.Config}}{{.Gateway}} {{end}}', spec.outside]);
  if (r.code !== 0) return null;
  return r.out.split(/\s+/).find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a)) || null;
}

/** The egress container runs and sits on both networks (idempotent; recreated when it died). */
export function ensureEgress(spec: InfraSpec): void {
  const st = docker(spec.docker, ['container', 'inspect', '-f', '{{.State.Running}}', spec.egress], 15_000);
  if (st.code === 0 && st.out === 'true') return;
  if (st.code === 0) docker(spec.docker, ['rm', '-f', spec.egress]);
  const r = docker(spec.docker, [
    'run', '-d', '--name', spec.egress, '--network', spec.outside, ...labels(spec, 'egress'),
    '--user', spec.user, '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '256', '--memory', '256m',
    ...(spec.dns || []).flatMap((d) => ['--dns', d]),
    '--mount', `type=bind,source=${spec.egressDirSource},target=/egress`,
    '--mount', `type=bind,source=${spec.codeDirSource},target=${CODE_MOUNT},readonly`,
    '--entrypoint', 'bun', spec.image, `${CODE_MOUNT}/egress-proxy.ts`, '/egress',
  ]);
  if (r.code !== 0) throw new Error(`sandbox: cannot start the egress container: ${r.err}`);
  const c = docker(spec.docker, ['network', 'connect', '--alias', PROXY_ALIAS, '--alias', RELAY_ALIAS, spec.internal, spec.egress]);
  if (c.code !== 0 && !/already exists|already attached/i.test(c.err)) {
    docker(spec.docker, ['rm', '-f', spec.egress]);
    throw new Error(`sandbox: cannot attach the egress container to ${spec.internal}: ${c.err}`);
  }
}

/** Session containers of THIS instance (by label) — all of them are orphans when the host boots. */
export function sessionContainers(spec: Pick<InfraSpec, 'docker' | 'tag'>): string[] {
  const r = docker(spec.docker, ['ps', '-a', '-q', '--filter', `label=arigami.sandbox.instance=${spec.tag}`, '--filter', 'label=arigami.sandbox.role=session']);
  return r.code === 0 ? r.out.split(/\s+/).filter(Boolean) : [];
}

export function removeContainers(d: string, ids: string[]): number {
  if (!ids.length) return 0;
  const r = docker(d, ['rm', '-f', ...ids]);
  return r.code === 0 ? ids.length : 0;
}
