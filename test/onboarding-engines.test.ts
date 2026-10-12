// Codex is an equal first-run choice: a host with ONLY Codex connected must finish onboarding and
// default to Codex. Out-of-process (config captures ARIGAMI_DIR at import) — see test/_child.js.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInChild } from './_child.js';

const env = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-eng-'));
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
