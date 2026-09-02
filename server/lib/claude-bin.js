// Where the `claude` CLI lives — resolved lazily and RE-CHECKED, not pinned at
// boot. Every spawner (sessions, the model-list handshake, one-shots, mcp-auth)
// goes through here so they all agree on ONE binary, and that binary is the
// one a fresh `which claude` would find right now.
//
// Why re-check: the CLI updates underneath a running host. A native install
// self-updates by re-pointing ~/.local/bin/claude; an `npm i -g` can drop a
// NEWER claude at /usr/bin that shadows the one we found at boot. A path
// resolved once at boot silently keeps spawning (and asking for models from) the
// old binary until someone restarts the host — that is how Fable 5.1 went
// missing from the picker while `claude --version` in a shell already had it.
import fs from 'node:fs';
import { isWin, which, extraBinDirs } from './platform.js';

// How often a call may re-resolve (a few statSyncs; the login-shell fallback is
// cached separately, see below). env: tests only.
const knob = process.env.ARIGAMI_CLI_RECHECK_MS;
export const RECHECK_MS = knob && Number(knob) >= 0 ? Number(knob) : 60_000;

// An explicit ARIGAMI_CLAUDE_BIN in the host's OWN environment pins the CLI for
// good (tests, non-standard installs). Captured once, at import: claudeBin()
// republishes its RESOLVED path into the same variable for sibling spawners
// and child processes, and that must never be mistaken for a pin.
const OVERRIDE = process.env.ARIGAMI_CLAUDE_BIN || '';

export const EXTRA_BINS = extraBinDirs();

let resolved = null; // { bin, at }
let shellFound = null; // last answer from the login-shell fallback (POSIX only)

function fromLoginShell() {
  // Last resort: ask the user's login shell where claude is — covers version
  // managers (nvm/asdf/volta) that only put it on PATH there. A login shell is
  // not free, so the answer is remembered and only re-asked once it goes away.
  if (isWin) return null;
  if (shellFound && fs.existsSync(shellFound)) return shellFound;
  shellFound = null;
  try {
    const shell = process.env.SHELL || '/bin/zsh';
    const r = Bun.spawnSync([shell, '-lc', 'command -v claude'], { stdout: 'pipe', stderr: 'ignore' });
    const out = new TextDecoder().decode(r.stdout).trim().split('\n').filter(Boolean).pop();
    if (out && fs.existsSync(out)) shellFound = out;
  } catch { /* ignore */ }
  return shellFound;
}

function resolveNow() {
  if (OVERRIDE && fs.existsSync(OVERRIDE)) return OVERRIDE;
  // which() honours PATHEXT, so this finds claude.exe / claude.cmd on Windows.
  return which('claude', EXTRA_BINS) || fromLoginShell() || 'claude'; // bare name: let spawn surface ENOENT if truly absent
}

/**
 * Absolute path of the `claude` CLI to spawn right now. Re-resolved at most
 * once per RECHECK_MS (always with `force`, e.g. the picker's manual refresh),
 * so a CLI that moved or was reinstalled is picked up without a host restart.
 */
export function claudeBin({ force = false } = {}) {
  const now = Date.now();
  if (!resolved || force || now - resolved.at >= RECHECK_MS) {
    const bin = resolveNow();
    if (resolved && bin !== resolved.bin) console.log(`[claude] CLI moved: ${resolved.bin} → ${bin}`);
    resolved = { bin, at: now };
    if (bin !== 'claude') process.env.ARIGAMI_CLAUDE_BIN = bin;
  }
  return resolved.bin;
}
