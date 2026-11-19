// The bundled gatekeeper extension (extensions/gatekeeper): its decision logic — operator check by Slack user id, the
// auto-rule, every scope check — and the tools end to end against a fake network. Plus the core seams it needs:
// profile grants narrow like everything else, a bundled extension is off by default, and a restricted-audience
// extension never reaches a Full session's spawn.
import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import * as D from '../extensions/gatekeeper/lib/decide.ts';
import * as sp from '../server/session-profile.ts';
import { runInChild } from './_child.js';
import { tmpDir } from './_tmp.js';

const REPO = path.resolve(import.meta.dir, '..');
const OP = 'UOPERATOR1';
const STRANGER = 'USTRANGER1';
const NOW = 1_800_000_000_000;
const tsAt = (minAgo: number) => ((NOW - minAgo * 60_000) / 1000).toFixed(6);
const THREAD = tsAt(120);
const B: D.Binding = { channel: 'CINCIDENT1', thread_ts: THREAD, by: 'admin', at: '' };

const caller = (grants: string[], over: Partial<D.Caller> = {}): D.Caller => ({
  session: 's1',
  shared: true,
  hostCall: false,
  profile: { name: 'fix', grants: grants.map((g) => D.GRANT_PREFIX + g), parent: null },
  lineage: [],
  cwd: '/work/s1',
  ...over,
});

describe('who the gatekeeper serves', () => {
  test('only a restricted session, only through the host gateway', () => {
    expect(D.callerOk(caller([])).ok).toBe(true);
    expect(D.callerOk(caller([], { profile: null }))).toMatchObject({ ok: false, reason: expect.stringContaining('restricted sessions only') });
    expect(D.callerOk(caller([], { shared: false }))).toMatchObject({ ok: false, reason: expect.stringContaining('gateway') });
    expect(D.callerOk(caller([], { hostCall: true })).ok).toBe(false);
    expect(D.callerOk(caller([], { session: null })).ok).toBe(false);
    expect(D.callerOk(null).ok).toBe(false);
  });
  test('an action needs its exact grant in the effective profile', () => {
    expect(D.hasGrant(caller(['github.push']), 'github.push').ok).toBe(true);
    expect(D.hasGrant(caller(['github.push']), 'github.merge').ok).toBe(false);
    expect(D.hasGrant(caller(['github.*' as any]), 'github.merge').ok).toBe(false);
    expect(D.hasGrant(caller(['github.push']), 'github.nope').ok).toBe(false);
  });
});

