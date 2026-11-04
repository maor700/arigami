// Stage 1b TTS endpoint logic (docs/VOICE.md): the gate's shapes pass through, text is bounded, the vendor stream
// is relayed as-is, usage is recorded in chars, two sentences per session in flight, and the key never reaches a
// result or a log line. capabilities/config capture ARIGAMI_DIR at import, so each case runs in a fresh child.
import { test, expect } from 'bun:test';
import path from 'node:path';
import { runInChild } from './_child.js';
import { tmpDir } from './_tmp.js';

const env = (dir: string) => ({ ARIGAMI_DIR: dir, ARIGAMI_FUNNEL_QUIET: '1', HOME: path.join(dir, 'home'), GROQ_API_KEY: '' });
const KEY = 'xi-test-SECRETKEY-0123456789abcdef';
const IMPORTS =
  "const vp=await import('./server/voice-providers.js');const vu=await import('./server/voice-usage.js');const cfgm=await import('./server/lib/config.js');const tts=await import('./server/voice-tts.js');" +
  'const logs=[];const _l=console.log,_e=console.error;console.log=(...a)=>logs.push(a.join(" "));console.error=(...a)=>logs.push(a.join(" "));' +
  'const audio=(chunks,ct="audio/mpeg")=>new Response(new ReadableStream({start(c){for(const x of chunks)c.enqueue(new TextEncoder().encode(x));c.close();}}),{status:200,headers:{"content-type":ct}});' +
  'const drain=async(r)=>{const rd=r.stream.getReader();let s="";for(;;){const {done,value}=await rd.read();if(done)break;s+=new TextDecoder().decode(value);}r.release();return s;};';
const run = (body: string) => {
  const r = runInChild(IMPORTS + body, env(tmpDir('arigami-tts-')));
  if (!r.ok) throw new Error(r.error);
  return r.out[0];
};

test('gate shapes: no provider → needs_setup; kill-switch → disabled; cap reached → soft-stopped; then the next provider in order', () => {
  const out = run(
    `const KEY=${JSON.stringify(KEY)};const seen=[];const f=async(u,i)=>{seen.push(String(u));return audio(["a"]);};` +
      "const none=await tts.handleTts({sessionId:'s1',text:'שלום עולם.'},{fetchImpl:f});" +
      "vp.setProviderSecret('voice:elevenlabs',{token:KEY});" +
      'cfgm.updateVoiceConfig({enabled:false});' +
      "const off=await tts.handleTts({sessionId:'s1',text:'שלום עולם.'},{fetchImpl:f});" +
      'cfgm.updateVoiceConfig({enabled:true});' +
      "cfgm.updateVoiceConfig({caps:{'voice:elevenlabs':0.01}});vu.recordVoiceUsage('voice:elevenlabs',{usd:1});" +
      "const capped=await tts.handleTts({sessionId:'s1',text:'שלום עולם.'},{fetchImpl:f});" +
      "vp.setProviderSecret('voice:openai',{token:KEY+'oa'});" +
      "const next=await tts.handleTts({sessionId:'s1',text:'שלום עולם.'},{fetchImpl:f});const body=await drain(next);" +
      'emit({none:none.body,noneStatus:none.status,off:off.body,capped:capped.body,next:{kind:next.kind,provider:next.provider},body,seen});'
  );
  expect(out.noneStatus).toBe(200);
  expect(out.none.needs_setup).toBe('voice:elevenlabs');
  expect(out.none.why).toContain('aloud');
  expect(out.off.disabled).toBe(true);
  expect(out.capped.budget).toBe('soft-stopped');
  expect(out.capped.provider).toBe('voice:elevenlabs');
  expect(out.next).toEqual({ kind: 'stream', provider: 'voice:openai' });
  expect(out.body).toBe('a');
  expect(out.seen).toEqual(['https://api.openai.com/v1/audio/speech']);
});

