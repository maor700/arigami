// Tests for the proxy port (server/proxy.js) + the pure page helpers it ships
// with (server/pages.js). Pure-helper tests run in-process; the live section
// boots a throwaway upstream + host pair on EPHEMERAL ports (never 3099 — the
// PoC may be running there).
//   bun test test/proxy.test.js
import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import http from 'node:http';
import zlib from 'node:zlib';
import {
  createProxy,
  targetOrigin,
  rewriteLocation,
  rewriteSetCookie,
  decompressBody,
  injectSnippet,
  swSnippet,
  getTarget,
  SW_SOURCE,
  BOOTSTRAP_HTML,
} from '../server/proxy.js';
import { mdToHtml, diffHtml, esc, isPrUrl, parsePrUrl, comparePage, ticketShell } from '../server/pages.js';
import { cfg } from '../server/lib/config.js';

// ---- targetOrigin --------------------------------------------------------------
describe('targetOrigin', () => {
  test('normalizes a full URL to its bare origin', () => {
    expect(targetOrigin('http://localhost:3056')).toBe('http://localhost:3056');
    expect(targetOrigin('https://my-preview.vercel.app/some/path?q=1')).toBe('https://my-preview.vercel.app');
  });
  test('keeps explicit ports, drops default ones', () => {
    expect(targetOrigin('http://localhost:3056/policies')).toBe('http://localhost:3056');
    expect(targetOrigin('https://app.example.com:443/x')).toBe('https://app.example.com');
  });
  test('null/garbage → null', () => {
    expect(targetOrigin(null)).toBe(null);
    expect(targetOrigin('')).toBe(null);
    expect(targetOrigin('not a url')).toBe(null);
  });
});

// ---- rewriteLocation -----------------------------------------------------------
describe('rewriteLocation', () => {
  const up = 'http://localhost:3056';
  test('same-origin absolute redirects become path-only', () => {
    expect(rewriteLocation('http://localhost:3056/login?next=%2Fx#f', up)).toBe('/login?next=%2Fx#f');
  });
  test('relative redirects resolve against the upstream and stay path-only', () => {
    expect(rewriteLocation('/after', up)).toBe('/after');
    expect(rewriteLocation('after?x=1', up)).toBe('/after?x=1');
  });
  test('cross-origin redirects (OAuth) pass through untouched', () => {
    const g = 'https://accounts.google.com/o/oauth2/auth?client=1';
    expect(rewriteLocation(g, up)).toBe(g);
  });
  test('garbage passes through untouched', () => {
    expect(rewriteLocation('::::', up)).toBe('/::::'); // resolves as a path
  });
});

// ---- rewriteSetCookie ----------------------------------------------------------
describe('rewriteSetCookie', () => {
  test('strips Domain and Secure, relaxes SameSite=None to Lax', () => {
    const [c] = rewriteSetCookie(['sid=abc; Domain=.example.com; Path=/; Secure; SameSite=None; HttpOnly']);
    expect(c).toBe('sid=abc; Path=/; SameSite=Lax; HttpOnly');
  });
  test('leaves SameSite=Lax/Strict alone', () => {
    expect(rewriteSetCookie(['a=1; SameSite=Strict'])[0]).toBe('a=1; SameSite=Strict');
    expect(rewriteSetCookie(['a=1; SameSite=Lax'])[0]).toBe('a=1; SameSite=Lax');
  });
  test('case-insensitive attribute matching, multiple cookies', () => {
    const out = rewriteSetCookie(['a=1; domain=foo.com; secure', 'b=2; SECURE; samesite=none']);
    expect(out[0]).toBe('a=1');
    expect(out[1]).toBe('b=2; SameSite=Lax');
  });
});

// ---- getTarget -----------------------------------------------------------------
describe('getTarget', () => {
  test('reads the SW-stamped header and normalizes to origin', () => {
    expect(getTarget({ headers: { 'x-poc-target': 'http://localhost:3024/deep/path' } })).toBe('http://localhost:3024');
    expect(getTarget({ headers: {} })).toBe(null);
    expect(getTarget({ headers: { 'x-poc-target': 'junk' } })).toBe(null);
  });
});