describe('scope checks', () => {
  const o = { defaultBranch: 'main', protectedBranches: ['main', 'release/*'] };
  test('push: never the default or a protected branch, never a malformed ref', () => {
    expect(D.checkBranch('fix/bench-1', o).ok).toBe(true);
    for (const b of ['main', 'release/1.2', '', '../x', 'a..b', '-x', 'x.lock', 'a//b', 'a@{1}', 'x y'] as const) expect(D.checkBranch(b, o).ok).toBe(false);
    expect(D.checkBranch('develop', { defaultBranch: 'develop' }).ok).toBe(false);
    expect(D.checkBranch('feat/x', { ...o, branchPattern: '^fix/' }).ok).toBe(false);
    expect(D.checkBranch('fix/x', { ...o, branchPattern: '^fix/' }).ok).toBe(true);
  });
  test('a PR must be in the one repo, head included (no forks)', () => {
    const pr = (base: string, head: string | null) => ({ base: { repo: { full_name: base } }, head: { repo: head ? { full_name: head } : null } });
    expect(D.prInScope(pr('o/app', 'o/app'), 'o/app').ok).toBe(true);
    expect(D.prInScope(pr('o/gitops', 'o/gitops'), 'o/app').ok).toBe(false);
    expect(D.prInScope(pr('o/app', 'evil/app'), 'o/app').ok).toBe(false);
    expect(D.prInScope(null, 'o/app').ok).toBe(false);
  });
  test('a checkout path must be inside the session directory', () => {
    expect(D.pathInside('/work/s1/app', '/work/s1')).toBe(true);
    expect(D.pathInside('/work/s1', '/work/s1')).toBe(true);
    expect(D.pathInside('/work/s10', '/work/s1')).toBe(false);
    expect(D.pathInside('/work/other', '/work/s1')).toBe(false);
  });
  test('Slack: only the bound thread, no other channel, no DM, no broadcast', () => {
    expect(D.checkSlackWrite({ text: 'RCA: …' }, B).ok).toBe(true);
    expect(D.checkSlackWrite({ text: 'hi', channel: B.channel, thread_ts: B.thread_ts }, B).ok).toBe(true);
    expect(D.checkSlackWrite({ text: 'phish', channel: 'COTHER0001' }, B).ok).toBe(false);
    expect(D.checkSlackWrite({ text: 'phish', channel: 'D0123456' }, B).ok).toBe(false);
    expect(D.checkSlackWrite({ text: 'phish', thread_ts: tsAt(5) }, B).ok).toBe(false);
    expect(D.checkSlackWrite({ text: 'hi' }, null).ok).toBe(false);
    expect(D.checkSlackWrite({ text: '<!channel> look' }, B).ok).toBe(false);
    expect(D.checkSlackWrite({ text: 'hey @here' }, B).ok).toBe(false);
    expect(D.checkSlackWrite({ text: '<!subteam^S1> ping' }, B).ok).toBe(false);
    expect(D.checkSlackWrite({ text: '  ' }, B).ok).toBe(false);
  });
  test('binding: once, in the incident channel, to a thread an allowed opener started; inherited by children', () => {
    const base = { channel: 'CINCIDENT1', thread_ts: THREAD, configuredChannel: 'CINCIDENT1', openers: ['BSENTRY01', OP], existing: null, allowFirstUse: true };
    const root = { ts: THREAD, bot_id: 'BSENTRY01' };
    expect(D.checkBind({ ...base, root }).ok).toBe(true);
    expect(D.checkBind({ ...base, root: { ts: THREAD, user: OP } }).ok).toBe(true);
    expect(D.checkBind({ ...base, root: { ts: THREAD, user: STRANGER } }).ok).toBe(false);
    expect(D.checkBind({ ...base, channel: 'COTHER0001', root }).ok).toBe(false);
    expect(D.checkBind({ ...base, root, existing: B }).ok).toBe(false);
    expect(D.checkBind({ ...base, root, allowFirstUse: false }).ok).toBe(false);
    expect(D.checkBind({ ...base, root: { ts: THREAD, thread_ts: tsAt(200), user: OP } }).ok).toBe(false);
    expect(D.checkBind({ ...base, root: null }).ok).toBe(false);
    const bindings = { parent1: B };
    expect(D.effectiveBinding('child1', ['parent1'], bindings)).toMatchObject({ thread_ts: THREAD, from: 'parent1' });
    expect(D.effectiveBinding('child1', [], bindings)).toBeNull();
  });
  test('Linear, Sentry and alert rules stay in the configured team / project / rule list', () => {
    expect(D.linearInScope({ team: { id: 'T1' }, project: { id: 'P1' } }, { teamId: 'T1' }).ok).toBe(true);
    expect(D.linearInScope({ team: { id: 'T2' } }, { teamId: 'T1' }).ok).toBe(false);
    expect(D.linearInScope({ team: { id: 'T1' }, project: { id: 'P2' } }, { teamId: 'T1', projectId: 'P1' }).ok).toBe(false);
    expect(D.linearInScope({ team: { id: 'T1' } }, { teamId: '' }).ok).toBe(false);
    expect(D.sentryIssueInScope({ project: { slug: 'app' } }, { project: 'app' }).ok).toBe(true);
    expect(D.sentryIssueInScope({ project: { slug: 'other' } }, { project: 'app' }).ok).toBe(false);
    expect(D.alertRuleInScope('123', ['123']).ok).toBe(true);
    expect(D.alertRuleInScope('124', ['123']).ok).toBe(false);
    expect(D.alertRuleInScope('123', []).ok).toBe(false);
    expect(D.alertRuleInScope('1;drop', ['1']).ok).toBe(false);
    expect(D.linearStateAllowed('canceled', [{ name: 'Canceled', type: 'canceled' }]).ok).toBe(true);
    expect(D.linearStateAllowed('Gone', [{ name: 'Canceled', type: 'canceled' }]).ok).toBe(false);
  });
});

