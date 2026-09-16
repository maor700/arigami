// Accounts are per PROVIDER (server/lib/providers.ts): claude logins feed the
// claude engine, codex logins feed the codex engine, and nothing that picks an
// account may cross that line. Runs the store in a child so its ARIGAMI_DIR /
// env never leaks into other test files (see test/_child.js).
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInChild } from './_child.js';

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

test('legacy accounts.json (no provider field) loads as claude accounts and keeps its activeId', () => {
  const dir = tmp('arigami-acct-legacy-');
  fs.writeFileSync(
    path.join(dir, 'accounts.json'),
    JSON.stringify({
      activeId: 'acc_tok',
      accounts: [
        { id: 'acc_tok', label: 'Work', type: 'oauth-token', pool: true, addedAt: '2026-01-01T00:00:00.000Z', token: { v: 0, t: 'sk-ant-oat01-x' } },
      ],
    })
  );
  const r = runInChild(
    "const a=await import('./server/accounts.js');a.initAccounts();" +
      'const l=a.listAccounts();' +
      "emit({providers:l.accounts.map(x=>x.provider),activeId:l.activeId,activeIds:l.activeIds,active:l.accounts[0].active,claudeActive:a.getActiveId(),codexActive:a.getActiveId('codex'),pickClaude:a.pickSessionAccount('claude'),pickCodex:a.pickSessionAccount('codex')});",
    // HOME → the temp dir so this host's own ~/.claude / ~/.codex logins are not seeded into the test.
    { ARIGAMI_DIR: dir, HOME: dir, ARIGAMI_CODEX_HOME: path.join(dir, 'no-codex-here') }
  );
  expect(r.ok).toBe(true);
  const o = r.out[0];
  expect(o.providers).toEqual(['claude']);
  expect(o.activeId).toBe('acc_tok');
  expect(o.activeIds.claude).toBe('acc_tok');
  expect(o.active).toBe(true);
  expect(o.claudeActive).toBe('acc_tok');
  expect(o.codexActive).toBe(null);
  expect(o.pickClaude).toBe('acc_tok');
  expect(o.pickCodex).toBe(null); // no codex login → a codex session gets no account, never a Claude token
});

test("the machine's own codex login is seeded as a codex-home account, active for codex only", () => {
  const dir = tmp('arigami-acct-codexhome-');
  const codexHome = path.join(dir, 'codex-home');
  fs.mkdirSync(codexHome);
  fs.writeFileSync(path.join(codexHome, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: {} }));
  fs.writeFileSync(
    path.join(dir, 'accounts.json'),
    JSON.stringify({
      activeId: 'acc_tok',
      accounts: [{ id: 'acc_tok', label: 'Work', provider: 'claude', type: 'oauth-token', pool: true, token: { v: 0, t: 'sk-ant-oat01-x' } }],
    })
  );
  const r = runInChild(
    "const a=await import('./server/accounts.js');a.initAccounts();" +
      'const l=a.listAccounts();const cx=l.accounts.find(x=>x.provider==="codex");' +
      'emit({types:l.accounts.map(x=>x.provider+":"+x.type),activeIds:l.activeIds,cxActive:cx.active,pickCodex:a.pickSessionAccount("codex"),pickClaude:a.pickSessionAccount("claude"),' +
      'authPath:a.codexAuthPathFor(cx.id),authPathFallback:a.codexAuthPathFor("acc_tok"),tokenForCodex:a.tokenForSession(cx.id)&&a.tokenForSession(cx.id).account.id,hasCodex:a.hasCredentials("codex"),next:a.nextAvailable("acc_tok")});',
    { ARIGAMI_DIR: dir, HOME: dir, ARIGAMI_CODEX_HOME: codexHome }
  );
  expect(r.ok).toBe(true);
  const o = r.out[0];
  expect(o.types).toEqual(['claude:oauth-token', 'codex:codex-home']);
  expect(o.activeIds.claude).toBe('acc_tok');
  expect(o.cxActive).toBe(true);
  expect(o.pickCodex).not.toBe('acc_tok');
  expect(o.pickClaude).toBe('acc_tok');
  expect(o.authPath).toBe(path.join(codexHome, 'auth.json'));
  // a codex session pinned (wrongly) to a claude account falls back to the active codex login
  expect(o.authPathFallback).toBe(path.join(codexHome, 'auth.json'));
  // a claude spawn asked for a codex account's token gets the active CLAUDE one instead
  expect(o.tokenForCodex).toBe('acc_tok');
  expect(o.hasCodex).toBe(true);
  // auto-switch never hops providers: the only "other" account is codex, so nothing is next
  expect(o.next).toBe(null);
});

