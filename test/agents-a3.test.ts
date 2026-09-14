// A3 unit: the tool/domain policy (agent-policy.ts), the activity ledger +
// daily budget (agent-ledger.ts) and the autoApprove field (agents.ts). The
// modules capture ARIGAMI_DIR at import time → each case runs in a fresh child.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInChild } from './_child.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-a3-'));
const env = (dir: string) => ({ ARIGAMI_DIR: dir, ARIGAMI_PORT: '', ARIGAMI_STATE_FILE: path.join(dir, 'state.json'), ARIGAMI_CHAT_DIR: path.join(dir, 'chat') });
const run = (dir: string, body: string) => {
  const r = runInChild(body, env(dir));
  if (!r.ok) throw new Error(r.error);
  return r.out[0];
};

test('policy: families expand, core + read-only tools always pass, restricted built-ins / external servers need an entry', () => {
  const o = run(
    tmp(),
    "const a=await import('./server/agents.ts');const p=await import('./server/agent-policy.ts');" +
      "a.createAgent({name:'Bot',slug:'bot',tools:['gmail','open_tab','mcp__whatsapp__*']});" +
      "const pol=p.policyFor('bot');" +
      "const allowed=['set_title','mcp__arigami__request_action','Read','Grep','mcp__arigami__open_tab','open_tab','mcp__composio-mcp__GMAIL_SEND_EMAIL','mcp__whatsapp__send_message'].map(n=>p.toolAllowed(pol,n));" +
      "const denied=['Bash','Edit','WebFetch','mcp__arigami__create_session','create_session','mcp__composio-mcp__GOOGLEDRIVE_LIST_FILES','mcp__linear__create_issue'].map(n=>p.toolAllowed(pol,n));" +
      "const dis=p.disallowedToolsFor(pol,['arigami','composio-mcp','whatsapp','linear']);" +
      "const none=p.policyFor(null);const free=p.disallowedToolsFor(p.policyOf(a.getAgent('bot')),[]);" +
      "a.updateAgent('bot',{tools:[]});const unrestricted=p.policyFor('bot');" +
      "emit({tools:pol.tools,allowed,denied,dis,none,restrictive:p.isRestrictive(unrestricted),unrestrictedTools:unrestricted.tools,freeLen:free.length});"
  );
  expect(o.tools).toEqual(expect.arrayContaining(['mcp__composio-mcp__GMAIL_*', 'open_tab', 'mcp__whatsapp__*']));
  expect(o.allowed.every(Boolean)).toBe(true);
  expect(o.denied.some(Boolean)).toBe(false);
  // built-ins the agent may not use + whole servers no entry touches (composio-mcp and whatsapp ARE touched)
  expect(o.dis).toEqual(expect.arrayContaining(['Bash', 'Edit', 'Write', 'WebFetch', 'WebSearch', 'mcp__linear']));
  expect(o.dis).not.toContain('mcp__composio-mcp');
  expect(o.dis).not.toContain('mcp__whatsapp');
  expect(o.dis).not.toContain('mcp__arigami');
  expect(o.none).toBeNull();
  expect(o.restrictive).toBe(false);
  expect(o.unrestrictedTools).toBeNull();
  expect(o.freeLen).toBeGreaterThan(0);
});

test('policy: domains — suffix match, *.wildcard, loopback/relative always allowed; checkToolCall logs a policy line', () => {
  const dir = tmp();
  const o = run(
    dir,
    "const a=await import('./server/agents.ts');const p=await import('./server/agent-policy.ts');const l=await import('./server/agent-ledger.ts');" +
      "a.createAgent({name:'Bot',slug:'bot',tools:['git','web','desktop'],domains:['example.com','*.notion.so']});" +
      "const pol=p.policyFor('bot');" +
      "const d=(u)=>p.domainAllowed(pol,u);" +
      "const v1=p.checkToolCall(pol,'WebFetch',{url:'https://evil.com/x'},'sess_1');" +
      "const v2=p.checkToolCall(pol,'mcp__arigami__open_tab',{url:'https://docs.example.com/'},'sess_1');" +
      "const v3=p.checkToolCall(pol,'Bash',{command:'ls'},'sess_1');" +
      "const v4=p.checkToolCall(pol,'mcp__composio-mcp__GMAIL_SEND_EMAIL',{},'sess_1');" +
      "emit({ex:d('https://example.com'),sub:d('http://a.b.example.com/p'),notion:d('https://x.notion.so'),bareNotion:d('https://notion.so'),evil:d('https://notexample.com'),loop:d('http://localhost:5173'),rel:d('/__pr/x/y/1'),v1,v2,v3,v4,ledger:l.readActivity('bot')});"
  );
  expect(o.ex).toBe(true);
  expect(o.sub).toBe(true);
  expect(o.notion).toBe(true);
  expect(o.bareNotion).toBe(false);
  expect(o.evil).toBe(false);
  expect(o.loop).toBe(true);
  expect(o.rel).toBe(true);
  expect(o.v1.allow).toBe(false);
  expect(o.v1.reason).toMatch(/evil\.com/);
  expect(o.v2.allow).toBe(true);
  expect(o.v3.allow).toBe(true);
  expect(o.v4.allow).toBe(false);
  expect(o.v4.reason).toMatch(/allowlist/);
  expect(o.ledger.filter((e: any) => e.kind === 'policy').length).toBe(2);
  expect(fs.existsSync(path.join(dir, 'agents/bot/activity.jsonl'))).toBe(true);
});