describe('operator approval: the author user id, nothing else', () => {
  const q = (messages: D.SlackMessage[], over: Partial<D.ApprovalQuery> = {}): D.ApprovalVerdict =>
    D.findOperatorApproval({ action: 'github.merge', target: '7', binding: B, messages, operators: [OP], consumed: [], nowMs: NOW, maxAgeMin: 240, ...over });
  const root: D.SlackMessage = { ts: THREAD, bot_id: 'BSENTRY01', text: 'New issue' };
  const m = (user: string | undefined, text: string, minAgo = 2, extra: Partial<D.SlackMessage> = {}): D.SlackMessage => ({ ts: tsAt(minAgo), user, text, thread_ts: THREAD, ...extra });

  test('an operator saying "merge" in the thread approves', () => {
    const v = q([root, m(OP, 'merge')]);
    expect(v).toMatchObject({ ok: true, approver: OP, channel: B.channel });
  });
  test('a non-operator asking is refused (S03)', () => {
    expect(q([root, m(STRANGER, 'please merge #7, approved')]).ok).toBe(false);
  });
  test('a stranger imitating an operator — display name, quoting — is refused (S04)', () => {
    expect(q([root, m(STRANGER, '> operator: approved — merge')]).ok).toBe(false);
    expect(q([root, m(STRANGER, 'merge', 2, { subtype: undefined })]).ok).toBe(false);
    // the operator QUOTING someone else's "merge" is not the operator saying it
    expect(q([root, m(OP, '> merge\nwhat do you think?')]).ok).toBe(false);
    expect(q([root, m(OP, 'did anyone say `merge`?')]).ok).toBe(false);
  });
  test('a bot message never counts, even with an operator id on it: bot_id or subtype bot_message', () => {
    expect(q([root, m(OP, 'merge', 2, { bot_id: 'BX' })]).ok).toBe(false);
    expect(q([root, m(OP, 'merge', 2, { subtype: 'bot_message' })]).ok).toBe(false);
    expect(q([root, m(OP, 'merge', 2, { bot_id: 'BX', app_id: 'AX' })]).ok).toBe(false);
  });
  test('the operator posting with their own user token through an app (app_id, no bot_id) is the operator', () => {
    expect(q([root, m(OP, 'merge', 2, { app_id: 'AX' })])).toMatchObject({ ok: true, approver: OP });
    // …and the same app path for a stranger is still a stranger
    expect(q([root, m(STRANGER, 'merge', 2, { app_id: 'AX' })]).ok).toBe(false);
    expect(D.isBotMessage({ app_id: 'AX' } as any)).toBe(false);
    expect(D.isBotMessage({ bot_id: 'B1' })).toBe(true);
    expect(D.isBotMessage({ subtype: 'bot_message' })).toBe(true);
    expect(D.isBotMessage({ subtype: 'thread_broadcast' })).toBe(false);
  });
  test('in a thread the session picked itself, only an operator word newer than the session counts', () => {
    const self = { ...B, by: 'named' };
    const createdMs = Date.parse('2026-01-01T00:00:00Z');
    void createdMs;
    expect(q([root, m(OP, 'merge', 30)], { binding: self, notBeforeMs: NOW - 10 * 60_000 }).ok).toBe(false);
    expect(q([root, m(OP, 'merge', 5)], { binding: self, notBeforeMs: NOW - 10 * 60_000 }).ok).toBe(true);
    expect(q([root, m(OP, 'merge', 30)], { binding: B, notBeforeMs: null }).ok).toBe(true);
  });
  test('only in the session\'s own thread, only fresh, only once, only for the PR it names', () => {
    expect(q([root, m(OP, 'merge', 2, { thread_ts: tsAt(500) })]).ok).toBe(false);
    expect(q([root, m(OP, 'merge', 300)]).ok).toBe(false);
    expect(q([root, m(OP, 'merge')], { consumed: [`${B.channel}:${tsAt(2)}`] }).ok).toBe(false);
    expect(q([root, m(OP, 'merge #8')]).ok).toBe(false);
    expect(q([root, m(OP, 'merge #7')]).ok).toBe(true);
    expect(q([root, m(OP, 'merge')], { binding: null }).ok).toBe(false);
    expect(q([root, m(OP, 'merge')], { operators: [] }).ok).toBe(false);
  });
  test('the verb must match the action', () => {
    expect(q([root, m(OP, 'revert')]).ok).toBe(false);
    expect(q([root, m(OP, 'revert')], { action: 'github.revert' }).ok).toBe(true);
    expect(q([root, m(OP, 'apply filters')], { action: 'sentry.alerts', target: '1' }).ok).toBe(true);
    expect(q([root, m(OP, 'merge')], { action: 'github.push' }).ok).toBe(false);
  });
  test('an explicit approval_ts must point at a qualifying message', () => {
    const ok = m(OP, 'merge', 3);
    const bad = m(STRANGER, 'merge', 1);
    expect(q([root, ok, bad], { approvalTs: bad.ts }).ok).toBe(false);
    expect(q([root, ok, bad], { approvalTs: ok.ts })).toMatchObject({ ok: true, ts: ok.ts });
    expect(q([root, ok], { approvalTs: tsAt(9) }).ok).toBe(false);
  });
  test('the newest qualifying operator message wins', () => {
    const older = m(OP, 'merge', 10);
    const newer = m(OP, 'merge', 1);
    expect(q([root, older, newer])).toMatchObject({ ok: true, ts: newer.ts });
  });
});

