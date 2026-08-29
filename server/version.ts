// GET /__api/version — what's running and whether upstream is ahead (B4-lite).
// Cheap fields (package version, sha, branch) are read once per TTL from the
// repo the host runs from; `ahead` counts commits on the tracking branch that
// HEAD doesn't have. Counting is local — it only sees what the last `git
// fetch` brought in — so `?refresh=1` fetches first (rate-limited to once per
// FETCH_TTL so a chatty UI can't hammer the remote).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const TTL_MS = 60_000;
const FETCH_TTL_MS = 5 * 60_000;

export interface VersionInfo {
  version: string;
  commit: string | null;
  commitDate: string | null;
  branch: string | null;
  upstream: string | null;
  ahead: number | null; // commits upstream has that we don't (null = no upstream / unknown)
  behind: number | null; // local commits not on upstream
  updateAvailable: boolean;
  fetchedAt: number | null;
  checkedAt: number;
}

function git(args: string[], cwd = ROOT, timeoutMs = 15_000): Promise<string | null> {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const p = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    const t = setTimeout(() => { if (!done) { done = true; try { p.kill(); } catch {} resolve(null); } }, timeoutMs);
    p.stdout.on('data', (c) => (out += c));
    p.on('error', () => { if (!done) { done = true; clearTimeout(t); resolve(null); } });
    p.on('close', (code) => { if (!done) { done = true; clearTimeout(t); resolve(code === 0 ? out.trim() : null); } });
  });
}

function packageVersion(root: string): string {
  try { return String(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version || '0.0.0'); } catch { return '0.0.0'; }
}

/** `git rev-list --left-right --count HEAD...@{u}` → "behind\tahead" (from our side: left = ours only, right = theirs only). */
export function parseLeftRight(s: string | null): { behind: number | null; ahead: number | null } {
  if (!s) return { behind: null, ahead: null };
  const m = /^(\d+)\s+(\d+)$/.exec(s.trim());
  if (!m) return { behind: null, ahead: null };
  return { behind: Number(m[1]), ahead: Number(m[2]) };
}

let cache: VersionInfo | null = null;
let lastFetch = 0;
let inflight: Promise<VersionInfo> | null = null;

export async function getVersion(opts: { refresh?: boolean; root?: string } = {}): Promise<VersionInfo> {
  const root = opts.root || ROOT;
  const wantFetch = !!opts.refresh && Date.now() - lastFetch > FETCH_TTL_MS;
  if (!wantFetch && cache && Date.now() - cache.checkedAt < TTL_MS) return cache;
  if (inflight) return inflight;
  inflight = (async () => {
    if (wantFetch) {
      lastFetch = Date.now();
      await git(['fetch', '--quiet', '--prune'], root, 30_000);
    }
    const [commit, commitDate, branch, upstream, lr] = await Promise.all([
      git(['rev-parse', '--short', 'HEAD'], root),
      git(['log', '-1', '--format=%cI'], root),
      git(['rev-parse', '--abbrev-ref', 'HEAD'], root),
      git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], root),
      git(['rev-list', '--left-right', '--count', 'HEAD...@{u}'], root),
    ]);
    const { behind, ahead } = parseLeftRight(lr);
    cache = {
      version: packageVersion(root),
      commit, commitDate, branch, upstream,
      ahead, behind,
      updateAvailable: (ahead ?? 0) > 0,
      fetchedAt: lastFetch || null,
      checkedAt: Date.now(),
    };
    return cache;
  })().finally(() => { inflight = null; });
  return inflight;
}

/** Drop the cache (after an upgrade / for tests). */
export function invalidateVersion(): void { cache = null; }
