import http, { IncomingMessage, ServerResponse, OutgoingHttpHeaders } from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import net from 'node:net';
import { cfg } from './lib/config.js';
import { secret } from './lib/secrets.js';

type TargetOrigin = string | null;
type HeaderValue = string | string[] | undefined;

interface TargetSplit {
  origin: TargetOrigin;
  path: string;
}

interface ProxyOptions {
  vercelBypass?: string;
  devServerPorts?: number[];
}

interface StatusResponse {
  targets: Array<{ target: TargetOrigin; lastSeen: number }>;
  devServers: number[];
}

interface ProxyHandlers {
  handle: (req: IncomingMessage, res: ServerResponse) => void;
  handleUpgrade: (req: IncomingMessage, socket: net.Socket, head: Buffer) => void;
  hasTarget: (req: IncomingMessage) => boolean;
  status: () => Promise<StatusResponse>;
}

export const hostOrigin = (req: IncomingMessage): string =>
  `http://${req.headers.host || 'localhost:' + (req.socket ? req.socket.localPort : cfg.port)}`;

export const targetOrigin = (raw: string | null | undefined): TargetOrigin => {
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
};

export const rewriteLocation = (
  location: string | null | undefined,
  upstreamOrigin: TargetOrigin
): string | null | undefined => {
  if (!location) return location;
  try {
    const loc = new URL(location, upstreamOrigin ?? undefined);
    if (loc.origin === upstreamOrigin) return loc.pathname + loc.search + loc.hash;
  } catch {}
  return location;
};

// The host's own auth cookies (C1) must never be overwritten by an upstream
// that happens to Set-Cookie the same name through the proxy.
const RESERVED_COOKIES = /^\s*(arigami_sid|arigami_oidc)\s*=/i;

export const rewriteSetCookie = (cookies: string[]): string[] =>
  cookies
    .filter((c) => !RESERVED_COOKIES.test(c))
    .map((c) =>
      c
        .replace(/;\s*Domain=[^;]*/gi, '')
        .replace(/;\s*Secure/gi, '')
        .replace(/;\s*SameSite=None/gi, '; SameSite=Lax')
    );

export const stripFrameAncestors = (v: HeaderValue): HeaderValue => {
  const strip = (s: string): string =>
    String(s)
      .split(';')
      .filter((d) => !/^\s*frame-ancestors\b/i.test(d))
      .join(';')
      .trim();
  return Array.isArray(v) ? v.map(strip) : strip(String(v || ''));
};

export const decompressBody = (buf: Buffer, enc: string): Buffer => {
  try {
    if (enc === 'gzip') return zlib.gunzipSync(buf);
    if (enc === 'br') return zlib.brotliDecompressSync(buf);
    if (enc === 'deflate') return zlib.inflateSync(buf);
  } catch {}
  return buf;
};

// Dev servers (Vite) answer uncompressed: fine on loopback, fatal over a
// remote link — a large app's cold load can be thousands of modules and tens of
// MB of JS with inline source maps, which at a few hundred KB/s reads as an
// endless loading loop. Text bodies gzip ~4-5x, so compress them on the way out.
const COMPRESSIBLE = /^(text\/|application\/(javascript|json|xml|wasm|manifest\+json)|image\/svg\+xml)/i;

export const shouldGzip = (
  method: string | undefined,
  status: number,
  acceptEncoding: HeaderValue,
  out: Record<string, HeaderValue>
): boolean => {
  if (method === 'HEAD' || status === 204 || status === 304 || status < 200) return false;
  if (out['content-encoding']) return false;
  if (!COMPRESSIBLE.test(String(out['content-type'] || ''))) return false;
  const len = Number(out['content-length']);
  if (Number.isFinite(len) && len > 0 && len < 1024) return false;
  return /\bgzip\b/i.test(String(acceptEncoding || ''));
};

const markGzipped = (out: Record<string, HeaderValue>): void => {
  out['content-encoding'] = 'gzip';
  delete out['content-length'];
  const vary = String(out.vary || '');
  if (!/accept-encoding/i.test(vary)) out.vary = vary ? `${vary}, Accept-Encoding` : 'Accept-Encoding';
  // The bytes differ from the upstream's, so a strong validator no longer holds.
  if (typeof out.etag === 'string' && !out.etag.startsWith('W/')) out.etag = 'W/' + out.etag;
};

