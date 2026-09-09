// Cross-platform runtime shims.
//
// The host was written for macOS: `~` paths resolve against $HOME, shell jobs
// run under `bash -lc`, the `claude` CLI is an extension-less binary, and
// process/credential probing goes through `lsof` + the macOS keychain. None of
// that holds on Windows. This module is the single place those assumptions get
// normalized, so the rest of the server can stay platform-blind.
//
// IMPORTANT: importing this module has a SIDE EFFECT — it defines process.env.HOME
// when the platform doesn't. Every `~`-expander in the codebase (lib/config,
// state, git, onboarding) reads process.env.HOME at module-eval time, so this
// must be imported BEFORE them (see the first line of server/index.ts and
// mcp/host-mcp.js).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const isWin: boolean = process.platform === 'win32';

// --- HOME -------------------------------------------------------------------
// Windows has no HOME; without this every `~/.arigami` path collapses to a
// relative one and the host scatters state into its own repo dir.
if (!process.env.HOME) process.env.HOME = process.env.USERPROFILE || os.homedir();

export const HOME: string = process.env.HOME || os.homedir();

/** Expand a leading `~` against HOME. Mirrors state.ts/config.ts's untildify. */
export const tilde = (p: string | null | undefined): string =>
  p && p.startsWith('~') ? path.join(HOME, p.slice(1)) : p || '';

/**
 * A path in the form a POSIX shell wants: `C:\Users\x` → `C:/Users/x`.
 * MSYS (Git Bash) understands drive-letter paths with forward slashes natively,
 * but backslashes inside its coreutils are escape characters. Use this whenever
 * a filesystem path is INTERPOLATED INTO a shell command string.
 */
export const toPosixPath = (p: string): string =>
  isWin ? String(p).replace(/\\/g, '/') : String(p);

// --- executable lookup ------------------------------------------------------
const PATHEXT: string[] = isWin
  ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
      .split(';')
      .filter(Boolean)
      .map((e) => e.toLowerCase())
  : [''];

/** Candidate filenames for `name` on this platform (`claude` → claude.exe, …). */
function exeNames(name: string): string[] {
  if (!isWin) return [name];
  if (path.extname(name)) return [name];
  return [...PATHEXT.map((e) => name + e), name];
}

/**
 * Absolute path to `name`, searching PATH then `extraDirs`, honouring PATHEXT
 * on Windows. Returns null when nothing matches.
 */
export function which(name: string, extraDirs: string[] = []): string | null {
  const dirs = [...(process.env.PATH || '').split(path.delimiter), ...extraDirs];
  const names = exeNames(name);
  for (const d of dirs) {
    if (!d) continue;
    for (const n of names) {
      try {
        const p = path.join(d, n);
        if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
      } catch {
        /* unreadable PATH entry — keep looking */
      }
    }
  }
  return null;
}

/** Extra user bin dirs to append to PATH — the ones a thin-PATH launch misses. */
export function extraBinDirs(): string[] {
  const dirs = isWin
    ? [
        path.join(HOME, '.local', 'bin'),
        path.join(HOME, '.bun', 'bin'),
        path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), 'npm'),
        'C:\\Program Files\\nodejs',
        'C:\\Program Files\\Git\\cmd',
        'C:\\Program Files\\GitHub CLI',
      ]
    : [
        path.join(HOME, '.local', 'bin'),
        path.join(HOME, '.bun', 'bin'),
        path.join(HOME, '.npm-global', 'bin'),
        path.join(HOME, '.yarn', 'bin'),
        '/opt/homebrew/bin',
        '/usr/local/bin',
        '/usr/bin',
      ];
  return dirs.filter(Boolean);
}

// --- POSIX shell ------------------------------------------------------------
// Every shell job the host runs (cleanup commands, onboarding clone/install,
// the skills) is POSIX sh written for macOS. On Windows we run it under Git
// Bash rather than translating it — Git for Windows ships bash + coreutils and
// is already a hard prerequisite here (git itself).
//
// System32\bash.exe is the WSL launcher: a DIFFERENT filesystem where the
// host's Windows paths don't exist. It must never be picked.
const WIN_BASH_CANDIDATES = [
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
  'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'bin', 'bash.exe'),
];

let bashPath: string | null | undefined;

/** Absolute path to a POSIX bash, or null if none is installed. */
export function findBash(): string | null {
  if (bashPath !== undefined) return bashPath;
  if (!isWin) {
    bashPath = which('bash') || '/bin/bash';
    return bashPath;
  }
  const override = process.env.ARIGAMI_BASH;
  if (override && fs.existsSync(override)) return (bashPath = override);
  for (const c of WIN_BASH_CANDIDATES) {
    try {
      if (c && fs.existsSync(c)) return (bashPath = c);
    } catch {
      /* ignore */
    }
  }
  // PATH last, and only if it isn't the WSL shim.
  const onPath = which('bash');
  bashPath = onPath && !/system32/i.test(onPath) ? onPath : null;
  return bashPath;
}

