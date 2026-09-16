// S1 — JIT setup: capability registry, identity + audit writers, needs_setup
// shape, minimal onboarding mode. capabilities.ts / onboarding.ts capture
// ARIGAMI_DIR at import, so every case runs in a fresh child (test/_child.js)
// with injected probes — no gh / claude / Composio / desktop needed.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInChild } from './_child.js';

const fresh = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-setup-'));
const env = (dir: string, extra: Record<string, string> = {}) => ({
  ARIGAMI_DIR: dir,
  ARIGAMI_FUNNEL_QUIET: '1',
  HOME: path.join(dir, 'home'),
  ...extra,
});

// Probes where NOTHING is connected — the fresh-install baseline.
const NONE =
  "const probes={identity:()=>null,claude:()=>({cli:true,authed:false}),codex:()=>({cli:true,authed:false}),git:()=>({authed:false,gh:false})," +
  "repos:()=>[{name:'app',present:false,dir:'/x/app',source:'https://example.invalid/app.git'}]," +
  "whatsapp:()=>({status:'disconnected',qr:null,user:null}),desktop:()=>({enabled:false,display:null,up:false})," +
  "push:()=>false,remote:()=>({available:false,reason:'Tailscale is not installed'}),telemetry:()=>({enabled:false,reason:'config'})," +
  'composioKey:()=>false,composioConnected:async()=>null};';
// Everything connected.
const ALL =
  "const probes={identity:()=>({email:'a@b.c',provider:'google',connectedAt:'t',chromeProfile:'base',providers:{}})," +
  "claude:()=>({cli:true,authed:true}),codex:()=>({cli:true,authed:true}),git:()=>({authed:true,gh:true})," +
  "repos:()=>[{name:'app',present:true,dir:'/x/app',source:'https://example.invalid/app.git'}]," +
  "whatsapp:()=>({status:'connected',qr:null,user:'me'}),desktop:()=>({enabled:true,display:':99',up:true})," +
  "push:()=>true,remote:()=>({available:true,loggedIn:true,serving:true,httpsUrl:'https://h/__host/'}),telemetry:()=>({enabled:true,reason:'config'})," +
  "composioKey:()=>true,composioConnected:async()=>new Set(['gmail'])};";

test('registry: every spec id resolves; statics + repos + known toolkits are listed with manual.kind/autoCapable/playbook', () => {
  const r = runInChild(
    `const c=await import('./server/capabilities.js');${NONE}` +
      "const ids=['identity','claude','codex','git','repo:app','whatsapp','composio:gmail','desktop','push','remote','telemetry'];" +
      'const resolved=ids.map(id=>{const cap=c.getCapability(id,probes);return cap&&{id:cap.id,kind:cap.manual.kind,auto:cap.autoCapable,playbook:cap.playbook||null};});' +
      'const all=c.listCapabilities(probes).map(x=>x.id);' +
      "emit({resolved,all,bad:[c.getCapability('nope'),c.getCapability('composio:../x'),c.isCapabilityId('repo:a b')]});",
    env(fresh())
  );
  if (!r.ok) throw new Error(r.error);
  const { resolved, all, bad } = r.out[0];
  expect(resolved.map((x: any) => x.id)).toEqual(['identity', 'claude', 'codex', 'git', 'repo:app', 'whatsapp', 'composio:gmail', 'desktop', 'push', 'remote', 'telemetry']);
  const byId = Object.fromEntries(resolved.map((x: any) => [x.id, x]));
  expect(byId.identity).toEqual({ id: 'identity', kind: 'takeover', auto: false, playbook: 'connect-identity' });
  expect(byId.claude).toEqual({ id: 'claude', kind: 'oauth', auto: true, playbook: 'connect-claude' });
  expect(byId.codex).toEqual({ id: 'codex', kind: 'oauth', auto: true, playbook: 'connect-codex' });
  expect(byId.git).toEqual({ id: 'git', kind: 'token', auto: true, playbook: 'connect-github' });
  expect(byId['repo:app'].kind).toBe('repo');
  expect(byId.whatsapp).toEqual({ id: 'whatsapp', kind: 'qr', auto: false, playbook: null });
  expect(byId['composio:gmail']).toEqual({ id: 'composio:gmail', kind: 'oauth', auto: true, playbook: 'connect-composio' });
  expect(byId.remote).toEqual({ id: 'remote', kind: 'toggle', auto: true, playbook: 'connect-tailscale' });
  for (const id of ['desktop', 'push', 'telemetry']) expect(byId[id].kind).toBe('toggle');
  expect(all.slice(0, 9)).toEqual(['identity', 'claude', 'codex', 'git', 'whatsapp', 'desktop', 'push', 'remote', 'telemetry']);
  expect(all).toContain('repo:app');
  expect(all).toContain('composio:gmail');
  expect(bad).toEqual([null, null, false]);
});