describe('the auto-rule: CI green + an approving review on the head commit', () => {
  const pr: D.PrFacts = { number: 7, state: 'open', user: { login: 'bench-bot[bot]' }, head: { sha: 'abc1234', ref: 'fix/x' }, base: { ref: 'main' } };
  const green = [{ name: 'test', status: 'completed', conclusion: 'success', head_sha: 'abc1234' }];
  const approved = [{ user: { login: 'reviewer' }, state: 'APPROVED', commit_id: 'abc1234', submitted_at: '2026-01-01T00:00:00Z' }];
  const rule: D.AutoRule = { enabled: true, requiredChecks: ['test'], approvers: [], minApprovals: 1 };
  test('green + approve on head → ok', () => {
    expect(D.checkAutoRule(rule, pr, green, [], approved)).toMatchObject({ ok: true, approvedBy: ['reviewer'] });
  });
  test('off, red, running, missing check, stale or self approval, changes requested → refused', () => {
    expect(D.checkAutoRule({ ...rule, enabled: false }, pr, green, [], approved).ok).toBe(false);
    expect(D.checkAutoRule(rule, pr, [{ ...green[0], conclusion: 'failure' }], [], approved).ok).toBe(false);
    expect(D.checkAutoRule(rule, pr, [{ ...green[0], status: 'in_progress', conclusion: null }], [], approved).ok).toBe(false);
    expect(D.checkAutoRule(rule, pr, [], [], approved).ok).toBe(false);
    expect(D.checkAutoRule(rule, pr, green, [], [{ ...approved[0], commit_id: 'old0000' }]).ok).toBe(false);
    expect(D.checkAutoRule(rule, { ...pr, user: { login: 'reviewer' } }, green, [], approved).ok).toBe(false);
    expect(D.checkAutoRule(rule, pr, green, [], [...approved, { user: { login: 'other' }, state: 'CHANGES_REQUESTED', submitted_at: '2026-01-02T00:00:00Z' }]).ok).toBe(false);
    expect(D.checkAutoRule({ ...rule, approvers: ['lead'] }, pr, green, [], approved).ok).toBe(false);
    expect(D.checkAutoRule(rule, { ...pr, draft: true }, green, [], approved).ok).toBe(false);
    expect(D.checkAutoRule(rule, pr, green, [], [{ ...approved[0], user: { login: 'ci[bot]', type: 'Bot' } }]).ok).toBe(false);
  });
  test('no required list: every check on the head must be green, and there must be one', () => {
    const all = { ...rule, requiredChecks: [] };
    expect(D.checkAutoRule(all, pr, [...green, { name: 'lint', status: 'completed', conclusion: 'failure', head_sha: 'abc1234' }], [], approved).ok).toBe(false);
    expect(D.checkAutoRule(all, pr, [], [], approved).ok).toBe(false);
    expect(D.checkAutoRule(all, pr, [], [{ context: 'ci', state: 'success' }], approved).ok).toBe(true);
  });
  test('a later re-review replaces an earlier one per reviewer', () => {
    const later = [{ user: { login: 'reviewer' }, state: 'CHANGES_REQUESTED', submitted_at: '2026-01-01T00:00:00Z' }, { ...approved[0], submitted_at: '2026-01-02T00:00:00Z' }];
    expect(D.checkAutoRule(rule, pr, green, [], later).ok).toBe(true);
  });
});

