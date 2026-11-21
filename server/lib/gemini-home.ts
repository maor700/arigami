// Where the machine's `agy` (Antigravity CLI) login lives. The token file is agy's: read-only for the host, never printed or copied.
import fs from 'node:fs';
import path from 'node:path';
import { HOME } from './platform.js';

/** The REAL gemini home — where `agy` on the host keeps its Google login. */
export function geminiRealHome(): string {
  return process.env.ARIGAMI_GEMINI_DIR || path.join(HOME, '.gemini');
}

/** agy's OAuth token file. */
export const geminiTokenFile = (): string => path.join(geminiRealHome(), 'antigravity-cli', 'antigravity-oauth-token');

/** True when this machine has its own `agy` login the host can borrow. */
export const hasLocalGeminiLogin = (): boolean => fs.existsSync(geminiTokenFile());
