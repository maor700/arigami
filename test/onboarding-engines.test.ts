// Codex is an equal first-run choice: a host with ONLY Codex connected must finish onboarding and
// default to Codex. Out-of-process (config captures ARIGAMI_DIR at import) — see test/_child.js.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInChild } from './_child.js';
import { tmpDir } from './_tmp.js';

const env = () => {
  const dir = tmpDir('arigami-eng-');
  return { ARIGAMI_DIR: dir, ARIGAMI_FUNNEL_QUIET: '1', HOME: path.join(dir, 'home'), CODEX_HOME: '', ARIGAMI_CODEX_HOME: path.join(dir, 'no-codex') };
};

test('default engine follows the connected one; an explicit connected default wins', () => {
  const r = runInChild(
    "const c=await import('./server/lib/config.js');" +
      'const set=(cl,cx)=>c.setEngineReadiness((e)=>e===\'claude\'?cl:cx);' +
      'const out={};' +
      "set(false,true);out.codexOnly=c.defaultEngine();" +
      "set(true,false);out.claudeOnly=c.defaultEngine();" +
      "set(false,false);out.none=c.defaultEngine();" +
      "set(true,true);out.both=c.defaultEngine();" +
      "c.updateDefaultEngine('codex');set(true,false);out.codexPrefButNotConnected=c.defaultEngine();" +
      "set(true,true);out.codexPref=c.defaultEngine();" +
      'emit(out);',
    env()
  );
  if (!r.ok) throw new Error(r.error);
  expect(r.out[0]).toEqual({ codexOnly: 'codex', claudeOnly: 'claude', none: 'claude', both: 'claude', codexPrefButNotConnected: 'claude', codexPref: 'codex' });
});

test('Codex-only host: minimal onboarding is done, the wizard never asks for Claude, health pings Codex, new sessions are Codex', () => {
  const r = runInChild(
    "const ob=await import('./server/onboarding.js');const st=await import('./server/state.js');" +
      "const probes={hasAdmin:()=>true,claudeCli:()=>true,claudeAuth:()=>false,codexCli:()=>true,codexAuth:()=>true,gitAuth:()=>false," +
      "profileApplied:()=>null,pendingProfile:()=>null,integrations:()=>({composio:false,whatsapp:'disconnected',tailscale:false}),repos:()=>[],health:()=>undefined,unattended:()=>false,telemetry:()=>({enabled:false,reason:'config'})};" +
      "const v=ob.wizard(probes);" +
      "const eng=(id)=>v.steps.find(s=>s.id===id);" +
      "const s=st.createSession({title:'t'});" +
      "emit({done:v.done,current:v.current,claude:eng('claude').status,codex:eng('codex').status,health:ob.healthEngine(probes),sessionEngine:s.engine});",
    { ...env(), ARIGAMI_ONBOARDING_MODE: '' }
  );
  if (!r.ok) throw new Error(r.error);
  // sessionEngine uses the REAL probes (nothing connected in the sandbox) → claude; the probe-injected parts are the contract here.
  expect(r.out[0]).toMatchObject({ done: true, current: null, claude: 'skipped', codex: 'ok', health: 'codex' });
});

test('"Claude connected" is not claimed from a credentials FILE alone: MCP-only, empty and expired files do not count', () => {
  const e = env();
  const r = runInChild(
    "const ob=await import('./server/onboarding.js');const fs=await import('node:fs');const path=await import('node:path');" +
      "const d=process.env.ARIGAMI_DIR;const w=(n,o)=>{const f=path.join(d,n);fs.writeFileSync(f,typeof o==='string'?o:JSON.stringify(o));return f};" +
      'emit({' +
      "mcpOnly:ob.claudeFileLoginUsable(w('a.json',{mcpOAuth:{'linear|x':{accessToken:'t'}}}))," +
      "empty:ob.claudeFileLoginUsable(w('b.json',{}))," +
      "garbage:ob.claudeFileLoginUsable(w('c.json','not json'))," +
      "missing:ob.claudeFileLoginUsable(path.join(d,'nope.json'))," +
      "expiredNoRefresh:ob.claudeFileLoginUsable(w('d.json',{claudeAiOauth:{accessToken:'a',expiresAt:1}}))," +
      "expiredWithRefresh:ob.claudeFileLoginUsable(w('e.json',{claudeAiOauth:{accessToken:'a',refreshToken:'r',expiresAt:1}}))," +
      "valid:ob.claudeFileLoginUsable(w('f.json',{claudeAiOauth:{accessToken:'a',expiresAt:Date.now()+3.6e6}}))});",
    e
  );
  if (!r.ok) throw new Error(r.error);
  expect(r.out[0]).toEqual({ mcpOnly: false, empty: false, garbage: false, missing: false, expiredNoRefresh: false, expiredWithRefresh: true, valid: true });
});

test('a host whose only credentials file is MCP-only reports no engine connected (wizard not done)', () => {
  const e = env();
  const r = runInChild(
    "const fs=await import('node:fs');const path=await import('node:path');const home=process.env.HOME;" +
      "fs.mkdirSync(path.join(home,'.claude'),{recursive:true});fs.writeFileSync(path.join(home,'.claude','.credentials.json'),JSON.stringify({mcpOAuth:{'linear|x':{accessToken:'t'}}}));" +
      "const ob=await import('./server/onboarding.js');const v=ob.wizard();emit({done:v.done,claude:v.steps.find(s=>s.id==='claude').status});",
    { ...e, ARIGAMI_ONBOARDING_MODE: '' }
  );
  if (!r.ok) throw new Error(r.error);
  expect(r.out[0].done).toBe(false);
  expect(r.out[0].claude).not.toBe('ok');
});

test('the CLI "Not logged in" notice is recognised (the chat shows the localized Connect card instead of the raw line)', () => {
  const r = runInChild(
    "const c=await import('./server/claude.js');emit({a:c.NOT_LOGGED_RE.test('Not logged in · Please run /login'),b:c.NOT_LOGGED_RE.test('Please run /login'),c:c.NOT_LOGGED_RE.test('I could not find the file'),d:c.NOT_LOGGED_RE.test('The user is not logged in to the app I was asked to test')});",
    env()
  );
  if (!r.ok) throw new Error(r.error);
  expect(r.out[0]).toEqual({ a: true, b: true, c: false, d: false });
});
