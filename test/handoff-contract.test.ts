// The one place the two independent handoff implementations meet.
//
// `control-plane/src/handoff.ts` mints; `server/handoff.ts` verifies. They are
// separate on purpose (the control-plane imports nothing from `server/` so the
// two services deploy and roll independently), which means the wire format is
// an untyped contract between two codebases — exactly the kind that drifts
// silently and only shows up as "I cannot sign in" in production. This test
// imports both and pins the contract in both directions.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as host from '../server/handoff.ts';
import * as cp from '../control-plane/src/handoff.ts';

const SECRET = cp.newSecret();

test('the control-plane generates a secret the host considers strong enough', () => {
  expect(cp.newSecret().length).toBeGreaterThanOrEqual(16);
  expect(host.enabled({ ARIGAMI_HANDOFF_SECRET: cp.newSecret() } as NodeJS.ProcessEnv)).toBe(true);
});

test('a control-plane token verifies on the host, with the email intact', () => {
  const r = host.verify(cp.mint(SECRET, 'Alice@Fake-Org.test'), { secret: SECRET });
  expect(r.ok).toBe(true);
  expect((r as any).payload.email).toBe('alice@fake-org.test');
});

test('the host mints tokens the same way (format is symmetric)', () => {
  const fromHost = host.mint(SECRET, 'a@b.c');
  expect(host.verify(fromHost, { secret: SECRET }).ok).toBe(true);
  // both produce "<payload>.<sig>" with a base64url JSON payload
  for (const tok of [fromHost, cp.mint(SECRET, 'a@b.c')]) {
    const [p, sig] = tok.split('.');
    expect(sig).toBeTruthy();
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    expect(payload.kind).toBe('handoff');
    expect(typeof payload.exp).toBe('number');
    expect(typeof payload.jti).toBe('string');
  }
});

test("the control-plane's default TTL is inside the host's hard ceiling", () => {
  const tok = cp.mint(SECRET, 'a@b.c');
  const payload = JSON.parse(Buffer.from(tok.split('.')[0], 'base64url').toString('utf8'));
  expect(payload.exp - Date.now()).toBeLessThanOrEqual(host.MAX_TTL_MS);
  expect(cp.DEFAULT_TTL_MS).toBeLessThanOrEqual(host.MAX_TTL_MS);
});

test('signInUrl points at the host route that redeems it, and never leaks the secret', () => {
  const url = new URL(cp.signInUrl('http://u-abc.example.test', SECRET, 'a@b.c'));
  expect(url.pathname).toBe('/__api/auth/handoff');
  const tok = url.searchParams.get('t')!;
  expect(host.verify(tok, { secret: SECRET }).ok).toBe(true);
  expect(url.href).not.toContain(SECRET);
});

test('no secret ⇒ signInUrl degrades to the plain tenant URL (pre-K8S-3 tenants keep working)', () => {
  expect(cp.signInUrl('http://u-abc.example.test', '', 'a@b.c')).toBe('http://u-abc.example.test');
});

test("a token minted for one tenant's secret is worthless against another's", () => {
  const other = cp.newSecret();
  expect(host.verify(cp.mint(SECRET, 'a@b.c'), { secret: other }).ok).toBe(false);
});

// ---- profile rollout operator calls --------------------------------------------

test('a control-plane operator token verifies on the host, claims intact', () => {
  const commit = 'a'.repeat(40);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'op-contract-'));
  const r = host.verifyOperator(cp.mintOperator(SECRET, { action: 'profile-apply', ref: 'v2', commit }), 'profile-apply', { secret: SECRET, dir });
  expect(r.ok).toBe(true);
  expect((r as any).payload).toMatchObject({ kind: 'operator', action: 'profile-apply', ref: 'v2', commit });
  expect(host.verifyOperator(cp.mintOperator(SECRET, { action: 'profile-status' }), 'profile-status', { secret: SECRET }).ok).toBe(true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('operator and sign-in tokens are not interchangeable, and the action is bound', () => {
  expect(host.verify(cp.mintOperator(SECRET, { action: 'profile-status' }), { secret: SECRET }).ok).toBe(false);
  expect(host.verifyOperator(cp.mint(SECRET, 'a@b.c'), 'profile-status', { secret: SECRET }).ok).toBe(false);
  expect(host.verifyOperator(cp.mintOperator(SECRET, { action: 'profile-status' }), 'profile-apply', { secret: SECRET }).ok).toBe(false);
  expect(host.verifyOperator(cp.mintOperator(cp.newSecret(), { action: 'profile-status' }), 'profile-status', { secret: SECRET }).ok).toBe(false);
});
