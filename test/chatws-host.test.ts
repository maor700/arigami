// CHATWS — the chat endpoint's wire diet + the hub's liveness probe.
//   * clipEvent caps long strings (tool-result bodies, tool input) and marks
//     the row {clipped, fullBytes}; assistant/user `text` only gets a generous
//     safety cap; short rows come back by identity (no copy, no marker).
//   * getChatPage/getChat honour `clip`; getChatEvent returns one FULL row from
//     the in-memory tail or from disk.
//   * bus.js answers {type:'ping'} with {type:'pong'} and drops clients that
//     miss a heartbeat round.
// claude.js resolves CHAT_DIR at import time, so the disk cases run in a child
// process with a tmp ARIGAMI_DIR (test/_child.js), like the other host tests.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInChild } from './_child.js';


function tmpInstance() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatws-'));
  fs.mkdirSync(path.join(dir, 'chat'), { recursive: true });
  return { dir, env: { ARIGAMI_DIR: dir, ARIGAMI_STATE_FILE: path.join(dir, 'state.json'), HOME: dir } };
}

function writeChat(dir: string, id: string, n: number, bigEvery = 4) {
  const lines: string[] = [];
  for (let i = 1; i <= n; i++) {
    const kind = i % bigEvery === 0 ? 'tool-result' : 'assistant-text';
    const ev: Record<string, unknown> = { id: `ev${i}`, seq: i, ts: 1_000 + i, kind };
    if (kind === 'tool-result') { ev.toolUseId = `tu${i}`; ev.content = 'R'.repeat(20_000); ev.isError = false; }
    else ev.text = `reply ${i}`;
    lines.push(JSON.stringify(ev));
  }
  fs.writeFileSync(path.join(dir, 'chat', `${id}.jsonl`), lines.join('\n') + '\n');
}

const load = "const c=await import('./server/claude.js');";

