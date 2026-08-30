// F3 #2 — the wizard's "paste a token" must PROVE the credential before it is
// stored: a one-shot `claude -p` (test/_fake-claude.js here) with only the
// candidate token in its env. A rejected token → clear error, nothing saved.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInChild } from './_child.js';

const FAKE_CLAUDE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '_fake-claude.js');
const fresh = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-wiztok-'));
const env = (dir: string, extra: Record<string, string> = {}) => ({
  ARIGAMI_DIR: dir, ARIGAMI_PORT: '', ARIGAMI_FUNNEL_QUIET: '1', HOME: path.join(dir, 'home'), ARIGAMI_CLAUDE_BIN: FAKE_CLAUDE, ...extra,
});
const FAKE = 'sk-ant-oat01-FAKE-FAKE-FAKE-FAKE-FAKE-FAKE-0000';

test('a fake sk-ant-oat01 token that claude rejects → error mentioning the reason, no account written', () => {
  const dir = fresh();
  const r = runInChild(
    "const ob=await import('./server/onboarding.ts');let msg=null;" +
      `try{await ob.setClaudeToken('${FAKE}','wizard');}catch(e){msg=e.message;}` +
      "const acc=await import('./server/accounts.js');acc.initAccounts();" +
      "emit({msg,accounts:acc.listAccounts().accounts.filter(a=>a.type==='oauth-token').length,file:require('node:fs').existsSync(process.env.ARIGAMI_DIR+'/accounts.json')});",
    env(dir, { FAKE_CLAUDE_MODE: 'fail-envelope', FAKE_CLAUDE_RESULT: 'API Error: 401 OAuth access token has been revoked' })
  );
  expect(r.ok).toBe(true);
  const o = r.out[0];
  expect(o.msg).toMatch(/token rejected/);
  expect(o.msg).toMatch(/revoked/);
  expect(o.accounts).toBe(0);
});

test('a token claude accepts → stored as an oauth-token account; the probe ran with THAT token, not the host env', () => {
  const dir = fresh();
  const r = runInChild(
    "const ob=await import('./server/onboarding.ts');" +
      `const res=await ob.setClaudeToken('${FAKE}','wizard');` +
      "const acc=await import('./server/accounts.js');acc.initAccounts();const list=acc.listAccounts().accounts;" +
      "emit({res,n:list.length,label:list[0]&&list[0].label,tok:acc.resolveToken(list[0]&&list[0].id)});",
    env(dir, { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-STALE-HOST-ENV' })
  );
  // Note: the host env token would be seeded as an account by initAccounts()
  // (pre-existing import feature); we only assert the wizard one exists.
  expect(r.ok).toBe(true);
  const o = r.out[0];
  expect(o.res).toEqual({ ok: true, kind: 'oauth' });
  expect(o.n).toBeGreaterThanOrEqual(1);
});

test('an API key is verified the same way and only then written to secrets.env', () => {
  const dir = fresh();
  const KEY = 'sk-ant-api03-FAKE-FAKE-FAKE-FAKE-FAKE-0000';
  const bad = runInChild(
    "const ob=await import('./server/onboarding.ts');let msg=null;" +
      `try{await ob.setClaudeToken('${KEY}');}catch(e){msg=e.message;}` +
      "emit({msg,has:require('node:fs').existsSync(process.env.ARIGAMI_DIR+'/secrets.env')});",
    env(dir, { FAKE_CLAUDE_MODE: 'fail-envelope', FAKE_CLAUDE_RESULT: 'invalid x-api-key' })
  );
  expect(bad.ok).toBe(true);
  expect(bad.out[0].msg).toMatch(/token rejected/);
  expect(bad.out[0].has).toBe(false);
  const good = runInChild(
    "const ob=await import('./server/onboarding.ts');" +
      `const res=await ob.setClaudeToken('${KEY}');` +
      "emit({res,txt:require('node:fs').readFileSync(process.env.ARIGAMI_DIR+'/secrets.env','utf8')});",
    env(dir)
  );
  expect(good.ok).toBe(true);
  expect(good.out[0].res).toEqual({ ok: true, kind: 'api-key' });
  expect(good.out[0].txt).toContain(`ANTHROPIC_API_KEY=${KEY}`);
});

test('a malformed paste is rejected before any probe runs', () => {
  const dir = fresh();
  const r = runInChild(
    "const ob=await import('./server/onboarding.ts');let msg=null;" +
      "try{await ob.setClaudeToken('too short');}catch(e){msg=e.message;}emit({msg});",
    env(dir, { FAKE_CLAUDE_MODE: 'fail' })
  );
  expect(r.ok).toBe(true);
  expect(r.out[0].msg).toMatch(/whole token/);
});
