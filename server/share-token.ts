// K2 — capability tokens for things opened WITHOUT a cookie: a shared
// artifact today (`/__artifacts/<id>/?t=…`), public webhooks in C3
// (`kind:'webhook'`). One HMAC-SHA256 module, one per-instance secret.
//
//   token  = base64url(JSON payload) + '.' + base64url(HMAC-SHA256(secret, payloadB64))
//   payload = { kind, id, exp (unix ms), nonce, ver? }
//
// `verify(token, {kind,id})` binds a token to ONE object: an artifact token can
// never open another artifact, nor a webhook. Revocation is by nonce
// (`$ARIGAMI_DIR/share-revoked.json`, GC'd after expiry); `revokeAll()`
// rotates the secret so every outstanding token dies at once. An issued-token
// registry (`share-tokens.json`) keeps nonce + metadata — never the token
// itself — so Settings/`GET /__api/share/tokens` can list live links and
// revoke them; leaking that file does not leak any link.
//
// All state lives under `cfg.configDir` (= ARIGAMI_DIR) per spec §0.1.6.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { cfg } from './lib/config.js';

export type ShareKind = 'artifact' | 'webhook';

export interface SharePayload {
  kind: ShareKind;
  id: string;
  exp: number;     // unix ms
  nonce: string;
  ver?: number;    // artifact: the version pinned when the link was minted
  scope?: ShareScope;
}

// F5: `scope:'assets'` marks the short-lived token the host itself mints so a
// sandboxed (opaque-origin, cookie-less) artifact document can fetch its own
// sub-resources. It is NOT a share link: hidden from the share lists, not
// revoked by `unshare()`, any version of that artifact, 24h TTL.
export type ShareScope = 'assets';

export interface IssuedToken {
  nonce: string;
  kind: ShareKind;
  id: string;
  exp: number;
  ver?: number;
  scope?: ShareScope;
  label?: string;
  createdAt: string;
}

export interface SignInput {
  kind: ShareKind;
  id: string;
  days?: number;   // default `defaultDays`, clamped to (0, maxDays]
  ver?: number;
  scope?: ShareScope;
  label?: string;  // free text for the admin list (e.g. artifact title)
}

export interface SignResult { token: string; exp: number; nonce: string; }

export type VerifyResult =
  | { ok: true; reason: 'ok'; payload: SharePayload }
  | { ok: false; reason: string; payload?: SharePayload };

export interface ShareTokenOptions {
  dir: string;
  defaultDays?: number;
  maxDays?: number;
  now?: () => number;
}

export const DEFAULT_DAYS = 7;
export const MAX_DAYS = 90;
const DAY_MS = 86_400_000;
const KINDS: ReadonlySet<string> = new Set(['artifact', 'webhook']);
const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

const b64u = (b: Buffer | string): string => Buffer.from(b).toString('base64url');

