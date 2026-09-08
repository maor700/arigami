// Host lifecycle from the cockpit (B4-lite, spec K4): restart now / restart
// when idle / upgrade — all of them end in *this process exiting 0* and the
// supervisor (systemd `Restart=always`, launchd `KeepAlive`, pm2 autorestart)
// bringing it back. Without a supervisor a restart would just be a shutdown,
// so `restart()` refuses (409) when no manager is detected.
//
// The restart itself is a small state machine, kept pure (injectable clock,
// busy-count and exit) so test/host-control.test.ts can drive it without a
// server:
//
//   idle ──request(now)──▶ draining ──(no busy | drain timeout)──▶ exiting
//     │                        ▲
//     └──request(idle)──▶ pending-idle ──(busy→0 | idle timeout)──┘
//                              │
//                              └──cancel()──▶ idle
//
// "busy" = a session whose claude turn is in flight (`claude.state ===
// 'working'`). claude.js pokes `onSessionIdle()` when a turn ends, which is
// what advances pending-idle. Draining gives in-flight turns a bounded grace
// period (cfg.host.drainTimeoutMs) — their processes are killed by the normal
// shutdown path (index.ts killAll) afterwards; sessions come back with
// `--resume` after the restart, the same as any host restart today.
//
// AUTH: every mutating endpoint here requires the `X-Arigami-Confirm: yes`
// header (api.ts) as a CSRF-ish guard for now. TODO(C1): once session-cookie
// auth lands, gate these behind the admin role and drop the header dance.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { cfg } from './lib/config.js';
import { ARIGAMI_DIR } from './lib/instance.js';
import { resourceRoot } from './lib/resource-root.js';
import * as state from './state.js';
import * as bus from './bus.js';

export type Manager = 'systemd' | 'launchd' | 'pm2' | 'docker' | 'none';
export type RestartWhen = 'now' | 'idle';
export type Phase = 'idle' | 'pending-idle' | 'draining' | 'exiting';

/**
 * What the parent of `pid` is running (first argv[0] basename + args on
 * Linux via /proc, `ps` elsewhere). '' when unknown.
 */
export function parentCommand(ppid: number = process.ppid): string {
  if (!ppid || ppid < 1) return '';
  try {
    if (process.platform === 'linux') return fs.readFileSync(`/proc/${ppid}/cmdline`).toString('utf8').split('\0').filter(Boolean).join(' ');
  } catch {}
  try {
    const r = spawnSync('ps', ['-o', 'command=', '-p', String(ppid)], { encoding: 'utf8', timeout: 2000 });
    return r.status === 0 ? String(r.stdout || '').trim() : '';
  } catch {
    return '';
  }
}

/**
 * Who will respawn us after exit. Pure over (env, ppid, parent command) so
 * it's testable. F4 #3: the env alone lies — `pm_id`/`PM2_HOME`/`INVOCATION_ID`
 * are inherited by every grandchild of a supervised host (a second instance
 * started from a session's shell, say), so a supervisor only counts when
 * THIS process's parent is that supervisor: pm2's God daemon, systemd
 * (pid 1 or the `systemd --user` manager), launchd (pid 1 on macOS).
 * `ARIGAMI_SUPERVISOR=<name|none>` still overrides (the shipped units set it).
 */