test('check(): nothing connected → all not ok with a human detail; everything connected → all ok; defaultMode follows identity+autoCapable', () => {
  const r = runInChild(
    `const c=await import('./server/capabilities.js');` +
      `{${NONE}const v=await c.capabilitiesStatus(probes);emit({none:v.capabilities.map(x=>[x.id,x.ok,x.defaultMode,x.detail.length>0]),identity:v.identity});}` +
      `{${ALL}const v=await c.capabilitiesStatus(probes);emit({all:v.capabilities.map(x=>[x.id,x.ok,x.defaultMode]),identity:v.identity.email});}`,
    env(fresh())
  );
  if (!r.ok) throw new Error(r.error);
  const none = r.out[0];
  expect(none.identity).toBeNull();
  for (const [id, ok, mode, hasDetail] of none.none) {
    expect(ok).toBe(false);
    expect(mode).toBe('manual'); // no identity → never auto
    expect(hasDetail).toBe(true);
  }
  const all = r.out[1];
  expect(all.identity).toBe('a@b.c');
  const m = Object.fromEntries(all.all.map(([id, ok, mode]: any) => [id, { ok, mode }]));
  for (const id of ['identity', 'claude', 'codex', 'git', 'repo:app', 'whatsapp', 'desktop', 'push', 'remote', 'telemetry', 'composio:gmail']) expect(m[id].ok).toBe(true);
  expect(m['composio:slack'].ok).toBe(false); // not in the connected set
  expect(m['composio:slack'].mode).toBe('auto'); // identity + autoCapable
  expect(m.whatsapp.mode).toBe('manual'); // never auto (QR)
});

test('ensure(): returns {ok} when connected, the exact needs_setup shape otherwise; unknown id → needs_setup with a hint', () => {
  const r = runInChild(
    `const c=await import('./server/capabilities.js');${NONE}` +
      "const a=await c.ensure('composio:gmail','read your inbox',probes);" +
      "const b=await c.ensure('claude','answer',{...probes,claude:()=>({cli:true,authed:true})});" +
      "const d=await c.ensure('bogus','x',probes);" +
      "emit({a,b,d,shape:c.needsSetup('whatsapp','send a message'),isA:c.isNeedsSetup(a),isB:c.isNeedsSetup(b)});",
    env(fresh())
  );
  if (!r.ok) throw new Error(r.error);
  const o = r.out[0];
  expect(o.a).toEqual({ needs_setup: 'composio:gmail', why: 'read your inbox', hint: 'call request_setup' });
  expect(o.b).toEqual({ ok: true, detail: 'signed in', owner: 'global' });
  expect(o.d.needs_setup).toBe('bogus');
  expect(o.d.hint).toMatch(/unknown capability/);
  expect(o.shape).toEqual({ needs_setup: 'whatsapp', why: 'send a message', hint: 'call request_setup' });
  expect(o.isA).toBe(true);
  expect(o.isB).toBe(false);
});