export function createShareTokens(opts: ShareTokenOptions) {
  const dir = opts.dir;
  const secretFile = path.join(dir, 'share-secret');
  const revokedFile = path.join(dir, 'share-revoked.json');
  const issuedFile = path.join(dir, 'share-tokens.json');
  const now = opts.now || (() => Date.now());
  const defaultDays = clampDays(opts.defaultDays ?? DEFAULT_DAYS, opts.maxDays ?? MAX_DAYS);
  const maxDays = Math.max(1, Math.floor(opts.maxDays ?? MAX_DAYS));

  // ---- secret ----------------------------------------------------------------
  let secret: Buffer | null = null;
  function loadSecret(): Buffer {
    if (secret) return secret;
    try {
      const hex = fs.readFileSync(secretFile, 'utf8').trim();
      if (/^[0-9a-f]{64}$/.test(hex)) { secret = Buffer.from(hex, 'hex'); return secret; }
    } catch {}
    return rotateSecret();
  }
  function rotateSecret(): Buffer {
    fs.mkdirSync(dir, { recursive: true });
    secret = crypto.randomBytes(32);
    const tmp = `${secretFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, secret.toString('hex') + '\n', { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, secretFile);
    return secret;
  }

  // ---- revocation + issued registry --------------------------------------------
  const readJson = <T,>(file: string, fallback: T): T => {
    try {
      const v = JSON.parse(fs.readFileSync(file, 'utf8'));
      return v && typeof v === 'object' ? (v as T) : fallback;
    } catch { return fallback; }
  };
  const writeJson = (file: string, v: unknown): void => {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(v, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  };
  // nonce → exp; entries drop out once the token they name has expired anyway.
  function readRevoked(): Record<string, number> {
    const all = readJson<Record<string, number>>(revokedFile, {});
    const t = now();
    let dirty = false;
    for (const [n, exp] of Object.entries(all)) {
      if (typeof exp !== 'number' || exp <= t) { delete all[n]; dirty = true; }
    }
    if (dirty) writeJson(revokedFile, all);
    return all;
  }
  function readIssued(): IssuedToken[] {
    const all = readJson<IssuedToken[]>(issuedFile, []);
    if (!Array.isArray(all)) return [];
    const t = now();
    const live = all.filter((x) => x && typeof x.exp === 'number' && x.exp > t);
    if (live.length !== all.length) writeJson(issuedFile, live);
    return live;
  }

  // ---- sign / verify ----------------------------------------------------------
  const mac = (payloadB64: string): Buffer =>
    crypto.createHmac('sha256', loadSecret()).update(payloadB64).digest();

  function sign(input: SignInput): SignResult {
    if (!KINDS.has(input.kind)) throw new Error(`share-token: unknown kind ${String(input.kind)}`);
    if (!ID_RE.test(String(input.id))) throw new Error('share-token: invalid id');
    const days = clampDays(input.days ?? defaultDays, maxDays);
    const exp = now() + Math.round(days * DAY_MS);
    const nonce = crypto.randomBytes(12).toString('base64url');
    const payload: SharePayload = { kind: input.kind, id: input.id, exp, nonce };
    if (input.ver != null) payload.ver = input.ver;
    if (input.scope) payload.scope = input.scope;
    const p = b64u(JSON.stringify(payload));
    const token = `${p}.${b64u(mac(p))}`;
    const issued = readIssued();
    issued.push({ nonce, kind: input.kind, id: input.id, exp, ...(input.ver != null ? { ver: input.ver } : {}), ...(input.scope ? { scope: input.scope } : {}), ...(input.label ? { label: String(input.label).slice(0, 120) } : {}), createdAt: new Date(now()).toISOString() });
    writeJson(issuedFile, issued);
    return { token, exp, nonce };
  }

  // Constant-time on the signature; the payload is only parsed after the MAC
  // matched, so a tampered/forged token never reaches JSON.parse.
  function verify(token: unknown, want: { kind: ShareKind; id: string }): VerifyResult {
    if (typeof token !== 'string' || token.length > 2048) return { ok: false, reason: 'malformed token' };
    const dot = token.indexOf('.');
    if (dot <= 0 || dot === token.length - 1 || token.indexOf('.', dot + 1) >= 0) return { ok: false, reason: 'malformed token' };
    const p = token.slice(0, dot);
    const sig = Buffer.from(token.slice(dot + 1), 'base64url');
    const expected = mac(p);
    if (sig.length !== expected.length || !crypto.timingSafeEqual(sig, expected)) return { ok: false, reason: 'invalid signature' };
    let payload: SharePayload;
    try { payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')); } catch { return { ok: false, reason: 'malformed payload' }; }
    if (!payload || typeof payload !== 'object' || typeof payload.nonce !== 'string' || typeof payload.exp !== 'number')
      return { ok: false, reason: 'malformed payload' };
    if (payload.kind !== want.kind || payload.id !== want.id) return { ok: false, reason: 'token is for a different resource', payload };
    if (payload.exp <= now()) return { ok: false, reason: 'link expired', payload };
    if (readRevoked()[payload.nonce]) return { ok: false, reason: 'link revoked', payload };
    return { ok: true, reason: 'ok', payload };
  }

  // ---- revocation API ------------------------------------------------------------
  function revoke(nonce: string): boolean {
    const issued = readIssued();
    const hit = issued.find((x) => x.nonce === nonce);
    const revoked = readRevoked();
    if (revoked[nonce]) return false;
    // Unknown nonce (registry lost?) — still block it for the max lifetime.
    revoked[nonce] = hit?.exp ?? now() + maxDays * DAY_MS;
    writeJson(revokedFile, revoked);
    if (hit) writeJson(issuedFile, issued.filter((x) => x.nonce !== nonce));
    return true;
  }
  // Every live SHARE token for one resource (e.g. all links of an artifact).
  // Asset-scope tokens survive unless `includeAssets` (artifact deleted).
  function revokeFor(kind: ShareKind, id: string, opts: { includeAssets?: boolean } = {}): number {
    const issued = readIssued();
    const match = (x: IssuedToken): boolean => x.kind === kind && x.id === id && (opts.includeAssets || !x.scope);
    const mine = issued.filter(match);
    if (!mine.length) return 0;
    const revoked = readRevoked();
    for (const x of mine) revoked[x.nonce] = x.exp;
    writeJson(revokedFile, revoked);
    writeJson(issuedFile, issued.filter((x) => !match(x)));
    return mine.length;
  }
  // Rotate the secret: every token ever minted becomes invalid, lists reset.
  function revokeAll(): number {
    const n = readIssued().length;
    rotateSecret();
    writeJson(revokedFile, {});
    writeJson(issuedFile, []);
    return n;
  }
  // Share links only — the host's own asset tokens are an implementation
  // detail (they never leave the served HTML) and would only clutter Settings.
  const list = (): IssuedToken[] => readIssued().filter((x) => !x.scope).sort((a, b) => a.exp - b.exp);
  const listFor = (kind: ShareKind, id: string): IssuedToken[] => list().filter((x) => x.kind === kind && x.id === id);

  return { sign, verify, revoke, revokeFor, revokeAll, list, listFor, defaultDays, maxDays, files: { secretFile, revokedFile, issuedFile } };
}

export type ShareTokens = ReturnType<typeof createShareTokens>;

export function clampDays(days: unknown, max: number): number {
  const n = Number(days);
  if (!Number.isFinite(n) || n <= 0) return Math.min(DEFAULT_DAYS, max);
  return Math.min(n, max);
}

// ---- process-wide instance bound to the running config ---------------------------
let inst: ShareTokens | null = null;
export function shareTokens(): ShareTokens {
  if (inst) return inst;
  inst = createShareTokens({
    dir: cfg.configDir!,
    defaultDays: cfg.share?.defaultDays,
    maxDays: cfg.share?.maxDays,
  });
  return inst;
}
