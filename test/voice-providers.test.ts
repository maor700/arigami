// Voice & phone foundation (docs/VOICE.md): capability ids, per-provider check() against a stubbed fetch, the
// needs_setup / disabled / soft-stopped shapes of requireVoiceProvider, the usage ledger + caps and the
// kill-switch. capabilities.ts / config.ts capture ARIGAMI_DIR at import, so every case runs in a fresh child.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { runInChild } from './_child.js';
import { tmpDir } from './_tmp.js';

const env = (dir: string, extra: Record<string, string> = {}) => ({ ARIGAMI_DIR: dir, ARIGAMI_FUNNEL_QUIET: '1', HOME: path.join(dir, 'home'), GROQ_API_KEY: '', ...extra });
const KEY = 'sk-test-SECRETKEY-0123456789abcdef';
const IMPORTS = "const c=await import('./server/capabilities.js');const vp=await import('./server/voice-providers.js');const vu=await import('./server/voice-usage.js');const cfgm=await import('./server/lib/config.js');";
const run = (body: string, dir = tmpDir('arigami-voice-'), extra: Record<string, string> = {}) => {
  const r = runInChild(IMPORTS + body, env(dir, extra));
  if (!r.ok) throw new Error(r.error);
  return { out: r.out[0], dir };
};

test('CAP_ID_RE: the five voice/phone ids resolve; junk does not', () => {
  const { out } = run(
    "const ids=['voice:openai','voice:gemini','voice:elevenlabs','voice:cartesia','voice:deepgram','telephony:twilio'];" +
      "const bad=['voice:','voice:nope','voice:OpenAI','telephony:','telephony:vonage','voice:openai/x','telephony:twilio '];" +
      'emit({ok:ids.map(c.isCapabilityId),bad:bad.map(c.isCapabilityId),caps:ids.map(id=>{const k=c.getCapability(id);return k&&[k.id,k.group,k.manual.kind,k.manual.fields.map(f=>f.name).join(","),k.autoCapable];}),' +
      "listed:c.listCapabilities({composioConnected:async()=>null}).map(x=>x.id).filter(x=>x.startsWith('voice:')||x.startsWith('telephony:'))});"
  );
  expect(out.ok).toEqual([true, true, true, true, true, true]);
  expect(out.bad).toEqual([false, false, false, false, false, false, false]);
  expect(out.caps).toEqual([
    ['voice:openai', 'voice', 'token', 'token', false],
    ['voice:gemini', 'voice', 'token', 'token', false],
    ['voice:elevenlabs', 'voice', 'token', 'token', false],
    ['voice:cartesia', 'voice', 'token', 'token', false],
    ['voice:deepgram', 'voice', 'token', 'token', false],
    ['telephony:twilio', 'voice', 'token', 'sid,token', false],
  ]);
  expect(out.listed).toEqual(['voice:openai', 'voice:gemini', 'voice:elevenlabs', 'voice:cartesia', 'voice:deepgram', 'telephony:twilio']);
});

