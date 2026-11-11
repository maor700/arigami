import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInChild } from './_child.js';
import { tmpDir } from './_tmp.js';

test('unknown and over-budget agents cannot provision mutating or full child worktrees', () => {
  const dir = tmpDir('child-preflight-');
  const r = runInChild(`
    const fs=await import('node:fs');
    const path=await import('node:path');
    const http=await import('node:http');
    const {execFileSync}=await import('node:child_process');
    const state=await import('./server/state.ts');
    const agents=await import('./server/agents.ts');
    const ledger=await import('./server/agent-ledger.ts');
    const api=await import('./server/api.ts');
    const repo=path.join(process.env.ARIGAMI_DIR,'repo');
    fs.mkdirSync(repo);
    const git=(...args)=>execFileSync('git',['-C',repo,...args],{encoding:'utf8'}).trim();
    git('init','-q','-b','main');
    git('-c','user.name=Test','-c','user.email=test@example.invalid','commit','--allow-empty','-qm','init');
    const master=state.createSession({title:'master',cwd:repo});
    agents.createAgent({name:'Spent',slug:'spent',budget:{tokensPerDay:1}});
    ledger.appendActivity('spent',{kind:'turn',sessionId:master.id,tokens:2});
    const before={branches:git('branch','--list'),worktrees:git('worktree','list','--porcelain'),sessions:state.listSessions().length};
    const server=http.createServer(api.handle);
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const results=[];
    try {
      for(const kind of ['mutating','full']) for(const agent of ['unknown','spent']) {
        const res=await fetch('http://127.0.0.1:'+server.address().port+'/__api/sessions',{
          method:'POST',headers:{'content-type':'application/json'},
          body:JSON.stringify({master:master.id,kind,agent,subtask:'rejected-'+kind+'-'+agent,worktree:true})
        });
        results.push({status:res.status,body:await res.json()});
      }
    } finally { await new Promise(resolve=>server.close(resolve)); }
    emit({results,before,after:{branches:git('branch','--list'),worktrees:git('worktree','list','--porcelain'),sessions:state.listSessions().length}});
  `, {ARIGAMI_DIR:dir,ARIGAMI_STATE_FILE:path.join(dir,'state.json'),ARIGAMI_CHAT_DIR:path.join(dir,'chat'),ARIGAMI_PORT:''});
  if (!r.ok) throw new Error(r.error);
  expect(r.out[0].results.map(x=>x.status)).toEqual([404,429,404,429]);
  expect(r.out[0].after).toEqual(r.out[0].before);
  expect(r.out[0].results[0].body.error).toContain('unknown agent');
  expect(r.out[0].results[1].body.budget.exceeded).toBe(true);
});
