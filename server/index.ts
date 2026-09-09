// FIRST — defines process.env.HOME on Windows. Every `~` path below (config,
// state, chat, repos) is resolved at module-eval time, so this must land before
// any of them are imported.
import './lib/platform.js';
import http, { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { resourceRoot } from './lib/resource-root.js';
import { cfg, ensureConfigFile, flushState } from './state.js';
import * as api from './api.js';
import * as bus from './bus.js';
import * as vnc from './vnc.js';
import * as screencast from './screencast.js';
import { killAll, kickAutoPlayAll } from './claude.js';
// Side-effect import: server/codex.ts calls registerEngine() at module load, the
// same way claude.js does at the bottom of its own file. It has to be imported
// from HERE and not from claude.js — codex.ts imports claude.js, so the reverse
// edge would be a cycle. Without this line pickEngine() throws "engine not
// implemented: codex" for every session that asked for it.
import './codex.js';
import { migrateLegacyMcpRegistration, autoStartBridge, stopBridge } from './whatsapp-bridge.js';
import { sweepOrphans, HOST_ID } from './lib/children.js';
import { claimHost, releaseHost } from './lib/hostlock.js';
import { ARIGAMI_DIR, IS_DEFAULT_INSTANCE } from './lib/instance.js';
import { flush as flushTriggers } from './triggers.js';
import * as artifacts from './artifacts.js';
import * as extServe from './ext-serve.js';
import { setDrainHandler, healthBody } from './host-control.js';
import { validateAuthBind } from './lib/config.js';
import { auth } from './auth.js';
// K2: share-token gate for cookie-less artifact links (see auth.ts ShareGate).
auth.setShareGate(artifacts.shareGate);
// EXT3: the same gate for an extension tab's own assets — the sandboxed page
// has an opaque origin and cannot send the cookie (see server/ext-serve.ts).
auth.setExtGate(extServe.shareGate);

const ROOT = resourceRoot();
const WEB_DIST = path.join(ROOT, 'web', 'dist');
// EXT: the browser tab SDK, served from the repo (sdk/browser/ext-sdk.js) at a
// stable path every extension page can <script src> — see sdk/README.md.
const EXT_SDK_FILE = path.join(ROOT, 'sdk', 'browser', 'ext-sdk.js');

// Desktop packaging (bun build --compile): inside a compiled binary there is
// no `bun` on PATH, so server/lib/bun-exec.ts re-execs THIS SAME binary with
// `--mcp <kind>` instead of `bun mcp/<file>.js` to run one of the mcp/*.js
// helper scripts. Must be the very first thing checked — before config-dir
// creation, the host lock or the port bind below — because these subprocesses
// spawn once per Claude Code session/tool-call and must never touch host
// state or compete for the port. `await new Promise(() => {})` permanently
// parks this module's own evaluation right here (never falling through to
// the server bootstrap below) while the imported script's own listeners
// (stdio for host-mcp.js/ext-mcp.js; policy-hook.js calls process.exit
// itself) keep the process alive on their own.
{
  const mcpIdx = process.argv.indexOf('--mcp');
  if (mcpIdx !== -1) {
    const MCP_FILES: Record<string, string> = { host: 'host-mcp.js', policy: 'policy-hook.js', ext: 'ext-mcp.js' };
    const kind = process.argv[mcpIdx + 1];
    const file = MCP_FILES[kind];
    if (!file) {
      console.error(`[host] unknown --mcp kind: ${kind}`);
      process.exit(1);
    }
    // Rewrite argv so the target script sees the same relative layout it
    // would under `bun mcp/<file>.js [...args]` (ext-mcp.js reads its module
    // path from argv[2]).
    process.argv = [process.argv[0], path.join(ROOT, 'mcp', file), ...process.argv.slice(mcpIdx + 2)];
    await import(path.join(ROOT, 'mcp', file));
    await new Promise(() => {});
  }
}

try {
  ensureConfigFile?.();
  // S1 (minimal onboarding): the default cwd is an empty workspace under the
  // data dir so "Connect Claude → Start" works with zero repos configured.
  try { fs.mkdirSync(cfg.defaultCwd, { recursive: true }); } catch {}
} catch {}

// K8S-1 (PRD-ARIGAMI-K8S.md §2): a provisioner customises a fresh instance by
// setting ARIGAMI_BUNDLE=<source> in the pod env — no wizard, no host bearer
// to call POST /__api/profiles/apply with. Must land before the trigger
// scheduler starts below (so the bundle's own cron jobs are live from tick
// one) and before server.listen() (so a readiness probe never sees "up"
// before the tenant's harness is configured). Errors are logged, not thrown —
// same as every other bootstrap step here: a bad ARIGAMI_BUNDLE shouldn't
// brick the pod.
if (process.env.ARIGAMI_BUNDLE) {
  try {
    const pf = await import('./profiles.js');
    const tr = await import('./triggers.js');
    tr.load();
    const rep = await pf.applyBundleEnv();
    tr.flush();
    if (rep) console.log(`[host] ARIGAMI_BUNDLE applied: "${rep.name}"${rep.errors.length ? ` (${rep.errors.length} errors)` : ''}`);
  } catch (e) {
    console.error('[host] ARIGAMI_BUNDLE apply failed:', (e as Error)?.message);
  }
}

// Populated once the loader has been imported (below); the /__ext resolver
// needs a synchronous handle and the route must 404 before that, not await.
let extensionsMod: typeof import('./extensions.js') | null = null;

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

// EXT3: teach ext-serve.ts which extensions may be served — loaded, enabled
// and actually declaring a tab; everything else is a 404, so a stray directory
// under user/extensions is never publicly readable and an asset token stops
// working the moment its extension is disabled. Null until the loader is
// imported below (the route 404s in that window, as it did before).
extServe.setResolver((name) => {
  const ext = extensionsMod?.getExtension(name);
  if (!ext || ext.state !== 'loaded' || !(ext.manifest?.tabs || []).length) return null;
  return path.join(ext.dir, 'ui');
});
// …and which of them the human granted the TRUSTED tier (manifest asked AND
// extensions.json agreed). False until the loader is imported, on a disable, and
// on anything unknown — the sandbox is what you fall back to.
extServe.setTrustResolver((name) => extensionsMod?.getExtension(name)?.trusted === true);

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
    // C1: auth gate before ANY routing. Sets req.auth (the principal) and
    // answers 401/302 itself for everything outside the small public allowlist
    // (auth.ts isPublicPath). The proxy, host pages and /__artifacts (A1/K2)
    // are all behind it — one origin, one cookie.
    if (auth.gate(req, res)) return;
    if (pathname === '/__health') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      // K8S-3: loopback callers also get busySessions (host-control.healthBody)
      // — the tenant-upgrade idle gate; never exposed through the ingress.
      res.end(JSON.stringify(healthBody(req.socket.remoteAddress)));
      return;
    }
    if (pathname.startsWith('/__api/') || pathname.startsWith('/__mcp/')) {
      api.handle(req, res);
      return;
    }
    if (pathname === '/__host' || pathname.startsWith('/__host/')) {
      serveHost(pathname, res);
      return;
    }
    // Published artifacts (A1) — static snapshots, sandboxed CSP, traversal-
    // guarded. Must precede handlePage/proxy so a pinned SW target can't
    // swallow it (also listed in the SW SKIP list, proxy.ts).
    // K2: a valid `?t=` share token passed auth.gate via artifacts.shareGate
    // and left `req.share` — artifacts.serve pins that grant to one artifact
    // and one version.
    if (pathname === '/__artifacts' || pathname.startsWith('/__artifacts/')) {
      try {
        if (artifacts.serve(req, res)) return;
      } catch (e) {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('artifact error: ' + (e as Error).message);
        return;
      }
    }
    // EXT: the tab SDK and the extension UI mounts. Both must sit BEFORE
    // handlePage/proxy — a pinned proxy target would otherwise swallow them.
    if (pathname === '/__ext-sdk.js') {
      try {
        const st = fs.statSync(EXT_SDK_FILE);
        res.writeHead(200, {
          'content-type': 'application/javascript; charset=utf-8',
          'cache-control': 'public, max-age=3600',
          etag: `W/"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`,
        });
        fs.createReadStream(EXT_SDK_FILE).pipe(res);
      } catch {
        res.writeHead(404);
        res.end();
      }
      return;
    }
    if (pathname === '/__ext' || pathname.startsWith('/__ext/')) {
      try {
        if (extServe.serve(req, res)) return;
      } catch (e) {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('extension error: ' + (e as Error).message);
        return;
      }
      res.writeHead(404);
      res.end();
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
      // C1: /__ws, /__vnc, /__screencast and the SW proxy's websockets all
      // need the cookie (or an internal bearer) — an anonymous upgrade is
      // answered 401 + closed.
      if (auth.gateUpgrade(req, socket)) return;
      if (pathname === '/__ws') return bus.handleUpgrade(req, socket, head);
      if (pathname === '/__vnc') return vnc.handleUpgrade(req, socket, head);
      // native-window's live view (no VNC server to bridge to there) — see screencast.ts.
      if (pathname === '/__screencast') return screencast.handleUpgrade(req, socket, head);
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

// Fail-closed (SPEC §7.9): auth off + non-loopback bind is refused outright.
{
  const bad = validateAuthBind(cfg);
  if (bad) {
    console.error('[host] refusing to start: ' + bad);
    process.exit(2);
  }
}

// FIRST, before anything destructive: refuse to boot if this identity
// (ARIGAMI_DIR + port) is already being served. A second copy of a live host
// must never reach sweepOrphans() — that sweep kills every session of the
// running host (T5). Nothing below runs unless we own this identity.
try {
  await claimHost(cfg.port);
  console.log(`[host] instance ${HOST_ID}${IS_DEFAULT_INSTANCE ? ' (default)' : ' (isolated: ' + ARIGAMI_DIR + ')'}`);
} catch (e) {
  console.error('[host] refusing to start: ' + ((e as Error)?.message || e));
  process.exit(2);
}

// BEFORE listen: a child left over from a previous run may still hold the
// listening socket it inherited from us (Windows), which keeps the port bound to
// a pid that no longer exists — every subsequent start would fail to bind until
// a reboot. Sweeping first turns that into a self-healing restart. Only records
// carrying OUR hostId are candidates (see lib/children.ts planSweep).
try {
  const swept = sweepOrphans();
  if (swept) console.log(`[host] swept ${swept} orphaned process tree(s) from a previous run`);
} catch (e) {
  console.error('[host] orphan sweep failed:', (e as Error)?.message);
}

// A bind failure is the single most confusing way for the host to die — say what
// it actually means, including the "owner is already dead" case.
server.on('error', (e: NodeJS.ErrnoException) => {
  if (e?.code === 'EADDRINUSE' || e?.code === 'EACCES') {
    console.error(
      `[host] cannot bind :${cfg.port} (${e.code}). Something already holds it — ` +
        `if the owning pid no longer exists, an orphaned child is still holding the ` +
        `socket it inherited: run \`bin/host.ps1 stop\` (Windows) or \`bin/host stop\` to sweep, ` +
        `or set a different port in ${cfg.configFile}.`
    );
    process.exit(1);
  }
  console.error('[host] server error:', e?.message || e);
});

server.listen(cfg.port, cfg.bind, () => {
  console.log(
    `[host] arigami up on http://${cfg.bind}:${cfg.port} (pid ${process.pid}, auth: ${cfg.auth.mode}${cfg.publicUrl ? ', public: ' + cfg.publicUrl : ''})`
  );
  if (cfg.auth.mode === 'off')
    console.warn('[host] auth is OFF — anyone who can reach this loopback port (incl. tailscale serve / any local proxy) has full control. See docs/AUTH.md');
  try {
    auth.announcePairing();
  } catch (e) {
    console.error('[host] pairing code failed:', (e as Error)?.message);
  }
  // BUGS1/B20: the host owns the ONE WhatsApp process. Retire the legacy
  // per-session `mcpServers.whatsapp` from ~/.claude.json BEFORE any session's
  // claude can spawn (idempotent, backed up), then bring the bridge up when a
  // pairing exists — with the per-session trees gone nothing else would.
  try {
    const r = migrateLegacyMcpRegistration();
    if (r.error) console.error(`[host] whatsapp legacy-mcp migration skipped: ${r.error}`);
  } catch (e) {
    console.error('[host] whatsapp legacy-mcp migration failed:', (e as Error)?.message);
  }
  import('./listeners.js')
    .then((m: any) => autoStartBridge(m.enqueueWake))
    .then((r) => { if (r.started || r.reason !== 'not paired') console.log(`[host] whatsapp bridge ${r.started ? 'up' : 'not started'} (${r.reason})`); })
    .catch((e: any) => console.error('[host] whatsapp bridge autostart failed:', e?.message));
  import('./accounts.js')
    .then((m: any) => {
      m.initAccounts(); // seed from keychain + any inherited .env token
      // B3: `install.sh --unattended` → pre-complete every skippable wizard step
      // so the wizard is done the moment pairing lands (no UI on a headless box).
      import('./onboarding.js').then((ob) => { try { ob.unattendedPrecomplete(); } catch {} }).catch(() => {});
      // K5/D3: `install` = the first boot of this data dir; then arm the
      // opt-in telemetry shipper (a no-op timer until someone opts in).
      import('./funnel.js').then((f) => { try { f.firstTime('install'); } catch {} }).catch(() => {});
      import('./telemetry.js').then((tm) => { try { tm.start(); } catch {} }).catch(() => {});
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
  // EXT: load the installed extensions BEFORE the listener scheduler, so an
  // extension's listener type is registered by the time the first tick polls a
  // listener rehydrated from state.json.
  import('./extensions.js')
    .then(async (m) => {
      extensionsMod = m;
      await m.start();
    })
    .catch((e: any) => console.error('[host] extension loader failed to start:', e?.message))
    .finally(() => {
      import('./listeners.js')
        .then((m: any) => m.startListenerScheduler())
        .catch((e: any) => console.error('[host] listener scheduler failed to start:', e?.message));
    });
  import('./triggers.js')
    .then((m: any) => m.startTriggerScheduler())
    .catch((e: any) => console.error('[host] trigger scheduler failed to start:', e?.message));
  // RES1: the session supervisor — one tick classifies every session and walks
  // the recovery ladder (server/supervisor.ts is the pure decision).
  import('./supervisor-loop.js')
    .then((m: any) => m.startSupervisor())
    .catch((e: any) => console.error('[host] supervisor failed to start:', e?.message));
  // UPD1: daily `claude` CLI update check (+ auto-apply unless cfg.host.claudeAutoUpdate=false).
  import('./lib/claude-update.js')
    .then((m: any) => m.startClaudeUpdater())
    .catch((e: any) => console.error('[host] claude updater failed to start:', e?.message));
  // LEARN1: autonomous memory learning — triages the pending queue when enough
  // proposals piled up / 48h passed (cfg.memory.learning), never under memory pressure.
  import('./memory-learning.js')
    .then((m: any) => m.startLearningScheduler())
    .catch((e: any) => console.error('[host] memory learning scheduler failed to start:', e?.message));
  // A queue that was waiting for a turn-end the restart cancelled would sit
  // there forever otherwise — sessions come back idle, and nothing else kicks.
  try {
    const n = kickAutoPlayAll();
    if (n) console.log(`[host] auto-play: kicked ${n} session(s) with a waiting prompt queue`);
  } catch (e) {
    console.error('[host] auto-play boot kick failed:', (e as Error)?.message);
  }
  // Shared :99 desktop (spec §7.3): default instance only, no-op when the
  // display is already up (legacy unit) or Xvfb/x11vnc are missing.
  import('./lib/desktops.js')
    .then((m: any) => m.ensureGlobalDesktop())
    .then((r: any) => console.log(r?.started ? `[host] global desktop up on ${r.display} (vnc :${r.vncPort})` : `[host] global desktop not started: ${r?.reason}`))
    .catch((e: any) => console.error('[host] global desktop failed:', e?.message));
});

// Restart-from-cockpit (host-control.ts): once a restart is draining, stop
// taking new connections so clients see "offline" and reconnect to the fresh
// process instead of racing our shutdown. Existing keep-alive sockets stay
// usable for the in-flight response.
setDrainHandler(() => { try { server.close(); } catch {} });

function shutdown(): void {
  flushState();
  try {
    flushTriggers();
  } catch {}
  killAll();
  try { stopBridge(); } catch {} // B20: the WhatsApp process is ours — never leave it orphaned
  releaseHost();
  try { server.close(); } catch {}
  process.exit(0);
}

process.on('exit', () => { try { releaseHost(); } catch {} });
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
// Windows delivers SIGBREAK (Ctrl+Break / taskkill without /F) rather than
// SIGTERM; SIGHUP is the console-closed case. Neither fires on `taskkill /F` —
// that's what the job object in lib/children.ts is for.
process.on('SIGBREAK', shutdown);
process.on('SIGHUP', shutdown);
