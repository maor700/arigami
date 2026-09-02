// Tiny static file server for the pilot's fake org-bundle repo (dumb-HTTP git
// clone needs nothing more). Binds 0.0.0.0 so pods reach it via k3d's
// host.k3d.internal. Test fixture only — no auth, read-only, path-guarded.
//
//   bun test/fixtures/serve-dir.ts <dir> [port]
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(process.argv[2] || '.');
const port = Number(process.argv[3] || 18092);

Bun.serve({
  port,
  hostname: '0.0.0.0',
  fetch(req) {
    const p = path.normalize(path.join(root, decodeURIComponent(new URL(req.url).pathname)));
    if (p !== root && !p.startsWith(root + path.sep)) return new Response('forbidden', { status: 403 });
    if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) return new Response('not found', { status: 404 });
    return new Response(Bun.file(p));
  },
});
console.log(`[serve-dir] ${root} on 0.0.0.0:${port}`);