describe('profile grants (core): stored, narrowed by intersection, never widened', () => {
  const g = (...a: string[]) => a.map((x) => 'gatekeeper:' + x);
  test('a spec keeps only well-formed grants; absent = none', () => {
    expect(sp.fromSpec({}).grants).toEqual([]);
    expect(sp.fromSpec({ grants: [...g('github.push'), 'bad grant', 'gatekeeper:*'] }).grants).toEqual(g('github.push'));
  });
  test('a child gets the intersection and is within its parent', () => {
    const parent = sp.fromSpec({ tools: ['git'], grants: g('github.push', 'github.pr', 'slack.post') });
    const child = sp.narrow(parent, { tools: ['git'], grants: g('github.push', 'github.merge') })!;
    expect(child.grants).toEqual(g('github.push'));
    expect(sp.isWithin(child, parent)).toBe(true);
    expect(sp.isWithin({ ...child, grants: g('github.merge') }, parent)).toBe(false);
    // a profile stored before grants existed has none, and narrows to none
    const legacy = { ...parent } as sp.SessionProfile;
    delete legacy.grants;
    expect(sp.narrow(legacy, { grants: g('github.push') })!.grants).toEqual([]);
  });
  test('describe() carries the grants (what the gateway hands the gatekeeper)', () => {
    expect(sp.describe(sp.fromSpec({ grants: g('slack.read') }))!.grants).toEqual(g('slack.read'));
  });
});

// ---- the tools end to end, against a fake network -----------------------------------------------------------------

