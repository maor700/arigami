// C3 — public webhooks: `/__api/webhooks/<kind>` is on the auth allowlist
// (no cookie) and every request is authenticated INSIDE this module, one
// verifier per kind, all constant-time, all answering a bare 401 on failure:
//
//   sms            `?t=` or `X-Arigami-Token` = share-token {kind:'webhook', id:'sms'}
//                  (long-lived, revocable/rotatable from Settings → Webhooks;
//                  Macrodroid can't HMAC, so a capability token it is)
//   slack          Slack v0 signing secret: `X-Slack-Signature` over
//                  `v0:<ts>:<body>`, `X-Slack-Request-Timestamp` within ±5 min
//   github         `X-Hub-Signature-256` = sha256=HMAC(secret, body);
//                  `X-GitHub-Delivery` is the replay nonce
//   custom/<id>    `X-Arigami-Signature` = sha256=HMAC(secret, `<ts>.<nonce>.<body>`),
//                  `X-Arigami-Timestamp` (unix s, ±5 min), `X-Arigami-Nonce` (unique)
//
// Replay guard: a 5-minute seen-set keyed by the provider's nonce (Slack
// signature, GitHub delivery id, custom nonce). The sms token is a bearer
// capability: no nonce is possible from the phone side, so it is not
// replay-guarded — it is revocable instead (documented in docs/SECURITY.md).
//
// Verified events are appended to `$ARIGAMI_DIR/webhooks.jsonl` (tail kept in
// memory, `GET /__api/webhooks/events`) and broadcast on the bus; `sms` is
// routed into the existing sms store so the sms-listener flow is unchanged.
// Secrets live in `$ARIGAMI_DIR/webhooks.json` (0600) or come from the
// environment / secrets.env (`SLACK_SIGNING_SECRET`,
// `ARIGAMI_GITHUB_WEBHOOK_SECRET`, `ARIGAMI_WEBHOOK_SECRET_<ID>`), env winning.
//
// Legacy: `/__api/sms/inbound` (unauthenticated, pre-C3) stays for ONE
// release via `handleLegacySms` — same parsing, a `Deprecation` header and a
// rate-limited warning in the host log.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { cfg, publicUrl } from './lib/config.js';
import { createShareTokens, type ShareTokens } from './share-token.js';

export const INBOUND_RE = /^\/__api\/webhooks\/(sms|slack|github|custom\/([A-Za-z0-9_.-]{1,64}))$/;
export const CUSTOM_ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;
export const isInboundWebhookPath = (pathname: string): boolean => INBOUND_RE.test(pathname);

export const SKEW_MS = 5 * 60_000;          // ±5 min for signed timestamps + replay window
export const MAX_BODY_BYTES = 256 * 1024;   // webhooks are small; 413 above this
export const RATE_LIMIT_PER_MIN = 120;      // per kind, sliding minute; 429 above
export const SMS_TOKEN_DAYS = 365;          // "long-lived": a year, rotate from Settings
export const SMS_TOKEN_MAX_DAYS = 3650;
export const LEGACY_SMS_PATH = '/__api/sms/inbound';
export const SMS_PATH = '/__api/webhooks/sms';
const EVENTS_TAIL = 200;

export type WebhookKind = 'sms' | 'slack' | 'github' | 'custom';

export interface WebhookEvent {
  id: string;
  kind: WebhookKind;
  customId?: string;
  event?: string;          // github: X-GitHub-Event; slack: event.type; sms: 'sms'
  receivedAt: string;
  payload: unknown;        // parsed JSON (or {raw} when not JSON), truncated
}

interface SmsRecord { token: string; nonce: string; exp: number; createdAt: string }
interface WebhooksFile {
  sms?: SmsRecord;
  slack?: { signingSecret?: string };
  github?: { secret?: string };
  custom: Record<string, { secret: string; label?: string; createdAt: string }>;
}

export interface WebhooksOptions {
  dir: string;
  now?: () => number;
  log?: (msg: string) => void;
  // sms sink — defaults to server/sms.ts receiveSms; injectable for tests
  onSms?: (from: string, body: string, timestamp?: string) => { id: string };
  onEvent?: (ev: WebhookEvent) => void;
  envSecret?: (name: string) => string;
  publicUrl?: (p: string) => string;
  maxBodyBytes?: number;
  ratePerMin?: number;
}

