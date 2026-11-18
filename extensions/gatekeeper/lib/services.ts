// Thin clients for the four bot identities. Each reads its credential from the gatekeeper's store per call; no value
// ever leaves this process except in the Authorization header of the service it belongs to.
import crypto from 'node:crypto';
import { readIdentities, redact, type Config } from './store.ts';

type Fetch = typeof fetch;
let doFetch: Fetch = (...a) => fetch(...a);
/** Tests swap the network for a fake. */
export function setFetch(f: Fetch | null): void {
  doFetch = f || ((...a) => fetch(...a));
}

export class ServiceError extends Error {
  status: number;
  constructor(service: string, status: number, msg: string) {
    super(`${service} ${status}: ${redact(msg).slice(0, 300)}`);
    this.status = status;
  }
}

async function call(service: string, url: string, init: RequestInit & { timeoutMs?: number }): Promise<any> {
  const res = await doFetch(url, { ...init, signal: AbortSignal.timeout(init.timeoutMs || 30_000), redirect: 'follow' });
  const text = await res.text();
  let body: any = text;
  try { body = text ? JSON.parse(text) : null; } catch { /* text */ }
  if (!res.ok) throw new ServiceError(service, res.status, typeof body === 'object' && body ? body.message || body.detail || body.error || JSON.stringify(body) : String(text));
  return body;
}

// ---- GitHub App: a short-lived installation token, narrowed to the ONE repo -----------------------------------------

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

export function appJwt(appId: string, pem: string, nowSec = Math.floor(Date.now() / 1000)): string {
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ iat: nowSec - 60, exp: nowSec + 540, iss: appId }));
  const sig = crypto.createSign('RSA-SHA256').update(`${head}.${body}`).sign(pem);
  return `${head}.${body}.${b64url(sig)}`;
}

let ghToken: { key: string; token: string; exp: number } | null = null;

/** The installation token, scoped by GitHub itself to `repo` only (repositories: [name]). */
export async function githubToken(cfg: Config): Promise<string> {
  const id = readIdentities().github || {};
  if (!id.appId || !id.installationId || !id.privateKey) throw new ServiceError('github', 0, 'no GitHub App identity configured');
  const repoName = cfg.github.repo.split('/')[1];
  const key = `${id.appId}:${id.installationId}:${cfg.github.repo}`;
  if (ghToken && ghToken.key === key && ghToken.exp - Date.now() > 5 * 60_000) return ghToken.token;
  const r = await call('github', `${cfg.github.apiUrl}/app/installations/${encodeURIComponent(id.installationId)}/access_tokens`, {
    method: 'POST',
    headers: { authorization: `Bearer ${appJwt(id.appId, id.privateKey)}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'user-agent': 'arigami-gatekeeper' },
    // Narrowed to the one repo even if the app is installed on more; permissions are the app's own (keep them minimal).
    body: JSON.stringify({ repositories: [repoName] }),
  });
  ghToken = { key, token: String(r.token), exp: Date.parse(r.expires_at) || Date.now() + 30 * 60_000 };
  return ghToken.token;
}

export async function gh(cfg: Config, method: string, p: string, body?: unknown, raw = false): Promise<any> {
  const token = await githubToken(cfg);
  const url = p.startsWith('http') ? p : `${cfg.github.apiUrl}${p}`;
  if (raw) {
    const res = await doFetch(url, { method, headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'arigami-gatekeeper' }, redirect: 'follow', signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new ServiceError('github', res.status, await res.text());
    return res.text();
  }
  return call('github', url, {
    method,
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'user-agent': 'arigami-gatekeeper', 'x-github-api-version': '2022-11-28' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export async function ghGraphql(cfg: Config, query: string, variables: Record<string, unknown>): Promise<any> {
  const r = await gh(cfg, 'POST', '/graphql', { query, variables });
  if (r?.errors?.length) throw new ServiceError('github', 200, r.errors.map((e: any) => e.message).join('; '));
  return r.data;
}

// ---- Slack bot (no chat:write.public, no im:write) ------------------------------------------------------------------

export async function slack(cfg: Config, method: string, params: Record<string, unknown>, post = false): Promise<any> {
  const token = readIdentities().slack?.botToken;
  if (!token) throw new ServiceError('slack', 0, 'no Slack bot identity configured');
  const base = cfg.slack.apiUrl.replace(/\/+$/, '');
  let r: any;
  if (post) {
    r = await call('slack', `${base}/${method}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify(params) });
  } else {
    const u = new URL(`${base}/${method}`);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
    r = await call('slack', u.toString(), { method: 'GET', headers: { authorization: `Bearer ${token}` } });
  }
  if (!r?.ok) throw new ServiceError('slack', 200, String(r?.error || 'not ok'));
  return r;
}

/** Every message of one thread, root first (paged). */
export async function slackThread(cfg: Config, channel: string, ts: string, max = 1000): Promise<any[]> {
  const out: any[] = [];
  let cursor: string | undefined;
  do {
    const r = await slack(cfg, 'conversations.replies', { channel, ts, limit: 200, ...(cursor ? { cursor } : {}) });
    out.push(...(r.messages || []));
    cursor = r.response_metadata?.next_cursor || undefined;
  } while (cursor && out.length < max);
  return out;
}

// ---- Linear (team-scoped by the gatekeeper's checks) ------------------------------------------------------------------

export async function linear(cfg: Config, query: string, variables: Record<string, unknown> = {}): Promise<any> {
  const key = readIdentities().linear?.apiKey;
  if (!key) throw new ServiceError('linear', 0, 'no Linear identity configured');
  const r = await call('linear', cfg.linear.apiUrl, { method: 'POST', headers: { authorization: key, 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }) });
  if (r?.errors?.length) throw new ServiceError('linear', 200, r.errors.map((e: any) => e.message).join('; '));
  return r.data;
}

// ---- Sentry (no alert-rule write; an optional separate identity is used ONLY after an approval) --------------------------

export async function sentry(cfg: Config, method: string, p: string, body?: unknown, opts: { alerts?: boolean } = {}): Promise<any> {
  const ids = readIdentities().sentry || {};
  const token = opts.alerts ? ids.alertsToken : ids.token;
  if (!token) throw new ServiceError('sentry', 0, opts.alerts ? 'no alert-rule identity configured (sentry.alertsToken) — approved rule changes cannot run' : 'no Sentry identity configured');
  return call('sentry', `${cfg.sentry.baseUrl.replace(/\/+$/, '')}${p}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
