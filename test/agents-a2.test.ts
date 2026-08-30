// A2 — connected identity, unit level (fresh child per case: capabilities.ts /
// chrome.ts / state.ts bind ARIGAMI_DIR at import). Covers:
//   1. owners: parseOwner, identity.json per owner, agent-first resolution with
//      shared fallback (identity + composio:*), host-level caps stay global,
//      audit lines carry `owner` and readAudit filters by it;
//   2. Chrome profile per agent: an agent session is seeded from
//      agents/<slug>/browser (empty at first — not chrome-base), syncs back into
//      it, touches chrome-base only with shared:true, and googleAccountEmail
//      never falls back to chrome-base for an agent session;
//   3. listeners armed by an agent session carry `agent`.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInChild } from './_child.js';

const fresh = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-a2-'));
const env = (dir: string) => ({
  ARIGAMI_DIR: dir,
  ARIGAMI_FUNNEL_QUIET: '1',
  ARIGAMI_PORT: '',
  ARIGAMI_STATE_FILE: path.join(dir, 'state.json'),
  ARIGAMI_CHAT_DIR: path.join(dir, 'chat'),
  HOME: path.join(dir, 'home'),
});

// Probes where nothing but the given identities / composio accounts exist.
const PROBES =
  "const ids={};const probes={identity:(o='global')=>ids[o]||null,claude:()=>({cli:true,authed:false}),git:()=>({authed:false,gh:false})," +
  'repos:()=>[],whatsapp:()=>({status:\'disconnected\',qr:null,user:null}),desktop:()=>({enabled:false,display:null,up:false}),' +
  "push:()=>false,remote:()=>({available:false,reason:'no'}),telemetry:()=>({enabled:false,reason:'config'})," +
  'composioKey:()=>true,composioConnected:async()=>new Set(["gmail","agent:bot:slack"])};';

test('owners: parseOwner / isOwnable; identity.json per owner; agent-first resolution with shared fallback', () => {
  const r = runInChild(
    `const c=await import('./server/capabilities.js');${PROBES}` +
      "emit({parse:[c.parseOwner(''),c.parseOwner('global'),c.parseOwner('agent:bot'),c.parseOwner('agent:Bad'),c.parseOwner('x')],ownable:[c.isOwnable('identity'),c.isOwnable('composio:gmail'),c.isOwnable('git')]});" +
      // agent identity written to agents/bot/identity.json, global untouched
      "const a=c.writeIdentity({email:'Bot@Example.com'},'agent:bot');" +
      "emit({a,file:c.identityFile('agent:bot'),globalExists:!!c.readIdentity(),agentRead:c.readIdentity('agent:bot')?.email});" +
      // nothing global: identity for agent resolves to the agent's own
      "ids['agent:bot']={email:'bot@example.com',provider:'google',connectedAt:'t',chromeProfile:'agent:bot',providers:{}};" +
      "const s1=await c.statusOf(c.getCapability('identity',probes,'agent:bot'),probes,'agent:bot');" +
      "const g1=await c.statusOf(c.getCapability('identity',probes),probes);" +
      // another agent with only a global identity → shared fallback
      "ids.global={email:'host@example.com',provider:'google',connectedAt:'t',chromeProfile:'base',providers:{}};" +
      "const s2=await c.statusOf(c.getCapability('identity',probes,'agent:other'),probes,'agent:other');" +
      // composio: bot owns slack, gmail is the host's → shared; googledrive nowhere
      "const cs=await c.statusOf(c.getCapability('composio:slack',probes,'agent:bot'),probes,'agent:bot');" +
      "const cg=await c.statusOf(c.getCapability('composio:gmail',probes,'agent:bot'),probes,'agent:bot');" +
      "const cd=await c.statusOf(c.getCapability('composio:googledrive',probes,'agent:bot'),probes,'agent:bot');" +
      "const cgGlobal=await c.statusOf(c.getCapability('composio:slack',probes),probes);" +
      // host-level capability for an agent owner stays global
      "const git=await c.statusOf(c.getCapability('git',probes,'agent:bot'),probes,'agent:bot');" +
      "const ens=await c.ensure('composio:slack','post',probes,'agent:bot');" +
      "const view=await c.capabilitiesStatus(probes,'agent:bot');" +
      "emit({s1:[s1.ok,s1.owner,s1.resolvedFrom,s1.ownable,s1.defaultMode],g1:[g1.ok,g1.resolvedFrom],s2:[s2.ok,s2.owner,s2.resolvedFrom,s2.detail,s2.defaultMode],cs:[cs.ok,cs.resolvedFrom],cg:[cg.ok,cg.resolvedFrom,cg.detail],cd:[cd.ok,cd.resolvedFrom],cgGlobal:[cgGlobal.ok,cgGlobal.resolvedFrom],git:[git.ownable,git.owner,git.resolvedFrom],ens,view:[view.owner,view.identity?.email,view.sharedIdentity?.email]});" +
      // clear only the agent's
      "emit({cleared:c.clearIdentity('agent:bot'),agentGone:c.readIdentity('agent:bot')===null,stillGlobalFile:c.identityFile()});",
    env(fresh())
  );
  if (!r.ok) throw new Error(r.error);
  const [o1, o2, o3, o4] = r.out;
  expect(o1.parse).toEqual(['global', 'global', 'agent:bot', null, null]);
  expect(o1.ownable).toEqual([true, true, false]);
  expect(o2.a.email).toBe('bot@example.com');
  expect(o2.a.chromeProfile).toBe('agent:bot');
  expect(o2.file).toMatch(/\/agents\/bot\/identity\.json$/);
  expect(o2.globalExists).toBe(false);
  expect(o2.agentRead).toBe('bot@example.com');
  expect(o3.s1).toEqual([true, 'agent:bot', 'agent:bot', true, 'manual']); // identity itself is not autoCapable
  expect(o3.g1).toEqual([false, null]);
  expect(o3.s2[0]).toBe(true);
  expect(o3.s2[1]).toBe('agent:other');
  expect(o3.s2[2]).toBe('global');
  expect(o3.s2[3]).toMatch(/\(shared\)$/);
  expect(o3.cs).toEqual([true, 'agent:bot']);
  expect(o3.cg).toEqual([true, 'global', 'connected (shared)']);
  expect(o3.cd).toEqual([false, null]);
  expect(o3.cgGlobal).toEqual([false, null]); // the agent's slack is NOT the host's
  expect(o3.git).toEqual([false, 'agent:bot', null]);
  expect(o3.ens).toEqual({ ok: true, detail: 'connected', owner: 'agent:bot' });
  expect(o3.view).toEqual(['agent:bot', 'bot@example.com', 'host@example.com']);
  expect(o4.cleared).toBe(true);
  expect(o4.agentGone).toBe(true);
});