// ---- decompressBody ------------------------------------------------------------
describe('decompressBody', () => {
  const raw = Buffer.from('<html><body>hello compress</body></html>');
  test('gzip / deflate / br roundtrip', () => {
    expect(decompressBody(zlib.gzipSync(raw), 'gzip').toString()).toBe(raw.toString());
    expect(decompressBody(zlib.deflateSync(raw), 'deflate').toString()).toBe(raw.toString());
    expect(decompressBody(zlib.brotliCompressSync(raw), 'br').toString()).toBe(raw.toString());
  });
  test('unknown encoding / corrupt data → original buffer', () => {
    expect(decompressBody(raw, '')).toBe(raw);
    expect(decompressBody(raw, 'zstd')).toBe(raw);
    expect(decompressBody(raw, 'gzip')).toBe(raw); // not actually gzip → passthrough
  });
});

// ---- injectSnippet / swSnippet ---------------------------------------------------
describe('injectSnippet', () => {
  test('injects before </body> (case-insensitive)', () => {
    expect(injectSnippet('<body>x</body>', '<i/>')).toBe('<body>x<i/></body>');
    // case-insensitive match; replacement normalizes the closing tag (PoC behavior)
    expect(injectSnippet('<BODY>x</BODY>', '<i/>')).toBe('<BODY>x<i/></body>');
  });
  test('appends when there is no body tag', () => {
    expect(injectSnippet('plain', '<i/>')).toBe('plain<i/>');
  });
  test('swSnippet registers the SW (unversioned) and embeds the target for inheritance', () => {
    const s = swSnippet('http://localhost:3024');
    expect(s).toContain("serviceWorker.register('/__poc-sw.js'");
    expect(s).toContain(JSON.stringify('http://localhost:3024')); // used by the pushState + child-iframe shims
    expect(s).not.toContain('poc_ws_target'); // no cookies anymore
  });
});

// ---- SW source sanity ------------------------------------------------------------
describe('SW_SOURCE', () => {
  test('skips host control routes but not app dunder paths', () => {
    // evaluate the SKIP predicate straight out of the SW source
    const m = /const SKIP = (\(p\) => [^\n]+);/.exec(SW_SOURCE);
    expect(m).toBeTruthy();
    const SKIP = eval(m[1]);
    for (const p of ['/__poc-sw.js', '/__whoami', '/__health', '/__card.js', '/__compare', '/__host/', '/__api/sessions', '/__ws', '/__mcp-x', '/__ticket/ENG-1', '/__ticket-img/a.png', '/__ticket-data/ENG-1']) {
      expect(SKIP(p)).toBe(true);
    }
    // proxied dev servers own their dunder paths (e.g. Vite's ping)
    expect(SKIP('/__vite_ping')).toBe(false);
    expect(SKIP('/app')).toBe(false);
  });
  test('stamps x-poc-target resolved from the frame url (stateless — no cache/cookies)', () => {
    expect(SW_SOURCE).toContain("h.set('x-poc-target', target)");
    expect(SW_SOURCE).toContain("__target");
    expect(SW_SOURCE).not.toContain('poc-clientmap'); // no persisted clientmap
    expect(SW_SOURCE).not.toContain('poc_ws_target'); // no cookies
  });
});

// ---- hasTarget -------------------------------------------------------------------
describe('hasTarget', () => {
  const p = createProxy({ vercelBypass: '', devServerPorts: [] });
  test('true when the SW stamped a target header', () => {
    expect(p.hasTarget({ url: '/', headers: { 'x-poc-target': 'http://localhost:3024' } })).toBe(true);
  });
  test('true mid-handshake (?__target= pin in the URL)', () => {
    expect(p.hasTarget({ url: '/?__target=http%3A%2F%2Flocalhost%3A3024', headers: {} })).toBe(true);
  });
  test('false for a fresh visitor', () => {
    expect(p.hasTarget({ url: '/', headers: {} })).toBe(false);
    expect(p.hasTarget({ url: '/anything?x=1', headers: {} })).toBe(false);
  });
});

