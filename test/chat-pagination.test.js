// getChatPage must walk back to the very first event, however long the
// transcript is (it used to stop at the last ~700: a fixed limit+500 read).
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInChild } from './_child.js';
import { tmpDir } from './_tmp.js';

test('older pages stay reachable down to seq 1 in a 2,000-event transcript', () => {
  const dir = tmpDir('pg-');
  const r = runInChild(
    `
    const st=await import('./server/state.ts'); const claude=await import('./server/claude.js');
    const s=st.createSession({title:'long'});
    const f=${JSON.stringify(dir)}+'/chat/'+s.id+'.jsonl';
    fs.mkdirSync(${JSON.stringify(dir)}+'/chat',{recursive:true});
    const lines=[]; for(let i=1;i<=2000;i++) lines.push(JSON.stringify({id:'e'+i,seq:i,kind:'user',text:'m'+i,ts:1}));
    fs.writeFileSync(f,lines.join('\\n')+'\\n');
    const seen=[]; let before=Infinity; let pages=0; let last;
    for(;;){ const p=claude.getChatPage(s.id,{limit:200,beforeSeq:before}); pages++; last=p;
      for(const e of p.events) seen.push(e.seq);
      if(!p.hasMore||!p.events.length) break; before=p.oldestSeq; if(pages>50) break; }
    emit({count:seen.length,min:Math.min(...seen),unique:new Set(seen).size,pages,hasMore:last.hasMore});
    const edge=claude.getChatPage(s.id,{limit:200,beforeSeq:1101});
    emit({edge:edge.events.length,oldest:edge.oldestSeq,more:edge.hasMore});
    const empty=claude.getChatPage(s.id,{limit:200,beforeSeq:1});
    emit({emptyN:empty.events.length,emptyMore:empty.hasMore});
  `,
    { ARIGAMI_DIR: dir, ARIGAMI_STATE_FILE: path.join(dir, 'state.json'), ARIGAMI_PORT: '' }
  );
  if (!r.ok) throw new Error(r.error);
  expect(r.out[0]).toEqual({ count: 2000, min: 1, unique: 2000, pages: 10, hasMore: false });
  expect(r.out[1]).toEqual({ edge: 200, oldest: 901, more: true });
  expect(r.out[2]).toEqual({ emptyN: 0, emptyMore: false });
});