export function detectManager(
  env: NodeJS.ProcessEnv = process.env,
  proc: { ppid?: number; parentCommand?: string } = {},
): Manager {
  const forced = (env.ARIGAMI_SUPERVISOR || '').toLowerCase();
  if (forced === 'systemd' || forced === 'launchd' || forced === 'pm2' || forced === 'docker') return forced;
  if (forced === 'none') return 'none';
  const ppid = proc.ppid ?? process.ppid;
  // F8: inside a container the image's ENTRYPOINT (pid 1) is our parent and
  // compose's `restart: unless-stopped` brings the container back after exit 0.
  if (inContainer() && ppid === 1) return 'docker';
  const parent = (proc.parentCommand ?? parentCommand(ppid)).toLowerCase();
  const head = parent.split(/\s+/).slice(0, 4); // only the program + first args count, not a shell's whole script text
  const isSystemd = ppid === 1 || /(^|\/)systemd$/.test(head[0] || '');
  const isPm2 = /^pm2\b/.test(parent) || parent.includes('god daemon') || head.some((t) => /(^|\/)(pm2|pm2-runtime)$|\/pm2\/(lib|bin)\//.test(t));
  if (env.INVOCATION_ID && isSystemd) return 'systemd'; // set by systemd for every service
  if ((env.PM2_HOME || env.pm_id !== undefined) && isPm2) return 'pm2';
  if (env.XPC_SERVICE_NAME && env.XPC_SERVICE_NAME !== '0' && process.platform === 'darwin' && ppid === 1) return 'launchd';
  return 'none';
}

export class NoSupervisorError extends Error {
  status = 409;
  constructor() {
    super('no supervisor: the host was started by hand, so exiting would not restart it. Run it under systemd/launchd/pm2 (see docs/DEPLOY.md) or use `bin/host restart`.');
  }
}

export interface RestartDeps {
  manager: () => Manager;
  busyCount: () => number;
  exit: (reason: string) => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
  drainTimeoutMs?: number;
  idleTimeoutMs?: number;
  /** Called once when draining starts — index.ts stops accepting new connections here. */
  onDrainStart?: () => void;
  emit?: (ev: Record<string, unknown>) => void;
}

export interface RestartStatus {
  phase: Phase;
  pendingRestart: RestartWhen | null;
  requestedAt: number | null;
  reason: string | null;
  busySessions: number;
}

export class RestartController {
  private phase: Phase = 'idle';
  private when: RestartWhen | null = null;
  private requestedAt: number | null = null;
  private reason: string | null = null;
  private timer: unknown = null;
  private readonly d: Required<Omit<RestartDeps, 'onDrainStart' | 'emit'>> & Pick<RestartDeps, 'onDrainStart' | 'emit'>;

  constructor(deps: RestartDeps) {
    this.d = {
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as any),
      drainTimeoutMs: 20_000,
      idleTimeoutMs: 30 * 60_000,
      ...deps,
    };
  }

  status(): RestartStatus {
    return {
      phase: this.phase,
      pendingRestart: this.phase === 'idle' ? null : this.when,
      requestedAt: this.requestedAt,
      reason: this.reason,
      busySessions: this.d.busyCount(),
    };
  }

  /** Schedule a restart. Throws NoSupervisorError when nothing would respawn us. */
  request(when: RestartWhen, reason = 'requested'): { scheduled: RestartWhen; busySessions: number } {
    if (this.d.manager() === 'none') throw new NoSupervisorError();
    if (this.phase === 'draining' || this.phase === 'exiting')
      return { scheduled: 'now', busySessions: this.d.busyCount() };
    this.requestedAt = this.d.now();
    this.reason = reason;
    const busy = this.d.busyCount();
    if (when === 'idle' && busy > 0) {
      this.when = 'idle';
      this.phase = 'pending-idle';
      this.arm(() => this.drain('idle-timeout'), this.d.idleTimeoutMs);
      this.emit({ kind: 'restart-scheduled', when: 'idle', busySessions: busy, reason });
      return { scheduled: 'idle', busySessions: busy };
    }
    this.when = 'now';
    this.drain(reason);
    return { scheduled: 'now', busySessions: busy };
  }

  /** Drop a pending-idle restart. No-op once draining has begun. */
  cancel(): boolean {
    if (this.phase !== 'pending-idle') return false;
    this.disarm();
    this.phase = 'idle';
    this.when = null;
    this.requestedAt = null;
    this.reason = null;
    this.emit({ kind: 'restart-cancelled' });
    return true;
  }

  /** claude.js calls this whenever a turn finishes. */
  onSessionIdle(): void {
    if (this.phase === 'pending-idle' && this.d.busyCount() === 0) this.drain('idle');
    else if (this.phase === 'draining' && this.d.busyCount() === 0) this.finish('drained');
  }

  private drain(reason: string): void {
    if (this.phase === 'draining' || this.phase === 'exiting') return;
    this.disarm();
    this.phase = 'draining';
    this.reason = reason;
    try { this.d.onDrainStart?.(); } catch {}
    const busy = this.d.busyCount();
    this.emit({ kind: 'restart-draining', busySessions: busy, reason, timeoutMs: this.d.drainTimeoutMs });
    if (busy === 0) return this.finish(reason);
    this.arm(() => this.finish('drain-timeout'), this.d.drainTimeoutMs);
  }

  private finish(reason: string): void {
    if (this.phase === 'exiting') return;
    this.disarm();
    this.phase = 'exiting';
    this.emit({ kind: 'restarting', reason });
    this.d.exit(reason);
  }

  private arm(fn: () => void, ms: number): void {
    this.disarm();
    this.timer = this.d.setTimer(fn, ms);
  }
  private disarm(): void {
    if (this.timer != null) { this.d.clearTimer(this.timer); this.timer = null; }
  }
  private emit(ev: Record<string, unknown>): void {
    try { this.d.emit?.(ev); } catch {}
  }
}