// ---- pages: markdown / diff / misc helpers ----------------------------------------
describe('mdToHtml', () => {
  test('headings, lists, inline marks', () => {
    const h = mdToHtml('# Title\n\n- one\n- two\n\n**bold** and `code` and *em*');
    expect(h).toContain('<h3>Title</h3>');
    expect(h).toContain('<ul>');
    expect(h).toContain('<li>one</li>');
    expect(h).toContain('<strong>bold</strong>');
    expect(h).toContain('<code>code</code>');
    expect(h).toContain('<em>em</em>');
  });
  test('links, images, bare URLs', () => {
    const h = mdToHtml('![shot](/__ticket-img/a.png)\n[doc](https://x.io/d)\nsee https://y.io/z');
    expect(h).toContain('<img alt="shot" src="/__ticket-img/a.png"');
    expect(h).toContain('<a href="https://x.io/d" target="_blank" rel="noopener">doc</a>');
    expect(h).toContain('<a href="https://y.io/z" target="_blank" rel="noopener">https://y.io/z</a>');
  });
  test('Linear <user> mentions become @Name, HTML is escaped', () => {
    const h = mdToHtml('hi <user id="u1">Alice</user> <script>alert(1)</script>');
    expect(h).toContain('@Alice');
    expect(h).not.toContain('<script>');
    expect(h).toContain('&lt;script&gt;');
  });
});

describe('diffHtml', () => {
  test('colors adds/dels/hunks, leaves headers plain', () => {
    const h = diffHtml('@@ -1,2 +1,2 @@\n--- a/x\n+++ b/x\n-old\n+new\n ctx');
    expect(h).toContain('<span class="hunk">@@ -1,2 +1,2 @@</span>');
    expect(h).toContain('<span class="del">-old</span>');
    expect(h).toContain('<span class="add">+new</span>');
    expect(h).toContain('<span class="">--- a/x</span>'); // file headers not colored
    expect(h).toContain('<span class="">+++ b/x</span>');
  });
  test('empty → placeholder; long → truncated', () => {
    expect(diffHtml('')).toContain('No diff');
    const long = Array.from({ length: 700 }, (_, i) => '+l' + i).join('\n');
    expect(diffHtml(long)).toContain('diff truncated');
  });
});

