// A5 unit — the fixes the live E2E run asked for (TEST-REPORT-AGENTS-E2E.md):
//   #1 Claude Code's own CronCreate/CronDelete/CronList are inside the `triggers`
//      family, so an agent without it cannot fake a session-only "routine";
//   #2 publish_artifact / share_artifact are a revocable `publish` family (they
//      used to be CORE), with a one-time migration for records written before;
//   #3 the injected policy line names the core tools + says denials are reported;
//   #5 the daily cap blocks TURNS once the final warning went out;
//   #7 a closed allowlist means --strict-mcp-config (no external MCP schemas).
// The modules capture ARIGAMI_DIR at import time → each case runs in a fresh child.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInChild } from './_child.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-a5-'));
const env = (dir: string) => ({ ARIGAMI_DIR: dir, ARIGAMI_PORT: '', ARIGAMI_STATE_FILE: path.join(dir, 'state.json'), ARIGAMI_CHAT_DIR: path.join(dir, 'chat') });
const run = (dir: string, body: string) => {
  const r = runInChild(body, env(dir));
  if (!r.ok) throw new Error(r.error);
  return r.out[0];
};

test('#1 scheduling: CronCreate & co. need the `triggers` family; a denial says the human adds the routine in the tab', () => {
  const o = run(
    tmp(),
    "const a=await import('./server/agents.ts');const p=await import('./server/agent-policy.ts');" +
      "a.createAgent({name:'Scout',slug:'scout',tools:['web','desktop']});" +
      "a.createAgent({name:'Timer',slug:'timer',tools:['triggers']});" +
      "const scout=p.policyFor('scout');const timer=p.policyFor('timer');" +
      "const scoutCron=['CronCreate','CronDelete','CronList','cronjob','register_listener'].map(n=>p.toolAllowed(scout,n));" +
      "const timerCron=['CronCreate','CronDelete','CronList','cronjob','register_listener'].map(n=>p.toolAllowed(timer,n));" +
      "const v=p.checkToolCall(scout,'CronCreate',{schedule:'0 7 * * *'});" +
      "const vHost=p.checkToolCall(scout,'mcp__arigami__cronjob',{});" +
      "emit({scoutCron,timerCron,v,vHost,dis:p.disallowedToolsFor(scout,[]),timerDis:p.disallowedToolsFor(timer,[]),restricted:p.RESTRICTED_BUILTINS});"
  );
  expect(o.scoutCron.some(Boolean)).toBe(false); // no `triggers` → none of them
  expect(o.timerCron.every(Boolean)).toBe(true);
  expect(o.v.allow).toBe(false);
  expect(o.v.reason).toMatch(/session-only schedule \(CronCreate\) is NOT a routine/);
  expect(o.v.reason).toMatch(/Routine tab/);
  expect(o.v.reason).toMatch(/never report a routine as created/);
  expect(o.vHost.reason).toMatch(/Routine tab/); // the host tool says the same
  // layer 1: the CLI never offers them to an agent without `triggers`
  expect(o.dis).toEqual(expect.arrayContaining(['CronCreate', 'CronDelete', 'CronList']));
  expect(o.timerDis).not.toContain('CronCreate');
  expect(o.restricted).toEqual(expect.arrayContaining(['Agent', 'Task', 'CronCreate', 'CronDelete', 'CronList']));
});

test('#2 publish: a restricted agent cannot publish or share; the family grants it; old records are migrated once', () => {
  const dir = tmp();
  const o = run(
    dir,
    "const a=await import('./server/agents.ts');const p=await import('./server/agent-policy.ts');const fs=await import('node:fs');const path=await import('node:path');" +
      "a.createAgent({name:'Scout',slug:'scout',tools:['web','desktop']});" +
      "a.createAgent({name:'Nili',slug:'nili',tools:['git','publish']});" +
      "const scout=p.policyFor('scout');const nili=p.policyFor('nili');" +
      "const tools=['publish_artifact','share_artifact','unshare_artifact'];" +
      "const scoutCan=tools.map(n=>p.toolAllowed(scout,n));const niliCan=tools.map(n=>p.toolAllowed(nili,n));" +
      "const longName=p.toolAllowed(scout,'mcp__arigami__publish_artifact');" +
      // a record written before A5 (no toolsV) keeps the publishing it had
      "const legacy=path.join(process.env.ARIGAMI_DIR,'agents','old');fs.mkdirSync(legacy,{recursive:true});" +
      "fs.writeFileSync(path.join(legacy,'agent.json'),JSON.stringify({slug:'old',name:'Old',emoji:'🤖',color:'#111111',skills:[],tools:['web'],homeSessionId:null,createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:00.000Z'}));" +
      "const migrated=a.getAgent('old').tools;const onDisk=JSON.parse(fs.readFileSync(path.join(legacy,'agent.json'),'utf8'));" +
      "const oldCan=p.toolAllowed(p.policyFor('old'),'publish_artifact');" +
      // …and unticking it afterwards sticks (the migration does not run twice)
      "a.updateAgent('old',{tools:['web']});const revoked=p.toolAllowed(p.policyFor('old'),'publish_artifact');" +
      "emit({scoutCan,niliCan,longName,migrated,onDisk,oldCan,revoked,core:p.CORE_TOOLS,families:p.FAMILY_IDS});"
  );
  expect(o.scoutCan.some(Boolean)).toBe(false);
  expect(o.niliCan.every(Boolean)).toBe(true);
  expect(o.longName).toBe(false); // the mcp__arigami__ prefix is not a way around it
  expect(o.core).not.toContain('publish_artifact');
  expect(o.core).not.toContain('share_artifact');
  expect(o.families).toContain('publish');
  expect(o.migrated).toEqual(['web', 'publish']);
  expect(o.onDisk.tools).toEqual(['web', 'publish']); // migrated once, on disk
  expect(o.onDisk.toolsV).toBe(2);
  expect(o.oldCan).toBe(true);
  expect(o.revoked).toBe(false);
});