// ---- upgrade job --------------------------------------------------------------

export interface UpgradeStep { name: string; cmd: string[]; cwd: string; failMessage?: string }
/** 'confirm' (VER1): pull + install + build, then WAIT — the restart is a separate, explicit click. */
export type UpgradeWhen = RestartWhen | 'confirm';
export interface UpgradeJob {
  id: string;
  startedAt: number;
  finishedAt: number | null;
  ok: boolean | null;
  step: string | null;
  error: string | null;
  when: UpgradeWhen;
  from: string | null; // version before the pull
  to: string | null; // version after it (read from the updated checkout)
  needsRestart: boolean; // VER1: built and waiting for the human's restart click
  log: string[]; // capped tail
}

export const DIRTY_ERROR = 'repo has uncommitted changes — commit or stash them before upgrading';
export const ALLOW_ERROR = 'upgrade disabled by config (host.allowUpgrade=false)';
export const NOT_FF_ERROR = 'the checkout has commits upstream does not — a fast-forward pull is impossible (see docs/GIT-REALIGN.md)';

/** `git status --porcelain` → dirty? Untracked files are ignored: a ff-only pull never touches them. */
export function isDirtyStatus(porcelain: string): boolean {
  return dirtyFiles(porcelain).length > 0;
}

/** VER1: the tracked paths that make the checkout dirty, as "XY path" lines (untracked skipped) — what the UI lists. */
export function dirtyFiles(porcelain: string): string[] {
  return porcelain.split('\n').filter((l) => l.trim() && !l.startsWith('??')).map((l) => `${l.slice(0, 2).trim() || '?'} ${l.slice(3).trim()}`);
}

export function upgradePlan(root: string): UpgradeStep[] {
  return [
    // no --prune: pruning is how a rewritten remote silently loses its merge base with this checkout
    { name: 'fetch', cmd: ['git', 'fetch', '--quiet', '--tags'], cwd: root },
    // VER1: fail EARLY, with a readable reason, instead of letting `pull --ff-only` print git's
    { name: 'check', cmd: ['git', 'merge-base', '--is-ancestor', 'HEAD', '@{u}'], cwd: root, failMessage: NOT_FF_ERROR },
    { name: 'pull', cmd: ['git', 'pull', '--ff-only', '--quiet'], cwd: root },
    { name: 'install', cmd: ['bun', 'install', '--frozen-lockfile'], cwd: root },
    { name: 'build', cmd: ['bun', 'run', 'build'], cwd: path.join(root, 'web') },
  ];
}