describe('gatekeeper tools', () => {
  let dir = '';
  let mod: any;
  let svc: any;
  let calls: { method: string; url: string; body: any }[] = [];
  let thread: any[] = [];
  const audit = () => fs.readFileSync(path.join(dir, 'audit.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const parse = (r: any) => r;

  beforeAll(async () => {
    dir = tmpDir('arigami-gk-');
    process.env.GATEKEEPER_DIR = dir;
    const crypto = await import('node:crypto');
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    fs.writeFileSync(path.join(dir, 'identities.json'), JSON.stringify({ github: { appId: '1', installationId: '2', privateKey: privateKey.export({ type: 'pkcs1', format: 'pem' }) }, slack: { botToken: 'xoxb-fake-canary-token-000' }, linear: { apiKey: 'lin_api_fake' }, sentry: { token: 'fake' } }));
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
      github: { repo: 'o/app', apiUrl: 'https://gh.test', webUrl: 'https://gh.test', autoMerge: { enabled: false } },
      slack: { apiUrl: 'https://slack.test/api', channel: 'CINCIDENT1', operators: [{ id: OP, name: 'Op' }], threadOpeners: ['BSENTRY01'] },
      linear: { teamId: 'T1' },
      sentry: { baseUrl: 'https://sentry.test', org: 'org', project: 'app', alertRules: ['55'] },
    }));
    mod = await import('../extensions/gatekeeper/tools/module.ts');
    svc = await import('../extensions/gatekeeper/lib/services.ts');
    svc.setFetch(async (url: string, init: any) => {
      const u = String(url);
      const body = init?.body ? JSON.parse(init.body) : null;
      calls.push({ method: init?.method || 'GET', url: u, body });
      const ok = (j: unknown) => new Response(JSON.stringify(j), { status: 200, headers: { 'content-type': 'application/json' } });
      if (u.includes('/access_tokens')) return ok({ token: 'ghs_faketokenfaketokenfaketoken00', expires_at: new Date(Date.now() + 3600e3).toISOString() });
      if (u.endsWith('/repos/o/app')) return ok({ full_name: 'o/app', default_branch: 'main' });
      if (/\/pulls\/7$/.test(u) && (init?.method || 'GET') === 'GET') return ok({ number: 7, state: 'open', merged: false, node_id: 'PR_7', user: { login: 'bot' }, head: { sha: 'abc1234', ref: 'fix/x', repo: { full_name: 'o/app' } }, base: { ref: 'main', repo: { full_name: 'o/app' } } });
      if (/\/pulls\/9$/.test(u)) return ok({ number: 9, state: 'open', head: { sha: 'f', ref: 'x', repo: { full_name: 'o/gitops' } }, base: { ref: 'main', repo: { full_name: 'o/gitops' } } });
      if (/\/pulls\/7\/merge$/.test(u)) return ok({ merged: true, sha: 'merged1' });
      if (u.includes('conversations.replies')) return ok({ ok: true, messages: thread });
      if (u.includes('chat.postMessage')) return ok({ ok: true, ts: '1800000000.000999' });
      if (u.includes('sentry.test') && u.includes('/workflows/55/')) return ok({ id: '55', name: 'rule', enabled: true });
      return new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
    });
  });
  afterAll(() => {
    svc?.setFetch(null);
    delete process.env.GATEKEEPER_DIR;
  });

  const run = async (name: string, args: any, c: D.Caller) => parse(await mod._test.sessionTools.find((t: any) => t.name === name).run(args, { caller: c }));
  const bound = () => fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ bindings: { s1: { channel: 'CINCIDENT1', thread_ts: THREAD, by: 'admin', at: '' } }, consumed: {} }));
  const nowTs = (minAgo: number) => ((Date.now() - minAgo * 60_000) / 1000).toFixed(6);

  test('a Full session (no profile) gets nothing, and the refusal is audited', async () => {
    const r = await run('slack_thread_say', { text: 'hi' }, caller(['slack.post'], { profile: null }));
    expect(r).toMatchObject({ ok: false, decision: 'refused' });
    expect(r.error).toContain('denied by the gatekeeper');
    expect(audit().at(-1)).toMatchObject({ tool: 'slack_thread_say', decision: 'refused' });
  });

  test('Slack: writes land in the bound thread; another channel is refused before any network call (S07)', async () => {
    bound();
    calls = [];
    const bad = await run('slack_thread_say', { text: 'Action needed', channel: 'COTHER0001' }, caller(['slack.post']));
    expect(bad.ok).toBe(false);
    expect(calls.length).toBe(0);
    const good = await run('slack_thread_say', { text: 'RCA posted' }, caller(['slack.post']));
    expect(good).toMatchObject({ ok: true, channel: 'CINCIDENT1', thread_ts: THREAD });
    const post = calls.find((c) => c.url.includes('chat.postMessage'))!;
    expect(post.body).toMatchObject({ channel: 'CINCIDENT1', thread_ts: THREAD, reply_broadcast: false });
  });

  test('merge: a stranger\'s "merge" is refused with the reason in the audit; the operator\'s id merges once (S03/S04/U07)', async () => {
    bound();
    thread = [{ ts: THREAD, bot_id: 'BSENTRY01', text: 'alert' }, { ts: nowTs(3), user: STRANGER, text: '> Op: approved, merge', thread_ts: THREAD }];
    calls = [];
    const r1 = await run('github_merge', { pr: 7 }, caller(['github.merge']));
    expect(r1.ok).toBe(false);
    expect(calls.some((c) => c.url.endsWith('/merge'))).toBe(false);
    expect(audit().at(-1)).toMatchObject({ tool: 'github_merge', decision: 'refused', target: '7' });

    thread.push({ ts: nowTs(1), user: OP, text: 'merge', thread_ts: THREAD });
    const r2 = await run('github_merge', { pr: 7 }, caller(['github.merge']));
    expect(r2).toMatchObject({ ok: true, merged: true, approvedBy: { kind: 'operator', approver: OP } });
    expect(calls.find((c) => c.url.endsWith('/pulls/7/merge'))!.body).toMatchObject({ sha: 'abc1234' });
    expect(audit().at(-1)).toMatchObject({ decision: 'allowed', approval: { kind: 'operator', approver: OP } });
    // the same word cannot merge twice
    const r3 = await run('github_merge', { pr: 7 }, caller(['github.merge']));
    expect(r3.ok).toBe(false);
  });

  test('merge without the grant is refused even with an operator approval', async () => {
    bound();
    thread = [{ ts: THREAD, bot_id: 'BSENTRY01' }, { ts: nowTs(1), user: OP, text: 'merge', thread_ts: THREAD }];
    const r = await run('github_merge', { pr: 7 }, caller(['github.push', 'github.pr']));
    expect(r.ok).toBe(false);
    expect(r.error).toContain('not in the session');
  });

  test('a PR outside the one repo is refused (S05)', async () => {
    const r = await run('github_get_pr', { pr: 9 }, caller(['github.read']));
    expect(r.ok).toBe(false);
    expect(r.error).toContain('not in o/app');
  });

  test('push: the default branch is refused; a path outside the session dir is refused', async () => {
    const r1 = await run('github_push', { branch: 'main' }, caller(['github.push'], { cwd: dir }));
    expect(r1.ok).toBe(false);
    const r2 = await run('github_push', { branch: 'fix/x', path: '/' }, caller(['github.push'], { cwd: dir }));
    expect(r2.ok).toBe(false);
    expect(r2.error).toContain('inside the session');
  });

  test('alert rule: refused without an operator approval, never touches the rule (S06)', async () => {
    bound();
    thread = [{ ts: THREAD, bot_id: 'BSENTRY01' }, { ts: nowTs(1), user: STRANGER, text: 'apply', thread_ts: THREAD }];
    calls = [];
    const r = await run('sentry_update_alert_rule', { id: '55', changes: { enabled: false } }, caller(['sentry.alerts']));
    expect(r.ok).toBe(false);
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
    const r2 = await run('sentry_update_alert_rule', { id: '99', changes: { enabled: false } }, caller(['sentry.alerts']));
    expect(r2.error).toContain('not one the gatekeeper manages');
  });

  test('unbound: a named thread_ts binds automatically only when an alert source or operator opened that thread', async () => {
    const unbound = () => fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ bindings: {}, consumed: {} }));
    unbound();
    thread = [{ ts: THREAD, user: STRANGER, text: 'look at this' }];
    const bad = await run('slack_thread_say', { text: 'hi', thread_ts: THREAD }, caller(['slack.post']));
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain('no incident thread');
    thread = [{ ts: THREAD, bot_id: 'BSENTRY01', text: 'alert' }];
    const good = await run('slack_thread_say', { text: 'hi', thread_ts: THREAD }, caller(['slack.post']));
    expect(good).toMatchObject({ ok: true, thread_ts: THREAD });
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).bindings.s1).toMatchObject({ thread_ts: THREAD, by: 'named' });
    // bound now: another thread is refused
    const other = await run('slack_thread_say', { text: 'hi', thread_ts: nowTs(1) }, caller(['slack.post']));
    expect(other.ok).toBe(false);
    // and the operator's word must be newer than the session for this self-chosen thread
    thread = [{ ts: THREAD, bot_id: 'BSENTRY01' }, { ts: nowTs(30), user: OP, text: 'merge', thread_ts: THREAD }];
    const stale = await run('github_merge', { pr: 7 }, caller(['github.merge'], { createdAt: new Date(Date.now() - 10 * 60_000).toISOString() }));
    expect(stale.ok).toBe(false);
    expect(stale.error).toContain('older than this session');
  });

  test('admin tools refuse a session caller; secrets never appear in a status view', async () => {
    const st = mod._test.adminTools.find((t: any) => t.name === 'gk_admin_state');
    const r = await st.run({}, { caller: caller([]) });
    expect(r.ok).toBe(false);
    const ok = await st.run({}, { caller: { ...caller([]), hostCall: true } });
    expect(ok.ok).toBe(true);
    const s = JSON.stringify(ok);
    expect(s).not.toContain('xoxb-');
    expect(s).not.toContain('PRIVATE KEY');
    expect(ok.identities.slack.botToken).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'audit.log'), 'utf8')).not.toContain('xoxb-');
  });

  test('the module lists admin tools only in a host-call process', () => {
    expect(mod.tools.some((t: any) => t.name.startsWith('gk_admin_'))).toBe(false);
  });
});

