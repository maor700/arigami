import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { tmpDir } from './_tmp.js';

test('media survives process restart, retains captionless images, scopes lookup to chat and downloads safely', () => {
  const tmp = tmpDir('wa-media-');
  const source = fs.readFileSync(path.resolve(import.meta.dir, '../scripts/whatsapp-media.ts'), 'utf8');
  fs.writeFileSync(path.join(tmp, 'media.ts'), source);
  fs.writeFileSync(path.join(tmp, 'database.ts'), `import {Database} from 'bun:sqlite'; const db=new Database(${JSON.stringify(path.join(tmp,'media.db'))}); export function initializeDatabase(){return db;}`);
  fs.writeFileSync(path.join(tmp, 'run.ts'), `
import {mock} from 'bun:test';
import {Readable} from 'node:stream';
import fs from 'node:fs';
import assert from 'node:assert/strict';
mock.module('zod',()=>({z:{string:()=>({min:()=>({})})}}));
mock.module('@whiskeysockets/baileys',()=>({
 proto:{WebMessageInfo:{encode:m=>({finish:()=>Buffer.from(JSON.stringify(m))}),decode:b=>JSON.parse(Buffer.from(b).toString())}},
 normalizeMessageContent:m=>m,
 downloadMediaMessage:async m=>Readable.from(m.key.id==='oversized' ? Array(51).fill(Buffer.alloc(1024*1024)) : [Buffer.from('image-bytes')])
}));
const {rememberMedia,registerMediaTool}=await import('./media.ts');
if(process.argv[2]==='seed') {
 for(const id of ['image','oversized']) assert.equal(rememberMedia({key:{remoteJid:'chat-a',id},message:{imageMessage:{mimetype:'image/png'}}}),'[image]');
} else {
 let handler;
 registerMediaTool({tool:(_n,_schema,h)=>handler=h},{updateMediaMessage:()=>{}},{});
 const missing=await handler({chat_jid:'other-chat',message_id:'image'});
 assert.equal(missing.isError,true);
 const result=await handler({chat_jid:'chat-a',message_id:'image'});
 assert.ok(!result.isError);
 const file=JSON.parse(result.content[0].text);
 assert.equal(fs.readFileSync(file.path,'utf8'),'image-bytes');
 assert.equal(file.mime_type,'image/png');
 assert.equal(fs.statSync(file.path).mode & 0o777,0o600);
 const large=await handler({chat_jid:'chat-a',message_id:'oversized'});
 assert.equal(large.isError,true);
 assert.match(large.content[0].text,/50 MiB/);
 assert.ok(fs.readdirSync(${JSON.stringify(path.join(tmp,'data/media'))}).every(n=>!n.endsWith('.part')));
}
`);
  for (const phase of ['seed', 'download']) {
    const r = spawnSync(process.execPath, [path.join(tmp, 'run.ts'), phase], { env: { ...process.env, WHATSAPP_MCP_DATA_DIR: path.join(tmp, 'data') }, encoding: 'utf8' });
    if (r.status) throw new Error(r.stderr);
    expect(r.status).toBe(0);
  }
});
