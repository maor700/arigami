// A1 agents: CRUD + validation (server/agents.ts), persona block, and the
// memory namespace isolation in memory.ts (scope agent:<slug>). Both modules
// capture ARIGAMI_DIR at import time, so every case runs in a fresh child
// process with its own dir (see _child.js).
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInChild } from './_child.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-agents-'));
const env = (dir) => ({ ARIGAMI_DIR: dir, ARIGAMI_PORT: '', ARIGAMI_STATE_FILE: path.join(dir, 'state.json'), ARIGAMI_CHAT_DIR: path.join(dir, 'chat') });

test('create/list/get/update/delete an agent; files land under $ARIGAMI_DIR/agents/<slug>/', () => {
  const dir = tmp();
  const r = runInChild(
    "const a=await import('./server/agents.ts');" +
      "const c=a.createAgent({name:'Marketing Lead',emoji:'📣',model:'sonnet',persona:'You write posts.\\nNever publish without approval.',skills:['dispatch'],tools:['whatsapp'],budget:{tokensPerDay:50000}});" +
      "const list=a.listAgentViews().map(x=>x.slug);" +
      "const got=a.getAgent('marketing-lead');" +
      "const up=a.updateAgent('marketing-lead',{emoji:'🎯',skills:[],budget:null,persona:'Short.'});" +
      "const del=a.deleteAgent('marketing-lead');" +
      "emit({c,list,got,up,del,after:a.listAgents().length});",
    env(dir)
  );
  if (!r.ok) throw new Error(r.error);
  const o = r.out[0];
  expect(o.c.ok).toBe(true);
  expect(o.c.agent.slug).toBe('marketing-lead');
  expect(o.c.agent.emoji).toBe('📣');
  expect(o.c.agent.model).toBe('sonnet');
  expect(o.c.agent.skills).toEqual(['dispatch']);
  expect(o.c.agent.tools).toEqual(['whatsapp']);
  expect(o.c.agent.budget).toEqual({ tokensPerDay: 50000 });
  expect(o.c.agent.color).toMatch(/^#[0-9A-Fa-f]{6}$/);
  expect(o.c.agent.persona).toContain('Never publish');
  expect(o.list).toEqual(['marketing-lead']);
  expect(o.got.name).toBe('Marketing Lead');
  expect(fs.existsSync(path.join(dir, 'agents/marketing-lead/agent.json'))).toBe(false); // deleted at the end
  expect(o.up.ok).toBe(true);
  expect(o.up.agent.emoji).toBe('🎯');
  expect(o.up.agent.skills).toEqual([]);
  expect(o.up.agent.budget).toBeUndefined();
  expect(o.up.agent.persona).toBe('Short.');
  expect(o.del.ok).toBe(true);
  expect(o.after).toBe(0);
});

test('validation: bad slug, unknown shared skill, duplicate, unknown agent on update', () => {
  const dir = tmp();
  const r = runInChild(
    "const a=await import('./server/agents.ts');" +
      "const heb=a.createAgent({name:'סוכן שיווק'});" + // slugify → '' → refused, needs explicit slug
      "const hebOk=a.createAgent({name:'סוכן שיווק',slug:'shivuk'});" +
      "const badSkill=a.createAgent({name:'X',slug:'x',skills:['no-such-skill-zzz']});" +
      "const dup=a.createAgent({name:'Again',slug:'shivuk'});" +
      "const upMissing=a.updateAgent('nope',{name:'n'});" +
      "const badColor=a.updateAgent('shivuk',{color:'red'});" +
      "emit({heb,hebOk:hebOk.ok,badSkill,dup,upMissing,badColor});",
    env(dir)
  );
  if (!r.ok) throw new Error(r.error);
  const o = r.out[0];
  expect(o.heb.ok).toBe(false);
  expect(o.heb.error).toMatch(/slug/);
  expect(o.hebOk).toBe(true);
  expect(o.badSkill.ok).toBe(false);
  expect(o.badSkill.error).toMatch(/unknown skill/);
  expect(o.dup.ok).toBe(false);
  expect(o.dup.status).toBe(409);
  expect(o.upMissing.status).toBe(404);
  expect(o.badColor.ok).toBe(false);
  expect(fs.existsSync(path.join(dir, 'agents/shivuk/agent.json'))).toBe(true);
  expect(fs.existsSync(path.join(dir, 'agents/shivuk/memory'))).toBe(true);
});

test('personaBlock: persona + skills + limits + memory note; empty for an unknown agent', () => {
  const dir = tmp();
  const r = runInChild(
    "const a=await import('./server/agents.ts');" +
      "a.createAgent({name:'Ops',slug:'ops',emoji:'🛠️',persona:'You keep the servers up.',skills:['dispatch'],domains:['example.com'],budget:{tokensPerDay:1000}});" +
      "emit({block:a.personaBlock('ops'),none:a.personaBlock('ghost')});",
    env(dir)
  );
  if (!r.ok) throw new Error(r.error);
  const { block, none } = r.out[0];
  expect(block).toMatch(/^<system-reminder>/);
  expect(block).toContain('"Ops" 🛠️ (slug: ops)');
  expect(block).toContain('You keep the servers up.');
  expect(block).toContain('dispatch');
  expect(block).toContain('example.com');
  expect(block).toContain('1000 tokens/day');
  expect(block).toContain('agent:ops');
  expect(none).toBe('');
});

test('memory namespace: agent writes land in agents/<slug>/memory, shared search never sees them, agent search sees USER.md + own', () => {
  const dir = tmp();
  const r = runInChild(
    "const m=await import('./server/memory.ts');" +
      "const w1=m.writeMemory({target:'memory',action:'add',content:'Shared fact: the deploy runs on Fridays',source:'t'});" +
      "const w2=m.writeMemory({target:'memory',action:'add',content:'Agent fact: campaign QUARTZ launches in May',source:'t',agent:'mkt'});" +
      "const w3=m.writeMemory({target:'journal',action:'add',content:'Agent journal: drafted three posts',source:'t',agent:'mkt'});" +
      "const w4=m.writeMemory({target:'user',action:'add',content:'The human prefers Hebrew replies',source:'t',agent:'mkt'});" +
      "const bad=m.writeMemory({target:'memory',action:'add',content:'x',source:'t',agent:'Bad Slug'});" +
      "const shared=m.searchMemory({query:'QUARTZ'});" +
      "const sharedSees=m.searchMemory({query:'Fridays'});" +
      "const agentSees=m.searchMemory({query:'QUARTZ',agent:'mkt'});" +
      "const agentUser=m.searchMemory({query:'Hebrew',agent:'mkt'});" +
      "const agentNotShared=m.searchMemory({query:'Fridays',agent:'mkt'});" +
      "const explicit=m.searchMemory({query:'QUARTZ',scope:'agent:mkt'});" +
      "const boot=m.getMemoryBootstrap('mkt');" +
      "const bootShared=m.getMemoryBootstrap();" +
      "const list=m.listMemory('mkt').map(f=>f.path);" +
      "const get=m.getMemoryFile('agents/mkt/MEMORY.md');" +
      "const esc=m.getMemoryFile('agents/mkt/../../USER.md');" +
      "emit({w1,w2,w3,w4,bad,shared,sharedSees:sharedSees.length,agentSees,agentUser:agentUser.length,agentNotShared:agentNotShared.length,explicit:explicit.length,boot,bootShared,list,get,esc});",
    env(dir)
  );
  if (!r.ok) throw new Error(r.error);
  const o = r.out[0];
  for (const k of ['w1', 'w2', 'w3', 'w4']) expect(o[k].ok).toBe(true);
  expect(o.bad.ok).toBe(false);
  // on disk: the agent's namespace, not the shared store
  expect(fs.readFileSync(path.join(dir, 'agents/mkt/memory/MEMORY.md'), 'utf8')).toContain('QUARTZ');
  expect(fs.readFileSync(path.join(dir, 'memory/MEMORY.md'), 'utf8')).not.toContain('QUARTZ');
  expect(fs.readdirSync(path.join(dir, 'agents/mkt/memory/journal')).length).toBe(1);
  expect(fs.readFileSync(path.join(dir, 'memory/USER.md'), 'utf8')).toContain('Hebrew'); // USER.md is shared
  // search isolation
  expect(o.shared).toEqual([]);
  expect(o.sharedSees).toBe(1);
  expect(o.agentSees.length).toBe(1);
  expect(o.agentSees[0].scope).toBe('agent:mkt');
  expect(o.agentSees[0].path).toBe('agents/mkt/MEMORY.md');
  expect(o.agentUser).toBe(1);
  expect(o.agentNotShared).toBe(0);
  expect(o.explicit).toBe(1);
  // bootstrap: the agent boots with USER.md + its own MEMORY.md, not the shared one
  expect(o.boot.agentMd).toContain('QUARTZ');
  expect(o.boot.memoryMd).toBe('');
  expect(o.boot.userMd).toContain('Hebrew');
  expect(o.bootShared.memoryMd).toContain('Fridays');
  expect(o.bootShared.agentMd).toBeUndefined();
  expect(o.list[0]).toBe('agents/mkt/MEMORY.md');
  expect(o.list.some((p) => p.startsWith('agents/mkt/journal/'))).toBe(true);
  expect(o.get.content).toContain('QUARTZ');
  expect(o.esc.error).toBe('invalid path');
});

// ---- ENGINE: an agent runs on an engine; every spawn path resolves it the same way ----

test('engine: validated (claude | codex | null), stored only when set, removable on update', () => {
  const dir = tmp();
  const r = runInChild(
    "const a=await import('./server/agents.ts');" +
      "const bad=a.createAgent({name:'Bad',slug:'bad',engine:'gemini'});" +
      "const c=a.createAgent({name:'Astra',slug:'astra',engine:'codex',model:'gpt-6-astra'});" +
      "const plain=a.createAgent({name:'Plain',slug:'plain'});" +
      "const explicitClaude=a.createAgent({name:'C',slug:'c',engine:'claude'});" +
      "const onDisk=JSON.parse(require('node:fs').readFileSync(a.agentDir('astra')+'/agent.json','utf8'));" +
      "const badUp=a.updateAgent('astra',{engine:'nope'});" +
      "const up=a.updateAgent('astra',{engine:null});" +
      "const up2=a.updateAgent('plain',{engine:'codex'});" +
      "emit({bad,c,plain,explicitClaude,onDisk,badUp,up,up2,persona:a.personaBlock('c')});",
    env(dir)
  );
  if (!r.ok) throw new Error(r.error);
  const o = r.out[0];
  expect(o.bad.ok).toBe(false);
  expect(o.bad.error).toContain('invalid engine');
  expect(o.c.ok).toBe(true);
  expect(o.c.agent.engine).toBe('codex');
  expect(o.c.agent.model).toBe('gpt-6-astra');
  expect(o.onDisk.engine).toBe('codex');
  expect('engine' in o.plain.agent).toBe(false);
  expect(o.explicitClaude.agent.engine).toBe('claude');
  expect(o.badUp.ok).toBe(false);
  expect(o.up.ok).toBe(true);
  expect('engine' in o.up.agent).toBe(false);
  expect(o.up2.agent.engine).toBe('codex');
});

test('engineForSpawn: explicit caller value wins, else the agent, else the host default; "" never overrides', () => {
  const dir = tmp();
  const r = runInChild(
    "const a=await import('./server/agents.ts');" +
      "const codex={engine:'codex'}, claude={engine:'claude'}, none={};" +
      'emit({' +
      "  agentWins:a.engineForSpawn(undefined,codex)," +
      "  emptyStringIsNotGiven:a.engineForSpawn('',codex)," +
      "  nullIsNotGiven:a.engineForSpawn(null,codex)," +
      "  explicitWins:a.engineForSpawn('claude',codex)," +
      "  explicitCodex:a.engineForSpawn('codex',none)," +
      "  bothAbsent:a.engineForSpawn(undefined,none)," +
      "  noAgent:a.engineForSpawn(undefined,null)," +
      "  agentClaude:a.engineForSpawn(undefined,claude)," +
      "  junkExplicit:a.engineForSpawn('gemini',codex)," +
      '});',
    env(dir)
  );
  if (!r.ok) throw new Error(r.error);
  const o = r.out[0];
  expect(o.agentWins).toBe('codex');
  expect(o.emptyStringIsNotGiven).toBe('codex');
  expect(o.nullIsNotGiven).toBe('codex');
  expect(o.explicitWins).toBe('claude');
  expect(o.explicitCodex).toBe('codex');
  expect(o.bothAbsent).toBeUndefined();
  expect(o.noAgent).toBeUndefined();
  expect(o.agentClaude).toBe('claude');
  expect(o.junkExplicit).toBe('codex');
});

test('personaBlock names the engine for a codex agent and stays silent for the default', () => {
  const dir = tmp();
  const r = runInChild(
    "const a=await import('./server/agents.ts');" +
      "a.createAgent({name:'Astra',slug:'astra',engine:'codex',model:'gpt-6-astra'});" +
      "a.createAgent({name:'Plain',slug:'plain'});" +
      "emit({astra:a.personaBlock('astra'),plain:a.personaBlock('plain')});",
    env(dir)
  );
  if (!r.ok) throw new Error(r.error);
  expect(r.out[0].astra).toContain('Your engine is Codex');
  expect(r.out[0].astra).toContain('gpt-6-astra');
  expect(r.out[0].plain).not.toContain('Your engine');
});

test('ENGINE/A3: codex built-ins (snake_case) are judged as their claude equivalents, not as unknown host tools', () => {
  const dir = tmp();
  const r = runInChild(
    "const a=await import('./server/agents.ts');" +
      "const pol=await import('./server/agent-policy.ts');" +
      "a.createAgent({name:'Astra',slug:'astra',engine:'codex',tools:['desktop','web','publish']});" +
      "const p=pol.policyFor('astra');" +
      "a.createAgent({name:'Dev',slug:'dev',engine:'codex',tools:['git']});" +
      "const g=pol.policyFor('dev');" +
      'emit({' +
      "  viewImage:pol.toolAllowed(p,'view_image'), updatePlan:pol.toolAllowed(p,'update_plan')," +
      "  applyPatch:pol.toolAllowed(p,'apply_patch'), webSearch:pol.toolAllowed(p,'web_search')," +
      "  shell:pol.toolAllowed(p,'shell'), bash:pol.toolAllowed(p,'Bash'), whatsapp:pol.toolAllowed(p,'mcp__arigami__whatsapp')," +
      "  gitApplyPatch:pol.toolAllowed(g,'apply_patch'), gitShell:pol.toolAllowed(g,'shell'), gitWebSearch:pol.toolAllowed(g,'web_search')," +
      '});',
    env(dir)
  );
  if (!r.ok) throw new Error(r.error);
  const o = r.out[0];
  expect(o.viewImage).toBe(true);
  expect(o.updatePlan).toBe(true);
  expect(o.applyPatch).toBe(false); // Edit — no `git`
  expect(o.webSearch).toBe(true); // WebSearch — `web` family
  expect(o.shell).toBe(false); // Bash — not granted
  expect(o.bash).toBe(false);
  expect(o.whatsapp).toBe(false);
  expect(o.gitApplyPatch).toBe(true);
  expect(o.gitShell).toBe(true);
  expect(o.gitWebSearch).toBe(false);
});