test('addCodexAccount adopts a pending dir, removeAccount deletes it, setActive is per provider', () => {
  const dir = tmp('arigami-acct-add-');
  const pending = path.join(dir, 'pending');
  fs.mkdirSync(pending);
  fs.writeFileSync(path.join(pending, 'auth.json'), JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-test' }));
  fs.writeFileSync(
    path.join(dir, 'accounts.json'),
    JSON.stringify({
      activeId: 'acc_tok',
      accounts: [{ id: 'acc_tok', label: 'Work', provider: 'claude', type: 'oauth-token', pool: true, token: { v: 0, t: 'sk-ant-oat01-x' } }],
    })
  );
  const r = runInChild(
    "const fs=await import('node:fs');const path=await import('node:path');const a=await import('./server/accounts.js');a.initAccounts();" +
      `const acc=a.addCodexAccount({label:'Key',type:'api-key',pendingDir:${JSON.stringify(pending)}});` +
      'const home=a.codexHomeOfAccount(acc.id);' +
      'const afterAdd={provider:acc.provider,type:acc.type,active:acc.active,homeExists:fs.existsSync(path.join(home,"auth.json")),pendingGone:!fs.existsSync(' + JSON.stringify(pending) + '),claudeActive:a.getActiveId("claude"),codexActive:a.getActiveId("codex")};' +
      // a second codex account, made active — claude's active must not move
      `const p2=path.join(${JSON.stringify(dir)},'pending2');fs.mkdirSync(p2);fs.writeFileSync(path.join(p2,'auth.json'),'{}');` +
      "const acc2=a.addCodexAccount({label:'Two',type:'chatgpt',pendingDir:p2,email:'x@y.z',plan:'plus'});a.setActive(acc2.id);" +
      'const afterSwitch={codexActive:a.getActiveId("codex"),claudeActive:a.getActiveId("claude"),email:a.getAccount(acc2.id).email};' +
      'a.removeAccount(acc.id);' +
      'emit({afterAdd,afterSwitch,removedDir:!fs.existsSync(home),codexActiveAfterRemove:a.getActiveId("codex"),saved:JSON.parse(fs.readFileSync(path.join(' + JSON.stringify(dir) + ',"accounts.json"),"utf8"))});',
    { ARIGAMI_DIR: dir, HOME: dir, ARIGAMI_CODEX_HOME: path.join(dir, 'no-codex-here') }
  );
  expect(r.ok).toBe(true);
  const o = r.out[0];
  expect(o.afterAdd).toMatchObject({ provider: 'codex', type: 'api-key', active: true, homeExists: true, pendingGone: true, claudeActive: 'acc_tok' });
  expect(o.afterAdd.codexActive).toBeTruthy();
  expect(o.afterSwitch.claudeActive).toBe('acc_tok');
  expect(o.afterSwitch.codexActive).not.toBe(o.afterAdd.codexActive);
  expect(o.afterSwitch.email).toBe('x@y.z');
  expect(o.removedDir).toBe(true);
  expect(o.codexActiveAfterRemove).toBe(o.afterSwitch.codexActive);
  // on disk: activeId (legacy) still mirrors claude's active; nothing from auth.json was copied in
  expect(o.saved.activeId).toBe('acc_tok');
  expect(o.saved.activeIds.claude).toBe('acc_tok');
  expect(JSON.stringify(o.saved)).not.toContain('sk-test');
});

test('sanitizeAccountsForExport marks codex-home stale like keychain, in both copies', async () => {
  const a = await import('../server/accounts.js');
  const bk = await import('../server/backup.ts');
  const raw = {
    activeId: 'k',
    activeIds: { claude: 'k', codex: 'c' },
    accounts: [
      { id: 'k', provider: 'claude', type: 'keychain', pool: true },
      { id: 'c', provider: 'codex', type: 'codex-home', pool: true },
      { id: 'x', provider: 'codex', type: 'chatgpt', pool: true },
    ],
  };
  for (const fn of [a.sanitizeAccountsForExport, bk.sanitizeAccountsForExport]) {
    const out = fn(raw);
    expect(out.activeId).toBe(null);
    expect(out.activeIds).toEqual({ claude: null, codex: null });
    expect(out.accounts.map((x) => x.type)).toEqual(['keychain-stale', 'codex-home-stale', 'chatgpt']);
    expect(out.accounts[1]).toMatchObject({ pool: false, needsReauth: true });
  }
});

test('codex-account: browser-login output parsing, callback parsing and rate-limit normalization are pure', async () => {
  const cx = await import('../server/codex-account.ts');
  // what `codex login` prints under the pty (CRLF + CSI colours) — verified on 0.153.4
  const url =
    'https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_EMoamEEZ73f0CkXaXp7hrann&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&scope=openid%20profile&code_challenge=SBUB&code_challenge_method=S256&state=FhE7bNTmJMKPRq3YUrceK3xwXMj3FMt7awVEKf1QTeg&originator=codex_cli_rs';
  const pty =
    'Starting local login server on \x1b[94mhttp://localhost:1455\x1b[0m.\r\nIf your browser did not open, navigate to this URL to authenticate:\r\n\r\n\x1b[94m' + url + '\x1b[0m\r\n\r\nOn a remote or headless machine? Use `codex login --device-auth` instead.\r\n';
  expect(cx.parseBrowserLogin(pty)).toEqual({ url, state: 'FhE7bNTmJMKPRq3YUrceK3xwXMj3FMt7awVEKf1QTeg' });
  expect(cx.parseBrowserLogin('Starting local login server on http://localhost:1455.')).toEqual({ url: null, state: null });
  // the paste-back: full callback address, bare query, bare code
  expect(cx.parseCallback('http://localhost:1455/auth/callback?code=ac_123.xyz&state=FhE7')).toEqual({ code: 'ac_123.xyz', state: 'FhE7' });
  expect(cx.parseCallback('  code=abc-def&state=s1#frag ')).toEqual({ code: 'abc-def', state: 's1' });
  expect(cx.parseCallback('abcdefgh1234')).toEqual({ code: 'abcdefgh1234', state: null });
  expect(cx.parseCallback('nope')).toEqual({ code: null, state: null });

  const usage = cx.normalizeCodexRateLimits({
    rateLimits: {
      limitId: 'codex',
      primary: { usedPercent: 58, windowDurationMins: 43200, resetsAt: 1791547480 },
      secondary: null,
      credits: { hasCredits: false, unlimited: false, balance: null },
      planType: 'free',
      rateLimitReachedType: null,
    },
  });
  expect(usage.available).toBe(true);
  expect(usage.session).toEqual({ pct: 58, resetsAt: new Date(1791547480 * 1000).toISOString(), windowMins: 43200 });
  expect(usage.week).toBe(null);
  expect(usage.plan).toBe('free');
  expect(cx.normalizeCodexRateLimits({})).toEqual({ available: false, reason: 'no-rate-limits' });
});
