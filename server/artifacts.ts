// Published artifacts (A1): the agent hands us a static file/folder (an HTML
// report, a built Vite `dist/`, an image) and we SNAPSHOT it under
//   $ARIGAMI_DIR/uploads/artifacts/<session>/<artifactId>/v<N>/
// and serve it back at the host-relative URL `/__artifacts/<artifactId>/`
// (current version) or `/__artifacts/<artifactId>/v<N>/` (a pinned version).
//
// Why a copy and not a symlink: the agent keeps editing its worktree after it
// published; a snapshot keeps the card the human already opened stable, and a
// re-publish of the same source path becomes the next version (same id, the
// chat card updates). Design: RESEARCH-ARIGAMI-REMOTE-ARTIFACTS.md §3(b),
// SPEC-ARIGAMI-DISTRIBUTION.md §A1.
//
// Safety: realpath on the source, symlinks are never followed inside the tree,
// node_modules/.git/.env* are skipped, a size cap applies to the whole
// version, and the serving path is traversal-guarded (same shape as serveHost
// in index.ts). The served HTML runs under a CSP `sandbox` (opaque origin) so
// a published page cannot call /__api on the cockpit's behalf.
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { cfg, nano, getSession, upsertArtifact, removeArtifact, findArtifact } from './state.js';
import type { Artifact } from './state.js';

export const ARTIFACTS_DIR = path.join(cfg.configDir!, 'uploads', 'artifacts');

const ID_RE = /^[A-Za-z0-9_-]+$/;
const VERSION_RE = /^v(\d+)$/;
const SKIP_NAMES = new Set(['node_modules', '.git']);
const skipName = (name: string): boolean => SKIP_NAMES.has(name) || name.startsWith('.env');

export interface PublishOpts {
  path: string;
  title: string;
  entry?: string;
  cwd?: string; // base for a relative `path` (the session's cwd)
}

export interface PublishResult {
  artifact: Artifact;
  warnings: string[];
}

export class PublishError extends Error {
  status: number;
  constructor(msg: string, status = 400) { super(msg); this.status = status; }
}

// ---- Copy (pure-ish helpers, exported for tests) -----------------------------

interface WalkEntry { rel: string; abs: string; size: number; }

// Enumerate the regular files under `root` (a realpath'd directory), skipping
// symlinks (never followed — a link to ~/.ssh must not be copied), the usual
// build/secret folders and dotenv files. Returns relative paths + sizes.
export function walkSource(root: string): WalkEntry[] {
  const out: WalkEntry[] = [];
  const visit = (dir: string, rel: string): void => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skipName(d.name)) continue;
      const abs = path.join(dir, d.name);
      const r = rel ? rel + '/' + d.name : d.name;
      if (d.isSymbolicLink()) continue;
      if (d.isDirectory()) { visit(abs, r); continue; }
      if (!d.isFile()) continue;
      out.push({ rel: r, abs, size: fs.statSync(abs).size });
    }
  };
  visit(root, '');
  return out;
}

// `<base href>` injection: only when the document has none. Placed right after
// <head> so it precedes every relative URL. Root-absolute URLs (src="/x") are
// NOT fixed by <base> — those get a warning instead (see scanHtmlWarnings).
export function injectBase(html: string, href: string): string {
  if (/<base\s/i.test(html)) return html;
  const tag = `<base href="${href}">`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + tag);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => m + '<head>' + tag + '</head>');
  return tag + html;
}

