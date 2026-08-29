// F1: the session LIST payload (GET /__api/sessions, WS state replay,
// session-updated broadcasts) goes over the wire in a slim form —
// claude.capabilities reduced to scalars + counts, finished workers'
// result.summary capped — while getSession()/GET /__api/sessions/:id keep the
// full record. Measured on a live host: ~900KB → ~75KB for 26 sessions.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInChild } from './_child.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-wire-'));

test('listSessionsForWire slims capabilities and caps finished summaries; the full record stays intact', () => {
  const dir = tmp();
  const r = runInChild(
    "const st=await import('./server/state.ts');" +
      "const caps={permissionMode:'default',model:'m',version:'1.0',mcpServers:[{name:'a',status:'connected'}],skills:['s1','s2'],commands:Array.from({length:50},(_,i)=>({name:'c'+i,description:'d'.repeat(200)})),tools:['t1','t2','t3'],agents:[{name:'x'}],models:[{value:'default'}]};" +
      "const long='x'.repeat(1000);" +
      "const done=st.createSession({title:'done',metadata:{result:{state:'done',summary:long}}});st.setClaude(done.id,{capabilities:caps,sessionId:'cs1'});" +
      "const live=st.createSession({title:'live',metadata:{result:{state:'milestone',summary:long}}});" +
      "const short=st.createSession({title:'short',metadata:{result:{state:'done',summary:'brief'}}});" +
      'const wire=st.listSessionsForWire({archived:true});' +
      'const w=(id)=>wire.find(s=>s.id===id);' +
      'emit({' +
      'wireCaps:w(done.id).claude.capabilities,' +
      'fullCapsLen:JSON.stringify(st.getSession(done.id).claude.capabilities).length,' +
      'wireCapsLen:JSON.stringify(w(done.id).claude.capabilities).length,' +
      'doneSummary:w(done.id).metadata.result,' +
      'fullSummaryLen:st.getSession(done.id).metadata.result.summary.length,' +
      'liveSummaryLen:w(live.id).metadata.result.summary.length,liveTrunc:w(live.id).metadata.result.summaryTruncated,' +
      'shortSummary:w(short.id).metadata.result,' +
      'keys:Object.keys(w(done.id)),' +
      'sameObjWhenNothingToSlim:w(short.id)===st.getSession(short.id),' +
      '});',
    { ARIGAMI_DIR: dir, ARIGAMI_PORT: '' }
  );
  if (!r.ok) throw new Error(r.error);
  const o = r.out[0];
  expect(o.wireCaps.slim).toBe(true);
  expect(o.wireCaps.model).toBe('m');
  expect(o.wireCaps.mcpServers).toEqual([{ name: 'a', status: 'connected' }]);
  expect(o.wireCaps.skills).toEqual(['s1', 's2']);
  expect(o.wireCaps.commands).toBeUndefined();
  expect(o.wireCaps.tools).toBeUndefined();
  expect(o.wireCaps.counts).toEqual({ commands: 50, tools: 3, agents: 1, models: 1 });
  expect(o.wireCapsLen).toBeLessThan(o.fullCapsLen / 10);
  expect(o.doneSummary.summary.length).toBe(400);
  expect(o.doneSummary.summaryTruncated).toBe(true);
  expect(o.doneSummary.state).toBe('done');
  expect(o.fullSummaryLen).toBe(1000); // getSession() — the stored record — untouched
  expect(o.liveSummaryLen).toBe(1000); // in-flight milestone: not capped
  expect(o.liveTrunc).toBeUndefined();
  expect(o.shortSummary).toEqual({ state: 'done', summary: 'brief' });
  // Everything the rail/folders need is still on the wire record.
  for (const k of ['id', 'title', 'color', 'status', 'cwd', 'archived', 'tabs', 'activeTabId', 'metadata', 'progress', 'claude', 'createdAt', 'updatedAt'])
    expect(o.keys).toContain(k);
  expect(o.sameObjWhenNothingToSlim).toBe(true);
});

// ?full=1 (host-mcp list_sessions): bearer/internal principals may read the
// untruncated list; cookie browsers never can.
test('canReadFullList: bearer/internal principals only', async () => {
  const { canReadFullList } = await import('../server/auth.ts');
  const user = { id: 'u1', role: 'admin' };
  expect(canReadFullList({ kind: 'session', sessionId: 's', user: null })).toBe(true);
  expect(canReadFullList({ kind: 'host', user: null })).toBe(true);
  expect(canReadFullList({ kind: 'off', user: null })).toBe(true);
  expect(canReadFullList({ kind: 'user', user, via: 'api-token' })).toBe(true);
  expect(canReadFullList({ kind: 'user', user, via: 'cookie' })).toBe(false);
  expect(canReadFullList(null)).toBe(false);
});

test('GET /__api/sessions?full=1 returns untruncated summaries for a bearer caller, slim for a cookie browser', () => {
  const dir = tmp();
  const r = runInChild(
    "const st=await import('./server/state.ts');const {canReadFullList}=await import('./server/auth.ts');" +
      "const long='x'.repeat(1000);" +
      "st.createSession({title:'done',metadata:{result:{state:'done',summary:long}}});" +
      // Mirror api.ts's branch exactly: full only when ?full=1 AND the principal may.
      "const pick=(url,p)=>{const u=new URL(url,'http://h');const full=u.searchParams.get('full')==='1'&&canReadFullList(p);return (full?st.listSessions({archived:true}):st.listSessionsForWire({archived:true})).find(s=>s.title==='done').metadata.result;};" +
      "emit({bearer:pick('/__api/sessions?archived=true&full=1',{kind:'session',sessionId:'s',user:null}),cookie:pick('/__api/sessions?archived=true&full=1',{kind:'user',user:{id:'u',role:'admin'},via:'cookie'}),noflag:pick('/__api/sessions?archived=true',{kind:'session',sessionId:'s',user:null})});",
    { ARIGAMI_DIR: dir, ARIGAMI_PORT: '' }
  );
  if (!r.ok) throw new Error(r.error);
  const o = r.out[0];
  expect(o.bearer.summary.length).toBe(1000);
  expect(o.bearer.summaryTruncated).toBeUndefined();
  expect(o.cookie.summary.length).toBe(400);
  expect(o.cookie.summaryTruncated).toBe(true);
  expect(o.noflag.summary.length).toBe(400);
});
