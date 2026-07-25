// FIRST — defines process.env.HOME on Windows. Every `~` path below (config,
// state, chat, repos) is resolved at module-eval time, so this must land before
// any of them are imported.
import './lib/platform.js';
import http, { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cfg, ensureConfigFile, flushState } from './state.js';
import * as api from './api.js';
import * as bus from './bus.js';
import { killAll } from './claude.js';
import { flush as flushTriggers } from './triggers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB_DIST = path.join(ROOT, 'web', 'dist');

try {
  ensureConfigFile?.();
} catch {}

interface ProxyModule {
  createProxy: (opts: any) => any;
  hasTarget?: (req: IncomingMessage) => boolean;
}

interface PagesModule {
  handlePage: (req: IncomingMessage, res: ServerResponse) => boolean;
}

interface Proxy {
  handle?: (req: IncomingMessage, res: ServerResponse) => void;
  handleUpgrade?: (req: IncomingMessage, socket: any, head: Buffer) => void;
  hasTarget?: (req: IncomingMessage) => boolean;
}

let proxy: Proxy | null = null;
let hasTarget: (req: IncomingMessage) => boolean = (): boolean => false;

try {
  const mod = (await import('./proxy.js')) as ProxyModule;
  proxy = mod.createProxy({ cfg });
  if (typeof mod.hasTarget === 'function')
    hasTarget = (req: IncomingMessage) => mod.hasTarget!(req);
  else if (typeof proxy?.hasTarget === 'function')
    hasTarget = (req: IncomingMessage) => proxy!.hasTarget!(req);
} catch (e) {
  const error = e instanceof Error ? e : new Error(String(e));
  console.error('[host] proxy.ts unavailable — proxying disabled:', error.message);
}

let handlePage: (req: IncomingMessage, res: ServerResponse) => boolean =
  (): boolean => false;
try {
  const mod = (await import('./pages.js')) as PagesModule & {
    setLiveTicketFetcher?: (fn: (id: string) => Promise<unknown>) => void;
  };
  handlePage = mod.handlePage;
  // Back the /__ticket page (pending-task preview, Linear session tab) with the
  // SAME Linear MCP OAuth credential the launcher uses, so an uncached ticket
  // still loads when connected to Linear (pages.js can't import linear-mcp).
  mod.setLiveTicketFetcher?.(async (id: string) => {
    const mcp = (await import('./linear-mcp.js')) as any;
    if (!mcp.status().connected) return null;
    return await mcp.getIssue(id);
  });
} catch (e) {
  const error = e instanceof Error ? e : new Error(String(e));
  console.error('[host] pages.js unavailable — host pages disabled:', error.message);
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

function serveHost(pathname: string, res: ServerResponse): void {
  let rel = pathname.replace(/^\/__host\/?/, '') || 'index.html';
  let file = path.normalize(path.join(WEB_DIST, rel));
  // Prefix check needs a separator boundary, else a sibling like
  // `web/dist-secrets` (reachable via `/__host/../dist-secrets/x`) would pass.
  if (file !== WEB_DIST && !file.startsWith(WEB_DIST + path.sep)) {
    res.writeHead(403);
    res.end();
    return;
  }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    file = path.join(WEB_DIST, 'index.html');
  }
  if (!fs.existsSync(file)) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      '<!doctype html><title>Arigami</title><body style="font-family:system-ui;padding:40px"><h1>Arigami</h1><p>UI not built yet — run <code>bun run build:web</code>. The API is live at <a href="/__api/sessions">/__api/sessions</a>.</p>'
    );
    return;
  }
  res.writeHead(200, {
    'content-type': MIME[path.extname(file)] || 'application/octet-stream',
  });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(
  (req: IncomingMessage, res: ServerResponse) => {
    const pathname = (req.url || '/').split('?')[0];
    if (pathname.startsWith('/__api/') || pathname.startsWith('/__mcp/')) {
      api.handle(req, res);
      return;
    }
    if (pathname === '/__host' || pathname.startsWith('/__host/')) {
      serveHost(pathname, res);
      return;
    }
    if (pathname === '/') {
      let pinned = false;
      try {
        pinned = !!hasTarget(req);
      } catch {}
      if (!pinned) {
        res.writeHead(302, { location: '/__host/' });
        res.end();
        return;
      }
    }
    try {
      if (handlePage(req, res)) return;
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('host page error: ' + error.message);
      return;
    }
    if (proxy?.handle) {
      proxy.handle(req, res);
      return;
    }
    res.writeHead(502, { 'content-type': 'text/plain' });
    res.end('arigami: proxy not available');
  }
);

server.on(
  'upgrade',
  (req: IncomingMessage, socket: any, head: Buffer) => {
    // A throw in this handler is an uncaught exception on the 'upgrade' event
    // and kills the process (with it, every running Claude session). Guard it.
    try {
      const pathname = (req.url || '').split('?')[0];
      if (pathname === '/__ws') return bus.handleUpgrade(req, socket, head);
      if (proxy?.handleUpgrade) return proxy.handleUpgrade(req, socket, head);
      socket.destroy();
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      console.error('[host] upgrade handler error:', error.message);
      try {
        socket.destroy();
      } catch {}
    }
  }
);

server.listen(cfg.port, () => {
  console.log(
    `[host] arigami up on http://localhost:${cfg.port} (pid ${process.pid})`
  );
  import('./accounts.js')
    .then((m: any) => {
      m.initAccounts(); // seed from keychain + any inherited .env token
      // Keep OAuth-login accounts' 8h access tokens renewed from their refresh tokens.
      import('./oauth-login.js').then((o: any) => o.startTokenRefresher()).catch(() => {});
      return import('./usage.js').then((u: any) => u.startUsagePolling());
    })
    .catch((e: any) => console.error('[host] accounts/usage init failed:', e?.message));
  // Pre-warm the MCP server list (slow `claude mcp list` health check) so the
  // /mcp panel is instant when first opened.
  import('./mcp-auth.js')
    .then((m: any) => m.listServers(true))
    .catch(() => {});
  import('./listeners.js')
    .then((m: any) => m.startListenerScheduler())
    .catch((e: any) => console.error('[host] listener scheduler failed to start:', e?.message));
  import('./triggers.js')
    .then((m: any) => m.startTriggerScheduler())
    .catch((e: any) => console.error('[host] trigger scheduler failed to start:', e?.message));
});

function shutdown(): void {
  flushState();
  try {
    flushTriggers();
  } catch {}
  killAll();
  server.close();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