export function scanHtmlWarnings(html: string): string[] {
  const w: string[] = [];
  if (/(src|href)=["']\/(?!\/)/i.test(html))
    w.push('entry references root-absolute URLs (src="/…" / href="/…") — they will not resolve under /__artifacts/; build with base "./" (Vite: base: "./")');
  if (/fetch\(\s*["']\//.test(html))
    w.push('entry calls fetch("/…") — the artifact runs sandboxed (opaque origin); same-origin API calls are blocked');
  return w;
}

function copyTree(entries: WalkEntry[], dest: string): void {
  for (const e of entries) {
    const target = path.join(dest, e.rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(e.abs, target, fs.constants.COPYFILE_EXCL);
  }
}

// ---- Publish / list / remove -------------------------------------------------

function artifactDir(sessionId: string, aid: string): string {
  return path.join(ARTIFACTS_DIR, sessionId, aid);
}

export function publish(sessionId: string, opts: PublishOpts): PublishResult {
  const s = getSession(sessionId);
  if (!s) throw new PublishError(`no such session: ${sessionId}`, 404);
  if (!opts.path || typeof opts.path !== 'string') throw new PublishError('path required');
  const title = String(opts.title || '').trim();
  if (!title) throw new PublishError('title required');
  const base = opts.cwd || s.cwd || process.cwd();
  const raw = path.resolve(base, opts.path);
  let src: string;
  try { src = fs.realpathSync(raw); } catch { throw new PublishError(`path not found: ${opts.path}`, 404); }
  // Never publish out of the host's own state dir (config.json, secrets,
  // state) — the only legitimate sub-tree there is uploads/.
  const cfgDir = safeReal(cfg.configDir!);
  if (cfgDir && (src === cfgDir || src.startsWith(cfgDir + path.sep)) && !src.startsWith(path.join(cfgDir, 'uploads') + path.sep))
    throw new PublishError('refusing to publish from the Arigami state directory', 403);
  const st = fs.statSync(src);
  const maxBytes = (cfg.artifacts?.maxMb ?? 50) * 1024 * 1024;

  let entries: WalkEntry[];
  let entry: string;
  if (st.isDirectory()) {
    entries = walkSource(src);
    entry = opts.entry ? String(opts.entry).replace(/^\/+/, '') : 'index.html';
    if (entry.split('/').some((seg) => seg === '..' || seg === '')) throw new PublishError('invalid entry');
    if (!entries.some((e) => e.rel === entry)) {
      // A folder without index.html is still publishable (an image set); the
      // route then lists nothing — only warn.
      if (opts.entry) throw new PublishError(`entry not found in folder: ${entry}`, 404);
    }
  } else if (st.isFile()) {
    if (skipName(path.basename(src))) throw new PublishError('refusing to publish that file');
    entry = path.basename(src);
    entries = [{ rel: entry, abs: src, size: st.size }];
  } else {
    throw new PublishError('path is neither a file nor a directory');
  }
  if (!entries.length) throw new PublishError('nothing to publish (folder empty after exclusions)');
  const bytes = entries.reduce((n, e) => n + e.size, 0);
  if (bytes > maxBytes)
    throw new PublishError(`artifact too large: ${(bytes / 1048576).toFixed(1)}MB > ${cfg.artifacts?.maxMb ?? 50}MB cap (exclude build junk or raise artifacts.maxMb)`, 413);

  // Same source published again by this session → next version, same id.
  const existing = (s.artifacts || []).find((a) => a.source === src);
  const aid = existing?.id || nano();
  const version = (existing?.version || 0) + 1;
  const dir = artifactDir(sessionId, aid);
  const vdir = path.join(dir, `v${version}`);
  fs.mkdirSync(vdir, { recursive: true });
  try {
    copyTree(entries, vdir);
  } catch (e) {
    fs.rmSync(vdir, { recursive: true, force: true });
    throw new PublishError(`copy failed: ${(e as Error).message}`, 500);
  }

  const warnings: string[] = [];
  const entryAbs = path.join(vdir, entry);
  if (/\.html?$/i.test(entry) && fs.existsSync(entryAbs)) {
    let html = fs.readFileSync(entryAbs, 'utf8');
    warnings.push(...scanHtmlWarnings(html));
    // The base points at the PINNED version so a page opened from an old card
    // keeps loading its own assets after a re-publish.
    const patched = injectBase(html, `/__artifacts/${aid}/v${version}/${entry.includes('/') ? entry.slice(0, entry.lastIndexOf('/') + 1) : ''}`);
    if (patched !== html) fs.writeFileSync(entryAbs, patched);
  } else if (!fs.existsSync(entryAbs)) {
    warnings.push(`no ${entry} in the folder — opening the artifact root shows nothing; pass entry:`);
  }
  const now = new Date().toISOString();
  const artifact: Artifact = {
    id: aid,
    title,
    path: `/__artifacts/${aid}/`,
    source: src,
    entry,
    version,
    bytes,
    files: entries.length,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ sessionId, ...artifact }, null, 2));
  upsertArtifact(sessionId, artifact);
  scheduleSweep();
  return { artifact, warnings };
}

function safeReal(p: string): string | null {
  try { return fs.realpathSync(p); } catch { return null; }
}

export function list(sessionId: string): Artifact[] {
  return getSession(sessionId)?.artifacts || [];
}

export function remove(sessionId: string, aid: string): boolean {
  if (!ID_RE.test(aid)) return false;
  const ok = removeArtifact(sessionId, aid);
  if (ok) fs.rmSync(artifactDir(sessionId, aid), { recursive: true, force: true });
  return ok;
}

// Session deleted → its artifacts go with it (like screens).
export function removeSession(sessionId: string): void {
  if (!ID_RE.test(sessionId)) return;
  fs.rmSync(path.join(ARTIFACTS_DIR, sessionId), { recursive: true, force: true });
}

// ---- Static serving ----------------------------------------------------------

// Resolve `/__artifacts/<aid>/<rel>` to a file on disk, or null when the
// artifact is unknown / the path escapes / the target is a symlink. A leading
// `v<N>/` segment pins a version; otherwise the current one is used. Directory
// targets resolve to the artifact's entry (root) or index.html (subdirs).
export function artifactFilePath(aid: string, rel: string): { file: string; version: number; root: string } | null {
  if (!ID_RE.test(aid)) return null;
  const found = findArtifact(aid);
  if (!found) return null;
  const { session, artifact } = found;
  if (rel.includes('\0')) return null;
  let segs = rel.split('/').filter((x) => x.length);
  if (segs.some((x) => x === '..' || x === '.')) return null;
  let version = artifact.version;
  const vm = segs.length && VERSION_RE.exec(segs[0]);
  if (vm) {
    const v = Number(vm[1]);
    if (v >= 1 && v <= artifact.version && fs.existsSync(path.join(artifactDir(session.id, aid), `v${v}`))) {
      version = v;
      segs = segs.slice(1);
    }
  }
  const root = path.join(artifactDir(session.id, aid), `v${version}`);
  const isRoot = segs.length === 0;
  let file = path.normalize(path.join(root, ...segs));
  if (file !== root && !file.startsWith(root + path.sep)) return null;
  let st: fs.Stats;
  try { st = fs.lstatSync(file); } catch { return null; }
  if (st.isSymbolicLink()) return null;
  if (st.isDirectory()) {
    file = path.join(file, isRoot ? artifact.entry : 'index.html');
    try { st = fs.lstatSync(file); } catch { return null; }
    if (!st.isFile() || st.isSymbolicLink()) return null;
    if (!file.startsWith(root + path.sep)) return null;
  }
  return { file, version, root };
}

export const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wasm': 'application/wasm',
  '.pdf': 'application/pdf',
  '.xml': 'application/xml',
};

// Defense in depth for "open in window" (no iframe sandbox there): the CSP
// `sandbox` directive gives the document an opaque origin even in a top-level
// tab, so it cannot read cookies or call /__api as the cockpit; scripts, forms
// and popups still work. `allow-same-origin` is deliberately absent.
export const ARTIFACT_CSP =
  "sandbox allow-scripts allow-forms allow-popups; default-src 'self' data: blob: https:; connect-src 'self' https:; img-src 'self' data: blob: https:; style-src 'self' 'unsafe-inline' https:; script-src 'self' 'unsafe-inline' https:";

// ---- K2 HOOK (share-token) ----------------------------------------------------
// K2 adds server/lib/share-token.ts with sign()/verify(). Until then any
// `?t=<token>` presented on an artifact URL is REJECTED (401) — a token we
// cannot verify must never grant access. C1's cookie middleware decides normal
// (cookie-bearing) access; this stub only handles the explicit token path.
// TODO(K2): replace with `verify(token, {kind:'artifact', id})` and, when
// valid, serve the version pinned in the token payload cookie-less.
export function verifyShareToken(_token: string, _ctx: { kind: 'artifact'; id: string }): { ok: boolean; reason: string; version?: number } {
  return { ok: false, reason: 'share links are not implemented yet (K2)' };
}

// GET /__artifacts/<aid>[/rel]  — returns true when it handled the request.
export function serve(req: IncomingMessage, res: ServerResponse): boolean {
  const raw = req.url || '/';
  const q = raw.indexOf('?');
  const pathname = q >= 0 ? raw.slice(0, q) : raw;
  if (!(pathname === '/__artifacts' || pathname.startsWith('/__artifacts/'))) return false;
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return true; }
  let decoded: string;
  try { decoded = decodeURIComponent(pathname); } catch { res.writeHead(400); res.end('bad path'); return true; }
  const m = /^\/__artifacts\/([^/]+)(\/.*)?$/.exec(decoded);
  if (!m) { res.writeHead(404); res.end('not found'); return true; }
  const aid = m[1];
  const rel = m[2] || '';
  // K2 hook: explicit share token on the URL.
  const params = q >= 0 ? new URLSearchParams(raw.slice(q + 1)) : null;
  const token = params?.get('t');
  if (token != null) {
    const v = verifyShareToken(token, { kind: 'artifact', id: aid });
    if (!v.ok) {
      res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(`<!doctype html><title>Link expired</title><body style="font-family:system-ui;padding:40px"><h1>Link expired</h1><p>${escapeHtml(v.reason)}</p>`);
      return true;
    }
  }
  // `/__artifacts/<id>` → `/__artifacts/<id>/` so relative assets resolve.
  if (!m[2]) {
    res.writeHead(302, { location: `/__artifacts/${encodeURIComponent(aid)}/${q >= 0 ? raw.slice(q) : ''}` });
    res.end();
    return true;
  }
  const hit = artifactFilePath(aid, rel);
  if (!hit) {
    const known = ID_RE.test(aid) && !!findArtifact(aid);
    const escaped = rel.split('/').some((x) => x === '..') || rel.includes('\0');
    res.writeHead(escaped ? 403 : (known ? 404 : 404), { 'content-type': 'text/plain', 'cache-control': 'no-store' });
    res.end(escaped ? 'forbidden' : 'not found');
    return true;
  }
  const ext = path.extname(hit.file).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  const isHtml = type.startsWith('text/html');
  const st = fs.statSync(hit.file);
  res.writeHead(200, {
    'content-type': type,
    'content-length': st.size,
    'content-security-policy': ARTIFACT_CSP,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    // HTML is re-published in place (same URL, new version) — never cache it;
    // everything else is addressed by version and immutable.
    'cache-control': isHtml ? 'no-store' : 'private, max-age=31536000, immutable',
  });
  if (req.method === 'HEAD') { res.end(); return true; }
  fs.createReadStream(hit.file).pipe(res);
  return true;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

// ---- Retention ---------------------------------------------------------------

export interface SweepResult { removedVersions: number; removedArtifacts: number; }

// Pure: under `root` (ARTIFACTS_DIR layout <sid>/<aid>/v<N>), delete version
// dirs older than maxAgeMs — but never the newest one, so a card always opens.
// Artifacts whose newest version is itself expired are removed entirely and
// reported via `onRemoveArtifact` so state can drop the record.
export function sweepArtifactsDir(
  root: string,
  maxAgeMs: number,
  now = Date.now(),
  onRemoveArtifact?: (sessionId: string, aid: string) => void
): SweepResult {
  const out: SweepResult = { removedVersions: 0, removedArtifacts: 0 };
  if (!fs.existsSync(root)) return out;
  for (const sid of fs.readdirSync(root)) {
    const sdir = path.join(root, sid);
    if (!safeIsDir(sdir)) continue;
    for (const aid of fs.readdirSync(sdir)) {
      const adir = path.join(sdir, aid);
      if (!safeIsDir(adir)) continue;
      const versions = fs.readdirSync(adir)
        .map((n) => ({ n, v: Number((VERSION_RE.exec(n) || [])[1]) }))
        .filter((x) => Number.isFinite(x.v) && safeIsDir(path.join(adir, x.n)))
        .sort((a, b) => a.v - b.v);
      if (!versions.length) continue;
      const newest = versions[versions.length - 1];
      const age = (n: string): number => { try { return now - fs.statSync(path.join(adir, n)).mtimeMs; } catch { return 0; } };
      if (age(newest.n) > maxAgeMs) {
        fs.rmSync(adir, { recursive: true, force: true });
        out.removedArtifacts++;
        onRemoveArtifact?.(sid, aid);
        continue;
      }
      for (const v of versions.slice(0, -1)) {
        if (age(v.n) > maxAgeMs) { fs.rmSync(path.join(adir, v.n), { recursive: true, force: true }); out.removedVersions++; }
      }
    }
    try { if (fs.readdirSync(sdir).length === 0) fs.rmdirSync(sdir); } catch {}
  }
  return out;
}

function safeIsDir(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

export function sweepNow(): SweepResult {
  const days = cfg.artifacts?.retentionDays ?? 30;
  return sweepArtifactsDir(ARTIFACTS_DIR, days * 86_400_000, Date.now(), (sid, aid) => { try { removeArtifact(sid, aid); } catch {} });
}
let sweepTimer: NodeJS.Timeout | null = null;
function scheduleSweep(): void {
  if (sweepTimer) return;
  sweepTimer = setTimeout(() => { sweepTimer = null; try { sweepNow(); } catch {} }, 5000);
  sweepTimer.unref?.(); // never keep a short-lived process (tests, one-shots) alive
}
setInterval(() => { try { sweepNow(); } catch {} }, 3_600_000).unref?.();
