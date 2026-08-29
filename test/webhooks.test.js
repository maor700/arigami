// C3 — server/webhooks.ts: one verifier per kind (valid / invalid / replay /
// tamper), the sms share-token (rotate/revoke, header + query forms), body cap,
// rate-limit headers, bare 401s, events, and the legacy /__api/sms/inbound
// alias (still 200, Deprecation header, log warning). Runs in-process against
// a tmp dir with an injectable clock, sms sink and env-secret lookup; the
// auth gate's public allowlist for these paths is covered in auth.test.js.
import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { createWebhooks, safeEqual, parseSms, isInboundWebhookPath, INBOUND_RE } from '../server/webhooks.ts';
import { createShareTokens } from '../server/share-token.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-wh-'));
const hmac = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('hex');

let t0 = 1_800_000_000_000;
const clock = { now: () => t0, tick: (ms) => { t0 += ms; } };
const env = { SLACK_SIGNING_SECRET: 'slack-secret-1' };
const smsSeen = [];
const logs = [];
const events = [];
let dir, wh, srv, base;

beforeAll(async () => {
  dir = tmp();
  wh = createWebhooks({
    dir,
    now: clock.now,
    log: (m) => logs.push(m),
    envSecret: (n) => env[n] || '',
    publicUrl: (p) => 'https://pub.example' + p,
    onSms: (from, body, ts) => { smsSeen.push({ from, body, ts }); return { id: 'sms' + smsSeen.length }; },
    onEvent: (e) => events.push(e),
    maxBodyBytes: 2048,
    ratePerMin: 50,
  });
  srv = http.createServer(async (req, res) => {
    if (await wh.handle(req, res)) return;
    if (await wh.handleLegacySms(req, res)) return;
    res.writeHead(404); res.end('nope');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + srv.address().port;
});
afterAll(() => srv.close());

const call = async (p, { method = 'POST', body = '', headers = {} } = {}) => {
  const r = await fetch(base + p, { method, body: method === 'GET' ? undefined : body, headers });
  let json = null;
  try { json = await r.json(); } catch {}
  return { status: r.status, json, h: (n) => r.headers.get(n) };
};

describe('helpers', () => {
  test('inbound path matcher: only the four inbound shapes', () => {
    for (const p of ['/__api/webhooks/sms', '/__api/webhooks/slack', '/__api/webhooks/github', '/__api/webhooks/custom/a.b-c_1'])
      expect([p, isInboundWebhookPath(p)]).toEqual([p, true]);
    for (const p of ['/__api/webhooks/', '/__api/webhooks/x', '/__api/webhooks/token', '/__api/webhooks/config', '/__api/webhooks/events', '/__api/webhooks/custom', '/__api/webhooks/custom/', '/__api/webhooks/custom/a/b', '/__api/webhooks/sms/x', '/__api/webhooks/custom/' + 'a'.repeat(65)])
      expect([p, isInboundWebhookPath(p)]).toEqual([p, false]);
    expect(INBOUND_RE.exec('/__api/webhooks/custom/zap')[2]).toBe('zap');
  });
  test('safeEqual', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
  });
  test('parseSms: query, json, form, aliases', () => {
    expect(parseSms(new URL('http://x/?from=%2B1&body=hi'), null, '')).toEqual({ from: '+1', body: 'hi', timestamp: undefined });
    expect(parseSms(new URL('http://x/'), Buffer.from('{"sender":"s","message":"m","timestamp":"2026-01-01"}'), 'application/json')).toEqual({ from: 's', body: 'm', timestamp: '2026-01-01' });
    expect(parseSms(new URL('http://x/'), Buffer.from('from=f&text=t'), 'application/x-www-form-urlencoded')).toEqual({ from: 'f', body: 't', timestamp: undefined });
    expect(parseSms(new URL('http://x/?from=only'), Buffer.from(''), '')).toBeNull();
  });
});

describe('sms (share-token kind webhook / id sms)', () => {
  test('no token yet → 401, bare body; rotate mints a year-long token; url uses publicUrl', async () => {
    expect(wh.smsToken()).toBeNull();
    const r = await call('/__api/webhooks/sms?from=%2B1&body=hello', { method: 'GET' });
    expect(r.status).toBe(401);
    expect(r.json).toEqual({ error: 'unauthorized' });
    const s = wh.rotateSmsToken();
    expect(s.exp).toBe(clock.now() + 365 * 86_400_000);
    expect(s.url).toBe('https://pub.example/__api/webhooks/sms?t=' + s.token);
    expect(s.live).toBe(true);
    expect(fs.statSync(wh.files.file).mode & 0o777).toBe(0o600);
    // the token is bound to kind webhook / id sms — an artifact verifier rejects it
    const st = createShareTokens({ dir, now: clock.now });
    expect(st.verify(s.token, { kind: 'artifact', id: 'sms' }).ok).toBe(false);
    expect(st.verify(s.token, { kind: 'webhook', id: 'sms' }).ok).toBe(true);
  });
  test('GET ?t= (Macrodroid), POST json with header, POST form → routed to the sms sink + event', async () => {
    const tok = wh.smsToken().token;
    const a = await call(`/__api/webhooks/sms?t=${tok}&from=%2B1&body=code%201234`, { method: 'GET' });
    expect(a.status).toBe(200);
    expect(a.json).toEqual({ ok: true, id: 'sms1' });
    expect(a.h('x-ratelimit-limit')).toBe('50');
    expect(Number(a.h('x-ratelimit-remaining'))).toBeGreaterThan(0);
    const b = await call('/__api/webhooks/sms', { body: JSON.stringify({ from: '+2', text: 'json' }), headers: { 'x-arigami-token': tok, 'content-type': 'application/json' } });
    expect(b.status).toBe(200);
    const c = await call('/__api/webhooks/sms', { body: 'sender=%2B3&message=form', headers: { 'x-arigami-token': tok, 'content-type': 'application/x-www-form-urlencoded' } });
    expect(c.status).toBe(200);
    expect(smsSeen.slice(-3)).toEqual([{ from: '+1', body: 'code 1234', ts: undefined }, { from: '+2', body: 'json', ts: undefined }, { from: '+3', body: 'form', ts: undefined }]);
    expect(events.filter((e) => e.kind === 'sms').length).toBe(3);
    expect(wh.events({ kind: 'sms' }).at(-1).payload).toEqual({ from: '+3', body: 'form' });
    // valid token but no message → 400 (authenticated caller gets detail)
    expect((await call(`/__api/webhooks/sms?t=${tok}`, { method: 'GET' })).status).toBe(400);
  });
  test('tampered / wrong-kind / expired / rotated / revoked tokens → 401', async () => {
    const tok = wh.smsToken().token;
    const flip = (s, i) => s.slice(0, i) + (s[i] === 'A' ? 'B' : 'A') + s.slice(i + 1);
    expect((await call(`/__api/webhooks/sms?t=${flip(tok, tok.length - 3)}&body=x`, { method: 'GET' })).status).toBe(401);
    expect((await call(`/__api/webhooks/sms?t=${flip(tok, 5)}&body=x`, { method: 'GET' })).status).toBe(401);
    const art = createShareTokens({ dir, now: clock.now }).sign({ kind: 'artifact', id: 'sms' }).token;
    expect((await call(`/__api/webhooks/sms?t=${art}&body=x`, { method: 'GET' })).status).toBe(401);
    // rotate → old dies immediately, new works
    const fresh = wh.rotateSmsToken(2);
    expect((await call(`/__api/webhooks/sms?t=${tok}&body=x`, { method: 'GET' })).status).toBe(401);
    expect((await call(`/__api/webhooks/sms?t=${fresh.token}&body=x`, { method: 'GET' })).status).toBe(200);
    // expiry honoured
    clock.tick(2 * 86_400_000 + 1);
    expect((await call(`/__api/webhooks/sms?t=${fresh.token}&body=x`, { method: 'GET' })).status).toBe(401);
    expect(wh.smsToken().live).toBe(false);
    // revoke → none
    expect(wh.revokeSmsToken()).toBe(true);
    expect(wh.smsToken()).toBeNull();
    expect(wh.revokeSmsToken()).toBe(false);
    wh.rotateSmsToken();
    expect(logs.some((l) => /sms: rejected/.test(l))).toBe(true);
    expect(logs.every((l) => !l.includes(tok))).toBe(true); // never logs a token
  });
});

describe('slack v0 signature', () => {
  const slack = (bodyObj, { secret = env.SLACK_SIGNING_SECRET, ts = Math.floor(clock.now() / 1000), sig } = {}) => {
    const body = JSON.stringify(bodyObj);
    return call('/__api/webhooks/slack', { body, headers: { 'content-type': 'application/json', 'x-slack-request-timestamp': String(ts), 'x-slack-signature': sig ?? 'v0=' + hmac(secret, `v0:${ts}:${body}`) } });
  };
  test('valid → 200 + event; url_verification echoes the challenge', async () => {
    const r = await slack({ type: 'event_callback', event: { type: 'message', text: 'hi' } });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(wh.events({ kind: 'slack' }).at(-1).event).toBe('message');
    const c = await slack({ type: 'url_verification', challenge: 'abc123' });
    expect(c.json).toEqual({ challenge: 'abc123' });
  });
  test('replay of the same signature → 401; new body same second → ok', async () => {
    const body = { type: 'event_callback', event: { type: 'message', text: 'again' } };
    const ts = Math.floor(clock.now() / 1000);
    expect((await slack(body, { ts })).status).toBe(200);
    expect((await slack(body, { ts })).status).toBe(401);
    expect((await slack({ ...body, n: 2 }, { ts })).status).toBe(200);
  });
  test('wrong secret / tampered body / stale timestamp / missing headers → 401 bare', async () => {
    expect((await slack({ a: 1 }, { secret: 'nope' })).status).toBe(401);
    const ts = Math.floor(clock.now() / 1000);
    const good = 'v0=' + hmac(env.SLACK_SIGNING_SECRET, `v0:${ts}:${JSON.stringify({ a: 1 })}`);
    expect((await slack({ a: 2 }, { ts, sig: good })).status).toBe(401);
    expect((await slack({ a: 3 }, { ts: ts - 301 })).status).toBe(401);
    expect((await slack({ a: 4 }, { ts: ts + 301 })).status).toBe(401);
    expect((await slack({ a: 5 }, { ts: ts - 299 })).status).toBe(200);
    const r = await call('/__api/webhooks/slack', { body: '{}' });
    expect(r.status).toBe(401);
    expect(r.json).toEqual({ error: 'unauthorized' });
    // no secret at all → 401 (never open)
    delete env.SLACK_SIGNING_SECRET;
    expect((await slack({ a: 6 }, { secret: 'whatever' })).status).toBe(401);
    env.SLACK_SIGNING_SECRET = 'slack-secret-1';
  });
  test('secret from webhooks.json when env is absent; env wins', async () => {
    delete env.SLACK_SIGNING_SECRET;
    wh.setSecret('slack', 'file-secret');
    expect(wh.configView().slack).toMatchObject({ configured: true, source: 'file' });
    expect((await slack({ f: 1 }, { secret: 'file-secret' })).status).toBe(200);
    env.SLACK_SIGNING_SECRET = 'slack-secret-1';
    expect(wh.configView().slack.source).toBe('env');
    expect((await slack({ f: 2 }, { secret: 'file-secret' })).status).toBe(401);
    wh.setSecret('slack', '');
    expect(fs.readFileSync(wh.files.file, 'utf8')).not.toContain('file-secret');
  });
});

describe('github X-Hub-Signature-256', () => {
  const gh = (bodyObj, { secret = 'gh-secret', delivery = crypto.randomUUID(), sig, event = 'push' } = {}) => {
    const body = JSON.stringify(bodyObj);
    return call('/__api/webhooks/github', { body, headers: { 'content-type': 'application/json', 'x-github-event': event, 'x-github-delivery': delivery, 'x-hub-signature-256': sig ?? 'sha256=' + hmac(secret, body) } });
  };
  test('unconfigured → 401; configured via file → valid 200 with event name', async () => {
    expect((await gh({ ref: 'x' })).status).toBe(401);
    wh.setSecret('github', 'gh-secret');
    const r = await gh({ ref: 'refs/heads/main' }, { event: 'push' });
    expect(r.status).toBe(200);
    expect(wh.events({ kind: 'github' }).at(-1)).toMatchObject({ event: 'push', payload: { ref: 'refs/heads/main' } });
  });
  test('replay by delivery id → 401; bad secret / tamper / missing sig → 401', async () => {
    const d = 'deliv-1';
    expect((await gh({ n: 1 }, { delivery: d })).status).toBe(200);
    expect((await gh({ n: 1 }, { delivery: d })).status).toBe(401);
    expect((await gh({ n: 1 }, { secret: 'bad' })).status).toBe(401);
    expect((await gh({ n: 2 }, { sig: 'sha256=' + hmac('gh-secret', '{"n":3}') })).status).toBe(401);
    expect((await call('/__api/webhooks/github', { body: '{}' })).status).toBe(401);
    // replay window is 5 min: same delivery after that is accepted again
    expect((await gh({ n: 4 }, { delivery: 'deliv-2' })).status).toBe(200);
    clock.tick(5 * 60_000 + 1);
    expect((await gh({ n: 4 }, { delivery: 'deliv-2' })).status).toBe(200);
  });
});

describe('custom/<id> HMAC', () => {
  let secret;
  const custom = (id, bodyObj, { sec = secret, ts = Math.floor(clock.now() / 1000), nonce = crypto.randomUUID(), sig, raw } = {}) => {
    const body = raw ?? JSON.stringify(bodyObj);
    return call(`/__api/webhooks/custom/${id}`, { body, headers: { 'content-type': 'application/json', 'x-arigami-timestamp': String(ts), 'x-arigami-nonce': nonce, 'x-arigami-signature': sig ?? 'sha256=' + hmac(sec, `${ts}.${nonce}.${body}`), 'x-arigami-event': 'ping' } });
  };
  test('add (secret shown once, not in config view), valid → 200, unknown id → 401', async () => {
    const c = wh.addCustom('zap', 'Zapier');
    secret = c.secret;
    expect(c.url).toBe('https://pub.example/__api/webhooks/custom/zap');
    expect(JSON.stringify(wh.configView())).not.toContain(secret);
    expect(wh.configView().custom).toEqual([{ id: 'zap', label: 'Zapier', createdAt: expect.any(String), path: '/__api/webhooks/custom/zap', url: c.url, envName: 'ARIGAMI_WEBHOOK_SECRET_ZAP' }]);
    expect(() => wh.addCustom('zap')).toThrow(/exists/);
    expect(() => wh.addCustom('bad id')).toThrow(/invalid/);
    const r = await custom('zap', { hello: 'world' });
    expect(r.status).toBe(200);
    expect(wh.events({ kind: 'custom' }).at(-1)).toMatchObject({ customId: 'zap', event: 'ping', payload: { hello: 'world' } });
    expect((await custom('other', { x: 1 })).status).toBe(401);
  });
  test('replay nonce / stale ts / tamper / wrong secret / missing headers → 401', async () => {
    const nonce = 'n-1';
    expect((await custom('zap', { a: 1 }, { nonce })).status).toBe(200);
    expect((await custom('zap', { a: 1 }, { nonce })).status).toBe(401);
    expect((await custom('zap', { a: 2 }, { ts: Math.floor(clock.now() / 1000) - 400 })).status).toBe(401);
    expect((await custom('zap', { a: 3 }, { sec: 'wrong' })).status).toBe(401);
    const ts = Math.floor(clock.now() / 1000);
    const sig = 'sha256=' + hmac(secret, `${ts}.n-2.{"a":4}`);
    expect((await custom('zap', null, { ts, nonce: 'n-2', sig, raw: '{"a":5}' })).status).toBe(401);
    expect((await call('/__api/webhooks/custom/zap', { body: '{}' })).status).toBe(401);
    // env secret overrides the file one
    process.env.__unused = '';
    env.ARIGAMI_WEBHOOK_SECRET_ZAP = 'env-secret';
    expect((await custom('zap', { a: 6 })).status).toBe(401);
    expect((await custom('zap', { a: 6 }, { sec: 'env-secret' })).status).toBe(200);
    delete env.ARIGAMI_WEBHOOK_SECRET_ZAP;
    expect(wh.removeCustom('zap')).toBe(true);
    expect((await custom('zap', { a: 7 })).status).toBe(401);
  });
});

describe('transport limits', () => {
  test('body over the cap → 413 before any verification; wrong method → 405', async () => {
    const big = 'x'.repeat(3000);
    expect((await call('/__api/webhooks/github', { body: big })).status).toBe(413);
    expect((await call('/__api/webhooks/slack', { method: 'GET' })).status).toBe(405);
    expect((await call('/__api/webhooks/github', { method: 'PUT', body: '{}' })).status).toBe(405);
  });
  test('rate limit: 429 with Retry-After after ratePerMin in a minute, per kind', async () => {
    const w2 = createWebhooks({ dir: tmp(), now: clock.now, log: () => {}, ratePerMin: 3, onSms: () => ({ id: 'x' }) });
    const s = http.createServer((req, res) => w2.handle(req, res));
    await new Promise((r) => s.listen(0, '127.0.0.1', r));
    const b = 'http://127.0.0.1:' + s.address().port;
    const st = [];
    for (let i = 0; i < 4; i++) { const r = await fetch(b + '/__api/webhooks/github', { method: 'POST', body: '{}' }); st.push([r.status, r.headers.get('x-ratelimit-remaining')]); }
    expect(st).toEqual([[401, '2'], [401, '1'], [401, '0'], [429, '0']]);
    const r = await fetch(b + '/__api/webhooks/github', { method: 'POST', body: '{}' });
    expect(r.headers.get('retry-after')).toMatch(/^\d+$/);
    expect((await fetch(b + '/__api/webhooks/slack', { method: 'POST', body: '{}' })).status).toBe(401); // other kind unaffected
    clock.tick(61_000);
    expect((await fetch(b + '/__api/webhooks/github', { method: 'POST', body: '{}' })).status).toBe(401);
    s.close();
  });
});

describe('legacy /__api/sms/inbound (one release, deprecated)', () => {
  test('GET query + POST json still 200 with Deprecation header; warning logged once a minute', async () => {
    const before = logs.filter((l) => l.includes('DEPRECATED')).length;
    const a = await call('/__api/sms/inbound?from=%2B9&body=legacy', { method: 'GET' });
    expect(a.status).toBe(200);
    expect(a.json.ok).toBe(true);
    expect(a.h('deprecation')).toBe('true');
    expect(a.h('x-arigami-deprecated')).toContain('/__api/webhooks/sms');
    const b = await call('/__api/sms/inbound', { body: JSON.stringify({ from: '+9', message: 'legacy2' }), headers: { 'content-type': 'application/json' } });
    expect(b.status).toBe(200);
    expect(smsSeen.slice(-2).map((x) => x.body)).toEqual(['legacy', 'legacy2']);
    expect(logs.filter((l) => l.includes('DEPRECATED')).length).toBe(before + 1);
    clock.tick(61_000);
    await call('/__api/sms/inbound?body=z', { method: 'GET' });
    expect(logs.filter((l) => l.includes('DEPRECATED')).length).toBe(before + 2);
    expect((await call('/__api/sms/inbound', { method: 'GET' })).status).toBe(400);
    expect(wh.events({ kind: 'sms' }).at(-1).payload.legacy).toBe(true);
  });
});