describe('esc / PR url helpers', () => {
  test('esc escapes html-significant chars', () => {
    expect(esc('<a href="x">&</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
    expect(esc(null)).toBe('');
  });
  test('isPrUrl / parsePrUrl', () => {
    expect(isPrUrl('https://github.com/acme/app/pull/2841')).toBe(true);
    expect(isPrUrl('https://github.com/acme/app/issues/3')).toBe(false);
    expect(parsePrUrl('https://github.com/acme/app/pull/2841/files')).toEqual({ owner: 'acme', repo: 'app', num: '2841' });
    expect(parsePrUrl('nope')).toBe(null);
  });
});

describe('comparePage', () => {
  test('two explicit proxied panes', () => {
    const html = comparePage('http://localhost:3024/policies', 'https://app.example.com/policies');
    expect(html).toContain('/?__target=' + encodeURIComponent('http://localhost:3024/policies'));
    expect(html).toContain('/?__target=' + encodeURIComponent('https://app.example.com/policies'));
  });
  test('b defaults to prodUrl + a path+search', () => {
    const saved = cfg.prodUrl;
    cfg.prodUrl = 'https://app.example.com';
    try {
      const html = comparePage('http://localhost:3024/policies?tab=2', '');
      const want = new URL('/policies?tab=2', cfg.prodUrl).href;
      expect(html).toContain('/?__target=' + encodeURIComponent(want));
    } finally {
      cfg.prodUrl = saved;
    }
  });
  test('b empty with no prodUrl configured → null (generic default)', () => {
    const saved = cfg.prodUrl;
    cfg.prodUrl = '';
    try {
      expect(comparePage('http://localhost:3024/policies?tab=2', '')).toBe(null);
    } finally {
      cfg.prodUrl = saved;
    }
  });
  test('bad a → null (caller answers 400)', () => {
    expect(comparePage('not a url', '')).toBe(null);
    expect(comparePage('', '')).toBe(null);
  });
});

describe('ticketShell', () => {
  test('mounts the card with the id and optional tab', () => {
    const h = ticketShell('ENG-17099', 'github');
    expect(h).toContain('data-ticket="ENG-17099"');
    expect(h).toContain('data-tab="github"');
    expect(h).toContain('src="/__card.js"');
    expect(ticketShell('ENG-1', 'bogus')).not.toContain('data-tab');
  });
});

// ---- live: ephemeral upstream + host (never touches 3099) -------------------------
describe('live proxy', () => {
  let upstream, host, proxy;
  let upstreamOrigin, hostOriginUrl, upstreamPort;

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      if (req.url === '/redir') {
        res.writeHead(302, { location: upstreamOrigin + '/after?x=1' });
        res.end();
        return;
      }
      if (req.url === '/cross') {
        res.writeHead(302, { location: 'https://accounts.google.com/auth' });
        res.end();
        return;
      }
      if (req.url.startsWith('/data')) {
        const body = zlib.gzipSync(Buffer.from(JSON.stringify({ ok: true })));
        res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': body.length });
        res.end(body);
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'set-cookie': 'sid=1; Domain=.example.com; Secure; SameSite=None',
        'x-saw-host': req.headers.host,
      });
      res.end('<html><body>upstream page</body></html>');
    });
    await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
    upstreamPort = upstream.address().port;
    upstreamOrigin = `http://127.0.0.1:${upstreamPort}`;

    proxy = createProxy({ vercelBypass: '', devServerPorts: [upstreamPort, upstreamPort + 17] });
    host = http.createServer((req, res) => proxy.handle(req, res));
    host.on('upgrade', (req, socket, head) => proxy.handleUpgrade(req, socket, head));
    await new Promise((r) => host.listen(0, '127.0.0.1', r));
    hostOriginUrl = `http://127.0.0.1:${host.address().port}`;
  });

  afterAll(() => {
    upstream.close();
    host.close();
  });

  const get = (p, headers = {}, redirect = 'manual') => fetch(hostOriginUrl + p, { headers, redirect });

  test('serves the Service Worker at root scope', async () => {
    const r = await get('/__poc-sw.js');
    expect(r.status).toBe(200);
    expect(r.headers.get('service-worker-allowed')).toBe('/');
    expect(await r.text()).toContain('x-poc-target');
  });

  test('/__whoami reports the stamped target', async () => {
    const r = await get('/__whoami', { 'x-poc-target': upstreamOrigin });
    expect(await r.json()).toMatchObject({ target: upstreamOrigin, ticket: null });
  });

  test('?__target= html nav without SW stamp serves the bootstrap (installs SW, then reloads)', async () => {
    const r = await get('/?__target=' + encodeURIComponent(upstreamOrigin), { accept: 'text/html' });
    expect(await r.text()).toBe(BOOTSTRAP_HTML);
  });

  test('?__target= request WITH x-poc-target (SW-relayed) proxies directly + injects the shim', async () => {
    const r = await get('/?__target=' + encodeURIComponent(upstreamOrigin), { accept: 'text/html', 'x-poc-target': upstreamOrigin });
    const html = await r.text();
    expect(html).toContain('upstream page');
    expect(html).toContain("serviceWorker.register('/__poc-sw.js'");
  });

  test('no target → 400 (index.js owns the fresh-visitor redirect)', async () => {
    const r = await get('/anything');
    expect(r.status).toBe(400);
  });

  test('proxies HTML: host header set, cookie rewritten, SW snippet injected, no-store', async () => {
    const r = await get('/', { 'x-poc-target': upstreamOrigin });
    expect(r.status).toBe(200);
    expect(r.headers.get('x-saw-host')).toBe(`127.0.0.1:${upstreamPort}`);
    expect(r.headers.get('set-cookie')).toBe('sid=1; SameSite=Lax');
    expect(r.headers.get('cache-control')).toBe('no-store');
    const body = await r.text();
    expect(body).toContain('upstream page');
    expect(body).toContain("serviceWorker.register('/__poc-sw.js'"); // SW shim injected
    expect(r.headers.get('referrer-policy')).toBe('no-referrer-when-downgrade'); // server Referer fallback
    expect(body).toContain('</body>');
  });

  test('rewrites same-origin Location to path-only, leaves cross-origin alone', async () => {
    const r1 = await get('/redir', { 'x-poc-target': upstreamOrigin });
    expect(r1.status).toBe(302);
    expect(r1.headers.get('location')).toBe('/after?x=1');
    const r2 = await get('/cross', { 'x-poc-target': upstreamOrigin });
    expect(r2.headers.get('location')).toBe('https://accounts.google.com/auth');
  });

  test('non-HTML bodies stream through with gzip intact', async () => {
    const r = await get('/data', { 'x-poc-target': upstreamOrigin });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true }); // fetch decodes the passthrough gzip
  });

  test('status() reports pinned targets + listening dev servers', async () => {
    const s = await proxy.status();
    expect(s.targets.map((t) => t.target)).toContain(upstreamOrigin);
    expect(s.devServers).toEqual([upstreamPort]); // the dead port is filtered out
  });
});
