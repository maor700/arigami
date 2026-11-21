// The gemini provider's account/quota layer: the machine's agy login is a live pointer, and its quota is Google's 5-hour bucket.
import { test, expect, beforeEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInChild } from './_child.js';
import { tmpDir } from './_tmp.js';
import * as gm from '../server/gemini-account.js';
import { PROVIDERS, providerForEngine, providerCatalog } from '../server/lib/providers.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/gemini');
const fixture = (n: string) => JSON.parse(fs.readFileSync(path.join(FIX, n), 'utf8'));
const SECRET = 'ya29.test-access-token-never-printed';

function tokenFile(expiry: string, extra: Record<string, unknown> = {}) {
  const dir = tmpDir('arigami-gemini-');
  const file = path.join(dir, 'antigravity-oauth-token');
  fs.writeFileSync(file, JSON.stringify({ token: { access_token: SECRET, token_type: 'Bearer', refresh_token: 'r', expiry, expires_in: 3599 }, auth_method: 'consumer', id_token_email: 'someone@example.com', ...extra }));
  return file;
}

/** A fetch that answers the three cloudcode-pa endpoints from the fixtures and records what it was asked. */
function fakeFetch(over: Record<string, { status?: number; json?: unknown }> = {}) {
  const calls: { ep: string; auth: string; ua: string; body: string }[] = [];
  const impl = (async (url: any, init: any) => {
    const ep = String(url).split(':').pop() as string;
    calls.push({ ep, auth: init.headers.authorization, ua: init.headers['user-agent'], body: init.body });
    const o = over[ep] || {};
    const json = o.json ?? (ep === 'retrieveUserQuotaSummary' ? fixture('quota-summary.json') : ep === 'fetchAvailableModels' ? fixture('available-models.json') : { currentTier: { id: 'free-tier', name: 'Antigravity' }, paidTier: { id: 'g1-pro-tier', name: 'Google AI Pro' } });
    return { status: o.status ?? 200, ok: (o.status ?? 200) < 400, json: async () => json };
  }) as unknown as typeof fetch;
  return { impl, calls };
}

beforeEach(() => gm.resetGeminiCaches());

test('the provider registry knows gemini: its own engine, one local account type, nothing to add from the cockpit', () => {
  expect(PROVIDERS.gemini.engine).toBe('gemini');
  expect(PROVIDERS.gemini.localType).toBe('gemini-home');
  expect(PROVIDERS.gemini.types).toEqual(['gemini-home']);
  expect(PROVIDERS.gemini.methods).toEqual([]);
  expect(providerForEngine('gemini')).toBe('gemini');
  expect(providerForEngine('codex')).toBe('codex');
  expect(providerCatalog().map((p) => p.id)).toEqual(['claude', 'codex', 'gemini']);
});

test('normalizeGeminiQuota: the shared Gemini 5-hour bucket becomes the session window; the Claude/GPT group stays separate', () => {
  const u = gm.normalizeGeminiQuota(fixture('quota-summary.json'), fixture('available-models.json'), 1000);
  expect(u.available).toBe(true);
  // remainingFraction 0.9737 → 3% used, with Google's own reset time
  expect(u.session).toEqual({ pct: 3, resetsAt: '2026-11-22T03:34:12Z', windowMins: 300 });
  expect(u.week).toBeNull(); // Gemini has no weekly bucket
  expect(u.limitReached).toBe(false);
  expect(u.fetchedAt).toBe(1000);
  // the 3p-* buckets belong to Claude/GPT-through-Google, never to the Gemini meter
  expect(u.thirdParty).toEqual({
    session: { pct: 0, resetsAt: '2026-11-22T03:46:20Z', windowMins: 300 },
    week: { pct: 0, resetsAt: '2026-11-28T22:46:20Z', windowMins: 10080 },
  });
});