test('ledger: a codex turn (cost null) totals as tokens only, a mixed range sums the known cost', () => {
  const o = run(
    tmp(),
    "const a=await import('./server/agents.ts');const l=await import('./server/agent-ledger.ts');" +
      "a.createAgent({name:'Bot',slug:'bot'});" +
      "l.appendActivity('bot',{kind:'turn',sessionId:'cx',tokens:3000,costUsd:null});" +
      "const codexOnly=l.totalsOf(l.readActivity('bot'));" +
      "l.appendActivity('bot',{kind:'turn',sessionId:'cl',tokens:1000,costUsd:0.02});" +
      "emit({codexOnly,mixed:l.totalsOf(l.readActivity('bot')),per:l.perSession(l.readActivity('bot')),empty:l.totalsOf([])});"
  );
  expect(o.codexOnly).toMatchObject({ tokens: 3000, turns: 1, costUsd: null });
  expect(o.mixed.costUsd).toBeCloseTo(0.02, 6);
  expect(o.per.cx).toEqual({ tokens: 3000, costUsd: null, turns: 1 });
  expect(o.per.cl.costUsd).toBeCloseTo(0.02, 6);
  expect(o.empty.costUsd).toBe(0);
});

test('ledger: append/read/totals per range; budget = today\'s turns vs cap, local day, resets at next midnight', () => {
  const o = run(
    tmp(),
    "const a=await import('./server/agents.ts');const l=await import('./server/agent-ledger.ts');" +
      "a.createAgent({name:'Bot',slug:'bot',budget:{tokensPerDay:5000}});" +
      "const now=new Date();const ago=(d)=>new Date(now.getTime()-d*864e5).toISOString();" +
      "l.appendActivity('bot',{kind:'session',sessionId:'s1'});" +
      "l.appendActivity('bot',{kind:'turn',sessionId:'s1',tokens:3000,costUsd:0.02});" +
      "l.appendActivity('bot',{kind:'turn',sessionId:'s1',tokens:1500,costUsd:0.01});" +
      "l.appendActivity('bot',{kind:'turn',sessionId:'s0',tokens:9000,costUsd:0.5,ts:ago(3)});" +
      "l.appendActivity('bot',{kind:'turn',sessionId:'s0',tokens:20000,costUsd:1,ts:ago(20)});" +
      "l.appendActivity('bot',{kind:'action',sessionId:'s1',auto:true,actionKind:'send-email'});" +
      "l.appendActivity('bot',{kind:'artifact',sessionId:'s1',detail:'report'});" +
      "l.appendActivity('nobody',{kind:'turn',tokens:1});" +
      "const today=l.totalsOf(l.readActivity('bot',{since:l.rangeStart('today')}));" +
      "const week=l.totalsOf(l.readActivity('bot',{since:l.rangeStart('7d')}));" +
      "const month=l.totalsOf(l.readActivity('bot',{since:l.rangeStart('30d')}));" +
      "const b1=l.budgetState('bot');" +
      "l.appendActivity('bot',{kind:'turn',sessionId:'s1',tokens:600,costUsd:0.01});" +
      "const b2=l.budgetState('bot');" +
      "const nobody=l.readActivity('nobody').length;" +
      "const mid=l.nextLocalMidnight(new Date('2026-08-30T10:00:00'));" +
      "emit({today,week,month,b1,b2,nobody,day:l.localDay(new Date('2026-08-30T23:30:00')),mid:[mid.getHours(),mid.getMinutes(),mid.getDate()],unknown:l.budgetState('ghost')});"
  );
  expect(o.today).toMatchObject({ tokens: 4500, turns: 2, sessions: 1, actions: 1, artifacts: 1, denied: 0 });
  expect(o.today.costUsd).toBeCloseTo(0.03, 6);
  expect(o.week.tokens).toBe(13500);
  expect(o.month.tokens).toBe(33500);
  expect(o.b1).toMatchObject({ cap: 5000, usedTokens: 4500, exceeded: false });
  expect(o.b2).toMatchObject({ cap: 5000, usedTokens: 5100, exceeded: true });
  expect(new Date(o.b2.resetsAt).getTime()).toBeGreaterThan(Date.now());
  expect(o.nobody).toBe(0); // never a ledger for an unknown agent
  expect(o.day).toBe('2026-08-30');
  expect(o.mid).toEqual([0, 0, 31]);
  expect(o.unknown).toBeNull();
});