test('clipEvent: long strings are cut and marked; short rows are untouched (same object)', async () => {
  const { dir, env } = tmpInstance();
  const out = runInChild(
    load +
      "const big={id:'a',seq:1,ts:1,kind:'tool-result',content:'x'.repeat(5000),toolUseId:'t'};" +
      "const arr={id:'b',seq:2,ts:2,kind:'tool-result',content:[{type:'text',text:'y'.repeat(5000)},{type:'text',text:'short'}]};" +
      "const inp={id:'c',seq:3,ts:3,kind:'tool-use',name:'Write',input:{file_path:'/f',content:'z'.repeat(5000)}};" +
      "const prose={id:'d',seq:4,ts:4,kind:'assistant-text',text:'p'.repeat(5000)};" +
      "const small={id:'e',seq:5,ts:5,kind:'user',text:'hi'};" +
      "const cb=c.clipEvent(big,1000), ca=c.clipEvent(arr,1000), ci=c.clipEvent(inp,1000), cp=c.clipEvent(prose,1000), cs=c.clipEvent(small,1000);" +
      "emit({" +
      " bigLen:cb.content.length, bigClipped:cb.clipped===true, bigFull:cb.fullBytes>5000, bigOrigIntact:big.content.length===5000," +
      " arr0:ca.content[0].text.length, arr1:ca.content[1].text, arrClipped:ca.clipped===true," +
      " inpLen:ci.input.content.length, inpPath:ci.input.file_path, inpClipped:ci.clipped===true," +
      " proseSame:cp===prose, proseLen:cp.text.length," +
      " smallSame:cs===small, noClip:c.clipEvent(big,0)===big })",
    env,
  );
  if (!out.ok) throw new Error(out.error);
  const r = out.out[0];
  expect(r.bigLen).toBe(1001); // 1000 chars + the ellipsis
  expect(r.bigClipped).toBe(true);
  expect(r.bigFull).toBe(true);
  expect(r.bigOrigIntact).toBe(true);
  expect(r.arr0).toBe(1001);
  expect(r.arr1).toBe('short');
  expect(r.arrClipped).toBe(true);
  expect(r.inpLen).toBe(1001);
  expect(r.inpPath).toBe('/f');
  expect(r.inpClipped).toBe(true);
  expect(r.proseSame).toBe(true); // 5000 < 16× the cap — prose is read in full
  expect(r.proseLen).toBe(5000);
  expect(r.smallSame).toBe(true);
  expect(r.noClip).toBe(true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('getChatPage honours clip (disk path) and getChatEvent returns the full row', async () => {
  const { dir, env } = tmpInstance();
  writeChat(dir, 'sess_t1', 1000);
  const out = runInChild(
    load +
      "const full=c.getChatPage('sess_t1',{limit:60});" +
      "const lite=c.getChatPage('sess_t1',{limit:60,clip:1500});" +
      "const older=c.getChatPage('sess_t1',{limit:60,beforeSeq:lite.oldestSeq,clip:1500});" +
      "const one=c.getChatEvent('sess_t1',996);" +
      "const since=c.clipEvents(c.getChat('sess_t1',990),1500);" +
      "emit({" +
      " fullN:full.events.length, fullBytes:JSON.stringify(full).length, liteN:lite.events.length, liteBytes:JSON.stringify(lite).length," +
      " liteHasMore:lite.hasMore, liteOldest:lite.oldestSeq, liteLast:lite.events.at(-1).seq," +
      " clippedRows:lite.events.filter(e=>e.clipped).length, olderLast:older.events.at(-1).seq, olderOldest:older.oldestSeq," +
      " oneLen:one.content.length, oneClipped:one.clipped===undefined, missing:c.getChatEvent('sess_t1',5000)," +
      " sinceN:since.length, sinceFirst:since[0].seq })",
    env,
  );
  if (!out.ok) throw new Error(out.error);
  const r = out.out[0];
  expect(r.fullN).toBe(60);
  expect(r.liteN).toBe(60);
  expect(r.liteLast).toBe(1000);
  expect(r.liteOldest).toBe(941);
  expect(r.liteHasMore).toBe(true);
  expect(r.clippedRows).toBe(15); // every 4th row is a 20KB tool-result
  expect(r.liteBytes).toBeLessThan(r.fullBytes / 8); // ~300KB → ~30KB
  expect(r.olderLast).toBe(940);
  expect(r.olderOldest).toBe(881);
  expect(r.oneLen).toBe(20_000);
  expect(r.oneClipped).toBe(true);
  expect(r.missing).toBeNull();
  expect(r.sinceN).toBe(10);
  expect(r.sinceFirst).toBe(991);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('getChat survives one torn line on disk', async () => {
  const { dir, env } = tmpInstance();
  writeChat(dir, 'sess_t2', 20);
  fs.appendFileSync(path.join(dir, 'chat', 'sess_t2.jsonl'), '{"id":"torn","seq":21,"ts":9,"kind":"user","text":"half\n');
  fs.appendFileSync(path.join(dir, 'chat', 'sess_t2.jsonl'), JSON.stringify({ id: 'ev22', seq: 22, ts: 10, kind: 'user', text: 'after' }) + '\n');
  const out = runInChild(
    load + "const evs=c.getChat('sess_t2',0);emit({n:evs.length,last:evs.at(-1).seq})",
    env,
  );
  if (!out.ok) throw new Error(out.error);
  const r = out.out[0];
  expect(r.n).toBe(21);
  expect(r.last).toBe(22);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('bus: ping → pong, heartbeat terminates a client that never pongs', async () => {
  const { dir, env } = tmpInstance();
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ sessions: [], listeners: [], folders: [] }));
  const out = runInChild(
    "const bus=await import('./server/bus.js');const http=await import('node:http');const net=await import('node:net');const {WebSocket}=await import('ws');" +
      "const srv=http.createServer();srv.on('upgrade',(req,sock,head)=>bus.handleUpgrade(req,sock,head));" +
      "await new Promise(r=>srv.listen(0,'127.0.0.1',r));const port=srv.address().port;" +
      "const ws=new WebSocket('ws://127.0.0.1:'+port+'/__ws');const msgs=[];" +
      "ws.on('message',(d)=>msgs.push(JSON.parse(String(d))));await new Promise(r=>ws.on('open',r));" +
      "ws.send(JSON.stringify({type:'ping',ts:42}));" +
      "await new Promise(r=>setTimeout(r,200));" +
      "const pong=msgs.find(m=>m.type==='pong');" +
      // A ghost: a raw TCP client that completes the WebSocket handshake and then
      // never answers anything (Bun's `ws` client always auto-pongs, so a real
      // client cannot play dead). It must be dropped after two heartbeat rounds.
      "const ghost=net.connect(port,'127.0.0.1');await new Promise(r=>ghost.on('connect',r));" +
      "ghost.write('GET /__ws HTTP/1.1\\r\\nHost: x\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\\r\\nSec-WebSocket-Version: 13\\r\\n\\r\\n');" +
      "let closed=false;ghost.on('close',()=>{closed=true});ghost.on('data',()=>{});ghost.on('error',()=>{});" +
      "await new Promise(r=>setTimeout(r,300));" +
      "const before=bus.clientCount();bus.__heartbeat();await new Promise(r=>setTimeout(r,200));const mid=bus.clientCount();bus.__heartbeat();await new Promise(r=>setTimeout(r,300));" +
      "emit({pong:!!pong,echo:pong&&pong.echo,state:msgs.some(m=>m.type==='state'),before,mid,after:bus.clientCount(),closed,liveOpen:ws.readyState===1});" +
      "ws.close();ghost.destroy();srv.close();",
    env,
  );
  if (!out.ok) throw new Error(out.error);
  const r = out.out[0];
  expect(r.state).toBe(true); // the snapshot lands too (order vs. the pong is not guaranteed)
  expect(r.pong).toBe(true);
  expect(r.echo).toBe(42);
  expect(r.before).toBe(2);
  expect(r.mid).toBe(2); // one missed round is not yet fatal
  expect(r.after).toBe(1); // the ghost is gone…
  expect(r.closed).toBe(true);
  expect(r.liveOpen).toBe(true); // …the real client is not
  fs.rmSync(dir, { recursive: true, force: true });
});
