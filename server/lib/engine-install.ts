// Engine CLIs on first need. The container image bakes in neither `claude` nor `codex`: both install into the user's
// ~/.local (the persistent volume; ~/.local/bin is first on PATH in the image), always the latest release, and then
// update in place through their normal update channel.
//   claude — at first boot when missing (it is the default engine): claude-update.js runs the native installer.
//   codex  — lazily, the first time a Codex account is added: `npm i -g --prefix ~/.local @openai/codex@latest`.
// Outside a container nothing is installed behind the user's back unless ARIGAMI_<ENGINE>_AUTOINSTALL=1;
// =0 turns it off everywhere.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { which, extraBinDirs, HOME } from './platform.js';

export type Engine = 'claude' | 'codex';

export function inContainerEnv(env: NodeJS.ProcessEnv = process.env, dockerenv = fs.existsSync('/.dockerenv')): boolean {
  return env.ARIGAMI_SUPERVISOR === 'docker' || dockerenv || !!env.KUBERNETES_SERVICE_HOST;
}

/** May the host install `engine` by itself? Pure (the container probe is injectable). */
export function autoInstallAllowed(engine: Engine, env: NodeJS.ProcessEnv = process.env, container = inContainerEnv(env)): boolean {
  const knob = env[`ARIGAMI_${engine.toUpperCase()}_AUTOINSTALL`];
  if (knob === '0') return false;
  return knob === '1' || container;
}

/** Where a user-level install puts things: ~/.local (bin → ~/.local/bin). */
export const USER_PREFIX = path.join(HOME, '.local');

/** The npm command that installs (or updates) codex into ~/.local. */
export function codexNpmArgs(prefix = USER_PREFIX): string[] {
  return ['install', '-g', '--prefix', prefix, '@openai/codex@latest'];
}

/** True when `bin` (resolved through symlinks) lives under ~/.local — i.e. it was installed by codexNpmArgs. */
export function isUserInstall(bin: string | null, prefix = USER_PREFIX): boolean {
  if (!bin) return false;
  let real = bin;
  try { real = fs.realpathSync(bin); } catch {}
  return real === prefix || real.startsWith(prefix + path.sep);
}

export function findCodex(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.ARIGAMI_CODEX_BIN) return env.ARIGAMI_CODEX_BIN;
  return which('codex', [path.join(USER_PREFIX, 'bin'), ...extraBinDirs()]);
}

export interface RunResult { code: number; output: string; timedOut?: boolean; error?: string | null }

export function runNpm(args: string[], timeoutMs = 10 * 60 * 1000): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile('npm', args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, CI: '1', NO_COLOR: '1', npm_config_update_notifier: 'false' } }, (err, stdout, stderr) => {
      const output = `${stdout || ''}${stderr ? `\n${stderr}` : ''}`.trim();
      resolve({ code: err ? (typeof (err as any).code === 'number' ? (err as any).code : 1) : 0, timedOut: !!(err as any)?.killed, output, error: err ? err.message : null });
    });
  });
}

let codexInflight: Promise<string> | null = null;

/**
 * The codex binary, installing it first when it's missing and that's allowed. Concurrent callers share one install.
 * Rejects with a message fit for the cockpit when codex is missing and can't be installed.
 */
export function ensureCodexCli(deps: {
  find?: () => string | null;
  allowed?: () => boolean;
  run?: (args: string[]) => Promise<RunResult>;
  emit?: (event: Record<string, unknown>) => void;
} = {}): Promise<string> {
  const find = deps.find || (() => findCodex());
  const found = find();
  if (found) return Promise.resolve(found);
  if (!(deps.allowed || (() => autoInstallAllowed('codex')))()) return Promise.reject(new Error('codex is not installed on this host — install it (npm i -g @openai/codex) and try again'));
  if (codexInflight) return codexInflight;
  const emit = deps.emit || defaultEmit;
  const run = deps.run || ((a: string[]) => runNpm(a));
  emit({ kind: 'codex-update-started', from: null, to: 'latest', reason: 'install' });
  codexInflight = (async () => {
    const r = await run(codexNpmArgs());
    const bin = find();
    if (r.code === 0 && bin) {
      emit({ kind: 'codex-update-done', from: null, to: 'latest', reason: 'install' });
      return bin;
    }
    const tail = r.output.split('\n').map((l) => l.trim()).filter(Boolean).slice(-2).join(' · ');
    const error = r.timedOut ? 'the codex install timed out' : `the codex install failed${tail ? `: ${tail}` : ` (exit ${r.code})`}`;
    emit({ kind: 'codex-update-failed', from: null, error, reason: 'install' });
    throw new Error(error);
  })().finally(() => { codexInflight = null; });
  return codexInflight;
}

function defaultEmit(event: Record<string, unknown>): void {
  import('../bus.js').then((bus) => bus.broadcast({ type: 'host', event } as any)).catch(() => {});
}
