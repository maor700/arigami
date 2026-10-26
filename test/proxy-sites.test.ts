// proxy.sites (an extension's sibling origins for a proxied site): the matcher, the query rewrite, the worker the host
// serves (it must parse — a broken worker silently keeps the old one), and the manifest rule.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { originMatches, rewriteHostInQuery, SW_SOURCE } from '../server/proxy.ts';
import { tmpDir } from './_tmp.js';

test('origin patterns: exact, or any subdomain of a "*." one — never a look-alike', () => {
  expect(originMatches('https://api.example.com', 'https://api.example.com')).toBe(true);
  expect(originMatches('https://*.example.com', 'https://api.example.com')).toBe(true);
  expect(originMatches('https://*.example.com', 'https://a.b.example.com')).toBe(true);
  expect(originMatches('https://*.example.com', 'https://example.com.evil.io')).toBe(false);
  expect(originMatches('https://*.example.com', 'https://evilexample.com')).toBe(false);
  expect(originMatches('https://*.example.com', 'http://api.example.com')).toBe(false);
});

test("rewriteQuery: the host's own origin in a query becomes the site's — raw and percent-encoded, behind a TLS proxy too", () => {
  const req = { headers: { host: '127.0.0.1:3099', 'x-forwarded-host': 'box.tailnet.ts.net' } } as any;
  const url = '/login/?redirect_uri=' + encodeURIComponent('https://box.tailnet.ts.net/dashboard?x=1') + '&back=http://127.0.0.1:3099/a';
  const out = rewriteHostInQuery(url, req, 'https://app.example.com');
  expect(decodeURIComponent(out)).toContain('redirect_uri=https://app.example.com/dashboard?x=1');
  expect(out).toContain('back=https://app.example.com/a');
  expect(out.startsWith('/login/?')).toBe(true);
});

test('the worker the host serves parses, with the routes in front', () => {
  const dir = tmpDir('arigami-sw-');
  const file = path.join(dir, 'sw.js');
  fs.writeFileSync(file, `const ROUTES = ${JSON.stringify([{ target: 'https://app.example.com', origins: ['https://*.example.com'] }])};\n` + SW_SOURCE);
  execFileSync('node', ['--check', file]);
  // the matcher inside the worker agrees with the server's
  const harness = 'var self = { addEventListener() {}, location: { origin: "http://h" } };\n' + fs.readFileSync(file, 'utf8') +
    ';console.log(JSON.stringify([DECLARED("https://api.example.com"),DECLARED("https://example.com.evil.io"),SIBLING("https://app.example.com","https://api.example.com"),SIBLING("https://other.io","https://api.example.com")]))';
  const run = execFileSync('node', ['-e', harness]).toString();
  expect(JSON.parse(run)).toEqual([true, false, true, false]);
});

test('an extension declares proxy.sites only with the "proxy:sites" permission, and only well-formed origins', async () => {
  const ext = await import('../server/extensions.ts');
  expect(ext.parseProxySite({ target: 'https://app.example.com/', origins: ['https://*.example.com'], rewriteQuery: true })).toEqual({ target: 'https://app.example.com', origins: ['https://*.example.com'], rewriteQuery: true });
  expect(ext.parseProxySite({ target: 'https://*.example.com', origins: [] })).toBeNull();
  expect(ext.parseProxySite({ target: 'https://app.example.com', origins: ['javascript:alert(1)'] })).toBeNull();
  const dir = tmpDir('arigami-ext-proxy-');
  const mk = (perms: string[]) => {
    const d = path.join(dir, 'demo');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'manifest.json'), JSON.stringify({ name: 'demo', version: '1', apiVersion: 1, permissions: perms, proxy: { sites: [{ target: 'https://app.example.com', origins: ['https://*.example.com'] }] } }));
    return d;
  };
  expect((await ext.validateExtension(mk([]))).errors.join(' ')).toMatch(/proxy:sites/);
  expect((await ext.validateExtension(mk(['proxy:sites']))).errors).toEqual([]);
});

test("the tunnel's X-Forwarded-Host reaches only a dev server on this box — a real site rejects a host it doesn't own", async () => {
  const { keepsForwardedHost } = await import('../server/proxy.ts');
  for (const h of ['127.0.0.1', 'localhost', '[::1]']) expect(keepsForwardedHost(h)).toBe(true);
  for (const h of ['www.example.com', 'app.example.io', '127.0.0.1.example.com', '10.0.0.5']) expect(keepsForwardedHost(h)).toBe(false);
});