test('agents: autoApprove is validated (kind regex), deduped, dropped when empty; persona block mentions enforcement', () => {
  const o = run(
    tmp(),
    "const a=await import('./server/agents.ts');" +
      "const c=a.createAgent({name:'Bot',slug:'bot',tools:['gmail'],domains:['example.com'],budget:{tokensPerDay:100},autoApprove:['send-email','send-email','post:facebook']});" +
      "const bad=a.updateAgent('bot',{autoApprove:['Bad Kind!']});" +
      "const badType=a.updateAgent('bot',{autoApprove:'x'});" +
      "const cleared=a.updateAgent('bot',{autoApprove:[]});" +
      "const block=a.personaBlock('bot');" +
      "emit({c:c.agent,bad,badType,cleared:cleared.agent,block,re:a.ACTION_KIND_RE.source});"
  );
  expect(o.c.autoApprove).toEqual(['send-email', 'post:facebook']);
  expect(o.bad.ok).toBe(false);
  expect(o.bad.error).toMatch(/invalid action kind/);
  expect(o.badType.ok).toBe(false);
  expect('autoApprove' in o.cleared).toBe(false);
  expect(o.block).toMatch(/The host enforces it/); // A5 (#3): reworded — may / denied / the host tells you
  expect(o.block).toMatch(/refuses open_tab \/ WebFetch/);
  expect(o.block).toMatch(/enforced by the host/);
  expect(o.block).toMatch(/request_action a short `kind`/);
});

test('CONN1: capabilityDenied — a connected capability whose tools are outside the allowlist reads as denied, never as "connected"', () => {
  const o = run(
    tmp(),
    "const a=await import('./server/agents.ts');const p=await import('./server/agent-policy.ts');" +
      "a.createAgent({name:'Kesher',slug:'kesher',tools:['whatsapp','triggers','web','desktop']});" +
      "a.createAgent({name:'Social',slug:'social',tools:['whatsapp','gmail']});" +
      "a.createAgent({name:'Free',slug:'free'});" +
      "const k=p.policyFor('kesher'),s=p.policyFor('social'),f=p.policyFor('free');" +
      "const ids=['whatsapp','composio:gmail','composio:googlecalendar','composio:googledrive','identity','claude','mcp:linear'];" +
      "emit({probe:ids.map(p.capabilityToolProbe),kesher:ids.map(id=>p.capabilityDenied(k,id)),social:ids.map(id=>p.capabilityDenied(s,id)),free:ids.map(id=>p.capabilityDenied(f,id)),none:ids.map(id=>p.capabilityDenied(null,id))});"
  );
  expect(o.probe).toEqual(['whatsapp', 'mcp__composio-mcp__GMAIL_LIST', 'mcp__composio-mcp__GOOGLECALENDAR_LIST', 'mcp__composio-mcp__GOOGLEDRIVE_LIST', null, null, null]);
  // kesher: whatsapp allowed; every Google toolkit denied; capabilities without a tool of their own are never "denied"
  expect(o.kesher).toEqual([false, true, true, true, false, false, false]);
  // social-manager: gmail allowed, calendar/drive denied (the live 2026-09-03 measurement)
  expect(o.social).toEqual([false, false, true, true, false, false, false]);
  // no allowlist (or no agent) restricts nothing
  expect(o.free).toEqual([false, false, false, false, false, false, false]);
  expect(o.none).toEqual([false, false, false, false, false, false, false]);
});