test('stream: chunks relayed in order, usage recorded in chars, provider request shaped for ElevenLabs, key only in the vendor header', () => {
  const out = run(
    `const KEY=${JSON.stringify(KEY)};let req=null;const f=async(u,i)=>{req={url:String(u),headers:i.headers,body:JSON.parse(i.body),method:i.method};return audio(["ID3","\\u0001\\u0002","tail"]);};` +
      "vp.setProviderSecret('voice:elevenlabs',{token:KEY});" +
      "const text='בדיקה. עוד משפט קצר!';" +
      "const r=await tts.handleTts({sessionId:'s1',text,lang:'he',voice:'bad voice id!'},{fetchImpl:f});" +
      "const before=tts.inflightFor('s1');const body=await drain(r);const after=tts.inflightFor('s1');" +
      "const usage=vu.voiceUsageThisMonth()['voice:elevenlabs'];" +
      'emit({kind:r.kind,provider:r.provider,ct:r.contentType,body,before,after,usage,req,leak:JSON.stringify({r:{kind:r.kind,provider:r.provider,ct:r.contentType},logs}).includes(KEY),logs});'
  );
  expect(out.kind).toBe('stream');
  expect(out.provider).toBe('voice:elevenlabs');
  expect(out.ct).toBe('audio/mpeg');
  expect(out.body).toBe('ID3\u0001\u0002tail');
  expect(out.before).toBe(1);
  expect(out.after).toBe(0);
  expect(out.usage.chars).toBe('בדיקה. עוד משפט קצר!'.length);
  expect(out.usage.calls).toBe(1);
  expect(out.usage.usd).toBeGreaterThan(0);
  expect(out.req.method).toBe('POST');
  expect(out.req.url).toBe('https://api.elevenlabs.io/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM/stream?output_format=mp3_44100_128');
  expect(out.req.headers['xi-api-key']).toBe(KEY);
  expect(out.req.body).toEqual({ text: 'בדיקה. עוד משפט קצר!', model_id: 'eleven_v3', language_code: 'he' });
  expect(out.leak).toBe(false);
  expect(out.logs.some((l: string) => /\[voice-tts\] voice:elevenlabs 20 chars/.test(l))).toBe(true);
});

test('bounds: empty / too-long text → 400; two in flight per session, the third → 429, freed again after release', () => {
  const out = run(
    `const KEY=${JSON.stringify(KEY)};vp.setProviderSecret('voice:elevenlabs',{token:KEY});` +
      "const empty=await tts.handleTts({sessionId:'s1',text:'   '});" +
      "const long=await tts.handleTts({sessionId:'s1',text:'א'.repeat(tts.TTS_MAX_CHARS+1)});" +
      "const ok=await tts.handleTts({sessionId:'s1',text:'א'.repeat(tts.TTS_MAX_CHARS)},{fetchImpl:async()=>audio(['x'])});await drain(ok);" +
      'const holds=[];const slow=()=>new Promise((res)=>holds.push(res));' +
      "const a=tts.handleTts({sessionId:'s2',text:'one.'},{fetchImpl:slow});const b=tts.handleTts({sessionId:'s2',text:'two.'},{fetchImpl:slow});" +
      'await new Promise((r)=>setTimeout(r,20));' +
      "const third=await tts.handleTts({sessionId:'s2',text:'three.'},{fetchImpl:slow});" +
      "const other=await tts.handleTts({sessionId:'s3',text:'other.'},{fetchImpl:async()=>audio(['y'])});await drain(other);" +
      "const during=tts.inflightFor('s2');" +
      "for(const h of holds)h(audio(['z']));const ra=await a,rb=await b;await drain(ra);await drain(rb);" +
      "const fourth=await tts.handleTts({sessionId:'s2',text:'four.'},{fetchImpl:async()=>audio(['w'])});await drain(fourth);" +
      "emit({empty:[empty.status,empty.body.error],long:[long.status,long.body.error],okKind:ok.kind,third:[third.status,third.body.error],otherKind:other.kind,during,after:tts.inflightFor('s2'),fourth:fourth.kind});"
  );
  expect(out.empty).toEqual([400, 'text required']);
  expect(out.long[0]).toBe(400);
  expect(out.long[1]).toContain('too long');
  expect(out.okKind).toBe('stream');
  expect(out.third[0]).toBe(429);
  expect(out.third[1]).toContain('busy');
  expect(out.otherKind).toBe('stream');
  expect(out.during).toBe(2);
  expect(out.after).toBe(0);
  expect(out.fourth).toBe('stream');
});