/**
 * argv for running a POSIX shell command string — the cross-platform stand-in
 * for `['bash', '-lc', cmd]`. Throws when Windows has no bash, which is a
 * clearer failure than an ENOENT deep inside a job runner.
 */
export function shellArgs(cmd: string, login = true): string[] {
  const bash = findBash();
  if (!bash)
    throw new Error(
      'no POSIX shell found — install Git for Windows (it ships bash), or set ARIGAMI_BASH to a bash.exe'
    );
  return [bash, login ? '-lc' : '-c', cmd];
}

// --- Chrome/Chromium binary lookup -------------------------------------------
// `google-chrome` (the Linux-only default) doesn't exist on macOS or Windows,
// so the naive `CHROME_BIN || 'google-chrome'` used to spawn ENOENT on both —
// silently, since supervise() swallows a child's 'error' event, so the caller
// saw a fake "opened" pid with no browser behind it. This is the single place
// both the real launch (lib/chrome.ts) and the health-check probe
// (onboarding.ts) resolve "Chrome" from, so they never disagree.
const MAC_CHROME_PATHS = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
const WIN_CHROME_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
];

/**
 * Ordered Chrome/Chromium candidates for this platform: CHROME_BIN /
 * ARIGAMI_CHROME_BIN always win, in that order, on every platform — the Linux
 * fallback chain (google-chrome, google-chrome-stable, chromium,
 * chromium-browser) is unchanged from before. `env`/`platform` are injectable
 * for testing without mocking process.env/process.platform.
 */
export function chromeCandidates(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string[] {
  const named = [env.CHROME_BIN, env.ARIGAMI_CHROME_BIN].filter((b): b is string => !!b);
  if (platform === 'win32') return [...named, ...WIN_CHROME_PATHS, 'chrome', 'chromium'];
  if (platform === 'darwin') return [...named, ...MAC_CHROME_PATHS, 'google-chrome', 'chromium', 'chromium-browser'];
  return [...named, 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'];
}

/**
 * Resolve the first candidate that actually exists on disk — absolute paths
 * (env override, macOS/Windows well-known locations) are checked directly,
 * bare names go through `which()`. null when nothing on this host matches.
 */
export function findChromeBin(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string | null {
  for (const c of chromeCandidates(env, platform)) {
    if (path.isAbsolute(c)) {
      try {
        if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
      } catch {
        /* unreadable path — keep looking */
      }
      continue;
    }
    const found = which(c);
    if (found) return found;
  }
  return null;
}

// --- pty --------------------------------------------------------------------
// `claude setup-token` / `claude mcp login` are TTY programs. On POSIX the host
// relays them through lib/pty-bridge.py (stdlib `pty`). Windows has no `pty`
// module, but Git for Windows ships winpty, which does the same job.
export function ptyArgs(bridge: string, cmd: string[]): string[] {
  if (!isWin) return ['python3', bridge, ...cmd];
  const winpty =
    which('winpty', ['C:\\Program Files\\Git\\usr\\bin', 'C:\\Program Files (x86)\\Git\\usr\\bin']);
  if (!winpty)
    throw new Error(
      'winpty not found — interactive `claude` logins need it. Install Git for Windows (ships winpty), ' +
        'or run `claude setup-token` in a terminal and paste the token into Accounts → Add token.'
    );
  // -Xallow-non-tty: our stdio are pipes, not a console.
  return [winpty, '-Xallow-non-tty', '-Xplain', ...cmd];
}

// --- directory links --------------------------------------------------------
// `fs.symlinkSync(target, link, 'dir')` needs SeCreateSymbolicLinkPrivilege on
// Windows — i.e. an elevated process or Developer Mode. An unprivileged host
// just gets EPERM, which is what the desktop sidecar hit live:
//   [ext] error: EPERM: operation not permitted, symlink '...user\skills' -> '...skills'
// leaving $ARIGAMI_DIR/skills and user/skills as two unrelated real directories
// instead of one pointing at the other. A NTFS *junction* is the same thing for
// directories, needs no privilege at all, and Node reports it as a symlink
// (`lstat().isSymbolicLink()` is true, `readlinkSync()` resolves it), so every
// existing isSymlink()/readlink() check keeps working unchanged.
//
// Junctions only support absolute local directory targets — which is all any
// caller here uses — so `target` is resolved to an absolute path first.
export function linkDir(target: string, link: string): void {
  fs.symlinkSync(path.resolve(target), link, isWin ? 'junction' : 'dir');
}

// --- process liveness -------------------------------------------------------
/** True when `pid` exists. Used instead of `kill -0` plumbing. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}
