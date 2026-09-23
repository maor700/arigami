// Per-session scratch space: the session's TMPDIR, deleted with the session.
//
// On the cloud host 37 entries in /tmp belonged to sessions — screenshots,
// probe scripts, logs, patches, a private Node install, whole ad-hoc worktrees
// — named after the ticket and owned by nobody, so no deletion could find
// them. Giving each session its own TMPDIR makes "what did this session leave
// behind" a single directory: everything that honours TMPDIR (mktemp, Bun,
// Node's os.tmpdir(), Playwright, most tools) lands here and goes when the
// session goes. A literal `/tmp/...` path an agent types by hand still escapes;
// the skills are told to use $TMPDIR, and the sweep below is the backstop for
// directories, not for that.
import fs from 'node:fs';
import path from 'node:path';
import { ARIGAMI_DIR } from './instance.js';

export const SCRATCH_ROOT = path.join(ARIGAMI_DIR, 'scratch');

const SAFE_ID = /^[A-Za-z0-9_-]+$/;

export function dirFor(sessionId: string): string {
  // The id becomes a path segment that is later rm -rf'd: refuse anything that
  // could climb out of SCRATCH_ROOT.
  if (!SAFE_ID.test(sessionId)) throw new Error(`unsafe session id for a scratch dir: ${sessionId}`);
  return path.join(SCRATCH_ROOT, sessionId);
}

/** Create (idempotently) and return the session's scratch dir. */
export function ensure(sessionId: string): string {
  const d = dirFor(sessionId);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** The env a session's process gets so every temp file lands in its scratch dir. */
export function envFor(sessionId: string): Record<string, string> {
  const d = ensure(sessionId);
  return process.platform === 'win32' ? { TMPDIR: d, TMP: d, TEMP: d } : { TMPDIR: d };
}

export function remove(sessionId: string): boolean {
  let d: string;
  try {
    d = dirFor(sessionId);
  } catch {
    return false;
  }
  if (!fs.existsSync(d)) return false;
  fs.rmSync(d, { recursive: true, force: true });
  return true;
}

/** Session ids that currently have a scratch dir. */
export function ids(): string[] {
  try {
    return fs.readdirSync(SCRATCH_ROOT).filter((n) => SAFE_ID.test(n));
  } catch {
    return [];
  }
}