test('check(): no key → not ok; stubbed fetch ok / 401 / timeout per provider; the key never reaches a message; rejection drops the key', () => {
  const { out, dir } = run(
    `const KEY=${JSON.stringify(KEY)};const seen=[];` +
      'const mk=(mode)=>async(url,init)=>{seen.push({url:String(url),h:init.headers});' +
      "if(mode==='timeout'){const e=new Error('The operation timed out: '+KEY);e.name='TimeoutError';throw e;}" +
      "if(mode==='down'){throw new Error('connect ECONNREFUSED '+KEY);}" +
      "return {ok:mode==='ok',status:mode==='ok'?200:401};};" +
      "const ids=['voice:openai','voice:gemini','voice:elevenlabs','voice:cartesia','voice:deepgram','telephony:twilio'];" +
      'const fields=(id)=>id===\'telephony:twilio\'?{sid:\'ACtestsid1234567890\',token:KEY}:{token:KEY};' +
      'const res={};' +
      'for(const id of ids){' +
      "  const none=await vp.checkProvider(id);" +
      '  vp.setProviderSecret(id,fields(id));' +
      "  const ok=await vp.checkProvider(id,{fetchImpl:mk('ok'),fresh:true});" +
      "  const rej=await vp.checkProvider(id,{fetchImpl:mk('401'),fresh:true});" +
      "  const to=await vp.checkProvider(id,{fetchImpl:mk('timeout'),fresh:true});" +
      "  const down=await vp.checkProvider(id,{fetchImpl:mk('down'),fresh:true});" +
      '  res[id]={none:[none.ok,none.data.hasKey],ok:[ok.ok,ok.detail],rej:[rej.ok,rej.detail,rej.data.rejected],to:[to.ok,to.detail],down:[down.ok,down.detail],' +
      '    connectedAfterRej:(await vp.checkProvider(id,{fetchImpl:mk(\'401\'),fresh:true}),vp.providerConnected(id))};' +
      '}' +
      "const leak=JSON.stringify(res).includes(KEY);" +
      "const urls=seen.map(s=>s.url);const hdr=seen.map(s=>JSON.stringify(s.h));" +
      // connectProvider: a rejected key is not kept; an accepted one is
      "let threw=null;try{await vp.connectProvider('voice:deepgram',{token:KEY+'x'},mk('401'));}catch(e){threw=e.message;}" +
      "const keptAfterReject=vp.hasProviderSecret('voice:deepgram');" +
      "const conn=await vp.connectProvider('voice:deepgram',{token:KEY+'y'},mk('ok'));" +
      "let short=null;try{vp.setProviderSecret('voice:openai',{token:'abc'});}catch(e){short=e.message;}" +
      "emit({res,leak,urls,hdr,threw,keptAfterReject,conn,short,file:vp.SECRETS_FILE});"
  );
  for (const id of ['voice:openai', 'voice:gemini', 'voice:elevenlabs', 'voice:cartesia', 'voice:deepgram', 'telephony:twilio']) {
    const r = out.res[id];
    expect(r.none).toEqual([false, false]);
    expect(r.ok).toEqual([true, 'connected']);
    expect(r.rej[0]).toBe(false);
    expect(r.rej[1]).toMatch(/rejected the key \(401\)/);
    expect(r.rej[2]).toBe(true);
    expect(r.to[0]).toBe(false);
    expect(r.to[1]).toMatch(/did not answer in 6s/);
    expect(r.down[0]).toBe(false);
    expect(r.down[1]).toMatch(/could not reach/);
    expect(r.connectedAfterRej).toBe(false); // a fresh rejection gates the provider off until a new key
  }
  expect(out.leak).toBe(false);
  // one cheap authenticated call each, at the vendor's own API
  expect(out.urls.some((u: string) => u.startsWith('https://api.openai.com/v1/models'))).toBe(true);
  expect(out.urls.some((u: string) => u.startsWith('https://generativelanguage.googleapis.com/v1beta/models'))).toBe(true);
  expect(out.hdr.some((h: string) => h.includes('x-goog-api-key'))).toBe(true);
  expect(out.urls.some((u: string) => u.startsWith('https://api.elevenlabs.io/v1/user'))).toBe(true);
  expect(out.urls.some((u: string) => u.startsWith('https://api.cartesia.ai/voices'))).toBe(true);
  expect(out.urls.some((u: string) => u.startsWith('https://api.deepgram.com/v1/projects'))).toBe(true);
  expect(out.urls.some((u: string) => u === 'https://api.twilio.com/2010-04-01/Accounts/ACtestsid1234567890.json')).toBe(true);
  expect(out.hdr.some((h: string) => h.includes('Cartesia-Version'))).toBe(true);
  expect(out.threw).toMatch(/rejected the key/);
  expect(out.keptAfterReject).toBe(false);
  expect(out.conn).toEqual({ ok: true, detail: 'connected' });
  expect(out.short).toMatch(/missing or does not look right/);
  // the key lives in its own 0600 file, not in config.json
  expect(out.file).toBe(path.join(dir, 'voice-providers.json'));
  expect(fs.statSync(out.file).mode & 0o777).toBe(0o600);
  expect(fs.readFileSync(out.file, 'utf8')).toContain(KEY + 'y');
  expect(fs.existsSync(path.join(dir, 'config.json')) ? fs.readFileSync(path.join(dir, 'config.json'), 'utf8') : '').not.toContain(KEY);
});