test('#3 the injected policy line: allowlist + core, what is denied, and that a denial is reported', () => {
  const o = run(
    tmp(),
    "const a=await import('./server/agents.ts');" +
      "a.createAgent({name:'Scout',slug:'scout',tools:['web'],persona:'read-only researcher'});" +
      "a.createAgent({name:'Pub',slug:'pub',tools:['web','publish'],autoApprove:['share']});" +
      "emit({scout:a.personaBlock('scout'),pub:a.personaBlock('pub')});"
  );
  expect(o.scout).toMatch(/You MAY use: your allowlist — web/);
  expect(o.scout).toMatch(/request_action/); // the core list is named, not implied
  expect(o.scout).toMatch(/memory_write/);
  expect(o.scout).toMatch(/DENIED: everything else, including the built-ins Bash/);
  expect(o.scout).toMatch(/If a call is denied the host TELLS you so/);
  expect(o.scout).toMatch(/never refuse a task on a guess about your own permissions/);
  // publishing is stated in both directions — that is what bug #2/#3 cost us
  expect(o.scout).toMatch(/publish_artifact is NOT available to you/);
  expect(o.scout).toMatch(/never minted on your word alone/);
  expect(o.pub).toMatch(/publish_artifact is available to you/);
  expect(o.pub).toMatch(/pre-approved the "share" kind/);
});

test('#5 budget: turns are blocked only after the one final warning, and the refusal names sessions AND turns', () => {
  const dir = tmp();
  const o = run(
    dir,
    "const a=await import('./server/agents.ts');const l=await import('./server/agent-ledger.ts');" +
      "a.createAgent({name:'Nili',slug:'nili',budget:{tokensPerDay:1000}});" +
      "l.appendActivity('nili',{kind:'turn',tokens:400});" +
      "const under=l.turnBlocked('nili');" +
      "l.appendActivity('nili',{kind:'turn',tokens:900});" +
      "const overNoWarning=l.turnBlocked('nili');" + // exceeded, but the final warning has not gone out
      "l.appendActivity('nili',{kind:'budget',detail:'warned'});" +
      "const blocked=l.turnBlocked('nili');" +
      "const yesterday=new Date(Date.now()-36e5*30);" +
      "emit({under,overNoWarning,blocked,warned:l.warnedToday('nili'),line:l.budgetRefusal(l.budgetState('nili'),'Nili'),none:l.turnBlocked(null),tomorrow:l.turnBlocked('nili',new Date(Date.now()+36e5*30))});"
  );
  expect(o.under).toBeNull();
  expect(o.overNoWarning).toBeNull(); // the model still gets its one wrap-up turn
  expect(o.blocked).toMatchObject({ slug: 'nili', cap: 1000, exceeded: true });
  expect(o.warned).toBe(true);
  expect(o.line).toMatch(/no new sessions or turns until local midnight/);
  expect(o.line).not.toMatch(/[֐-׿]/); // #11: no Hebrew inside the English line
  expect(o.line).toMatch(/Settings → Host → Budgets/);
  expect(o.none).toBeNull();
  expect(o.tomorrow).toBeNull(); // a new local day resets both the usage and the warning
});

test('#7 strict mcp: an allowlist that touches no external server gets --strict-mcp-config', () => {
  const o = run(
    tmp(),
    "const a=await import('./server/agents.ts');const p=await import('./server/agent-policy.ts');" +
      "a.createAgent({name:'Nili',slug:'nili',tools:['git','publish']});" +
      "a.createAgent({name:'Scout',slug:'scout',tools:['web','desktop']});" +
      "a.createAgent({name:'Mailer',slug:'mailer',tools:['gmail']});" +
      "a.createAgent({name:'Wa',slug:'wa',tools:['whatsapp']});" +
      "a.createAgent({name:'Free',slug:'free'});" +
      "emit({nili:p.strictMcpFor(p.policyFor('nili')),scout:p.strictMcpFor(p.policyFor('scout'))," +
      "mailer:p.strictMcpFor(p.policyFor('mailer')),wa:p.strictMcpFor(p.policyFor('wa')),free:p.strictMcpFor(p.policyFor('free'))});"
  );
  expect(o.nili).toBe(true); // Edit/Write only — composio must never be loaded
  expect(o.scout).toBe(true);
  expect(o.mailer).toBe(false); // needs composio-mcp, so the hook keeps doing the filtering
  expect(o.wa).toBe(false);
  expect(o.free).toBe(false); // unrestricted agents are untouched
});
