// Where the machine's `agy` (Antigravity CLI) login lives. The token file is agy's: read-only for the host, never printed or copied.
import fs from 'node:fs';
import path from 'node:path';
import { HOME } from './platform.js';

/** A gemini home other than ~/.gemini: ARIGAMI_GEMINI_HOME (ARIGAMI_GEMINI_DIR is the same knob), or null. */
export function geminiHomeOverride(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.ARIGAMI_GEMINI_HOME || env.ARIGAMI_GEMINI_DIR || null;
}

/** The REAL gemini home — where `agy` on the host keeps its Google login. */
export function geminiRealHome(env: NodeJS.ProcessEnv = process.env): string {
  return geminiHomeOverride(env) || path.join(HOME, '.gemini');
}

/** agy's OAuth token file (agy refreshes it itself). */
export function geminiTokenFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(geminiRealHome(env), 'antigravity-cli', 'antigravity-oauth-token');
}

/** True when this machine has its own `agy` login the host can borrow. */
export function hasLocalGeminiLogin(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    return fs.statSync(geminiTokenFile(env)).size > 0;
  } catch {
    return false;
  }
}
