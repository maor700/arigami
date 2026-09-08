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

export interface AvailableInfo {
  version: string | null; // package.json version at the upstream tip
  tag: string | null; // newest v* tag reachable from upstream
  release: { tag: string; url: string; publishedAt: string | null } | null; // GitHub Releases (refresh only)
}

export interface VersionInfo {
  version: string; // VERSION file, else package.json (both written by `bun run release`)
  tag: string | null; // the v* tag HEAD sits on (null between releases)
  available: AvailableInfo;
  commit: string | null;
  commitDate: string | null;
  branch: string | null;
  upstream: string | null;
  ahead: number | null; // commits upstream has that we don't (null = no upstream / unknown)
  behind: number | null; // local commits not on upstream
  updateAvailable: boolean; // upstream has commits we lack, or a newer version number
  sharedBase: boolean | null; // false = HEAD and upstream share NO merge base (a ff pull is impossible)
  image: string | null; // container image (Docker builds), else null
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

/** The running version: VERSION (plain text, mirrored by `bun run release`) wins, package.json is the fallback. */
export function currentVersion(root = ROOT): string {
  try {
    const v = fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim();
    if (/^\d+\.\d+\.\d+/.test(v)) return v;
  } catch {}
  return packageVersion(root);
}

/** semver-ish compare on the numeric triple (pre-release suffixes ignored): -1 | 0 | 1; null when either side is not a version. */
export function compareVersions(a: string | null | undefined, b: string | null | undefined): -1 | 0 | 1 | null {
  const pa = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(a || ''));
  const pb = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(b || ''));
  if (!pa || !pb) return null;
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

function repoSlug(root: string): string | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const raw = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url || '';
    const m = /github\.com[/:]([^/]+)\/([^/.]+)/.exec(raw);
    return m ? `${m[1]}/${m[2]}` : null;
  } catch { return null; }
}

/** GitHub's "latest release" for the repo in package.json — best effort, 5s, never throws. */
export async function fetchLatestRelease(root: string, fetchImpl: typeof fetch = fetch): Promise<AvailableInfo['release']> {
  const slug = repoSlug(root);
  if (!slug || process.env.ARIGAMI_NO_RELEASE_CHECK) return null;
  try {
    const r = await fetchImpl(`https://api.github.com/repos/${slug}/releases/latest`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'arigami' }, signal: AbortSignal.timeout(5000) });
    if (!r.ok) return null;
    const j = (await r.json()) as { tag_name?: string; html_url?: string; published_at?: string };
    return j.tag_name ? { tag: j.tag_name, url: j.html_url || `https://github.com/${slug}/releases/tag/${j.tag_name}`, publishedAt: j.published_at || null } : null;
  } catch { return null; }
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
let lastRelease: AvailableInfo['release'] = null;
let inflight: Promise<VersionInfo> | null = null;

export async function getVersion(opts: { refresh?: boolean; root?: string } = {}): Promise<VersionInfo> {
  const root = opts.root || ROOT;
  const wantFetch = !!opts.refresh && Date.now() - lastFetch > FETCH_TTL_MS;
  if (!wantFetch && cache && Date.now() - cache.checkedAt < TTL_MS) return cache;
  if (inflight) return inflight;
  inflight = (async () => {
    if (wantFetch) {
      lastFetch = Date.now();
      // `--prune` on purpose NOT: a pruned remote-tracking ref is how a rewritten
      // upstream silently loses its merge base with the checkout (docs/GIT-REALIGN.md).
      const [, rel] = await Promise.all([git(['fetch', '--quiet', '--tags'], root, 30_000), fetchLatestRelease(root)]);
      lastRelease = rel;
    }
    const [commit, commitDate, branch, upstream, lr, headTag, upTag, upPkg, base] = await Promise.all([
      git(['rev-parse', '--short', 'HEAD'], root),
      git(['log', '-1', '--format=%cI'], root),
      git(['rev-parse', '--abbrev-ref', 'HEAD'], root),
      git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], root),
      git(['rev-list', '--left-right', '--count', 'HEAD...@{u}'], root),
      git(['describe', '--tags', '--exact-match', '--match', 'v*', 'HEAD'], root),
      git(['describe', '--tags', '--abbrev=0', '--match', 'v*', '@{u}'], root),
      git(['show', '@{u}:package.json'], root),
      git(['merge-base', 'HEAD', '@{u}'], root),
    ]);
    const { behind, ahead } = parseLeftRight(lr);
    let upVersion: string | null = null;
    try { upVersion = upPkg ? String(JSON.parse(upPkg).version || '') || null : null; } catch {}
    const availableVersion = [upVersion, upTag?.replace(/^v/, ''), lastRelease?.tag.replace(/^v/, '')].filter(Boolean)
      .sort((a, b) => -(compareVersions(a, b) ?? 0))[0] || null;
    const version = currentVersion(root);
    cache = {
      version,
      tag: headTag,
      available: { version: availableVersion, tag: upTag, release: lastRelease },
      // F8: a Docker image has no .git — the build stamps ARIGAMI_COMMIT/ARIGAMI_BRANCH.
      commit: commit || process.env.ARIGAMI_COMMIT || null,
      commitDate: commitDate || process.env.ARIGAMI_COMMIT_DATE || null,
      branch: branch || process.env.ARIGAMI_BRANCH || null,
      upstream,
      image: process.env.ARIGAMI_IMAGE || null,
      ahead, behind,
      updateAvailable: (ahead ?? 0) > 0 || compareVersions(availableVersion, version) === 1,
      // upstream known (lr parsed) but no merge base → the histories were rewritten apart
      sharedBase: upstream ? !!base : null,
      fetchedAt: lastFetch || null,
      checkedAt: Date.now(),
    };
    return cache;
  })().finally(() => { inflight = null; });
  return inflight;
}

/** Drop the cache — and the fetch rate-limit, so the next `?refresh=1` really fetches (after an upgrade / for tests). */
export function invalidateVersion(): void { cache = null; lastFetch = 0; }