test('codex capability: CLI missing / not signed in / signed in; manual = codex login start + an OpenAI key field', () => {
  const r = runInChild(
    `const c=await import('./server/capabilities.js');${NONE}` +
      "const st=async(cx)=>{const cap=c.getCapability('codex',{...probes,codex:()=>cx});const k=await cap.check();return [k.ok,k.data.cli];};" +
      "const cap=c.getCapability('codex',probes);" +
      "emit({noCli:await st({cli:false,authed:true}),out:await st({cli:true,authed:false}),in:await st({cli:true,authed:true}),manual:cap.manual,events:cap.events,id:c.isCapabilityId('codex')});",
    env(fresh())
  );
  if (!r.ok) throw new Error(r.error);
  const o = r.out[0];
  expect(o.noCli).toEqual([false, false]);
  expect(o.out).toEqual([false, true]);
  expect(o.in).toEqual([true, true]);
  expect(o.manual.start).toBe('/__api/accounts/login/start');
  expect(o.manual.fields[0]).toMatchObject({ name: 'token', secret: true });
  expect(o.events).toContain('accounts');
  expect(o.id).toBe(true);
});

test('identity.json: write/merge/mark provider/clear; refuses secrets and bad emails; never stores tokens', () => {
  const dir = fresh();
  const r = runInChild(
    `const c=await import('./server/capabilities.js');const fs=await import('node:fs');` +
      "const w=c.writeIdentity({email:'Me@Example.com'});" +
      "const m=c.markIdentityProvider('composio:gmail');" +
      "const again=c.writeIdentity({email:'me@example.com',chromeProfile:'base'});" +
      "let bad1=null,bad2=null;try{c.writeIdentity({email:'nope'})}catch(e){bad1=e.message}" +
      "try{c.writeIdentity({email:'me@example.com',chromeProfile:'sk-ant-oat01-abcdefghijklmnop'})}catch(e){bad2=e.message}" +
      'const raw=fs.readFileSync(c.IDENTITY_FILE,"utf8");const mode=fs.statSync(c.IDENTITY_FILE).mode&0o777;' +
      'const cleared=c.clearIdentity();' +
      'emit({w,m,again,bad1,bad2,raw,mode,cleared,after:c.readIdentity(),connected:c.identityConnected()});',
    env(dir)
  );
  if (!r.ok) throw new Error(r.error);
  const o = r.out[0];
  expect(o.w.email).toBe('me@example.com');
  expect(o.w.provider).toBe('google');
  expect(o.w.chromeProfile).toBe('base');
  expect(o.m.providers['composio:gmail'].at).toBeTruthy();
  expect(o.again.connectedAt).toBe(o.w.connectedAt); // same email → connectedAt kept
  expect(o.again.providers['composio:gmail']).toBeTruthy(); // merge keeps providers
  expect(o.bad1).toMatch(/valid email/);
  expect(o.bad2).toMatch(/secret/);
  expect(o.raw).not.toMatch(/sk-ant/);
  expect(o.mode).toBe(0o600);
  expect(o.cleared).toBe(true);
  expect(o.after).toBeNull();
  expect(o.connected).toBe(false);
});

test('connections.log: JSONL append with the spec fields, newest-last tail, secrets scrubbed from detail', () => {
  const dir = fresh();
  const r = runInChild(
    `const c=await import('./server/capabilities.js');const fs=await import('node:fs');` +
      "c.appendAudit({sessionId:'sess_1',capability:'composio:gmail',mode:'auto',result:'requested',evidence:null,human:false,detail:'read inbox'});" +
      "c.appendAudit({sessionId:'sess_1',capability:'composio:gmail',mode:'auto',result:'done',evidence:'/__artifacts/abc/',human:false});" +
      "c.appendAudit({sessionId:null,capability:'git',mode:'manual',result:'done',evidence:null,human:true,detail:'token ghp_abcdefghijklmnopqrstuvwxyz0123'});" +
      'const lines=fs.readFileSync(c.AUDIT_FILE,"utf8").trim().split("\\n").map(l=>JSON.parse(l));' +
      'emit({lines,tail:c.readAudit(2).map(e=>e.result),all:c.readAudit().length});',
    env(dir)
  );
  if (!r.ok) throw new Error(r.error);
  const { lines, tail, all } = r.out[0];
  expect(lines.length).toBe(3);
  expect(Object.keys(lines[1]).sort()).toEqual(['at', 'capability', 'evidence', 'human', 'mode', 'result', 'sessionId']);
  expect(lines[1].evidence).toBe('/__artifacts/abc/');
  expect(lines[0].detail).toBe('read inbox');
  expect(lines[2].detail).toBeUndefined(); // looked like a token → dropped
  expect(lines[2].human).toBe(true);
  expect(tail).toEqual(['done', 'done']);
  expect(all).toBe(3);
});