test('requireVoiceProvider: needs_setup names the recommended provider per kind; groq is today\'s STT; connected → ok', () => {
  const { out } = run(
    "const kinds=['stt','tts','realtime','telephony'];" +
      'const none=Object.fromEntries(kinds.map(k=>[k,vp.requireVoiceProvider(k)]));' +
      "process.env.GROQ_API_KEY='gsk_test';const stt=vp.requireVoiceProvider('stt');" +
      "const fok=async()=>({ok:true,status:200});" +
      "await vp.connectProvider('voice:elevenlabs',{token:'xi-0123456789abcdef'},fok);" +
      "await vp.connectProvider('telephony:twilio',{sid:'ACabcdef0123456789',token:'tok-0123456789abcdef'},fok);" +
      "emit({none,stt,tts:vp.requireVoiceProvider('tts'),tel:vp.requireVoiceProvider('telephony'),rt:vp.requireVoiceProvider('realtime','call the owner'),summary:vp.voiceProviders(),telephonyConnected:vp.telephonyConnected()});"
  );
  for (const k of ['stt', 'tts', 'realtime', 'telephony']) {
    expect(Object.keys(out.none[k]).sort()).toEqual(['hint', 'needs_setup', 'why']);
    expect(out.none[k].hint).toContain(`request_setup({capability:"${out.none[k].needs_setup}"`);
    expect(out.none[k].hint).toContain('Settings → Connections → Voice & phone');
  }
  expect(out.none.stt.needs_setup).toBe('voice:deepgram');
  expect(out.none.tts.needs_setup).toBe('voice:elevenlabs');
  expect(out.none.realtime.needs_setup).toBe('voice:openai');
  expect(out.none.telephony.needs_setup).toBe('telephony:twilio');
  expect(out.stt).toEqual({ ok: true, provider: 'groq', kind: 'stt' });
  expect(out.tts).toEqual({ ok: true, provider: 'voice:elevenlabs', kind: 'tts' });
  expect(out.tel).toEqual({ ok: true, provider: 'telephony:twilio', kind: 'telephony' });
  expect(out.rt).toEqual({ needs_setup: 'voice:openai', why: 'call the owner', hint: expect.stringContaining('voice:openai') });
  expect(out.summary).toEqual({ enabled: true, stt: ['groq'], tts: ['voice:elevenlabs'], realtime: [], telephony: true });
  expect(out.telephonyConnected).toBe(true);
});