test('normalizeGeminiQuota: the tightest Gemini model wins, an empty bucket reads as exhausted, a Gemini group in the summary takes over', () => {
  const tight = gm.normalizeGeminiQuota(null, { models: { 'gemini-a': { quotaInfo: { remainingFraction: 0.5, resetTime: 'T1' } }, 'gemini-b': { quotaInfo: { remainingFraction: 0.2, resetTime: 'T2' } }, 'claude-x': { quotaInfo: { remainingFraction: 0.01, resetTime: 'T3' } } } });
  expect(tight.session).toEqual({ pct: 80, resetsAt: 'T2', windowMins: 300 });
  // proto3 JSON omits a zero remainingFraction
  const out = gm.normalizeGeminiQuota(null, { models: { 'gemini-a': { quotaInfo: { resetTime: 'T1' } } } });
  expect(out.session?.pct).toBe(100);
  expect(out.limitReached).toBe(true);
  const grouped = gm.normalizeGeminiQuota(
    { groups: [{ displayName: 'Gemini models', buckets: [{ bucketId: 'g-5h', window: '5h', resetTime: 'T5', remainingFraction: 0.25 }, { bucketId: 'g-weekly', window: 'weekly', resetTime: 'TW', remainingFraction: 0.9 }] }] },
    { models: { 'gemini-a': { quotaInfo: { remainingFraction: 1, resetTime: 'T1' } } } }
  );
  expect(grouped.session).toEqual({ pct: 75, resetsAt: 'T5', windowMins: 300 });
  expect(grouped.week).toEqual({ pct: 10, resetsAt: 'TW', windowMins: 10080 });
  // nothing about Gemini at all → unavailable, never a made-up 0%
  expect(gm.normalizeGeminiQuota(fixture('quota-summary.json'), { models: {} })).toEqual({ available: false, reason: 'unavailable' });
});

test('readGeminiLogin reads agy\'s file as-is and survives a missing or broken one', () => {
  const file = tokenFile('2099-01-01T00:00:00Z');
  const before = fs.readFileSync(file, 'utf8');
  expect(gm.readGeminiLogin(file)).toEqual({ token: SECRET, email: 'someone@example.com', expiresAt: Date.parse('2099-01-01T00:00:00Z') });
  expect(fs.readFileSync(file, 'utf8')).toBe(before); // read-only
  expect(gm.readGeminiLogin(path.join(path.dirname(file), 'nope'))).toBeNull();
  fs.writeFileSync(file, 'not json');
  expect(gm.readGeminiLogin(file)).toBeNull();
});