export const injectSnippet = (html: string, tag: string): string => {
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + tag);
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, tag + '</body>');
  return html + tag;
};

export const swSnippet = (target: string): string => {
  const t = JSON.stringify(target);
  const targetOrigin = JSON.stringify(new URL(target).origin);
  return (
    `<script>(function(){` +
    `if(navigator.serviceWorker){var __c=navigator.serviceWorker.controller;` +
    `if(__c){try{sessionStorage.removeItem('arigami_boot')}catch(e){}}` +
    `if(__c&&__c.scriptURL.indexOf('?v=')>-1&&!sessionStorage.getItem('poc_heal')){sessionStorage.setItem('poc_heal','1');` +
    `navigator.serviceWorker.getRegistrations().then(function(rs){return Promise.all(rs.map(function(r){return r.unregister()}))})` +
    `.then(function(){return self.caches?caches.keys().then(function(ks){return Promise.all(ks.map(function(k){return caches.delete(k)}))}):0})` +
    `.then(function(){location.reload()});return;}` +
    `try{navigator.serviceWorker.register('/__poc-sw.js',{scope:'/'}).catch(function(){})}catch(e){}}` +
    `try{var KEEP=function(u){try{var x=new URL(u,location.href);if(x.origin===location.origin&&!x.searchParams.has('__target')){x.searchParams.set('__target',${t});x.searchParams.set('__keep','1')}return x.pathname+x.search+x.hash}catch(e){return u}};` +
    `['pushState','replaceState'].forEach(function(m){var o=history[m];if(o)history[m]=function(s,ti,u){return o.call(this,s,ti,u==null?u:KEEP(u))}})}catch(e){}` +
    `try{var TNO=${targetOrigin};var INH=function(f){try{var s=f.getAttribute&&f.getAttribute('src');if(s&&s.indexOf('__target=')<0){var x=new URL(s,location.href);if(x.origin===location.origin){x.searchParams.set('__target',${t});x.searchParams.set('__keep','1');f.setAttribute('src',x.pathname+x.search+x.hash)}else if(x.origin===TNO){var y=new URL(location.origin);y.pathname=x.pathname;y.search=x.search;y.hash=x.hash;y.searchParams.set('__target',${t});y.searchParams.set('__keep','1');f.setAttribute('src',y.pathname+y.search+y.hash)}}}catch(e){}};` +
    `var SCAN=function(n){if(!n)return;if(n.tagName==='IFRAME'){INH(n)}else if(n.querySelectorAll){var l=n.querySelectorAll('iframe');for(var i=0;i<l.length;i++)INH(l[i])}};` +
    `var WATCH_IFRAME=function(f){var o=new MutationObserver(function(){INH(f)});o.observe(f,{attributes:true,attributeFilter:['src']})};` +
    `new MutationObserver(function(ms){for(var i=0;i<ms.length;i++){var m=ms[i];if(m.type==='attributes'){INH(m.target)}else{for(var j=0;j<m.addedNodes.length;j++){var n=m.addedNodes[j];SCAN(n);if(n.tagName==='IFRAME')WATCH_IFRAME(n)}}}}).observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:['src']});` +
    `SCAN(document);` +
    `document.querySelectorAll('iframe').forEach(function(f){WATCH_IFRAME(f)})}catch(e){}` +
    `})();</script>`
  );
};

export const getTarget = (req: IncomingMessage): TargetOrigin =>
  targetOrigin(req.headers['x-poc-target'] as string | undefined);

// Last resort, for a page that runs without the worker (BOOTSTRAP_HTML gave
// up): a nested module import's Referer is the importing module, not the
// document, so it carries no `?__target`. The injected document set this
// cookie. It is shared by every tab, which is why it only ever comes last.
export const cookieTarget = (req: IncomingMessage): TargetOrigin => {
  const m = /(?:^|;\s*)poc_target=([^;]+)/.exec(String(req.headers.cookie || ''));
  if (!m) return null;
  // A malformed percent-encoding (e.g. `poc_target=%zz`) makes
  // decodeURIComponent throw; in the 'upgrade' handler an uncaught throw takes
  // down the whole process and every session — treat it as absent.
  try {
    return targetOrigin(decodeURIComponent(m[1]));
  } catch {
    return null;
  }
};

