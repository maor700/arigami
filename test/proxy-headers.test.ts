// C2 — server/lib/proxy-headers.ts: X-Forwarded-* are believed only when
// trustProxy is on AND the TCP peer is loopback; cookies get `Secure` behind
// Caddy / tailscale serve; browserOrigin follows the same rule; config
// derives trustProxy from the bind address.
import { test, expect, describe } from 'bun:test';
import { isLoopbackAddress, proxyTrusted, requestProto, requestHost, requestIsSecure, requestOrigin } from '../server/lib/proxy-headers.ts';
import { resolveTrustProxy } from '../server/lib/config.ts';
import { createAuth, COOKIE } from '../server/auth.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const req = (headers: Record<string, string | string[]>, remoteAddress?: string) => ({ headers, socket: { remoteAddress } });
const ON = { trustProxy: true };
const OFF = { trustProxy: false };

describe('isLoopbackAddress', () => {
  test('v4, v6, mapped', () => {
    for (const a of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1', 'localhost']) expect(isLoopbackAddress(a)).toBe(true);
    for (const a of ['10.0.0.1', '::ffff:10.0.0.1', '172.18.0.2', '', undefined, '1270.0.0.1']) expect(isLoopbackAddress(a)).toBe(false);
  });
});

describe('proxyTrusted', () => {
  test('needs both trustProxy and a loopback peer', () => {
    expect(proxyTrusted(req({}, '127.0.0.1'), ON)).toBe(true);
    expect(proxyTrusted(req({}, '::ffff:127.0.0.1'), ON)).toBe(true);
    expect(proxyTrusted(req({}, '10.0.0.7'), ON)).toBe(false);
    expect(proxyTrusted(req({}, '127.0.0.1'), OFF)).toBe(false);
    expect(proxyTrusted(req({}), ON)).toBe(false);
  });
});

describe('requestProto / requestHost', () => {
  test('forwarded proto from loopback + trust', () => {
    expect(requestProto(req({ 'x-forwarded-proto': 'https' }, '127.0.0.1'), ON)).toBe('https');
    expect(requestProto(req({ 'x-forwarded-proto': 'HTTPS, http' }, '127.0.0.1'), ON)).toBe('https');
    expect(requestProto(req({ 'x-forwarded-proto': 'http' }, '127.0.0.1'), ON)).toBe('http');
    expect(requestProto(req({}, '127.0.0.1'), ON)).toBe('http');
  });
  test('forged header from a remote peer or with trust off is ignored', () => {
    expect(requestProto(req({ 'x-forwarded-proto': 'https' }, '10.0.0.7'), ON)).toBe('http');
    expect(requestProto(req({ 'x-forwarded-proto': 'https' }, '127.0.0.1'), OFF)).toBe('http');
    expect(requestProto(req({ 'x-forwarded-proto': 'ftp' }, '127.0.0.1'), ON)).toBe('http');
  });
  test('host: forwarded when trusted, else Host, else fallback', () => {
    expect(requestHost(req({ host: '127.0.0.1:3099', 'x-forwarded-host': 'a.example' }, '127.0.0.1'), ON)).toBe('a.example');
    expect(requestHost(req({ host: '127.0.0.1:3099', 'x-forwarded-host': 'a.example' }, '10.0.0.7'), ON)).toBe('127.0.0.1:3099');
    expect(requestHost(req({}, '127.0.0.1'), ON, 'localhost:1')).toBe('localhost:1');
  });
});

describe('requestIsSecure', () => {
  test('https publicUrl always secure, even with no request', () => {
    expect(requestIsSecure(undefined, { trustProxy: false, publicUrl: 'https://x.example' })).toBe(true);
    expect(requestIsSecure(req({}, '10.0.0.7'), { trustProxy: false, publicUrl: 'https://x.example' })).toBe(true);
  });
  test('http publicUrl / none → only a trusted forwarded https', () => {
    expect(requestIsSecure(undefined, { trustProxy: true, publicUrl: 'http://x.example' })).toBe(false);
    expect(requestIsSecure(req({ 'x-forwarded-proto': 'https' }, '127.0.0.1'), ON)).toBe(true);
    expect(requestIsSecure(req({ 'x-forwarded-proto': 'https' }, '10.0.0.7'), ON)).toBe(false);
    expect(requestIsSecure(req({ 'x-forwarded-proto': 'https' }, '127.0.0.1'), OFF)).toBe(false);
    expect(requestIsSecure(req({}, '127.0.0.1'), ON)).toBe(false);
  });
});

describe('requestOrigin (api.ts browserOrigin)', () => {
  test('publicUrl wins over everything', () => {
    expect(requestOrigin(req({ host: 'b', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'a' }, '127.0.0.1'), { trustProxy: true, publicUrl: 'https://p.example' }, 'f')).toBe('https://p.example');
  });
  test('trusted forwarded headers → proto://forwarded-host (port kept)', () => {
    expect(requestOrigin(req({ host: '127.0.0.1:3099', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'a.example' }, '127.0.0.1'), ON, 'f')).toBe('https://a.example');
    expect(requestOrigin(req({ host: '127.0.0.1:3099', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'lan-box:8443' }, '::1'), ON, 'f')).toBe('https://lan-box:8443');
    // proto but no forwarded host → Host header
    expect(requestOrigin(req({ host: '127.0.0.1:3099', 'x-forwarded-proto': 'https' }, '127.0.0.1'), ON, 'f')).toBe('https://127.0.0.1:3099');
  });
  test('pre-C2 rule when untrusted: loopback Host → http, other → https no port', () => {
    expect(requestOrigin(req({ host: 'localhost:3099' }, '127.0.0.1'), ON, 'f')).toBe('http://localhost:3099');
    expect(requestOrigin(req({ host: '[::1]:3099' }, '127.0.0.1'), ON, 'f')).toBe('http://[::1]:3099');
    expect(requestOrigin(req({ host: 'box.ts.net:3099' }, '10.0.0.7'), ON, 'f')).toBe('https://box.ts.net');
    expect(requestOrigin(req({ host: 'box.ts.net', 'x-forwarded-proto': 'http' }, '10.0.0.7'), ON, 'f')).toBe('https://box.ts.net');
    expect(requestOrigin(req({}, '127.0.0.1'), OFF, 'localhost:3099')).toBe('http://localhost:3099');
  });
});

describe('config.resolveTrustProxy', () => {
  test('defaults: loopback bind → true, other → false; explicit wins', () => {
    expect(resolveTrustProxy({ bind: '127.0.0.1' })).toBe(true);
    expect(resolveTrustProxy({ bind: '::1' })).toBe(true);
    expect(resolveTrustProxy({ bind: '0.0.0.0' })).toBe(false);
    expect(resolveTrustProxy({ bind: '0.0.0.0', trustProxy: true })).toBe(true);
    expect(resolveTrustProxy({ bind: '127.0.0.1', trustProxy: false })).toBe(false);
  });
});

describe('auth cookies behind a proxy', () => {
  const mk = (over: Record<string, unknown> = {}) =>
    createAuth({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-c2-')), auth: { mode: 'pairing', cookieDays: 30 }, log: () => {}, ...over } as any);
  test('Secure only for a trusted forwarded https (or https publicUrl)', () => {
    const a = mk({ trustProxy: true });
    expect(a.cookieHeader('t', 10)).not.toContain('Secure');
    expect(a.cookieHeader('t', 10, req({ 'x-forwarded-proto': 'https' }, '127.0.0.1') as any)).toContain('; Secure');
    expect(a.cookieHeader('t', 10, req({ 'x-forwarded-proto': 'https' }, '10.0.0.7') as any)).not.toContain('Secure');
    const b = mk({ trustProxy: false });
    expect(b.cookieHeader('t', 10, req({ 'x-forwarded-proto': 'https' }, '127.0.0.1') as any)).not.toContain('Secure');
    const c = mk({ publicUrl: 'https://p.example' });
    expect(c.cookieHeader('t', 10)).toContain('; Secure');
    expect(c.cookieHeader('t', 10)).toStartWith(`${COOKIE}=t; Path=/; HttpOnly; SameSite=Lax; Max-Age=10`);
  });
  test('setCookie / clearCookie thread the request through', () => {
    const a = mk({ trustProxy: true });
    const r = req({ 'x-forwarded-proto': 'https' }, '::ffff:127.0.0.1') as any;
    const headers: Record<string, string> = {};
    const res = { setHeader: (k: string, v: string) => { headers[k] = v; } } as any;
    const u = a.createUser('x@example.com', 'admin');
    a.setCookie(res, a.createWebSession(u.id, 'ua'), r);
    expect(headers['set-cookie']).toContain('; Secure');
    a.clearCookie(res, r);
    expect(headers['set-cookie']).toMatch(/Max-Age=0.*Secure/);
    a.clearCookie(res);
    expect(headers['set-cookie']).not.toContain('Secure');
  });
});
