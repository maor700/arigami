// EXT — an extension's own npm dependencies (`<ext>/package.json` → `<ext>/node_modules`).
//
// An install copies the extension WITHOUT node_modules, and an export never
// carries them, so an extension whose tools import a package (`xlsx`, …) loads
// on a new host with nothing to import. This module answers two questions for
// the loader (server/extensions.ts), which owns WHEN they are asked:
//
//   checkDeps(dir)    are the declared dependencies there, and from THIS package.json/lockfile?
//   installDeps(dir)  one `bun install` in the extension directory, bounded and quiet
//
// The install is deliberately narrow:
//   --production       devDependencies are for the author; the host runs the TS directly
//   --frozen-lockfile  when bun.lock / bun.lockb exists — the versions the author pinned, or a failure
//   --no-save          when there is none — never write a lockfile into the user's extension
//                      (it would make the directory differ from its source, and the next
//                      profile apply would see an "update" that is only our own file)
//   --ignore-scripts   no lifecycle script runs — not the extension's own preinstall/postinstall,
//                      not a dependency's. The install happens on an admin's click or on a
//                      profile apply nobody watches, with the host's privileges; a postinstall
//                      in some transitive package is code nobody reviewed, which is exactly the
//                      supply-chain path a lockfile alone does not close. A package that needs a
//                      native build will not work this way: run `bun install` by hand in the
//                      extension directory (the loader picks it up), or set
//                      ARIGAMI_EXT_DEPS_SCRIPTS=1 to fall back to Bun's own policy (only
//                      `trustedDependencies` run their scripts).
//
// A stamp (`node_modules/.arigami-deps.json`) records the package.json + lockfile
// the tree was installed from, so a changed manifest re-installs even when every
// package name is still present.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isCompiledBinary } from './resource-root.js';

export const STAMP_FILE = '.arigami-deps.json';
const LOCKFILES = ['bun.lock', 'bun.lockb'];
const DEFAULT_TIMEOUT_MS = 180_000;

export interface DepsCheck {
  /** package.json declares at least one runtime dependency */
  needed: boolean;
  /** every one of them is installed, at a matching version, from this package.json/lockfile */
  satisfied: boolean;
  /** what is absent or wrong, human-readable ("xlsx", "xlsx@0.17.0 (wants ^0.18.5)", "package.json changed since the last install") */
  missing: string[];
  /** the lockfile the install is pinned to, or null (not reproducible) */
  lockfile: string | null;
  /** sha256 of package.json + lockfile — what an install is FROM */
  stamp: string;
  /** package.json could not be read */
  error?: string;
}

const readJson = (f: string): any => JSON.parse(fs.readFileSync(f, 'utf8'));

export function lockfileOf(dir: string): string | null {
  for (const f of LOCKFILES) if (fs.existsSync(path.join(dir, f))) return f;
  return null;
}

/** The runtime dependencies package.json declares (optional ones are best-effort, so not required). */
export function declaredDeps(dir: string): Record<string, string> | null {
  const file = path.join(dir, 'package.json');
  if (!fs.existsSync(file)) return null;
  const pkg = readJson(file);
  const deps = pkg && typeof pkg.dependencies === 'object' && !Array.isArray(pkg.dependencies) ? pkg.dependencies : {};
  return Object.fromEntries(Object.entries(deps).map(([k, v]) => [k, String(v)]));
}

export function stampOf(dir: string): string {
  const h = createHash('sha256');
  for (const f of ['package.json', ...LOCKFILES]) {
    h.update(f + '\0');
    try { h.update(fs.readFileSync(path.join(dir, f))); } catch { /* absent */ }
    h.update('\0');
  }
  return h.digest('hex').slice(0, 16);
}

function installedStamp(dir: string): string | null {
  try { return String(readJson(path.join(dir, 'node_modules', STAMP_FILE)).stamp || '') || null; } catch { return null; }
}

// A plain semver range (^1.2.3, ~1, >=2 <3, 1.x, *). Anything else — file:, link:,
// git, a URL, an npm: alias, a dist-tag — is checked for presence only.
const SEMVER_RANGE = /^[\s\d.xX*^~<>=|-]+$/;