export const refererTarget = (req: IncomingMessage): TargetOrigin => {
  try {
    return targetOrigin(
      new URL(req.headers.referer || '').searchParams.get('__target')
    );
  } catch {
    return null;
  }
};

const splitTarget = (raw: string | null): TargetSplit => {
  try {
    const u = new URL(raw ?? '');
    const path =
      u.pathname !== '/' || u.search || u.hash
        ? u.pathname + u.search + u.hash
        : '';
    return { origin: u.origin, path };
  } catch {
    return { origin: targetOrigin(raw), path: '' };
  }
};

const getPinnedTicket = (req: IncomingMessage): string =>
  (req.headers['x-poc-ticket'] as string) || '';

// `/__ext` (the extension mounts and /__ext-sdk.js) is on the SKIP list for the
// same reason /__artifacts is: a TRUSTED extension tab is same-origin, so a
// client this SW has pinned to a proxy target must not swallow its own page or
// assets. Its child iframes carry their own `?__target=`, and those are proxied.
export const SW_SOURCE = `
const SKIP = (p) => p === '/__poc-sw.js' || p === '/__whoami' || p === '/__health' || p === '/__card.js' || p.startsWith('/__host') || p.startsWith('/__api') || p.startsWith('/__ws') || p.startsWith('/__mcp') || p.startsWith('/__ticket') || p.startsWith('/__artifacts') || p.startsWith('/__preview') || p.startsWith('/__ext');

const MEM = new Map();

function targetOf(u){ try { const t = new URL(u, self.location.origin).searchParams.get('__target'); return t ? new URL(t).origin : null; } catch (e) { return null; } }

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  try { for (const k of await caches.keys()) await caches.delete(k); } catch (e) {}
  await self.clients.claim();
})()));

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (SKIP(url.pathname)) return;

  if (req.mode !== 'navigate' && targetOf(req.referrer)) return;

  event.respondWith((async () => {
    let target = targetOf(req.url);
    if (!target) { try { const c = await self.clients.get(event.clientId); if (c) target = targetOf(c.url); } catch (e) {} }
    if (!target && req.referrer) target = targetOf(req.referrer);
    if (!target) target = MEM.get(event.clientId) || MEM.get(event.resultingClientId) || null;
    if (!target) {
      return fetch(req);
    }

    if (event.clientId) MEM.set(event.clientId, target);
    if (event.resultingClientId) MEM.set(event.resultingClientId, target);

    const h = new Headers();
    for (const [k, v] of req.headers) {
      const lk = k.toLowerCase();
      if (lk === 'origin' || lk.startsWith('sec-fetch-')) continue;
      h.set(k, v);
    }
    h.set('x-poc-target', target);
    if (req.mode === 'navigate') {
      h.set('x-poc-nav', '1');
      return fetch(new Request(req.url, { method: req.method, headers: h, redirect: 'follow' }));
    }
    const init = { method: req.method, headers: h, credentials: 'include', redirect: 'follow' };
    if (req.method !== 'GET' && req.method !== 'HEAD') init.body = await req.blob();
    return fetch(new Request(req.url, init));
  })());
});
`;

export const BOOTSTRAP_HTML = `<!doctype html><meta charset="utf-8"><title>…</title>
<body style="margin:0;background:#0d1117;color:#8b949e;font:13px ui-monospace,Menlo,monospace;display:flex;align-items:center;justify-content:center;height:100vh">
<div>starting host proxy…</div>
<script>
(async () => {
  try {
    const regs = await navigator.serviceWorker.getRegistrations();
    const stale = regs.some((r) => ['active','waiting','installing'].some((k) => r[k] && r[k].scriptURL.indexOf('?v=') > -1));
    if (stale) {
      await Promise.all(regs.map((r) => r.unregister()));
      if (self.caches) { const ks = await caches.keys(); await Promise.all(ks.map((k) => caches.delete(k))); }
    }
    await navigator.serviceWorker.register('/__poc-sw.js', { scope: '/' });
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise((res) => { navigator.serviceWorker.addEventListener('controllerchange', res, { once: true }); setTimeout(res, 2500); });
    }
  } catch (e) {}
  // Landing here again means the worker never took the navigation over: it
  // failed to register (untrusted cert, private window, SW blocked) or DevTools
  // "Bypass for network" is on. Reloading again would loop forever, so go on
  // without it — the server routes a worker-less page by its Referer and the
  // poc_target cookie.
  let seen = 0;
  try { seen = Number(sessionStorage.getItem('arigami_boot') || 0); sessionStorage.setItem('arigami_boot', String(seen + 1)); } catch (e) { seen = 1; }
  if (seen < 1 && navigator.serviceWorker && navigator.serviceWorker.controller) return location.reload();
  const u = new URL(location.href);
  u.searchParams.set('__nosw', '1');
  location.replace(u.pathname + u.search + u.hash);
})();
</script></body>`;