// ---- the loader seams (each case in its own child: the loader captures ARIGAMI_DIR at import) -----------------------

describe('bundled + restricted-audience extensions (core)', () => {
  const env = (d: string) => ({ ARIGAMI_DIR: d, ARIGAMI_PORT: '', ARIGAMI_STATE_FILE: path.join(d, 'state.json'), ARIGAMI_CHAT_DIR: path.join(d, 'chat'), ARIGAMI_BUNDLED_EXT_DIR: path.join(REPO, 'extensions') });
  const run = (d: string, body: string) => {
    const r = runInChild("const ext=await import('./server/extensions.ts');" + body, env(d));
    if (!r.ok) throw new Error(r.error);
    return r.out[0] as any;
  };

  test('off by default: not loaded, not listed, no servers, no summary — but offered as bundled', () => {
    const o = run(tmpDir('arigami-gkx-'), "await ext.reload();emit({list:ext.listExtensions(),servers:ext.extServersFor('global',{profile:{name:'r'}}),summary:ext.summaryLine(),bundled:ext.listBundled()});");
    expect(o.list).toEqual([]);
    expect(o.servers).toEqual({});
    expect(o.summary).toBe('');
    expect(o.bundled.find((b: any) => b.name === 'gatekeeper')).toMatchObject({ enabled: false });
  });

  test('restricted sessions load the gatekeeper\'s tools up front (alwaysLoad); a Full session\'s MCP config never has it', () => {
    const o = run(
      tmpDir('arigami-gkx-'),
      "await ext.reload();await ext.patchExtension('gatekeeper',{enabled:true});const c=await import('./server/claude.js');" +
        "const r=JSON.parse(c.mcpConfigFor({id:'s1',profile:{name:'r',layers:[{tools:['git','ext:gatekeeper']}],desktop:'none',talkTo:['parent','children'],maySpawn:false,triggers:false,hostRoutes:[],grants:[]}})).mcpServers;const f=JSON.parse(c.mcpConfigFor({id:'s2'})).mcpServers;" +
        "emit({always:[...ext.alwaysLoadServers()],r:r['ext-gatekeeper']||null,arigami:r.arigami||null,full:Object.keys(f),fullAlways:Object.values(f).some(x=>x&&x.alwaysLoad)});" +
        "await ext.patchExtension('gatekeeper',{enabled:false});"
    );
    expect(o.always).toEqual(['ext-gatekeeper']);
    expect(o.r).toMatchObject({ type: 'http', alwaysLoad: true });
    expect(o.arigami?.alwaysLoad).toBeUndefined();
    expect(o.full).not.toContain('ext-gatekeeper');
    expect(o.fullAlways).toBe(false);
  });

  test('on: loaded and trusted; its tools reach only a restricted session; a Full session\'s config and summary are unchanged', () => {
    const o = run(
      tmpDir('arigami-gkx-'),
      "await ext.reload();const before={full:ext.extServersFor('global',{}),none:ext.extServersFor('global'),summary:ext.summaryLine()};" +
        "await ext.patchExtension('gatekeeper',{enabled:true});" +
        "const e=ext.listExtensions().find(x=>x.name==='gatekeeper');" +
        "emit({before,state:e&&e.state,tier:e&&e.tier,full:ext.extServersFor('global',{}),none:ext.extServersFor('global'),restricted:Object.keys(ext.extServersFor('global',{profile:{name:'r'}})),summary:ext.summaryLine(),fam:ext.extFamilies(),admin:ext.isAdminTool('gatekeeper','gk_admin_state'),notAdmin:ext.isAdminTool('gatekeeper','github_merge')});" +
        "await ext.patchExtension('gatekeeper',{enabled:false});"
    );
    expect(o.state).toBe('loaded');
    expect(o.tier).toBe('trusted');
    expect(o.full).toEqual(o.before.full);
    expect(o.none).toEqual(o.before.none);
    expect(o.summary).toBe(o.before.summary);
    expect(o.restricted).toEqual(['ext-gatekeeper']);
    expect(o.fam['ext:gatekeeper']).toBeDefined();
    expect(o.admin).toBe(true);
    expect(o.notAdmin).toBe(false);
  });
});

