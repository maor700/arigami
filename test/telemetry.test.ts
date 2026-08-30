// D3 — server/telemetry.ts. config.js / funnel.js capture ARIGAMI_DIR at
// import, so every case runs in a fresh child (test/_child.js) with its own
// data dir, a stub sender (nothing ever hits the network) and injected facts.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInChild } from './_child.js';

const fresh = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-tele-'));
const env = (dir: string, extra: Record<string, string> = {}) => ({
  ARIGAMI_DIR: dir,
  ARIGAMI_FUNNEL_QUIET: '1',
  HOME: path.join(dir, 'home'),
  ARIGAMI_TELEMETRY: '',
  DO_NOT_TRACK: '',
  ...extra,
});

// Facts a real host would derive from version.ts / state.ts, minus the imports.
const FACTS = "tm.setFactsProvider(async()=>({version:'1.2.3',commit:'abc1234',sessions:3}));";
// A sender that records every call and never opens a socket.
const SENDER = "const sent=[];tm.setSender(async(url,body)=>{sent.push({url,body:JSON.parse(body)});return {ok:true,status:204};});";
const PRELUDE = `const tm=await import('./server/telemetry.js');const f=await import('./server/funnel.js');${FACTS}${SENDER}`;

test('off by default: effective()=off via config, flush() sends nothing', () => {
  const dir = fresh();
  const r = runInChild(
    PRELUDE + "f.firstTime('session.first');const eff=tm.effective();const fl=await tm.flush({force:true});emit({eff,fl,sent});",
    env(dir)
  );
  expect(r.ok).toBe(true);
  const { eff, fl, sent } = r.out[0];
  expect(eff).toEqual({ enabled: false, reason: 'config', configured: false });
  expect(fl).toEqual({ sent: false, reason: 'disabled' });
  expect(sent).toEqual([]);
  expect(fs.existsSync(path.join(dir, 'telemetry.json'))).toBe(false);
});

test('opt-in via config (setEnabled) sends; ARIGAMI_TELEMETRY=1 enables; DO_NOT_TRACK=1 wins over both', () => {
  const dir = fresh();
  const r = runInChild(
    PRELUDE + "tm.setEnabled(true);f.firstTime('session.first');const eff=tm.effective();const fl=await tm.flush();emit({eff,fl,n:sent.length});",
    env(dir)
  );
  expect(r.ok).toBe(true);
  expect(r.out[0].eff).toEqual({ enabled: true, reason: 'config', configured: true });
  expect(r.out[0].fl.sent).toBe(true);
  expect(r.out[0].n).toBe(1);
  const cfgFile = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  expect(cfgFile.telemetry.enabled).toBe(true);

  // env=1 on a fresh dir (config off) → enabled, reason env.
  const r2 = runInChild(PRELUDE + 'emit(tm.effective());', env(fresh(), { ARIGAMI_TELEMETRY: '1' }));
  expect(r2.out[0]).toEqual({ enabled: true, reason: 'env', configured: false });

  // DNT beats config=on AND env=1; flush is a no-op.
  const r3 = runInChild(
    PRELUDE + "f.firstTime('session.first');const eff=tm.effective();const fl=await tm.flush({force:true});emit({eff,fl,n:sent.length});",
    env(dir, { ARIGAMI_TELEMETRY: '1', DO_NOT_TRACK: '1' })
  );
  expect(r3.out[0].eff).toEqual({ enabled: false, reason: 'dnt', configured: true });
  expect(r3.out[0].fl).toEqual({ sent: false, reason: 'disabled' });
  expect(r3.out[0].n).toBe(0);
});