test('audit: entries carry owner (global omitted), readAudit filters by owner', () => {
  const r = runInChild(
    "const c=await import('./server/capabilities.js');" +
      "c.appendAudit({sessionId:'s1',capability:'identity',mode:'manual',result:'done',evidence:null,human:true});" +
      "c.appendAudit({sessionId:'s2',capability:'composio:gmail',mode:'auto',result:'done',evidence:null,human:false,owner:'agent:bot'});" +
      "c.appendAudit({sessionId:'s3',capability:'git',mode:'manual',result:'done',evidence:null,human:true,owner:'global'});" +
      "emit({all:c.readAudit(50).map(e=>[e.capability,e.owner??null]),bot:c.readAudit(50,'agent:bot').map(e=>e.capability),glob:c.readAudit(50,'global').map(e=>e.capability)});",
    env(fresh())
  );
  if (!r.ok) throw new Error(r.error);
  expect(r.out[0].all).toEqual([['identity', null], ['composio:gmail', 'agent:bot'], ['git', null]]);
  expect(r.out[0].bot).toEqual(['composio:gmail']);
  expect(r.out[0].glob).toEqual(['identity', 'git']);
});

test('chrome: agent session seeded from agents/<slug>/browser (empty, not chrome-base); sync lands in the agent profile; shared:true also in chrome-base; googleAccountEmail never falls back to chrome-base for an agent', () => {
  const dir = fresh();
  // A pre-existing shared login in chrome-base that an agent must NOT inherit.
  fs.mkdirSync(path.join(dir, 'chrome-base', 'Default'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'chrome-base', 'Default', 'Cookies'), 'shared-cookies');
  fs.writeFileSync(path.join(dir, 'chrome-base', 'Default', 'Preferences'), JSON.stringify({ account_info: [{ email: 'host@example.com' }] }));
  const r = runInChild(
    "const st=await import('./server/state.js');const ch=await import('./server/lib/chrome.js');const fs=await import('node:fs');const path=await import('node:path');" +
      "const plain=st.createSession({title:'p',cwd:process.env.ARIGAMI_DIR});const bot=st.createSession({title:'b',cwd:process.env.ARIGAMI_DIR,metadata:{agent:'bot'}});" +
      "emit({seedPlain:ch.profileSeedFor(plain.id),seedBot:ch.profileSeedFor(bot.id),agentDir:ch.agentBrowserDir('bot'),agentOf:[ch.agentOfSession(plain.id),ch.agentOfSession(bot.id)]});" +
      'const pd=ch.ensureSessionProfile(plain.id);const bd=ch.ensureSessionProfile(bot.id);' +
      "emit({plainHasShared:fs.existsSync(path.join(pd,'Default','Cookies')),botHasShared:fs.existsSync(path.join(bd,'Default','Cookies')),agentDirCreated:fs.existsSync(ch.agentBrowserDir('bot')),email:[ch.googleAccountEmail(plain.id),ch.googleAccountEmail(bot.id)]});" +
      // the bot logs in: its own cookies + Google account in ITS copy
      "fs.mkdirSync(path.join(bd,'Default'),{recursive:true});fs.writeFileSync(path.join(bd,'Default','Cookies'),'bot-cookies');fs.writeFileSync(path.join(bd,'Default','Preferences'),JSON.stringify({account_info:[{email:'bot@example.com'}]}));" +
      'const r1=await ch.syncProfileToBase(bot.id);' +
      "emit({r1,agentCookies:fs.readFileSync(path.join(ch.agentBrowserDir('bot'),'Default','Cookies'),'utf8'),baseCookies:fs.readFileSync(path.join(ch.CHROME_BASE_DIR,'Default','Cookies'),'utf8'),email:ch.googleAccountEmail(bot.id)});" +
      'const r2=await ch.syncProfileToBase(bot.id,{shared:true});' +
      "emit({r2,baseCookies:fs.readFileSync(path.join(ch.CHROME_BASE_DIR,'Default','Cookies'),'utf8')});" +
      // a SECOND session of the bot now inherits the bot's profile
      "const bot2=st.createSession({title:'b2',cwd:process.env.ARIGAMI_DIR,metadata:{agent:'bot'}});const bd2=ch.ensureSessionProfile(bot2.id);" +
      "emit({bot2Cookies:fs.readFileSync(path.join(bd2,'Default','Cookies'),'utf8'),none:await ch.syncProfileToBase('sess_never')});",
    env(dir)
  );
  if (!r.ok) throw new Error(r.error);
  const [o1, o2, o3, o4, o5] = r.out;
  expect(o1.seedPlain.owner).toBe('global');
  expect(o1.seedPlain.dir).toBe(path.join(dir, 'chrome-base'));
  expect(o1.seedBot).toEqual({ dir: path.join(dir, 'agents', 'bot', 'browser'), owner: 'agent:bot' });
  expect(o1.agentOf).toEqual([null, 'bot']);
  expect(o2.plainHasShared).toBe(true);
  expect(o2.botHasShared).toBe(false);
  expect(o2.agentDirCreated).toBe(true);
  expect(o2.email).toEqual(['host@example.com', null]); // the bot does NOT see the host's Google account
  expect(o3.r1).toEqual({ ok: true, synced: ['Default/Cookies'], targets: ['agent:bot'] });
  expect(o3.agentCookies).toBe('bot-cookies');
  expect(o3.baseCookies).toBe('shared-cookies');
  expect(o3.email).toBe('bot@example.com');
  expect(o4.r2.targets).toEqual(['agent:bot', 'global']);
  expect(o4.baseCookies).toBe('bot-cookies');
  expect(o5.bot2Cookies).toBe('bot-cookies');
  expect(o5.none).toEqual({ ok: false, synced: [], targets: [] });
});

test('listeners armed by an agent session carry agent; plain sessions do not', () => {
  const r = runInChild(
    "const st=await import('./server/state.js');" +
      "const plain=st.createSession({title:'p',cwd:process.env.ARIGAMI_DIR});const bot=st.createSession({title:'b',cwd:process.env.ARIGAMI_DIR,metadata:{agent:'bot'}});" +
      "const mk=(sessionId)=>st.addListener({sessionId,type:'sms',label:'SMS',params:{},fireOn:['new_message'],watermark:{},ttlAt:Date.now()+1000,intervalSec:5,nextPollAt:0});" +
      'const a=mk(plain.id),b=mk(bot.id);' +
      "emit({a:a.agent??null,b:b.agent,mine:st.listListeners().filter(l=>l.agent==='bot').map(l=>l.id)});",
    env(fresh())
  );
  if (!r.ok) throw new Error(r.error);
  expect(r.out[0].a).toBeNull();
  expect(r.out[0].b).toBe('bot');
  expect(r.out[0].mine.length).toBe(1);
});