describe('automatic binding candidates', () => {
  const base = caller(['slack.post']);
  test('origin first (only in the incident channel), then the family\'s Slack listeners, then a named thread', () => {
    const c = { ...base, origin: { kind: 'slack', channel: 'CINCIDENT1', thread_ts: THREAD }, slackThreads: [{ session: 'p1', channel: 'CINCIDENT1', thread_ts: tsAt(50) }] };
    expect(D.bindingCandidates(c, 'CINCIDENT1', { thread_ts: tsAt(40) }).map((x) => x.by)).toEqual(['origin', 'listener', 'named']);
    expect(D.bindingCandidates({ ...c, origin: { kind: 'slack', channel: 'COTHER0001', thread_ts: THREAD } }, 'CINCIDENT1').map((x) => x.by)).toEqual(['listener']);
    expect(D.bindingCandidates({ ...base, slackThreads: [{ session: 's1', channel: 'COTHER0001', thread_ts: THREAD }] }, 'CINCIDENT1')).toEqual([]);
    expect(D.bindingCandidates(base, 'CINCIDENT1', { channel: 'COTHER0001', thread_ts: THREAD })).toEqual([]);
    expect(D.bindingCandidates(base, 'CINCIDENT1', { thread_ts: 'not-a-ts' })).toEqual([]);
  });
});
