// "Pick a repository" for the onboarding repo step: the repos the connected GitHub account can see, searchable.
//
// The token comes from whatever the host already holds — GH_TOKEN / GITHUB_TOKEN, the read-only ARIGAMI_GIT_TOKEN,
// the `x-access-token` line the wizard writes to ~/.git-credentials, or `gh auth token` — and is only ever sent to
// api.github.com. Read-only tokens are enough: nothing here writes.
//
// Large accounts: `GET /user/repos` is walked server-side (100 per page, capped at MAX_PAGES pages = 1000 repos,
// cached for a minute per token) and filtered by the query, so typing narrows instantly and an org with hundreds
// of repos does not cost one GitHub request per keystroke. When the account has more than the cap, or the query is
// `owner/name`, the GitHub search API is asked as well. Every failure comes back as `{ok:false, code, message}` with
// text a person can act on — never a stack trace, never the token.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { HOME } from './platform.js';

export interface GhRepo {
  fullName: string;
  owner: string;
  name: string;
  private: boolean;
  description: string;
  updatedAt: string;
  defaultBranch: string;
  /** https clone URL — what the repo step's source field takes. */
  url: string;
}

export type RepoListResult =
  | { ok: true; items: GhRepo[]; page: number; perPage: number; hasMore: boolean; total: number; truncated: boolean; login: string | null; source: string }
  | { ok: false; code: 'no_token' | 'bad_token' | 'rate_limited' | 'forbidden' | 'unreachable' | 'error'; message: string; retryAfter?: number };

export interface GhDeps {
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  /** `gh auth token` — injectable for tests. */
  ghToken?: () => string | null;
  /** ~/.git-credentials text — injectable for tests. */
  credentials?: () => string;
  now?: () => number;
}

// ARIGAMI_GITHUB_API points this at a GitHub Enterprise API (or a test double); operator-set, never request-derived.
const API = (process.env.ARIGAMI_GITHUB_API || 'https://api.github.com').replace(/\/+$/, '');
const PER_PAGE = 100;
export const MAX_PAGES = 10;
const CACHE_MS = 60_000;

const defaultGhToken = (): string | null => {
  try {
    const r = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8', timeout: 5000 });
    const t = String(r.stdout || '').trim();
    return r.status === 0 && t ? t : null;
  } catch {
    return null;
  }
};
const defaultCredentials = (): string => {
  try {
    return fs.readFileSync(path.join(HOME, '.git-credentials'), 'utf8');
  } catch {
    return '';
  }
};

/** The GitHub token this host can use, and where it came from (never logged). */
export function resolveToken(deps: GhDeps = {}): { token: string; source: string } | null {
  const env = deps.env || process.env;
  for (const k of ['GH_TOKEN', 'GITHUB_TOKEN', 'ARIGAMI_GIT_TOKEN']) {
    const v = String(env[k] || '').trim();
    if (v) return { token: v, source: k };
  }
  for (const line of (deps.credentials || defaultCredentials)().split('\n')) {
    const m = /^https:\/\/[^:@/]+:([^@/\s]+)@github\.com\/?$/.exec(line.trim());
    if (m) return { token: decodeURIComponent(m[1]), source: '.git-credentials' };
  }
  const t = (deps.ghToken || defaultGhToken)();
  return t ? { token: t, source: 'gh' } : null;
}

function mapRepo(r: any): GhRepo {
  const full = String(r?.full_name || '');
  const [owner, ...rest] = full.split('/');
  return {
    fullName: full,
    owner: owner || String(r?.owner?.login || ''),
    name: rest.join('/') || String(r?.name || ''),
    private: !!r?.private,
    description: String(r?.description || '').slice(0, 200),
    updatedAt: String(r?.pushed_at || r?.updated_at || ''),
    defaultBranch: String(r?.default_branch || ''),
    url: String(r?.clone_url || `https://github.com/${full}.git`),
  };
}

class GhError extends Error {
  constructor(public code: Extract<RepoListResult, { ok: false }>['code'], message: string, public retryAfter?: number) {
    super(message);
  }
}