const tcpUp = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    let done = false;
    const fin = (ok: boolean) => {
      if (done) return;
      done = true;
      try {
        s.destroy();
      } catch {}
      resolve(ok);
    };
    s.setTimeout(300, () => fin(false));
    s.once('connect', () => fin(true));
    s.once('error', () => fin(false));
  });

export function createProxy(opts: ProxyOptions = {}): ProxyHandlers {
  const VERCEL_BYPASS =
    opts.vercelBypass !== undefined
      ? opts.vercelBypass
      : secret('VERCEL_AUTOMATION_BYPASS_SECRET');
  const devServerPorts = opts.devServerPorts || cfg.devServerPorts;

  const pinned = new Map<TargetOrigin, number>();

  function proxyRequest(
    req: IncomingMessage,
    res: ServerResponse,
    target: string,
    targetForInjection: string | null = null
  ): void {
    let upstream: URL;
    try {
      upstream = new URL(req.url || '/', target);
    } catch {
      res.writeHead(400);
      res.end('bad target');
      return;
    }
    const mod = upstream.protocol === 'https:' ? https : http;
    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v !== undefined) {
        headers[k] = v;
      }
    }
    headers.host = upstream.host;

    if (VERCEL_BYPASS && /\.vercel\.app$/i.test(upstream.hostname)) {
      headers['x-vercel-protection-bypass'] = VERCEL_BYPASS;
      headers['x-vercel-set-bypass-cookie'] = 'true';
    }

    for (const [suffix, cookieVal] of Object.entries(cfg.upstreamCookies || {})) {
      const cookie = cookieVal as string | undefined;
      if (
        cookie &&
        (upstream.hostname === suffix ||
          upstream.hostname.endsWith('.' + suffix))
      ) {
        const existingCookie = headers.cookie as string | undefined;
        headers.cookie = existingCookie
          ? `${existingCookie}; ${cookie}`
          : cookie;
      }
    }
    if (headers.origin) {
      headers.origin = upstream.origin;
    }
    if (headers.referer) {
      const referer = headers.referer as string | string[];
      if (typeof referer === 'string') {
        headers.referer = referer.split(hostOrigin(req)).join(upstream.origin);
      }
    }

    const preq = mod.request(
      upstream,
      { method: req.method, headers, rejectUnauthorized: false },
      (pres: IncomingMessage) => {
        const out: Record<string, string | string[] | undefined> = { ...pres.headers };

        if (out.location) {
          const rewritten = rewriteLocation(
            out.location as string | undefined,
            upstream.origin
          );
          if (rewritten !== null && rewritten !== undefined) {
            out.location = rewritten;
          }
        }
        if (out['set-cookie'])
          out['set-cookie'] = rewriteSetCookie(
            Array.isArray(out['set-cookie'])
              ? out['set-cookie']
              : [String(out['set-cookie'])]
          );

        const st = pres.statusCode || 200;
        const navHeader = req.headers['x-poc-nav'] as string | undefined;
        const outLocation = out.location as string | undefined;
        if (
          navHeader === '1' &&
          st >= 301 &&
          st <= 308 &&
          st !== 304 &&
          outLocation &&
          (req.method === 'GET' || req.method === 'HEAD')
        ) {
          pres.resume();
          const reqWithHops = req as IncomingMessage & { __pocNavHops?: number };
          const hops = (reqWithHops.__pocNavHops || 0) + 1;
          if (outLocation.startsWith('/') && hops <= 5) {
            req.url = outLocation;
            reqWithHops.__pocNavHops = hops;
            return proxyRequest(req, res, target);
          }
          const writeHeadHeaders: Record<string, string | string[]> = {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
          };
          if (out['set-cookie']) {
            writeHeadHeaders['set-cookie'] = out['set-cookie'] as string | string[];
          }
          res.writeHead(200, writeHeadHeaders);
          return res.end(
            `<!doctype html><script>location.replace(${JSON.stringify(outLocation)})</script>`
          );
        }

        delete out['x-frame-options'];
        for (const k of [
          'content-security-policy',
          'content-security-policy-report-only',
        ]) {
          if (out[k]) {
            const val = out[k];
            if (typeof val === 'string' || Array.isArray(val)) {
              out[k] = stripFrameAncestors(val);
            }
          }
        }

        for (const k of Object.keys(out)) {
          if (k.toLowerCase().startsWith('access-control-')) delete out[k];
        }

        out['referrer-policy'] = 'no-referrer-when-downgrade';

        if (String(out['content-type'] || '').includes('text/html')) {
          const chunks: Buffer[] = [];
          pres.on('data', (c: Buffer) => chunks.push(c));
          pres.on('end', () => {
            const buf = decompressBody(
              Buffer.concat(chunks),
              String(out['content-encoding'] || '').toLowerCase()
            );
            const snippetTarget = targetForInjection || target;
            const body = Buffer.from(
              injectSnippet(buf.toString('utf8'), swSnippet(snippetTarget)),
              'utf8'
            );
            delete out['content-encoding'];
            delete out['transfer-encoding'];
            delete out.etag;
            delete out['last-modified'];
            out['cache-control'] = 'no-store';
            out['content-length'] = String(body.length);

            if (targetForInjection) {
              const existingCookies = out['set-cookie'] || [];
              const cookieList = Array.isArray(existingCookies)
                ? existingCookies
                : [String(existingCookies)];
              out['set-cookie'] = [
                `poc_target=${encodeURIComponent(target)}; Path=/; SameSite=Lax`,
                ...cookieList,
              ];
            }

            if (shouldGzip(req.method, pres.statusCode || 200, req.headers['accept-encoding'], out)) {
              const gz = zlib.gzipSync(body, { level: 5 });
              markGzipped(out);
              out['content-length'] = String(gz.length);
              res.writeHead(pres.statusCode || 200, out);
              res.end(gz);
              return;
            }
            res.writeHead(pres.statusCode || 200, out);
            res.end(body);
          });
          pres.on('error', () => res.end());
          return;
        }

        if (shouldGzip(req.method, pres.statusCode || 200, req.headers['accept-encoding'], out)) {
          markGzipped(out);
          delete out['transfer-encoding'];
          res.writeHead(pres.statusCode || 200, out);
          const gz = zlib.createGzip({ level: 5 });
          gz.on('error', () => res.destroy());
          pres.on('error', () => gz.destroy());
          pres.pipe(gz).pipe(res);
          return;
        }
        res.writeHead(pres.statusCode || 200, out);
        pres.pipe(res);
      }
    );

    preq.on('error', (e: Error) => {
      if (!res.headersSent)
        res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('proxy error contacting ' + upstream.origin + ': ' + e.message);
    });

    const reqWithHops = req as IncomingMessage & { __pocNavHops?: number };
    if (reqWithHops.__pocNavHops) preq.end();
    else req.pipe(preq);
  }

  function handle(req: IncomingMessage, res: ServerResponse): void {
    const u = new URL(req.url || '/', hostOrigin(req));

    if (u.pathname === '/__poc-sw.js') {
      res.writeHead(200, {
        'content-type': 'application/javascript; charset=utf-8',
        'service-worker-allowed': '/',
        'cache-control': 'no-cache',
      });
      res.end(SW_SOURCE);
      return;
    }

    if (u.pathname === '/__whoami') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          hostOrigin: hostOrigin(req),
          target: getTarget(req),
          ticket: getPinnedTicket(req) || null,
        })
      );
      return;
    }

    if (
      u.searchParams.get('__target') && // non-empty target only — empty would loop the bootstrap forever
      !u.searchParams.has('__nosw') && // the bootstrap gave up on the worker (BOOTSTRAP_HTML)
      !req.headers['x-poc-target'] &&
      (req.headers.accept || '').includes('text/html')
    ) {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(BOOTSTRAP_HTML);
      return;
    }

    let target: TargetOrigin = null;
    let targetForInjection: string | null = null;
    let landPath: string | null = null;

    if (u.searchParams.has('__target')) {
      const rawTarget = u.searchParams.get('__target') || '';
      const { origin, path } = splitTarget(rawTarget);
      target = origin;
      targetForInjection = rawTarget;
      landPath = path;
    }

    target = target || getTarget(req) || refererTarget(req) || cookieTarget(req);

    if (!target) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('No target — open via the host UI at /__host/.\n');
      return;
    }

    if (landPath != null && u.pathname === '/') {
      u.searchParams.delete('__target');
      u.searchParams.delete('__keep');
      u.searchParams.delete('__ticket');
      u.searchParams.delete('__nosw');
      const rest = u.searchParams.toString();
      const base = landPath || u.pathname;
      req.url =
        base + (rest ? (base.includes('?') ? '&' : '?') + rest : '');
    } else if (u.searchParams.has('__target')) {
      u.searchParams.delete('__target');
      u.searchParams.delete('__keep');
      u.searchParams.delete('__ticket');
      u.searchParams.delete('__nosw');
      const rest = u.searchParams.toString();
      req.url =
        u.pathname + (rest ? '?' + rest : '');
    }

    pinned.set(target, Date.now());
    proxyRequest(req, res, target, targetForInjection);
  }

  function handleUpgrade(
    req: IncomingMessage,
    socket: net.Socket,
    head: Buffer
  ): void {
    const target: TargetOrigin = refererTarget(req) || getTarget(req) || cookieTarget(req);

    if (!target) {
      console.error(`[WS] no target for ${req.url}`);
      socket.destroy();
      return;
    }

    pinned.set(target, Date.now());

    let upstream: URL;
    try {
      upstream = new URL(req.url || '/', target);
    } catch {
      socket.destroy();
      return;
    }

    const mod = upstream.protocol === 'https:' ? https : http;
    const headers: Record<string, string | string[]> = {
      ...req.headers,
      host: upstream.host,
    };
    if (headers.origin) headers.origin = upstream.origin;

    const preq = mod.request(upstream, {
      method: req.method,
      headers,
      rejectUnauthorized: false,
    });

    preq.on(
      'upgrade',
      (
        pres: IncomingMessage,
        psocket: net.Socket,
        phead: Buffer
      ) => {
        const h =
          'HTTP/1.1 101 Switching Protocols\r\n' +
          Object.entries(pres.headers)
            .map(
              ([k, v]) =>
                `${k}: ${Array.isArray(v) ? v.join(', ') : v}`
            )
            .join('\r\n') +
          '\r\n\r\n';
        socket.write(h);
        if (phead && phead.length) socket.write(phead);
        psocket.pipe(socket);
        socket.pipe(psocket);
        psocket.on('error', () => socket.destroy());
        socket.on('error', () => psocket.destroy());
      }
    );

    // If the upstream answers with a normal HTTP response instead of a 101
    // (auth expired, wrong path, dev server down), the 'upgrade' event never
    // fires. Without a 'response' handler the client socket is never closed and
    // leaks — HMR clients reconnect aggressively, so fds pile up until restart.
    preq.on('response', (pres: IncomingMessage) => {
      try {
        socket.write(
          `HTTP/1.1 ${pres.statusCode || 502} ${pres.statusMessage || 'Bad Gateway'}\r\n\r\n`
        );
      } catch {}
      socket.destroy();
      pres.destroy();
    });
    preq.on('error', () => socket.destroy());
    // Bound the handshake so a hung upstream can't pin the socket open forever.
    preq.setTimeout(30_000, () => preq.destroy());
    socket.on('error', () => preq.destroy());
    if (head && head.length) preq.write(head);
    preq.end();
  }

  function hasTarget(req: IncomingMessage): boolean {
    if (req.headers['x-poc-target']) return true;
    try {
      return new URL(req.url || '/', 'http://x').searchParams.has('__target');
    } catch {
      return false;
    }
  }

  async function status(): Promise<StatusResponse> {
    const up = await Promise.all(
      devServerPorts.map((p: number) =>
        tcpUp(p).then((ok: boolean) => (ok ? p : null))
      )
    );
    return {
      targets: [...pinned.entries()].map(([target, lastSeen]) => ({
        target,
        lastSeen,
      })),
      devServers: up.filter((p: number | null) => p !== null) as number[],
    };
  }

  return { handle, handleUpgrade, hasTarget, status };
}