test('vendor errors: a 401 with the key in its body → 502 without the key, nothing recorded, slot freed; a thrown fetch too', () => {
  const out = run(
    `const KEY=${JSON.stringify(KEY)};vp.setProviderSecret('voice:cartesia',{token:KEY});` +
      "const rej=await tts.handleTts({sessionId:'s1',text:'hello there.'},{fetchImpl:async()=>new Response('invalid key '+KEY,{status:401,headers:{'content-type':'text/plain'}})});" +
      "const down=await tts.handleTts({sessionId:'s1',text:'hello there.'},{fetchImpl:async()=>{throw new Error('connect ECONNREFUSED '+KEY);}});" +
      "emit({rej:[rej.status,rej.body.error],down:[down.status,down.body.error],inflight:tts.inflightFor('s1'),usage:vu.voiceUsageThisMonth()['voice:cartesia']||null,leak:JSON.stringify({rej,down,logs}).includes(KEY)});"
  );
  expect(out.rej[0]).toBe(502);
  expect(out.rej[1]).toContain('Cartesia answered 401');
  expect(out.rej[1]).toContain('•••');
  expect(out.down[0]).toBe(502);
  expect(out.down[1]).toContain('ECONNREFUSED');
  expect(out.inflight).toBe(0);
  expect(out.usage).toBeNull();
  expect(out.leak).toBe(false);
});

test('vendorRequest: Cartesia and OpenAI shapes, config overrides for voice/model, language_code on every ElevenLabs model but multilingual_v2', () => {
  const out = run(
    `const KEY=${JSON.stringify(KEY)};for(const id of ['voice:elevenlabs','voice:cartesia','voice:openai'])vp.setProviderSecret(id,{token:KEY+id.length});` +
      "const car=tts.vendorRequest('voice:cartesia','שלום',{lang:'he'});const oa=tts.vendorRequest('voice:openai','hi',{voice:'nova'});" +
      "cfgm.cfg.voice.tts={voice:{'voice:elevenlabs':'VoiceXYZ'},model:{'voice:elevenlabs':'eleven_flash_v2_5'}};" +
      "const el=tts.vendorRequest('voice:elevenlabs','hi',{lang:'en'});" +
      "cfgm.updateVoiceConfig({caps:{}});const kept=cfgm.cfg.voice.tts;" +
      'emit({car:{url:car.url,h:Object.keys(car.headers),body:car.body},oa:{url:oa.url,auth:oa.headers.Authorization.slice(0,7),body:oa.body},el:{url:el.url,body:el.body},kept});'
  );
  expect(out.car.url).toBe('https://api.cartesia.ai/tts/bytes');
  expect(out.car.h).toEqual(['X-API-Key', 'Cartesia-Version', 'content-type']);
  expect(out.car.body).toEqual({ model_id: 'sonic-3', transcript: 'שלום', voice: { mode: 'id', id: 'a0e99841-438c-4a64-b679-ae501e7d6091' }, output_format: { container: 'mp3', bit_rate: 128000, sample_rate: 44100 }, language: 'he' });
  expect(out.oa.url).toBe('https://api.openai.com/v1/audio/speech');
  expect(out.oa.auth).toBe('Bearer ');
  expect(out.oa.body).toEqual({ model: 'gpt-4o-mini-tts', input: 'hi', voice: 'nova', response_format: 'mp3' });
  expect(out.el.url).toContain('/text-to-speech/VoiceXYZ/stream');
  expect(out.el.body).toEqual({ text: 'hi', model_id: 'eleven_flash_v2_5', language_code: 'en' });
  expect(out.kept).toEqual({ voice: { 'voice:elevenlabs': 'VoiceXYZ' }, model: { 'voice:elevenlabs': 'eleven_flash_v2_5' } });
});
