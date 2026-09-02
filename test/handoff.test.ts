// K8S-3 orchestrator handoff (server/handoff.ts): the token that replaces the
// pairing code for a tenant whose user the control-plane already authenticated.
// Everything an attacker would try is a test here — off by default, tamper,
// wrong secret, expiry, over-long life, replay — because this route admits a
// user with no other credential.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import * as ho from '../server/handoff.ts';

const SECRET = 'a-test-secret-at-least-16-chars';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-handoff-'));

test('disabled unless a long-enough secret is configured', () => {
  expect(ho.enabled({} as NodeJS.ProcessEnv)).toBe(false);
  expect(ho.enabled({ ARIGAMI_HANDOFF_SECRET: 'short' } as NodeJS.ProcessEnv)).toBe(false);
  expect(ho.enabled({ ARIGAMI_HANDOFF_SECRET: SECRET } as NodeJS.ProcessEnv)).toBe(true);
  // With no secret nothing is a valid token — a standalone host is untouched.
  const r = ho.verify(ho.mint(SECRET, 'a@b.c'), { secret: '' });
  expect(r.ok).toBe(false);
  expect((r as any).status).toBe(404);
});

test('a freshly minted token verifies and carries the email', () => {
  const r = ho.verify(ho.mint(SECRET, 'Alice@Example.com'), { secret: SECRET });
  expect(r.ok).toBe(true);
  expect((r as any).payload.email).toBe('alice@example.com'); // normalised
  expect((r as any).payload.kind).toBe('handoff');
});

test('a token signed with a different secret is rejected', () => {
  const r = ho.verify(ho.mint('another-secret-at-least-16', 'a@b.c'), { secret: SECRET });
  expect(r.ok).toBe(false);
  expect((r as any).status).toBe(403);
});

test('tampering with the payload invalidates the signature', () => {
  const tok = ho.mint(SECRET, 'victim@example.com');
  const [p, sig] = tok.split('.');
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  payload.email = 'attacker@example.com';
  const forged = Buffer.from(JSON.stringify(payload)).toString('base64url') + '.' + sig;
  const r = ho.verify(forged, { secret: SECRET });
  expect(r.ok).toBe(false);
  expect((r as any).status).toBe(403);
});

test('malformed tokens are refused, not crashed on', () => {
  for (const bad of ['', 'nodot', 'a.b.c', '.', 'x.']) {
    const r = ho.verify(bad, { secret: SECRET });
    expect(r.ok).toBe(false);
  }
  // valid signature over a non-JSON payload
  const p = Buffer.from('not json').toString('base64url');
  const sig = Buffer.from(crypto.createHmac('sha256', SECRET).update(p).digest()).toString('base64url');
  expect(ho.verify(`${p}.${sig}`, { secret: SECRET }).ok).toBe(false);
});

test('an expired token is refused', () => {
  const tok = ho.mint(SECRET, 'a@b.c', 60_000);
  expect(ho.verify(tok, { secret: SECRET }).ok).toBe(true);
  const r = ho.verify(tok, { secret: SECRET, now: Date.now() + 61_000 });
  expect(r.ok).toBe(false);
  expect((r as any).error).toMatch(/expired/);
});

test('the VERIFIER caps the token life — a minter cannot issue a long-lived key', () => {
  // Hand-roll a token claiming a 24h life, correctly signed.
  const payload = { kind: 'handoff', email: 'a@b.c', exp: Date.now() + 24 * 3600_000, jti: 'x1' };
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = Buffer.from(crypto.createHmac('sha256', SECRET).update(p).digest()).toString('base64url');
  const r = ho.verify(`${p}.${sig}`, { secret: SECRET });
  expect(r.ok).toBe(false);
  expect((r as any).error).toMatch(/exceeds the allowed maximum/);
  // mint() itself also clamps, so the two agree.
  const clamped = ho.verify(ho.mint(SECRET, 'a@b.c', 24 * 3600_000), { secret: SECRET });
  expect(clamped.ok).toBe(true);
});

test('consume() is single-use and survives a restart (state is on disk)', () => {
  const dir = tmp();
  const tok = ho.mint(SECRET, 'a@b.c');
  expect(ho.consume(tok, { secret: SECRET, dir }).ok).toBe(true);
  const again = ho.consume(tok, { secret: SECRET, dir });
  expect(again.ok).toBe(false);
  expect((again as any).error).toMatch(/already used/);
  // "restart": nothing in memory, the file is the only record
  expect(fs.existsSync(path.join(dir, ho.USED_FILE))).toBe(true);
  const afterRestart = ho.consume(tok, { secret: SECRET, dir });
  expect(afterRestart.ok).toBe(false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('spent-token bookkeeping is pruned once entries expire', () => {
  const dir = tmp();
  ho.consume(ho.mint(SECRET, 'a@b.c', 60_000), { secret: SECRET, dir });
  expect(JSON.parse(fs.readFileSync(path.join(dir, ho.USED_FILE), 'utf8')).used.length).toBe(1);
  // a later sign-in, past the first token's expiry, drops the dead entry
  ho.consume(ho.mint(SECRET, 'b@b.c'), { secret: SECRET, dir, now: Date.now() + 120_000 });
  const used = JSON.parse(fs.readFileSync(path.join(dir, ho.USED_FILE), 'utf8')).used;
  expect(used.length).toBe(1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('two different tokens for the same user both work (each is its own jti)', () => {
  const dir = tmp();
  expect(ho.consume(ho.mint(SECRET, 'a@b.c'), { secret: SECRET, dir }).ok).toBe(true);
  expect(ho.consume(ho.mint(SECRET, 'a@b.c'), { secret: SECRET, dir }).ok).toBe(true);
  fs.rmSync(dir, { recursive: true, force: true });
});
