// The Chrome icon on the shared desktop's panel (tint2) starts `google-chrome-stable` from the system launcher file.
// Inside a container / Kubernetes pod that Chrome cannot start without `--no-sandbox` (its zygote dies, so a click on
// the icon does nothing). Arigami's own Chrome launches already pass the flag (chrome.ts chromeExtraFlags); this puts
// the same flag on the icon by shadowing the launcher file in the user's data dir, which the panel reads first.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromeExtraFlags } from './chrome.js';

const SYSTEM_LAUNCHERS = ['/usr/share/applications/google-chrome.desktop', '/usr/share/applications/com.google.Chrome.desktop'];

/** The launcher text with `flags` added to every Chrome Exec line that lacks them. Pure. */
export function withChromeFlags(desktop: string, flags: string[]): string {
  return desktop
    .split('\n')
    .map((line) => {
      const m = /^(Exec=\S*(?:google-chrome|chrome)\S*)(.*)$/.exec(line);
      if (!m) return line;
      const missing = flags.filter((f) => !line.includes(f));
      return missing.length ? `${m[1]} ${missing.join(' ')}${m[2]}` : line;
    })
    .join('\n');
}

/**
 * Shadow the system Chrome launcher(s) with a copy that carries the container flags. A no-op on a native host
 * (no flags) and when the system launcher is absent. Returns the files written.
 */
export function ensureChromeLauncherFlags(opts: { env?: NodeJS.ProcessEnv; home?: string; dockerenv?: boolean; systemLaunchers?: string[] } = {}): string[] {
  const env = opts.env || process.env;
  // --no-sandbox is the one that matters for a click on the icon; the others are for headless-ish launches
  const flags = chromeExtraFlags(env, opts.dockerenv).filter((f) => f === '--no-sandbox');
  if (!flags.length) return [];
  const home = opts.home || env.HOME || os.homedir();
  const dir = path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'applications');
  const written: string[] = [];
  for (const src of opts.systemLaunchers || SYSTEM_LAUNCHERS) {
    let text: string;
    try {
      text = fs.readFileSync(src, 'utf8');
    } catch {
      continue;
    }
    const next = withChromeFlags(text, flags);
    const dest = path.join(dir, path.basename(src));
    try {
      if (fs.existsSync(dest) && fs.readFileSync(dest, 'utf8') === next) continue;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(dest, next);
      written.push(dest);
    } catch {
      /* a read-only home: the icon keeps its old behaviour, nothing else breaks */
    }
  }
  return written;
}