test('payload shape: allow-listed events only, no forbidden strings, R4 milestones map to wire names', () => {
  const dir = fresh();
  const r = runInChild(
    PRELUDE +
      "tm.setEnabled(true);" +
      // The whole R4 funnel + onboarding + a junk event carrying PII-looking props.
      "for(const n of ['install','session.first','pm.first_tree','screen.first_request','skill.first_applied','artifact.first_publish','share.first_link','cron.first'])f.firstTime(n,{path:'/home/someone/repo',email:'x@y.z'});" +
      "f.emit('onboarding.step',{step:'pair',status:'ok',detail:'paired as x@y.z'});" +
      "f.emit('onboarding.done',{});" +
      "f.emit('secret.thing',{prompt:'hello world'});" +
      "const p=await tm.preview();const st=await tm.status();emit({p,st});",
    env(dir)
  );
  expect(r.ok).toBe(true);
  const { p, st } = r.out[0];
  expect(Object.keys(p).sort()).toEqual(['arch', 'commit', 'docker', 'events', 'id', 'os', 'sentAt', 'sessions', 'v', 'version']);
  expect(p.v).toBe(1);
  expect(p.version).toBe('1.2.3');
  expect(p.commit).toBe('abc1234');
  expect(p.sessions).toBe('2-5');
  expect(typeof p.docker).toBe('boolean');
  expect(p.events.map((e: any) => e.name)).toEqual([
    'install', 'first_session', 'first_pm_tree', 'first_request_screen', 'first_proposal_applied',
    'first_artifact_published', 'first_share_link', 'first_cron', 'onboarding_step', 'onboarding_done',
  ]);
  const step = p.events.find((e: any) => e.name === 'onboarding_step');
  expect(step).toEqual({ name: 'onboarding_step', at: step.at, step: 'pair', status: 'ok' });
  for (const e of p.events) expect(Object.keys(e).every((k) => ['name', 'at', 'step', 'status'].includes(k))).toBe(true);
  // The forbidden-content grep from the spec: no '/', no '@', no hostname-ish, no whitespace inside strings.
  const raw = JSON.stringify(p);
  expect(raw).not.toMatch(/[\/@\\]/);
  expect(raw).not.toMatch(/[a-z0-9-]+\.(com|net|org|dev|io|local|internal|ts)\b/i);
  expect(raw).not.toMatch(/home|repo|hello|prompt|secret|paired/);
  expect(raw).not.toMatch(os.hostname().split('.')[0]);
  // status() exposes the same preview + counts, and is itself clean.
  expect(st.enabled).toBe(true);
  expect(st.pending).toBe(10);
  expect(st.id).toBe(p.id);
  expect(JSON.stringify(st.preview)).not.toMatch(/[\/@]/);
});

test('assertClean rejects a payload smuggling a path / email / hostname / extra key', () => {
  const dir = fresh();
  const r = runInChild(
    PRELUDE +
      "const {payload:base}=await tm.buildPayload();const tries=[" +
      "{...base,version:'/usr/local'},{...base,version:'me@x'},{...base,arch:'host.example.com'},{...base,extra:1}," +
      "{...base,events:[{name:'first_session',at:base.sentAt,prompt:'hi'}]},{...base,events:[{name:'not_a_thing',at:base.sentAt}]}];" +
      "emit(tries.map(t=>{try{tm.assertClean(t);return 'ok';}catch(e){return 'rejected';}}));",
    env(dir)
  );
  expect(r.ok).toBe(true);
  expect(r.out[0]).toEqual(['rejected', 'rejected', 'rejected', 'rejected', 'rejected', 'rejected']);
});

test('batching: one send carries every unsent event, the cursor advances, nothing is re-sent; the daily ping sends an empty batch', () => {
  const dir = fresh();
  const r = runInChild(
    PRELUDE +
      "tm.setEnabled(true);f.firstTime('install');f.firstTime('session.first');f.firstTime('pm.first_tree');" +
      "const a=await tm.flush();const b=await tm.flush();const c=await tm.flush({force:true});" +
      "f.firstTime('cron.first');const d=await tm.flush();emit({a,b,c,d,sent:sent.map(s=>({url:s.url,names:s.body.events.map(e=>e.name)}))});",
    env(dir)
  );
  expect(r.ok).toBe(true);
  const { a, b, c, d, sent } = r.out[0];
  expect(a).toMatchObject({ sent: true, events: 3 });
  expect(b).toEqual({ sent: false, reason: 'nothing' });
  expect(c).toMatchObject({ sent: true, events: 0 }); // daily ping
  expect(d).toMatchObject({ sent: true, events: 1 });
  expect(sent.map((s: any) => s.names)).toEqual([['install', 'first_session', 'first_pm_tree'], [], ['first_cron']]);
  expect(sent.every((s: any) => s.url === 'https://telemetry.arigami.dev/v1/events')).toBe(true);
  const st = JSON.parse(fs.readFileSync(path.join(dir, 'telemetry.json'), 'utf8'));
  expect(st.cursor).toBe(4);
  expect(st.lastPayload.events.map((e: any) => e.name)).toEqual(['first_cron']);
});