test('geminiUsage: two quota calls with the bearer token, then a 5-minute cache; the token never appears in the result', async () => {
  const file = tokenFile('2099-01-01T00:00:00Z');
  const f = fakeFetch();
  let now = 1_000_000;
  const u = await gm.geminiUsage({ file, fetchImpl: f.impl, now: () => now });
  expect(u.session?.pct).toBe(3);
  expect(f.calls.map((c) => c.ep).sort()).toEqual(['fetchAvailableModels', 'retrieveUserQuotaSummary']);
  expect(f.calls.every((c) => c.auth === `Bearer ${SECRET}` && /^antigravity\//.test(c.ua) && c.body === '{}')).toBe(true);
  expect(JSON.stringify(u)).not.toContain(SECRET);
  // the usage poller asks every minute — the provider is asked once per 5 minutes
  now += 4 * 60_000;
  expect(await gm.geminiUsage({ file, fetchImpl: f.impl, now: () => now })).toBe(u);
  expect(f.calls.length).toBe(2);
  now += 2 * 60_000;
  await gm.geminiUsage({ file, fetchImpl: f.impl, now: () => now });
  expect(f.calls.length).toBe(4);
});

test('geminiUsage: signed out → no-credentials; a 401 is reported; a network failure keeps the last good reading', async () => {
  const f = fakeFetch();
  expect(await gm.geminiUsage({ file: path.join(tmpDir('arigami-gemini-'), 'missing'), fetchImpl: f.impl })).toEqual({ available: false, reason: 'no-credentials' });
  expect(f.calls.length).toBe(0);

  gm.resetGeminiCaches();
  const file = tokenFile('2099-01-01T00:00:00Z');
  const denied = fakeFetch({ retrieveUserQuotaSummary: { status: 401, json: {} }, fetchAvailableModels: { status: 401, json: {} } });
  expect(await gm.geminiUsage({ file, fetchImpl: denied.impl })).toEqual({ available: false, reason: 'http-401' });
  await gm.geminiUsage({ file, fetchImpl: denied.impl });
  expect(denied.calls.length).toBe(2); // a refusal is not re-asked every poll

  gm.resetGeminiCaches();
  let now = 1_000_000;
  const good = await gm.geminiUsage({ file, fetchImpl: fakeFetch().impl, now: () => now });
  now += 6 * 60_000;
  const broken = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
  expect(await gm.geminiUsage({ file, fetchImpl: broken, now: () => now })).toBe(good);
});

test('a lapsed token: agy renews its own file only while someone is looking, at most hourly; nothing is fetched with a dead token', async () => {
  const file = tokenFile('2020-01-01T00:00:00Z');
  const f = fakeFetch();
  let now = Date.parse('2026-11-22T00:00:00Z');
  let refreshes = 0;
  const stuck = { file, fetchImpl: f.impl, now: () => now, refreshLogin: async () => { refreshes++; } };
  // the background poll alone never runs agy
  expect(await gm.geminiUsage(stuck)).toEqual({ available: false, reason: 'token-expired' });
  expect(refreshes).toBe(0);
  expect(f.calls.length).toBe(0);
  // the Accounts page was opened → the very next poll makes one attempt
  gm.noteGeminiDemand(now);
  expect(await gm.geminiUsage(stuck)).toEqual({ available: false, reason: 'token-expired' });
  expect(refreshes).toBe(1);
  now += 10 * 60_000;
  gm.noteGeminiDemand(now);
  await gm.geminiUsage({ ...stuck, force: true });
  expect(refreshes).toBe(1); // not again within the hour
  expect(f.calls.length).toBe(0);
  // an hour on, still looking: agy renews the file → the read works
  now += 60 * 60_000;
  gm.noteGeminiDemand(now);
  const renew = async () => { refreshes++; fs.writeFileSync(file, JSON.stringify({ token: { access_token: SECRET, expiry: '2099-01-01T00:00:00Z' }, id_token_email: 'someone@example.com' })); };
  const u = await gm.geminiUsage({ ...stuck, refreshLogin: renew, force: true });
  expect(refreshes).toBe(2);
  expect(u.available).toBe(true);
  // demand goes stale after 15 minutes
  gm.resetGeminiCaches();
  fs.writeFileSync(file, JSON.stringify({ token: { access_token: SECRET, expiry: '2020-01-01T00:00:00Z' } }));
  gm.noteGeminiDemand(now - 16 * 60_000);
  await gm.geminiUsage({ ...stuck, force: true });
  expect(refreshes).toBe(2);
});

test('geminiIdentity: the email comes from the token file, the plan tier from loadCodeAssist (paid tier first), cached', async () => {
  const file = tokenFile('2099-01-01T00:00:00Z');
  const f = fakeFetch();
  expect(await gm.geminiIdentity({ file, fetchImpl: f.impl })).toEqual({ email: 'someone@example.com', plan: 'Google AI Pro' });
  expect(f.calls.map((c) => c.ep)).toEqual(['loadCodeAssist']);
  expect(JSON.parse(f.calls[0].body).metadata).toMatchObject({ ideType: 'ANTIGRAVITY', pluginType: 'GEMINI' });
  await gm.geminiIdentity({ file, fetchImpl: f.impl });
  expect(f.calls.length).toBe(1);
  // a call that yields no plan is not repeated on the next poll; a lapsed token asks nothing
  gm.resetGeminiCaches();
  const none = fakeFetch({ loadCodeAssist: { status: 403, json: {} } });
  let now = 1_000_000;
  expect(await gm.geminiIdentity({ file, fetchImpl: none.impl, now: () => now })).toEqual({ email: 'someone@example.com', plan: null });
  now += 60_000;
  await gm.geminiIdentity({ file, fetchImpl: none.impl, now: () => now });
  expect(none.calls.length).toBe(1);
  now += 5 * 60_000;
  await gm.geminiIdentity({ file, fetchImpl: none.impl, now: () => now });
  expect(none.calls.length).toBe(2);
  gm.resetGeminiCaches();
  const lapsed = fakeFetch();
  expect(await gm.geminiIdentity({ file: tokenFile('2020-01-01T00:00:00Z'), fetchImpl: lapsed.impl })).toEqual({ email: 'someone@example.com', plan: null });
  expect(lapsed.calls.length).toBe(0);
  gm.resetGeminiCaches();
  const free = fakeFetch({ loadCodeAssist: { json: { currentTier: { id: 'free-tier', name: 'Antigravity' } } } });
  expect((await gm.geminiIdentity({ file, fetchImpl: free.impl })).plan).toBe('Antigravity');
  expect(await gm.geminiIdentity({ file: path.join(path.dirname(file), 'nope'), fetchImpl: free.impl })).toEqual({ email: null, plan: null });
});

test("the machine's agy login is seeded as a gemini-home account: active for gemini only, a pointer with no token in accounts.json", () => {
  const dir = tmpDir('arigami-acct-geminihome-');
  const home = path.join(dir, 'gemini-home');
  fs.mkdirSync(path.join(home, 'antigravity-cli'), { recursive: true });
  fs.writeFileSync(path.join(home, 'antigravity-cli', 'antigravity-oauth-token'), JSON.stringify({ token: { access_token: SECRET, expiry: '2099-01-01T00:00:00Z' }, id_token_email: 'someone@example.com' }));
  fs.writeFileSync(
    path.join(dir, 'accounts.json'),
    JSON.stringify({ activeId: 'acc_tok', accounts: [{ id: 'acc_tok', label: 'Work', provider: 'claude', type: 'oauth-token', pool: true, token: { v: 0, t: 'sk-ant-oat01-x' } }] })
  );
  const r = runInChild(
    "const a=await import('./server/accounts.js');a.initAccounts();" +
      'const l=a.listAccounts();const g=l.accounts.find(x=>x.provider==="gemini");' +
      'emit({types:l.accounts.map(x=>x.provider+":"+x.type),activeIds:l.activeIds,gActive:g.active,pickGemini:a.pickSessionAccount("gemini")===g.id,pickClaude:a.pickSessionAccount("claude"),' +
      'token:a.resolveToken(g.id),forSession:a.tokenForSession(g.id)&&a.tokenForSession(g.id).account.id,has:a.hasCredentials("gemini"),next:a.nextAvailable("acc_tok"),again:a.adoptLocalLogins(),count:a.listAccounts().accounts.length,' +
      'stale:a.sanitizeAccountsForExport({activeIds:{gemini:g.id},accounts:[{id:g.id,provider:"gemini",type:"gemini-home",pool:true}]})});',
    { ARIGAMI_DIR: dir, HOME: dir, ARIGAMI_CODEX_HOME: path.join(dir, 'no-codex-here'), ARIGAMI_GEMINI_HOME: home }
  );
  expect(r.ok).toBe(true);
  const o = r.out[0];
  expect(o.types).toEqual(['claude:oauth-token', 'gemini:gemini-home']);
  expect(o.activeIds.claude).toBe('acc_tok');
  expect(o.gActive).toBe(true);
  expect(o.pickGemini).toBe(true);
  expect(o.pickClaude).toBe('acc_tok');
  expect(o.token).toBeNull(); // no bearer token is ever handed out for a gemini account
  expect(o.forSession).toBe('acc_tok'); // a claude spawn asked for it gets the active claude account
  expect(o.has).toBe(true);
  expect(o.next).toBeNull(); // auto-switch never hops providers
  expect(o.again).toBe(false); // adopting twice adds nothing
  expect(o.count).toBe(2);
  expect(o.stale.accounts[0]).toMatchObject({ type: 'gemini-home-stale', pool: false, needsReauth: true });
  expect(o.stale.activeIds.gemini).toBeNull();
  // the store holds a pointer, never the credential
  expect(fs.readFileSync(path.join(dir, 'accounts.json'), 'utf8')).not.toContain(SECRET);
});

test('a login made after boot is adopted without a restart; a machine with no agy login gets no gemini account', () => {
  const dir = tmpDir('arigami-acct-geminilate-');
  const home = path.join(dir, 'gemini-home');
  const r = runInChild(
    "const fs=await import('node:fs');const a=await import('./server/accounts.js');a.initAccounts();" +
      'const before=a.listAccounts().accounts.map(x=>x.type);const hasBefore=a.hasCredentials("gemini");' +
      `fs.mkdirSync(${JSON.stringify(path.join(home, 'antigravity-cli'))},{recursive:true});fs.writeFileSync(${JSON.stringify(path.join(home, 'antigravity-cli', 'antigravity-oauth-token'))},'{}');` +
      'emit({before,hasBefore,adopted:a.adoptLocalLogins(),after:a.listAccounts().accounts.map(x=>x.type),active:a.getActiveId("gemini")!==null});',
    { ARIGAMI_DIR: dir, HOME: dir, ARIGAMI_CODEX_HOME: path.join(dir, 'no-codex-here'), ARIGAMI_GEMINI_DIR: home, CLAUDE_CODE_OAUTH_TOKEN: '' }
  );
  expect(r.ok).toBe(true);
  expect(r.out[0]).toEqual({ before: [], hasBefore: false, adopted: true, after: ['gemini-home'], active: true });
});