function run(cmd: string[], cwd: string, onLine: (l: string) => void): Promise<number> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd[0], cmd.slice(1), { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    let buf = '';
    const feed = (c: Buffer) => {
      buf += c.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); }
    };
    p.stdout.on('data', feed);
    p.stderr.on('data', feed);
    p.on('error', reject);
    p.on('close', (code) => { if (buf) onLine(buf); resolve(code ?? 1); });
  });
}

/** VER1: the dirty list the Settings card shows next to the update button (5s cache — the UI polls). */
let dirtyCache: { at: number; root: string; files: string[] } | null = null;
export async function dirtyNow(root = ROOT): Promise<string[]> {
  if (dirtyCache && dirtyCache.root === root && Date.now() - dirtyCache.at < 5_000) return dirtyCache.files;
  let files: string[] = [];
  try { files = dirtyFiles(await gitStatus(root)); } catch {}
  dirtyCache = { at: Date.now(), root, files };
  return files;
}

function gitStatus(root: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn('git', ['status', '--porcelain'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (c) => (out += c));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error('git status failed'))));
  });
}

// ---- singleton wiring ---------------------------------------------------------

const ROOT = resourceRoot();
const STARTED_AT = Date.now();
let drainHandler: (() => void) | null = null;
let current: UpgradeJob | null = null;

export function busySessions(): number {
  return state.listSessions({ archived: true }).filter((s) => s.claude?.state === 'working').length;
}

/** Is this a loopback peer (the only caller /__health tells more than {ok} to)? */
export function isLoopback(remoteAddress: string | undefined): boolean {
  const a = String(remoteAddress || '');
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

/**
 * K8S-3: the public `/__health` body. Loopback callers (a `kubectl exec` from
 * the control-plane, bin/host on the same box) additionally get
 * `busySessions` — the same "a claude turn is in flight" count the restart
 * drain uses — so an orchestrator can hold an upgrade until the tenant is
 * idle WITHOUT this activity signal being visible through the ingress to the
 * open internet (the probe endpoint is unauthenticated by design).
 */
export function healthBody(remoteAddress: string | undefined, busy: () => number = busySessions): { ok: true; busySessions?: number } {
  return isLoopback(remoteAddress) ? { ok: true, busySessions: busy() } : { ok: true };
}

/** index.ts registers "stop accepting" here (server.close()). */
export function setDrainHandler(fn: () => void): void { drainHandler = fn; }

export const restarts = new RestartController({
  manager: () => detectManager(),
  busyCount: busySessions,
  drainTimeoutMs: cfg.host?.drainTimeoutMs,
  idleTimeoutMs: (cfg.host?.idleTimeoutMin ?? 30) * 60_000,
  onDrainStart: () => drainHandler?.(),
  emit: (ev) => bus.broadcast({ type: 'host', event: ev }),
  exit: (reason) => {
    console.log(`[host] restarting (${reason}) — exiting 0 for the supervisor (${detectManager()})`);
    // Give the broadcast + the HTTP response a tick to flush, then take the
    // normal shutdown path (flushState → killAll → exit 0) via our own SIGTERM.
    setTimeout(() => {
      try { process.kill(process.pid, 'SIGTERM'); } catch { process.exit(0); }
      setTimeout(() => process.exit(0), 5000).unref();
    }, 150);
  },
});

/** /.dockerenv or a docker/k8s cgroup — same probe telemetry/onboarding use. */
export function inContainer(): boolean {
  try {
    if (fs.existsSync('/.dockerenv')) return true;
    return /docker|kubepods|containerd/.test(fs.readFileSync('/proc/1/cgroup', 'utf8'));
  } catch {
    return false;
  }
}

export async function hostStatus() {
  const r = restarts.status();
  const docker = inContainer();
  return {
    manager: detectManager(),
    // VER1: what blocks an upgrade (tracked changes in the running checkout), listed for the human
    dirty: docker ? [] : await dirtyNow(),
    // F8: Docker mode — no git checkout to pull; upgrade = pull + recreate on the host machine.
    docker,
    image: docker ? process.env.ARIGAMI_IMAGE || null : null,
    uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000),
    pid: process.pid,
    busySessions: r.busySessions,
    pendingRestart: r.pendingRestart,
    phase: r.phase,
    requestedAt: r.requestedAt,
    allowUpgrade: !docker && cfg.host?.allowUpgrade !== false,
    upgrade: current ? { ...current, log: current.log.slice(-40) } : null,
  };
}

