// The target proxy gzips uncompressed text bodies (Vite dev serves none), so a
// remote browser is not stuck downloading raw JS on every cold load.
import { test, expect, describe } from 'bun:test';
import { shouldGzip } from '../server/proxy.ts';

const js = { 'content-type': 'text/javascript' };

describe('shouldGzip', () => {
  test('text bodies the client accepts gzip for', () => {
    expect(shouldGzip('GET', 200, 'gzip, deflate, br', js)).toBe(true);
    expect(shouldGzip('GET', 200, 'gzip', { 'content-type': 'application/javascript; charset=utf-8' })).toBe(true);
    expect(shouldGzip('GET', 200, 'gzip', { 'content-type': 'text/css' })).toBe(true);
    expect(shouldGzip('GET', 200, 'gzip', { 'content-type': 'image/svg+xml' })).toBe(true);
    expect(shouldGzip('GET', 200, 'gzip', { 'content-type': 'application/json' })).toBe(true);
  });
  test('leaves everything else alone', () => {
    expect(shouldGzip('GET', 200, 'br', js)).toBe(false);
    expect(shouldGzip('GET', 200, undefined, js)).toBe(false);
    expect(shouldGzip('HEAD', 200, 'gzip', js)).toBe(false);
    expect(shouldGzip('GET', 304, 'gzip', js)).toBe(false);
    expect(shouldGzip('GET', 204, 'gzip', js)).toBe(false);
    expect(shouldGzip('GET', 200, 'gzip', { ...js, 'content-encoding': 'br' })).toBe(false);
    expect(shouldGzip('GET', 200, 'gzip', { 'content-type': 'font/woff2' })).toBe(false);
    expect(shouldGzip('GET', 200, 'gzip', { 'content-type': 'image/png' })).toBe(false);
    expect(shouldGzip('GET', 200, 'gzip', { ...js, 'content-length': '200' })).toBe(false);
  });
});
