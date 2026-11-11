// The repo picker's server side: token resolution, server-side search, paging, and friendly failures.
// GitHub is mocked at the fetch boundary — no network, no gh.
import { test, expect, beforeEach } from 'bun:test';
import { listGithubRepos, resolveToken, matches, _clearCache, MAX_PAGES } from '../server/lib/github-repos.ts';

const repo = (full: string, extra: Record<string, unknown> = {}) => ({ full_name: full, private: false, pushed_at: '2026-01-01T00:00:00Z', default_branch: 'main', clone_url: `https://github.com/${full}.git`, description: '', ...extra });
const json = (body: unknown, headers: Record<string, string> = {}, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const deps = (fetchImpl: any, env: Record<string, string> = { GH_TOKEN: 'ghp_test_token_aaaaaaaaaaaaaaaaaaaa' }) => ({ fetch: fetchImpl, env, ghToken: () => null, credentials: () => '', now: () => 1_000_000 });

beforeEach(() => _clearCache());

test('token: env first, then the wizard’s .git-credentials, then gh; none → null', () => {
  expect(resolveToken({ env: { GITHUB_TOKEN: 'x1' }, ghToken: () => 'g', credentials: () => '' })).toEqual({ token: 'x1', source: 'GITHUB_TOKEN' });
  expect(resolveToken({ env: { ARIGAMI_GIT_TOKEN: 'ro' }, ghToken: () => null, credentials: () => '' })?.source).toBe('ARIGAMI_GIT_TOKEN');
  expect(resolveToken({ env: {}, ghToken: () => 'g', credentials: () => 'https://x-access-token:abc123@github.com\n' })).toEqual({ token: 'abc123', source: '.git-credentials' });
  expect(resolveToken({ env: {}, ghToken: () => 'from-gh', credentials: () => '' })).toEqual({ token: 'from-gh', source: 'gh' });
  expect(resolveToken({ env: {}, ghToken: () => null, credentials: () => '' })).toBeNull();
});

test('no token → friendly no_token, no request made', async () => {
  let calls = 0;
  const r = await listGithubRepos({}, { ...deps(async () => { calls++; return json([]); }, {}) });
  expect(r).toMatchObject({ ok: false, code: 'no_token' });
  expect(calls).toBe(0);
});

test('lists with the bearer token to api.github.com only; maps owner/name, private, updatedAt', async () => {
  const seen: { url: string; auth: string }[] = [];
  const f = async (url: any, init: any) => {
    seen.push({ url: String(url), auth: init.headers.authorization });
    if (String(url).includes('/user/repos')) return json([repo('acme/api', { private: true }), repo('me/site', { description: 'my site' })]);
    return json({ login: 'me' });
  };
  const r: any = await listGithubRepos({}, deps(f));
  expect(r.ok).toBe(true);
  expect(r.items.map((i: any) => i.fullName)).toEqual(['acme/api', 'me/site']);
  expect(r.items[0]).toMatchObject({ owner: 'acme', name: 'api', private: true, url: 'https://github.com/acme/api.git' });
  expect(r.login).toBe('me');
  expect(seen.every((s) => s.url.startsWith('https://api.github.com/') && s.auth === 'Bearer ghp_test_token_aaaaaaaaaaaaaaaaaaaa')).toBe(true);
});

test('query filters server-side over every page of the account, and paging reports hasMore', async () => {
  const pages: Record<string, any[]> = {
    '1': Array.from({ length: 100 }, (_, i) => repo(`org-a/svc-${i}`)),
    '2': [repo('org-b/billing-api'), repo('org-c/billing-ui'), repo('me/notes')],
  };
  const f = async (url: any) => {
    const u = new URL(String(url));
    if (u.pathname === '/user/repos') {
      const p = u.searchParams.get('page')!;
      return json(pages[p] || [], p === '1' ? { link: '<https://api.github.com/user/repos?page=2>; rel="next"' } : {});
    }
    return json({ login: 'me' });
  };
  const q: any = await listGithubRepos({ q: 'billing' }, deps(f));
  expect(q.items.map((i: any) => i.fullName)).toEqual(['org-b/billing-api', 'org-c/billing-ui']);
  expect(q.total).toBe(2);
  const p1: any = await listGithubRepos({ page: 1, perPage: 50 }, deps(f));
  expect(p1.items.length).toBe(50);
  expect(p1.hasMore).toBe(true);
  const p3: any = await listGithubRepos({ page: 3, perPage: 50 }, deps(f));
  expect(p3.items.length).toBe(3);
  expect(p3.hasMore).toBe(false);
});

test('an account larger than the walked cap is flagged truncated and the search API fills the gap', async () => {
  const urls: string[] = [];
  const f = async (url: any) => {
    const u = new URL(String(url));
    urls.push(u.pathname);
    if (u.pathname === '/user/repos') return json([repo('big/one')], { link: '<x>; rel="next"' });
    if (u.pathname === '/search/repositories') return json({ items: [repo('big/needle-repo')] });
    return json({ login: 'me' });
  };
  const r: any = await listGithubRepos({ q: 'needle' }, deps(f));
  expect(r.truncated).toBe(true);
  expect(urls.filter((p) => p === '/user/repos').length).toBe(MAX_PAGES);
  expect(r.items.map((i: any) => i.fullName)).toEqual(['big/needle-repo']);
});

test('failures are friendly and never echo the token', async () => {
  const bad: any = await listGithubRepos({}, deps(async () => json({ message: 'Bad credentials' }, {}, 401)));
  expect(bad).toMatchObject({ ok: false, code: 'bad_token' });
  _clearCache();
  const rl: any = await listGithubRepos({}, deps(async () => json({}, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(1000 + 120) }, 403)));
  expect(rl).toMatchObject({ ok: false, code: 'rate_limited', retryAfter: 120 });
  expect(rl.message).toContain('minute');
  _clearCache();
  const sso: any = await listGithubRepos({}, deps(async () => json({}, {}, 403)));
  expect(sso.code).toBe('forbidden');
  _clearCache();
  const down: any = await listGithubRepos({}, deps(async () => { throw new Error('ENOTFOUND'); }));
  expect(down.code).toBe('unreachable');
  for (const r of [bad, rl, sso, down]) expect(JSON.stringify(r)).not.toContain('ghp_test_token');
});

test('matches: every term, case-insensitive, owner/name or description', () => {
  const r = { fullName: 'Acme/Billing-API', description: 'invoices', owner: 'Acme', name: 'Billing-API', private: false, updatedAt: '', defaultBranch: '', url: '' };
  expect(matches(r, 'acme bill')).toBe(true);
  expect(matches(r, 'acme/billing')).toBe(true);
  expect(matches(r, 'invoice')).toBe(true);
  expect(matches(r, 'zzz')).toBe(false);
});
