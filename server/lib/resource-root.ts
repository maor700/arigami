// Where the app finds its own files at runtime (web/dist, skills/, mcp/, …).
// Today that's always the git repo checkout. Once we ship a `bun build
// --compile` binary (Tauri desktop packaging), `import.meta.url` no longer
// points at a real file — Bun rewrites it into its embedded virtual
// filesystem — so the historical dirname-of-this-file computation breaks.
//
// Priority order:
//   1. ARIGAMI_ROOT env — explicit override, wins over everything.
//   2. Compiled-binary resources dir — only when we can prove we're running
//      inside a `bun build --compile` executable.
//   3. Fallback: the exact computation every call site used before this
//      module existed (dirname(this file) walked up to the repo root). On
//      Linux/dev this must produce byte-identical results to today.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Bun compiles single-file executables by embedding sources into a virtual
// filesystem and rewriting import.meta.url to a "file:///$bunfs/..." URL
// instead of a real file:// path to disk. Verified empirically with
// `bun build --compile` (Bun 1.4.0): a plain `bun run` gives
// "file:///abs/path/to/file.ts", while the compiled binary gives
// "file:///$bunfs/root/<binary-name>". process.isBun is true in both cases,
// so it alone can't distinguish them — the $bunfs marker is the actual signal.
/** Exported so other lib/ helpers (bun-exec.ts) can branch on the same signal without re-deriving it. */
export function isCompiledBinary(): boolean {
  if (typeof (process as any).isBun === 'undefined') return false;
  // The virtual-filesystem marker is PLATFORM-SPECIFIC. Both forms verified
  // empirically by compiling a probe that prints import.meta.url (Bun 1.3.6):
  //   Linux/macOS  file:///$bunfs/root/<binary>
  //   Windows      file:///B:/%7EBUN/root/<binary>   (import.meta.path uses the literal ~BUN form)
  // Checking only '/$bunfs/' silently returned false on Windows, so the
  // compiled desktop sidecar took the repo-checkout fallback branch below,
  // resolved its root to a path inside the virtual filesystem, and served the
  // "UI not built yet" placeholder with version 0.0.0 instead of the bundled
  // cockpit — found live, not by inspection. Both spellings of the Windows
  // marker are matched because the URL form is percent-encoded ('%7EBUN')
  // while the path form is literal ('~BUN').
  const url = import.meta.url;
  return (
    url.includes('/$bunfs/') ||
    url.toLowerCase().includes('/%7ebun/') ||
    url.includes('/~BUN/')
  );
}

let cached: string | undefined;

/** The root directory the app reads its own resources from (web/dist, skills/, mcp/, profiles/, …). */
export function resourceRoot(): string {
  if (cached !== undefined) return cached;
  if (process.env.ARIGAMI_ROOT) {
    cached = process.env.ARIGAMI_ROOT;
  } else if (isCompiledBinary()) {
    cached = path.join(path.dirname(process.execPath), 'resources');
  } else {
    // This file lives at <repoRoot>/server/lib/resource-root.ts — two
    // levels below the repo root, same as the old per-file computations.
    cached = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  }
  return cached;
}
