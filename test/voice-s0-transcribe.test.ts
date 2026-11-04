// scripts/whatsapp-transcribe.ts (installed into the bridge as src/arigami-transcribe.ts):
// an incoming voice note becomes "[Audio] <text>"; no key / too big / failing /
// slow / own notes leave "[Audio]" alone; the key never reaches the logger.
import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './_tmp.js';

test('voice notes are transcribed into the row, bounded and never fatal', () => {
  const tmp = tmpDir('wa-stt-');
  fs.writeFileSync(path.join(tmp, 'transcribe.ts'), fs.readFileSync(path.resolve(import.meta.dir, '../scripts/whatsapp-transcribe.ts'), 'utf8'));
  fs.writeFileSync(path.join(tmp, 'database.ts'), `import {Database} from 'bun:sqlite'; const db=new Database(${JSON.stringify(path.join(tmp, 'wa.db'))}); db.exec('CREATE TABLE IF NOT EXISTS messages (id TEXT, chat_jid TEXT, content TEXT, PRIMARY KEY(id, chat_jid))'); export function initializeDatabase(){return db;}`);
  fs.writeFileSync(path.join(tmp, 'run.ts'), `
import {mock} from 'bun:test';
import {Readable} from 'node:stream';
import assert from 'node:assert/strict';
mock.module('@whiskeysockets/baileys',()=>({
 normalizeMessageContent:m=>m,
 downloadMediaMessage:async m=>Readable.from(m.key.id==='huge' ? Array(27).fill(Buffer.alloc(1024*1024)) : [Buffer.from('OggS-bytes')])
}));
const {initializeDatabase}=await import('./database.ts');
const {transcribeAudio,drain}=await import('./transcribe.ts');
const db=initializeDatabase();
const row=(id)=>db.prepare('SELECT content FROM messages WHERE id=? AND chat_jid=?').get(id,'chat-a')?.content;
const note=(id,extra={},audio={})=>({key:{remoteJid:'chat-a',id,fromMe:false,...extra},message:{audioMessage:{mimetype:'audio/ogg; codecs=opus',fileLength:1000,ptt:true,...audio}}});
for(const id of ['ok','nokey','mine','declared','huge','throws','slow','groq']) db.prepare('INSERT INTO messages VALUES(?,?,?)').run(id,'chat-a','[Audio]');
const logs=[];const logger={info:(...a)=>logs.push(JSON.stringify(a)),warn:(...a)=>logs.push(JSON.stringify(a)),debug(){},error:(...a)=>logs.push(JSON.stringify(a))};
const calls=[];
const stub=async(buf,mime,lang)=>{calls.push({bytes:buf.length,mime,lang});return 'שלום עולם';};

transcribeAudio(note('ok'),{},logger,stub);
transcribeAudio(note('nokey'),{},logger);                       // no stub, no GROQ_API_KEY yet
transcribeAudio(note('mine',{fromMe:true}),{},logger,stub);
transcribeAudio(note('declared',{}, {fileLength: 30*1024*1024}),{},logger,stub);
transcribeAudio(note('huge'),{},logger,stub);
transcribeAudio(note('throws'),{},logger,async()=>{throw new Error('stt down')});
transcribeAudio(note('slow'),{},logger,()=>new Promise(()=>{}));
await drain();
assert.equal(row('ok'),'[Audio] שלום עולם');
assert.equal(row('nokey'),'[Audio]');
assert.equal(row('mine'),'[Audio]');
assert.equal(row('declared'),'[Audio]');
assert.equal(row('huge'),'[Audio]');
assert.equal(row('throws'),'[Audio]');
assert.equal(row('slow'),'[Audio]');
assert.deepEqual(calls,[{bytes:10,mime:'audio/ogg; codecs=opus',lang:'he'}]);
assert.ok(logs.some(l=>l.includes('timed out')));
assert.ok(logs.some(l=>l.includes('exceeds')));

// The real Groq path: multipart to the transcription endpoint, language from env, key in the header only.
process.env.GROQ_API_KEY='gsk_test_secret';
process.env.ARIGAMI_VOICE_LANG='en';
let seen=null;
globalThis.fetch=async(url,init)=>{const f=init.body;seen={url:String(url),auth:init.headers.Authorization,language:f.get('language'),model:f.get('model'),name:f.get('file').name};return new Response(JSON.stringify({text:' hello there '}),{status:200,headers:{'content-type':'application/json'}});};
transcribeAudio(note('groq'),{},logger);
await drain();
assert.equal(row('groq'),'[Audio] hello there');
assert.match(seen.url,/audio\\/transcriptions$/);
assert.equal(seen.auth,'Bearer gsk_test_secret');
assert.equal(seen.language,'en');
assert.equal(seen.model,'whisper-large-v3-turbo');
assert.equal(seen.name,'note.ogg');
assert.ok(!logs.join('\\n').includes('gsk_test_secret'));
assert.ok(!fs.readdirSync(${JSON.stringify(tmp)}).some(n=>/\\.(ogg|part)$/.test(n)));
import fs from 'node:fs';
`);
  const r = spawnSync(process.execPath, [path.join(tmp, 'run.ts')], { env: { ...process.env, GROQ_API_KEY: '', ARIGAMI_VOICE_LANG: '', ARIGAMI_STT_TIMEOUT_MS: '1500' }, encoding: 'utf8', timeout: 30000 });
  if (r.status) throw new Error(r.stderr + r.stdout);
  expect(r.status).toBe(0);
});