// --- minimal onboarding mode (default) ----------------------------------------

const WIZ_NONE =
  "const wp={hasAdmin:()=>true,claudeCli:()=>true,claudeAuth:()=>true,codexCli:()=>true,codexAuth:()=>false,gitAuth:()=>false," +
  "profileApplied:()=>null,pendingProfile:()=>null,integrations:()=>({composio:false,whatsapp:'disconnected',tailscale:false})," +
  "repos:()=>[],health:()=>undefined,unattended:()=>false,telemetry:()=>({enabled:false,reason:'config'})};";

test('minimal mode (default): pair+claude ok → wizard done, current=null, optional steps still todo; full mode needs everything', () => {
  const dir = fresh();
  const r = runInChild(
    `const ob=await import('./server/onboarding.js');${WIZ_NONE}` +
      'const v=ob.wizard(wp);' +
      "const full=ob.setOnboardingMode('full',wp);" +
      "const back=ob.setOnboardingMode('minimal',wp);" +
      'emit({mode:v.mode,required:v.required,done:v.done,current:v.current,todo:v.steps.filter(s=>s.status==="todo").map(s=>s.id),' +
      'fullMode:full.mode,fullDone:full.done,fullCurrent:full.current,fullRequired:full.required.length,backDone:back.done,' +
      'events:(await import("node:fs")).readFileSync(process.env.ARIGAMI_DIR+"/funnel.jsonl","utf8").trim().split("\\n").map(l=>JSON.parse(l).name)});',
    env(dir)
  );
  if (!r.ok) throw new Error(r.error);
  const o = r.out[0];
  expect(o.mode).toBe('minimal');
  expect(o.required).toEqual(['pair', 'claude', 'codex']);
  expect(o.done).toBe(true);
  expect(o.current).toBeNull();
  expect(o.todo).toContain('git'); // optional, not blocking
  expect(o.fullMode).toBe('full');
  expect(o.fullDone).toBe(false);
  expect(o.fullCurrent).toBe('git');
  expect(o.fullRequired).toBe(9);
  expect(o.backDone).toBe(true);
  expect(o.events.filter((n: string) => n === 'onboarding.done').length).toBe(2); // done → not done → done again
});

test('minimal mode: claude missing → not done, current=claude (the only screen a fresh install sees)', () => {
  const r = runInChild(
    `const ob=await import('./server/onboarding.js');${WIZ_NONE}` +
      'const v=ob.wizard({...wp,claudeAuth:()=>false});emit({done:v.done,current:v.current});' +
      'const v2=ob.wizard({...wp,hasAdmin:()=>false});emit({done:v2.done,current:v2.current});',
    env(fresh())
  );
  if (!r.ok) throw new Error(r.error);
  expect(r.out[0]).toEqual({ done: false, current: 'claude' });
  expect(r.out[1]).toEqual({ done: false, current: 'pair' });
});

test('doctor: capabilities CLI lists the registry offline (no network) and the wizard doctor prints the mode', () => {
  const dir = fresh();
  const r = runInChild(
    `const c=await import('./server/capabilities.js');${NONE}emit({text:await c.formatDoctor(probes)});`,
    env(dir)
  );
  if (!r.ok) throw new Error(r.error);
  const text: string = r.out[0].text;
  for (const id of ['identity', 'claude', 'git', 'whatsapp', 'desktop', 'push', 'remote', 'telemetry', 'repo:app']) expect(text).toContain(id);
  expect(text).toContain('[auto]');
  expect(text).toMatch(/identity: none/);
});