export function checkDeps(dir: string): DepsCheck {
  const stamp = stampOf(dir);
  const lockfile = lockfileOf(dir);
  let deps: Record<string, string> | null;
  try {
    deps = declaredDeps(dir);
  } catch (e) {
    return { needed: true, satisfied: false, missing: [], lockfile, stamp, error: `package.json is not valid JSON: ${(e as Error).message}` };
  }
  if (!deps || !Object.keys(deps).length) return { needed: false, satisfied: true, missing: [], lockfile, stamp };
  const missing: string[] = [];
  const semver = (globalThis as any).Bun?.semver;
  for (const [name, range] of Object.entries(deps)) {
    let have: string | undefined;
    try { have = String(readJson(path.join(dir, 'node_modules', name, 'package.json')).version || ''); } catch { missing.push(name); continue; }
    if (semver && have && SEMVER_RANGE.test(range.trim()) && !semver.satisfies(have, range)) missing.push(`${name}@${have} (wants ${range})`);
  }
  // Installed by us from a DIFFERENT package.json/lockfile: an update changed them.
  // A tree with no stamp (someone ran `bun install` by hand) is judged by presence alone.
  const was = installedStamp(dir);
  if (!missing.length && was && was !== stamp) missing.push('package.json or the lockfile changed since the last install');
  return { needed: true, satisfied: missing.length === 0, missing, lockfile, stamp };
}

export interface InstallResult {
  ok: boolean;
  /** one line, for the status the cockpit shows */
  error?: string;
  ms: number;
  args: string[];
}

/** How to run Bun: `bun` on PATH, or — inside a compiled binary, which has no `bun` beside it — the binary itself acting as Bun. */
function bunCommand(): { command: string; env: Record<string, string> } {
  if (isCompiledBinary()) return { command: process.execPath, env: { BUN_BE_BUN: '1' } };
  return { command: process.env.ARIGAMI_EXT_BUN || 'bun', env: {} };
}

/** The last lines of Bun's output that say something — enough for one status line. */
function summarise(out: string, code: number | null, signal: string | null): string {
  const lines = out
    .split('\n')
    .map((l) => l.replace(/\x1b\[[0-9;]*m/g, '').trim())
    .filter((l) => l && !/^bun install v/i.test(l) && !/^\[[\d.]+m?s\]/.test(l));
  const msg = lines.filter((l) => /error|fail|not found|could not|unable|404|ENOTFOUND|ECONN|EAI_AGAIN|timed? ?out|lockfile/i.test(l)).slice(-2).join(' — ') || lines.slice(-2).join(' — ');
  return (msg || `bun install exited with ${signal || code}`).slice(0, 400);
}

/**
 * `bun install` inside `dir`. Never throws. On success the stamp is written, so
 * checkDeps() knows which package.json/lockfile this tree came from.
 */
export async function installDeps(dir: string, opts: { timeoutMs?: number } = {}): Promise<InstallResult> {
  const t0 = Date.now();
  const lockfile = lockfileOf(dir);
  const args = ['install', '--production', lockfile ? '--frozen-lockfile' : '--no-save'];
  if (process.env.ARIGAMI_EXT_DEPS_SCRIPTS !== '1') args.push('--ignore-scripts');
  const timeoutMs = opts.timeoutMs ?? (Number(process.env.ARIGAMI_EXT_DEPS_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS);
  const { command, env: extra } = bunCommand();
  // Bun reads its registry/proxy settings from the env, so the host's env goes
  // along — minus the identity a session's shell may have left in it.
  const { ARIGAMI_TOKEN: _t, ARIGAMI_SESSION_ID: _s, ...base } = process.env as Record<string, string>;
  const r = await new Promise<{ code: number | null; signal: string | null; out: string; timedOut: boolean; spawnError?: string }>((resolve) => {
    let out = '';
    let child: ReturnType<typeof spawn>;
    try {
      // Its own process group, so the timeout takes down whatever it started too
      // (a grandchild holding the pipes would otherwise outlive the kill).
      child = spawn(command, args, { cwd: dir, env: { ...base, ...extra, NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    } catch (e) {
      resolve({ code: null, signal: null, out: '', timedOut: false, spawnError: (e as Error).message });
      return;
    }
    const keep = (b: Buffer) => { out = (out + b.toString('utf8')).slice(-16_000); };
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    const timer = setTimeout(() => {
      try { process.platform !== 'win32' && child.pid ? process.kill(-child.pid, 'SIGKILL') : child.kill('SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
      resolve({ code: null, signal: 'SIGKILL', out, timedOut: true });
    }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: null, signal: null, out, timedOut: false, spawnError: e.message }); });
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, out, timedOut: false }); });
  });
  const ms = Date.now() - t0;
  if (r.spawnError) return { ok: false, error: `could not run bun: ${r.spawnError}`, ms, args };
  if (r.timedOut) return { ok: false, error: `bun install timed out after ${Math.round(timeoutMs / 1000)}s (offline, or a slow registry?)`, ms, args };
  if (r.code !== 0) return { ok: false, error: summarise(r.out, r.code, r.signal), ms, args };
  try {
    fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules', STAMP_FILE), JSON.stringify({ stamp: stampOf(dir), lockfile, at: new Date().toISOString(), args }, null, 2) + '\n');
  } catch { /* the presence check still holds */ }
  return { ok: true, ms, args };
}