test('a failed send keeps the cursor so events retry; endpoint comes from config / ARIGAMI_TELEMETRY_URL', () => {
  const dir = fresh();
  const r = runInChild(
    PRELUDE +
      "tm.setEnabled(true);f.firstTime('install');" +
      "tm.setSender(async()=>{throw new Error('ECONNREFUSED');});const a=await tm.flush();" +
      "tm.setSender(async()=>({ok:false,status:500}));const b=await tm.flush();" +
      "tm.setSender(async(url,body)=>{sent.push({url,body:JSON.parse(body)});return {ok:true,status:204};});const c=await tm.flush();" +
      "emit({a,b,c,sent:sent.map(s=>s.url)});",
    env(dir, { ARIGAMI_TELEMETRY_URL: 'https://example.invalid/v1/events' })
  );
  expect(r.ok).toBe(true);
  const { a, b, c, sent } = r.out[0];
  expect(a).toMatchObject({ sent: false, reason: 'error', error: 'ECONNREFUSED' });
  expect(b).toMatchObject({ sent: false, reason: 'error', status: 500 });
  expect(c).toMatchObject({ sent: true, events: 1 });
  expect(sent).toEqual(['https://example.invalid/v1/events']);
});

test('instance id: uuid persisted in telemetry-id, stable across imports, rotate/forget gives a new one and clears history', () => {
  const dir = fresh();
  const r = runInChild(
    PRELUDE + "tm.setEnabled(true);f.firstTime('install');await tm.flush();const id1=tm.instanceId();const id2=tm.instanceId();const {id:id3}=tm.forget();const st=await tm.status();emit({id1,id2,id3,st});",
    env(dir)
  );
  expect(r.ok).toBe(true);
  const { id1, id2, id3, st } = r.out[0];
  expect(id1).toMatch(/^[0-9a-f-]{36}$/);
  expect(id2).toBe(id1);
  expect(id3).not.toBe(id1);
  expect(fs.readFileSync(path.join(dir, 'telemetry-id'), 'utf8').trim()).toBe(id3);
  expect(st.id).toBe(id3);
  expect(st.lastSentAt).toBe(null);
  // A second process reads the same id back.
  const r2 = runInChild(PRELUDE + 'emit(tm.instanceId());', env(dir));
  expect(r2.out[0]).toBe(id3);
});

test('wizard step: telemetry is a skippable step; enable/disable decisions settle it; DNT settles it by itself', () => {
  const dir = fresh();
  const probes =
    "const probes={hasAdmin:()=>true,claudeCli:()=>true,claudeAuth:()=>true,gitAuth:()=>true,profileApplied:()=>'x',pendingProfile:()=>null," +
    "integrations:()=>({composio:false,whatsapp:'disconnected',tailscale:false}),repos:()=>['app'],health:()=>({ok:true,at:'',checks:[]}),unattended:()=>false};";
  const r = runInChild(
    `const ob=await import('./server/onboarding.js');const tm=await import('./server/telemetry.js');${probes}` +
      "ob.wizardAct('integrations','complete','user',probes);" +
      "const v1=ob.wizard(probes);tm.setEnabled(true);const v2=ob.wizardAct('telemetry','complete','user',probes);" +
      "emit({s1:v1.steps.find(s=>s.id==='telemetry'),cur:v1.current,s2:v2.steps.find(s=>s.id==='telemetry'),done:v2.done});",
    env(dir)
  );
  expect(r.ok).toBe(true);
  const { s1, cur, s2, done } = r.out[0];
  expect(s1.status).toBe('todo');
  expect(s1.skippable).toBe(true);
  expect(s1.data).toEqual({ enabled: false, reason: 'config' });
  expect(cur).toBe('telemetry');
  expect(s2.status).toBe('ok');
  expect(s2.data).toEqual({ enabled: true, reason: 'config' });
  expect(done).toBe(true);
  const r2 = runInChild(
    `const ob=await import('./server/onboarding.js');${probes}emit(ob.wizard(probes).steps.find(s=>s.id==='telemetry'));`,
    env(fresh(), { DO_NOT_TRACK: '1' })
  );
  expect(r2.out[0].status).toBe('ok');
  expect(r2.out[0].data).toEqual({ enabled: false, reason: 'dnt' });
});