test('budget: usage accrues per provider per month at PLAN.md prices; under cap → ok, at cap → soft-stopped, the gate falls back; kill-switch → everything off', () => {
  const { out, dir } = run(
    "const fok=async()=>({ok:true,status:200});" +
      "await vp.connectProvider('voice:elevenlabs',{token:'xi-0123456789abcdef'},fok);" +
      "await vp.connectProvider('voice:cartesia',{token:'sk_car_0123456789abcdef'},fok);" +
      "const a=vu.recordVoiceUsage('voice:elevenlabs',{chars:10000});const b=vu.recordVoiceUsage('voice:elevenlabs',{chars:5000});" +
      "const tw=vu.recordVoiceUsage('telephony:twilio',{seconds:60,inbound:true});const tw2=vu.recordVoiceUsage('telephony:twilio',{seconds:60});" +
      "const dg=vu.recordVoiceUsage('voice:deepgram',{seconds:600});const known=vu.recordVoiceUsage('voice:openai',{seconds:60,usd:0.25});" +
      "const noCap=vu.voiceBudgetState('voice:elevenlabs');" +
      "cfgm.updateVoiceConfig({caps:{'voice:elevenlabs':1}});const under=vu.voiceBudgetState('voice:elevenlabs');" +
      "const c3=vu.recordVoiceUsage('voice:elevenlabs',{chars:10000});const over=vu.voiceBudgetState('voice:elevenlabs');" +
      "const fallback=vp.requireVoiceProvider('tts');" +
      "cfgm.updateVoiceConfig({caps:{'voice:cartesia':0.01}});vu.recordVoiceUsage('voice:cartesia',{chars:1000});const stopped=vp.requireVoiceProvider('tts');" +
      "const month=vu.voiceUsageThisMonth();" +
      "const bad=vu.voiceBudgetState('voice:nope');vu.recordVoiceUsage('voice:elevenlabs',{chars:-5,seconds:'x'});" +
      "cfgm.updateVoiceConfig({caps:{'voice:cartesia':null}});const cleared=vu.voiceBudgetState('voice:cartesia');" +
      // kill-switch
      "cfgm.updateVoiceConfig({enabled:false});" +
      "const off={req:vp.requireVoiceProvider('tts'),summary:vp.voiceProviders(),check:await vp.checkProvider('voice:elevenlabs',{fetchImpl:fok,fresh:true}),status:(await c0()).detail,connected:vp.providerConnected('voice:elevenlabs'),offline:vp.checkProviderOffline('voice:elevenlabs').ok};" +
      "async function c0(){const cap=(await import('./server/capabilities.js')).getCapability('voice:elevenlabs');return (await import('./server/capabilities.js')).statusOf(cap);}" +
      "cfgm.updateVoiceConfig({enabled:true});const back=vp.requireVoiceProvider('tts');" +
      "const cfgFile=JSON.parse(require('node:fs').readFileSync(cfgm.cfg.configFile,'utf8')).voice;" +
      'emit({a,b,tw,tw2,dg,known,noCap,under,c:c3,over,fallback,stopped,month,bad,cleared,off,back,cfgFile,file:vu.USAGE_FILE});'
  );
  expect(out.a).toEqual({ seconds: 0, chars: 10000, usd: 0.4, calls: 1 });
  expect(out.b.chars).toBe(15000);
  expect(out.b.usd).toBeCloseTo(0.6, 6);
  expect(out.tw.usd).toBeCloseTo(0.0107, 6);
  expect(out.tw2.usd).toBeCloseTo(0.0107 + 0.0646, 6);
  expect(out.dg.usd).toBeCloseTo(0.092, 6);
  expect(out.known.usd).toBe(0.25);
  expect(out.noCap).toBe('ok');
  expect(out.under).toBe('ok');
  expect(out.c.usd).toBeCloseTo(1.0, 6);
  expect(out.over).toBe('soft-stopped');
  expect(out.fallback).toEqual({ ok: true, provider: 'voice:cartesia', kind: 'tts' });
  expect(out.stopped).toEqual({ ok: false, budget: 'soft-stopped', provider: 'voice:elevenlabs', why: expect.stringContaining('cap') });
  expect(out.month['voice:elevenlabs']).toMatchObject({ chars: 25000, calls: 3, capUsd: 1, state: 'soft-stopped' });
  expect(out.month['voice:cartesia']).toMatchObject({ capUsd: 0.01, state: 'soft-stopped' });
  expect(out.month['telephony:twilio']).toMatchObject({ seconds: 120, capUsd: null, state: 'ok' });
  expect(out.bad).toBe('ok');
  expect(out.cleared).toBe('ok');
  expect(out.off.req).toEqual({ ok: false, disabled: true, why: expect.stringContaining('switched off') });
  expect(out.off.summary).toEqual({ enabled: false, stt: [], tts: [], realtime: [], telephony: false });
  expect(out.off.check.ok).toBe(false);
  expect(out.off.check.data).toMatchObject({ hasKey: true, disabled: true });
  expect(out.off.status).toContain('switched off');
  expect(out.off.connected).toBe(false);
  expect(out.off.offline).toBe(false);
  expect(out.back).toEqual({ ok: true, provider: 'voice:cartesia', kind: 'tts' }); // elevenlabs is still at its cap
  expect(out.cfgFile).toEqual({ enabled: true, caps: { 'voice:elevenlabs': 1 } });
  expect(out.file).toBe(path.join(dir, 'voice-usage.json'));
  const ledger = JSON.parse(fs.readFileSync(out.file, 'utf8'));
  expect(Object.keys(ledger)).toEqual([new Date().toISOString().slice(0, 7)]);
});

test('doctor: voice rows answer offline (key stored → ok, none → paste a key) and never call out', () => {
  const { out } = run(
    "vp.setProviderSecret('voice:openai',{token:'sk-0123456789abcdef'});" +
      "globalThis.fetch=async()=>{throw new Error('network call in doctor');};" +
      'emit(await c.formatDoctor({composioConnected:async()=>null}));'
  );
  expect(out).toMatch(/✓ voice:openai\s+key stored \(not verified\)/);
  expect(out).toMatch(/○ voice:elevenlabs\s+paste a key for ElevenLabs/);
  expect(out).toMatch(/○ telephony:twilio\s+paste a key for Twilio \(phone\)/);
});