async function gh(f: typeof fetch, token: string, pathAndQuery: string, now: () => number): Promise<{ body: any; link: string }> {
  let res: Response;
  try {
    res = await f(`${API}${pathAndQuery}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'arigami' },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new GhError('unreachable', 'Could not reach GitHub. Check this machine’s internet connection and try again.');
  }
  if (res.ok) return { body: await res.json().catch(() => null), link: res.headers.get('link') || '' };
  const remaining = res.headers.get('x-ratelimit-remaining');
  const reset = Number(res.headers.get('x-ratelimit-reset') || 0);
  if (res.status === 401) throw new GhError('bad_token', 'GitHub rejected the saved sign-in (expired or revoked). Connect GitHub again, or paste the repository URL below.');
  if (res.status === 429 || (res.status === 403 && remaining === '0')) {
    const wait = reset ? Math.max(1, Math.ceil(reset - now() / 1000)) : Number(res.headers.get('retry-after') || 60);
    throw new GhError('rate_limited', `GitHub’s rate limit was reached. Try again in about ${Math.max(1, Math.ceil(wait / 60))} minute(s), or paste the repository URL below.`, wait);
  }
  if (res.status === 403) throw new GhError('forbidden', 'GitHub refused to list repositories with this sign-in (the token may lack repository read access, or an organization requires SSO approval). Paste the repository URL below instead.');
  throw new GhError('error', `GitHub answered ${res.status}. Try again, or paste the repository URL below.`);
}

type Listed = { repos: GhRepo[]; truncated: boolean; login: string | null };
const cache = new Map<string, { at: number; v: Listed }>();
export const _clearCache = (): void => cache.clear();

async function listAll(f: typeof fetch, token: string, now: () => number): Promise<Listed> {
  const hit = cache.get(token);
  if (hit && now() - hit.at < CACHE_MS) return hit.v;
  const repos: GhRepo[] = [];
  let truncated = false;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { body, link } = await gh(f, token, `/user/repos?per_page=${PER_PAGE}&page=${page}&sort=pushed&affiliation=owner,collaborator,organization_member`, now);
    for (const r of Array.isArray(body) ? body : []) repos.push(mapRepo(r));
    if (!/rel="next"/.test(link)) break;
    if (page === MAX_PAGES) truncated = true;
  }
  let login: string | null = null;
  try { login = String((await gh(f, token, '/user', now)).body?.login || '') || null; } catch { /* fine-grained tokens may not read /user */ }
  const v = { repos, truncated, login };
  cache.set(token, { at: now(), v });
  if (cache.size > 8) cache.delete(cache.keys().next().value as string);
  return v;
}

/** Search the GitHub API for `owner/name` style queries and for accounts bigger than the walked cap. */
async function search(f: typeof fetch, token: string, q: string, listed: Listed, now: () => number): Promise<GhRepo[]> {
  const [ownerPart, namePart] = q.includes('/') ? [q.split('/')[0], q.split('/').slice(1).join('/')] : ['', q];
  const owners = ownerPart ? [ownerPart] : [...new Set([listed.login, ...listed.repos.map((r) => r.owner)].filter(Boolean) as string[])].slice(0, 6);
  if (!owners.length || !/^[\w.\-]+$/.test(ownerPart || 'x') || !/^[\w.\-]*$/.test(namePart)) return [];
  const query = `${namePart} in:name ${owners.map((o) => `user:${o}`).join(' ')}`.trim();
  try {
    const { body } = await gh(f, token, `/search/repositories?q=${encodeURIComponent(query)}&per_page=30&sort=updated`, now);
    return (Array.isArray(body?.items) ? body.items : []).map(mapRepo);
  } catch {
    return []; // search is best-effort; the walked list is the answer
  }
}

/** Substring match on "owner/name" (and the description), case-insensitive; every whitespace-separated term must hit. */
export function matches(r: GhRepo, q: string): boolean {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hay = `${r.fullName} ${r.description}`.toLowerCase();
  return terms.every((t) => hay.includes(t));
}

export async function listGithubRepos(opts: { q?: string; page?: number; perPage?: number } = {}, deps: GhDeps = {}): Promise<RepoListResult> {
  const now = deps.now || Date.now;
  const f = deps.fetch || fetch;
  const tok = resolveToken(deps);
  if (!tok) return { ok: false, code: 'no_token', message: 'GitHub is not connected on this host yet. Connect GitHub first, or paste the repository URL below.' };
  const q = String(opts.q || '').trim().slice(0, 100);
  const perPage = Math.min(50, Math.max(1, Math.floor(Number(opts.perPage)) || 20));
  const page = Math.max(1, Math.floor(Number(opts.page)) || 1);
  try {
    const listed = await listAll(f, tok.token, now);
    let pool = q ? listed.repos.filter((r) => matches(r, q)) : listed.repos;
    if (q && (listed.truncated || q.includes('/')) && pool.length < perPage) {
      const seen = new Set(pool.map((r) => r.fullName.toLowerCase()));
      const extra = (await search(f, tok.token, q, listed, now)).filter((r) => !seen.has(r.fullName.toLowerCase()));
      pool = [...pool, ...extra];
    }
    const start = (page - 1) * perPage;
    return {
      ok: true,
      items: pool.slice(start, start + perPage),
      page, perPage,
      hasMore: start + perPage < pool.length,
      total: pool.length,
      truncated: listed.truncated,
      login: listed.login,
      source: tok.source,
    };
  } catch (e) {
    if (e instanceof GhError) return { ok: false, code: e.code, message: e.message, ...(e.retryAfter ? { retryAfter: e.retryAfter } : {}) };
    return { ok: false, code: 'error', message: 'Could not list repositories. Paste the repository URL below instead.' };
  }
}
