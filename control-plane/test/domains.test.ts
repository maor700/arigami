import { describe, test, expect } from 'bun:test';
import { domainAllowed } from '../src/domains.js';

describe('domain allow-list', () => {
  const allow = ['example.com', 'sub.example.org'];

  test('allows an email on an allowed domain', () => {
    expect(domainAllowed('alice@example.com', allow)).toBe(true);
  });

  test('is case-insensitive on both the email and the configured domain', () => {
    expect(domainAllowed('Alice@Example.COM', allow)).toBe(true);
    expect(domainAllowed('alice@example.com', ['EXAMPLE.com'])).toBe(true);
  });

  test('rejects an email on a domain not in the list', () => {
    expect(domainAllowed('mallory@evil.com', allow)).toBe(false);
  });

  test('does not match on a suffix — a lookalike subdomain is not the real one', () => {
    expect(domainAllowed('eve@notexample.com', allow)).toBe(false);
    expect(domainAllowed('eve@example.com.evil.net', allow)).toBe(false);
  });

  test('a listed subdomain does not implicitly allow its parent domain', () => {
    expect(domainAllowed('bob@example.org', allow)).toBe(false); // only sub.example.org is listed
  });

  test('rejects malformed input', () => {
    expect(domainAllowed('', allow)).toBe(false);
    expect(domainAllowed('not-an-email', allow)).toBe(false);
    expect(domainAllowed('trailing@', allow)).toBe(false);
  });

  test('an empty allow-list allows nobody, even a plausible-looking email', () => {
    expect(domainAllowed('alice@example.com', [])).toBe(false);
  });

  test('tolerates a leading "@" or stray whitespace in configured domains', () => {
    expect(domainAllowed('alice@example.com', [' @example.com '])).toBe(true);
  });
});

describe('open signup ("*")', () => {
  test('a bare "*" allows any domain', () => {
    expect(domainAllowed('anyone@wherever.example', ['*'])).toBe(true);
    expect(domainAllowed('someone@consumer-idp.example', ['*'])).toBe(true);
  });

  test('"*" alongside real domains still allows everything (not domain-limited)', () => {
    expect(domainAllowed('anyone@wherever.example', ['example.com', '*'])).toBe(true);
  });

  test('still rejects malformed input even in open mode — "*" allows any DOMAIN, not a missing one', () => {
    expect(domainAllowed('', ['*'])).toBe(false);
    expect(domainAllowed('not-an-email', ['*'])).toBe(false);
  });

  test('without "*", a real domain list is still exclusive as before', () => {
    expect(domainAllowed('mallory@evil.com', ['example.com'])).toBe(false);
  });
});