const hmacHex = (secret: string, data: string | Buffer): string =>
  crypto.createHmac('sha256', secret).update(data).digest('hex');

// Constant-time string compare that never short-circuits on length: when the
// lengths differ we still run one full comparison (against ourselves) so the
// timing does not leak the expected length.
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(String(a)), bb = Buffer.from(String(b));
  if (ab.length !== bb.length) { crypto.timingSafeEqual(bb, bb); return false; }
  return crypto.timingSafeEqual(ab, bb);
}

function headerOf(req: IncomingMessage, name: string): string {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] || '' : String(v || '');
}

// Raw-body reader with a hard cap — resolves null when over the cap (caller
// answers 413). Webhook signatures are over the exact bytes, so no JSON here.
export function readRaw(req: IncomingMessage, maxBytes: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let n = 0;
    let over = false;
    req.on('data', (c: Buffer) => {
      if (over) return;
      n += c.length;
      if (n > maxBytes) { over = true; resolve(null); req.resume(); return; }
      chunks.push(c);
    });
    req.on('end', () => { if (!over) resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}

// Accepts the shapes the phone-side forwarders send: query string (Macrodroid
// GET), JSON body, or a urlencoded form. Same aliases as the legacy handler.
export function parseSms(u: URL, raw: Buffer | null, contentType: string): { from: string; body: string; timestamp?: string } | null {
  const q = (k: string) => u.searchParams.get(k) || '';
  let from = q('from') || q('sender');
  let body = q('body') || q('message') || q('text');
  let timestamp: string | undefined = q('timestamp') || undefined;
  if (!from && !body && raw && raw.length) {
    const text = raw.toString('utf8');
    let b: any = null;
    if (/application\/x-www-form-urlencoded/i.test(contentType)) b = Object.fromEntries(new URLSearchParams(text));
    else { try { b = JSON.parse(text); } catch { b = null; } }
    if (b && typeof b === 'object') {
      from = String(b.from || b.sender || '');
      body = String(b.body || b.message || b.text || '');
      if (b.timestamp) timestamp = String(b.timestamp);
    }
  }
  if (!body) return null;
  return { from, body, timestamp };
}

export function createWebhooks(opts: WebhooksOptions) {
  const dir = opts.dir;
  const file = path.join(dir, 'webhooks.json');
  const eventsFile = path.join(dir, 'webhooks.jsonl');
  const now = opts.now || (() => Date.now());
  const log = opts.log || ((m: string) => console.log(m));
  const envSecret = opts.envSecret || (() => '');
  const toPublic = opts.publicUrl || ((p: string) => p);
  const maxBody = opts.maxBodyBytes ?? MAX_BODY_BYTES;
  const ratePerMin = opts.ratePerMin ?? RATE_LIMIT_PER_MIN;
  const tokens: ShareTokens = createShareTokens({ dir, defaultDays: SMS_TOKEN_DAYS, maxDays: SMS_TOKEN_MAX_DAYS, now });

  // ---- state file ------------------------------------------------------------
  function read(): WebhooksFile {
    try {
      const v = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (v && typeof v === 'object') return { ...v, custom: v.custom && typeof v.custom === 'object' ? v.custom : {} };
    } catch {}
    return { custom: {} };
  }
  function write(v: WebhooksFile): void {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(v, null, 2) + '\n', { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  }

  // ---- secrets ----------------------------------------------------------------
  const slackSecret = () => envSecret('SLACK_SIGNING_SECRET') || read().slack?.signingSecret || '';
  const githubSecret = () => envSecret('ARIGAMI_GITHUB_WEBHOOK_SECRET') || read().github?.secret || '';
  const customEnvName = (id: string) => 'ARIGAMI_WEBHOOK_SECRET_' + id.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  const customSecret = (id: string) => envSecret(customEnvName(id)) || read().custom[id]?.secret || '';

  // ---- sms token (a share-token of kind 'webhook', id 'sms') -------------------
  function smsToken(): (SmsRecord & { path: string; url: string; live: boolean }) | null {
    const s = read().sms;
    if (!s) return null;
    const v = tokens.verify(s.token, { kind: 'webhook', id: 'sms' });
    const p = `${SMS_PATH}?t=${s.token}`;
    return { ...s, path: p, url: toPublic(p), live: v.ok };
  }
  function rotateSmsToken(days?: number): SmsRecord & { path: string; url: string; live: boolean } {
    const f = read();
    if (f.sms) tokens.revoke(f.sms.nonce);
    const r = tokens.sign({ kind: 'webhook', id: 'sms', days: days ?? SMS_TOKEN_DAYS, label: 'sms webhook' });
    f.sms = { token: r.token, nonce: r.nonce, exp: r.exp, createdAt: new Date(now()).toISOString() };
    write(f);
    log('[webhooks] sms token rotated');
    return smsToken()!;
  }
  function revokeSmsToken(): boolean {
    const f = read();
    if (!f.sms) return false;
    tokens.revoke(f.sms.nonce);
    delete f.sms;
    write(f);
    log('[webhooks] sms token revoked');
    return true;
  }

  // ---- admin config -----------------------------------------------------------
  function configView() {
    const f = read();
    return {
      sms: (() => { const s = smsToken(); return s ? { exp: s.exp, createdAt: s.createdAt, live: s.live, path: s.path, url: s.url } : null; })(),
      slack: { configured: !!slackSecret(), source: envSecret('SLACK_SIGNING_SECRET') ? 'env' : f.slack?.signingSecret ? 'file' : 'missing', path: '/__api/webhooks/slack', url: toPublic('/__api/webhooks/slack') },
      github: { configured: !!githubSecret(), source: envSecret('ARIGAMI_GITHUB_WEBHOOK_SECRET') ? 'env' : f.github?.secret ? 'file' : 'missing', path: '/__api/webhooks/github', url: toPublic('/__api/webhooks/github') },
      custom: Object.entries(f.custom).map(([id, c]) => ({ id, label: c.label || '', createdAt: c.createdAt, path: `/__api/webhooks/custom/${id}`, url: toPublic(`/__api/webhooks/custom/${id}`), envName: customEnvName(id) })),
      publicUrl: !!cfgPublicUrl(),
      limits: { maxBodyBytes: maxBody, ratePerMin, skewMs: SKEW_MS },
    };
  }
  const cfgPublicUrl = () => (opts.publicUrl ? toPublic('/') !== '/' : !!cfg.publicUrl);
  function setSecret(kind: 'slack' | 'github', value: string): void {
    const f = read();
    const v = String(value || '').trim();
    if (kind === 'slack') { if (v) f.slack = { signingSecret: v }; else delete f.slack; }
    else { if (v) f.github = { secret: v }; else delete f.github; }
    write(f);
    log(`[webhooks] ${kind} secret ${v ? 'set' : 'cleared'}`);
  }
  function addCustom(id: string, label?: string): { id: string; secret: string; path: string; url: string } {
    if (!CUSTOM_ID_RE.test(id)) throw new Error('invalid id (A-Za-z0-9_.- up to 64)');
    const f = read();
    if (f.custom[id]) throw new Error('id exists');
    const secret = crypto.randomBytes(32).toString('base64url');
    f.custom[id] = { secret, ...(label ? { label: String(label).slice(0, 60) } : {}), createdAt: new Date(now()).toISOString() };
    write(f);
    log(`[webhooks] custom webhook "${id}" created`);
    const p = `/__api/webhooks/custom/${id}`;
    return { id, secret, path: p, url: toPublic(p) };
  }
  function removeCustom(id: string): boolean {
    const f = read();
    if (!f.custom[id]) return false;
    delete f.custom[id];
    write(f);
    return true;
  }

  // ---- replay guard + rate limit ---------------------------------------------
  const seen = new Map<string, number>(); // key → expiry
  function replay(key: string): boolean {
    const t = now();
    if (seen.size > 5000 || seen.size % 100 === 0) for (const [k, e] of seen) if (e <= t) seen.delete(k);
    if (seen.has(key) && seen.get(key)! > t) return true;
    seen.set(key, t + SKEW_MS);
    return false;
  }
  const buckets = new Map<string, number[]>();
  function rate(kind: string): { ok: boolean; remaining: number; reset: number } {
    const t = now();
    const arr = (buckets.get(kind) || []).filter((x) => x > t - 60_000);
    const ok = arr.length < ratePerMin;
    if (ok) arr.push(t);
    buckets.set(kind, arr);
    return { ok, remaining: Math.max(0, ratePerMin - arr.length), reset: Math.ceil(((arr[0] || t) + 60_000 - t) / 1000) };
  }

  // ---- events -------------------------------------------------------------------
  const tail: WebhookEvent[] = [];
  try {
    if (fs.existsSync(eventsFile)) for (const l of fs.readFileSync(eventsFile, 'utf8').split('\n').filter(Boolean).slice(-EVENTS_TAIL)) { try { tail.push(JSON.parse(l)); } catch {} }
  } catch {}
  let seq = 0;
  function record(kind: WebhookKind, payload: unknown, extra: Partial<WebhookEvent> = {}): WebhookEvent {
    const ev: WebhookEvent = { id: now().toString(36) + (++seq).toString(36), kind, receivedAt: new Date(now()).toISOString(), payload, ...extra };
    tail.push(ev);
    if (tail.length > EVENTS_TAIL) tail.shift();
    try { fs.mkdirSync(dir, { recursive: true }); fs.appendFileSync(eventsFile, JSON.stringify(ev) + '\n'); } catch {}
    try { opts.onEvent?.(ev); } catch {}
    return ev;
  }
  /** Route an `ext-…` custom webhook to the extension that declared it. Best-effort. */
  async function deliverToExtension(customId: string, ev: WebhookEvent): Promise<void> {
    if (!customId.startsWith('ext-')) return;
    try {
      const ext = await import('./extensions.js');
      const parsed = ext.parseWebhookId(customId);
      if (!parsed) return;
      const type = ext.webhookListenerType(parsed.ext, parsed.id);
      if (!type) return;
      const listeners = await import('./listeners.js');
      await listeners.deliverExtWebhook(type, { kind: 'custom', customId, body: ev.payload, receivedAt: ev.receivedAt });
    } catch (e) {
      log(`[webhooks] extension delivery for ${customId} failed: ${(e as Error).message}`);
    }
  }

  const events = (q: { kind?: string; since?: string; limit?: number } = {}): WebhookEvent[] =>
    tail.filter((e) => (!q.kind || e.kind === q.kind) && (!q.since || e.receivedAt > q.since)).slice(-(q.limit || 50));

  const parsePayload = (raw: Buffer): unknown => {
    const text = raw.toString('utf8').slice(0, 64 * 1024);
    try { return JSON.parse(text); } catch { return { raw: text }; }
  };

  // ---- verifiers (each returns a reason string on failure, '' on success) --------
  function verifySlack(req: IncomingMessage, raw: Buffer): string {
    const secret = slackSecret();
    if (!secret) return 'no slack signing secret configured';
    const ts = headerOf(req, 'x-slack-request-timestamp');
    const sig = headerOf(req, 'x-slack-signature');
    if (!/^\d{1,12}$/.test(ts) || !sig) return 'missing slack headers';
    if (Math.abs(now() - Number(ts) * 1000) > SKEW_MS) return 'slack timestamp outside ±5 min';
    const expected = 'v0=' + hmacHex(secret, `v0:${ts}:${raw.toString('utf8')}`);
    if (!safeEqual(sig, expected)) return 'bad slack signature';
    if (replay('slack:' + sig)) return 'slack replay';
    return '';
  }
  function verifyGithub(req: IncomingMessage, raw: Buffer): string {
    const secret = githubSecret();
    if (!secret) return 'no github secret configured';
    const sig = headerOf(req, 'x-hub-signature-256');
    if (!sig) return 'missing X-Hub-Signature-256';
    if (!safeEqual(sig, 'sha256=' + hmacHex(secret, raw))) return 'bad github signature';
    const delivery = headerOf(req, 'x-github-delivery') || sig;
    if (replay('github:' + delivery)) return 'github replay';
    return '';
  }
  function verifyCustom(id: string, req: IncomingMessage, raw: Buffer): string {
    const secret = customSecret(id);
    if (!secret) return `unknown custom webhook ${id}`;
    const ts = headerOf(req, 'x-arigami-timestamp');
    const nonce = headerOf(req, 'x-arigami-nonce');
    const sig = headerOf(req, 'x-arigami-signature');
    if (!/^\d{1,12}$/.test(ts) || !nonce || nonce.length > 128 || !sig) return 'missing custom headers';
    if (Math.abs(now() - Number(ts) * 1000) > SKEW_MS) return 'custom timestamp outside ±5 min';
    const expected = 'sha256=' + hmacHex(secret, Buffer.concat([Buffer.from(`${ts}.${nonce}.`), raw]));
    if (!safeEqual(sig, expected)) return 'bad custom signature';
    if (replay(`custom:${id}:${nonce}`)) return 'custom replay';
    return '';
  }
  function verifySms(req: IncomingMessage, u: URL): string {
    const t = u.searchParams.get('t') || headerOf(req, 'x-arigami-token');
    if (!t) return 'missing token';
    const v = tokens.verify(t, { kind: 'webhook', id: 'sms' });
    if (!v.ok) return 'sms token: ' + v.reason;
    const rec = read().sms;
    // Only the CURRENT token counts — a rotated-away one is revoked, but be strict anyway.
    if (!rec || v.payload.nonce !== rec.nonce) return 'sms token: not the current token';
    return '';
  }

  // ---- HTTP -----------------------------------------------------------------------
  const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
    res.end(JSON.stringify(body));
  };
  const deny = (res: ServerResponse, kind: string, reason: string, headers: Record<string, string>) => {
    log(`[webhooks] ${kind}: rejected (${reason})`);
    send(res, 401, { error: 'unauthorized' }, headers); // no detail on the wire
  };
  const smsSink = opts.onSms || ((from, body, ts) => { const sms = require('./sms.js'); return sms.receiveSms(from, body, ts); });

  // Returns true when the request was a webhook route and has been answered.
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const u = new URL(req.url || '/', 'http://h');
    const mt = INBOUND_RE.exec(u.pathname);
    if (!mt) return false;
    const kind: WebhookKind = mt[2] ? 'custom' : (mt[1] as WebhookKind);
    const customId = mt[2] || '';
    const method = req.method || 'GET';
    const rl = rate(kind === 'custom' ? `custom/${customId}` : kind);
    const rlHeaders = { 'x-ratelimit-limit': String(ratePerMin), 'x-ratelimit-remaining': String(rl.remaining), 'x-ratelimit-reset': String(rl.reset) };
    if (!rl.ok) { send(res, 429, { error: 'rate limited' }, { ...rlHeaders, 'retry-after': String(rl.reset) }); return true; }
    if (method !== 'POST' && !(kind === 'sms' && method === 'GET')) { send(res, 405, { error: 'method not allowed' }, { ...rlHeaders, allow: kind === 'sms' ? 'GET, POST' : 'POST' }); return true; }
    const raw = await readRaw(req, maxBody);
    if (raw === null) { send(res, 413, { error: 'body too large' }, rlHeaders); return true; }

    if (kind === 'sms') {
      const why = verifySms(req, u);
      if (why) { deny(res, 'sms', why, rlHeaders); return true; }
      const s = parseSms(u, raw, headerOf(req, 'content-type'));
      if (!s) { send(res, 400, { error: 'missing body/message' }, rlHeaders); return true; }
      const msg = smsSink(s.from, s.body, s.timestamp);
      record('sms', { from: s.from, body: s.body }, { event: 'sms' });
      send(res, 200, { ok: true, id: msg.id }, rlHeaders);
      return true;
    }
    if (kind === 'slack') {
      const why = verifySlack(req, raw);
      if (why) { deny(res, 'slack', why, rlHeaders); return true; }
      const payload = parsePayload(raw) as any;
      if (payload && payload.type === 'url_verification' && typeof payload.challenge === 'string') { send(res, 200, { challenge: payload.challenge }, rlHeaders); return true; }
      const ev = record('slack', payload, { event: String(payload?.event?.type || payload?.type || '') });
      send(res, 200, { ok: true, id: ev.id }, rlHeaders);
      return true;
    }
    if (kind === 'github') {
      const why = verifyGithub(req, raw);
      if (why) { deny(res, 'github', why, rlHeaders); return true; }
      const ev = record('github', parsePayload(raw), { event: headerOf(req, 'x-github-event') });
      send(res, 200, { ok: true, id: ev.id }, rlHeaders);
      return true;
    }
    const why = verifyCustom(customId, req, raw);
    if (why) { deny(res, `custom/${customId}`, why, rlHeaders); return true; }
    const ev = record('custom', parsePayload(raw), { customId, event: headerOf(req, 'x-arigami-event') || '' });
    // EXT: `ext-<name>-<id>` is an extension's own webhook. The manifest maps it
    // to a listener type, and that provider's onWebhook turns the delivery into
    // the same outcome a poll would have produced — which finally closes the
    // "an inbound webhook cannot wake a session" gap (SMS was the exception,
    // and only because a poller re-read its store).
    void deliverToExtension(customId, ev);
    send(res, 200, { ok: true, id: ev.id }, rlHeaders);
    return true;
  }

  // Pre-C3 unauthenticated path. Kept for one release: same behaviour, plus a
  // Deprecation header and a (once a minute) warning in the host log.
  let lastWarn = 0;
  async function handleLegacySms(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const u = new URL(req.url || '/', 'http://h');
    if (u.pathname !== LEGACY_SMS_PATH && !u.pathname.startsWith(LEGACY_SMS_PATH + '/')) return false;
    const method = req.method || 'GET';
    const hdr = { deprecation: 'true', 'x-arigami-deprecated': `use ${SMS_PATH}?t=<token> (Settings > Webhooks)` };
    if (method !== 'GET' && method !== 'POST') { send(res, 405, { error: 'method not allowed' }, hdr); return true; }
    if (now() - lastWarn > 60_000) {
      lastWarn = now();
      log(`[webhooks] DEPRECATED: ${LEGACY_SMS_PATH} accepts unauthenticated SMS and will be removed in the next release — point the phone at ${SMS_PATH}?t=<token> (Settings → Webhooks, or GET /__api/webhooks/token)`);
    }
    const raw = await readRaw(req, maxBody);
    if (raw === null) { send(res, 413, { error: 'body too large' }, hdr); return true; }
    const s = parseSms(u, raw, headerOf(req, 'content-type'));
    if (!s) { send(res, 400, { error: 'missing body/message' }, hdr); return true; }
    const msg = smsSink(s.from, s.body, s.timestamp);
    record('sms', { from: s.from, body: s.body, legacy: true }, { event: 'sms' });
    send(res, 200, { ok: true, id: msg.id }, hdr);
    return true;
  }

  return {
    handle, handleLegacySms,
    smsToken, rotateSmsToken, revokeSmsToken,
    configView, setSecret, addCustom, removeCustom, customEnvName,
    events, record,
    files: { file, eventsFile },
  };
}

export type Webhooks = ReturnType<typeof createWebhooks>;

// ---- process-wide instance bound to the running config ---------------------------
let inst: Webhooks | null = null;
export function webhooks(): Webhooks {
  if (inst) return inst;
  const { secret } = require('./lib/secrets.js') as typeof import('./lib/secrets.js');
  const { broadcast, emitLocal } = require('./bus.js') as { broadcast: (m: unknown) => void; emitLocal: (n: string, p?: unknown) => void };
  inst = createWebhooks({
    dir: cfg.configDir!,
    envSecret: secret,
    publicUrl,
    onEvent: (ev) => {
      // The WS message deliberately carries NO payload (it reaches browsers);
      // the in-process domain event does, because a hook needs the body.
      try { broadcast({ type: 'webhook', kind: ev.kind, customId: ev.customId, event: ev.event, id: ev.id, receivedAt: ev.receivedAt }); } catch {}
      try { emitLocal('webhook.received', { kind: ev.kind, customId: ev.customId, event: ev.event, id: ev.id, receivedAt: ev.receivedAt, body: ev.payload }); } catch {}
    },
  });
  return inst;
}