export function currentUpgrade(): UpgradeJob | null { return current; }

/**
 * git fetch → pull --ff-only → bun install → web build → restart.
 * Resolves as soon as the job is accepted (progress streams on the bus as
 * `host` events {kind:'upgrade-progress'|'upgrade-done'|'upgrade-failed'}).
 */
export async function startUpgrade(when: UpgradeWhen = 'confirm', root = ROOT, plan: UpgradeStep[] = upgradePlan(root)): Promise<UpgradeJob> {
  if (cfg.host?.allowUpgrade === false) throw Object.assign(new Error(ALLOW_ERROR), { status: 403 });
  if (current && current.finishedAt === null) throw Object.assign(new Error('an upgrade is already running'), { status: 409 });
  if (detectManager() === 'none') throw new NoSupervisorError();
  const dirty = dirtyFiles(await gitStatus(root));
  if (dirty.length) throw Object.assign(new Error(DIRTY_ERROR), { status: 409, dirty });

  const ver = await import('./version.js');
  const job: UpgradeJob = { id: `upg_${Date.now().toString(36)}`, startedAt: Date.now(), finishedAt: null, ok: null, step: null, error: null, when, from: ver.currentVersion(root), to: null, needsRestart: false, log: [] };
  dirtyCache = null;
  current = job;
  const logDir = path.join(ARIGAMI_DIR, 'logs');
  try { fs.mkdirSync(logDir, { recursive: true }); } catch {}
  const logFile = path.join(logDir, 'upgrade.log');
  const line = (l: string) => {
    job.log.push(l);
    if (job.log.length > 400) job.log.splice(0, job.log.length - 400);
    try { fs.appendFileSync(logFile, `${new Date().toISOString()} [${job.step}] ${l}\n`); } catch {}
    bus.broadcast({ type: 'host', event: { kind: 'upgrade-progress', jobId: job.id, step: job.step, line: l } });
  };

  (async () => {
    try {
      for (const s of plan) {
        job.step = s.name;
        line(`$ ${s.cmd.join(' ')}`);
        const code = await run(s.cmd, s.cwd, line);
        if (code !== 0) throw new Error(s.failMessage || `${s.name} failed (exit ${code})`);
      }
      job.ok = true;
      job.finishedAt = Date.now();
      job.to = ver.currentVersion(root);
      ver.invalidateVersion();
      if (when === 'confirm') {
        // VER1: the new code is on disk; nothing runs it until the human clicks restart.
        job.step = 'await-restart';
        job.needsRestart = true;
        line(`✓ ${job.from ?? '?'} → ${job.to} built — waiting for the restart click`);
        bus.broadcast({ type: 'host', event: { kind: 'upgrade-done', jobId: job.id, when, needsRestart: true, from: job.from, to: job.to } });
        return;
      }
      job.step = 'restart';
      bus.broadcast({ type: 'host', event: { kind: 'upgrade-done', jobId: job.id, when, needsRestart: false, from: job.from, to: job.to } });
      restarts.request(when, 'upgrade');
    } catch (e) {
      job.ok = false;
      job.error = (e as Error).message;
      job.finishedAt = Date.now();
      line(`✗ ${job.error}`);
      bus.broadcast({ type: 'host', event: { kind: 'upgrade-failed', jobId: job.id, error: job.error, step: job.step } });
    }
  })();
  return job;
}
