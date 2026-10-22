// PROMPT1: the instruction blocks (server/prompt-blocks.ts) — defaults, the owner's overrides and own blocks in the
// user repo, rendering per engine/turn, and what claude.js composes from them. Imports ARIGAMI_DIR → in a child.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { runInChild } from './_child.js';
import { tmpDir } from './_tmp.js';

function inChild(body, dir = tmpDir('arigami-prompts-')) {
  const r = runInChild("const pb=await import('./server/prompt-blocks.ts');" + body, { ARIGAMI_DIR: dir, ARIGAMI_PORT: '' });
  if (!r.ok) throw new Error(r.error);
  return { out: r.out[0], dir };
}

test('defaults: every built-in renders on its turn, container and simple-mode only when they apply', () => {
  const { out } = inChild(
    "emit({ids:pb.listBlocks().map(b=>b.id),first:pb.render('first-turn',{sharedDisplay:':99',capabilities:'CAPS',extensions:''})," +
      "firstDocker:pb.render('first-turn',{docker:true}),every:pb.render('every-turn',{}),simple:pb.render('every-turn',{simpleMode:true})});"
  );
  expect(out.ids).toEqual(['links', 'login', 'host-rules', 'container', 'identity', 'simple-mode']);
  const order = ['Arigami links', 'Signing in to a service', 'Temporary files go under $TMPDIR', 'You are the agent inside Arigami'].map((s) => out.first.indexOf(s));
  expect(order.every((i, k) => i >= 0 && (k === 0 || i > order[k - 1]))).toBe(true);
  expect(out.first).toContain('shared desktop :99');
  expect(out.first).toContain('CAPS');
  expect(out.first).not.toContain('{{');
  expect(out.first).not.toContain('passwordless sudo');
  expect(out.firstDocker).toContain('passwordless sudo');
  expect(out.every).toBe('');
  expect(out.simple).toContain('Simple chat mode is ON');
  expect((out.first.match(/<system-reminder>/g) || []).length).toBe(4); // links, login, host-rules, identity
});

test("the owner's override replaces the text, enabled:false turns a block off, equal-to-default stores nothing", () => {
  const { out, dir } = inChild(
    "pb.saveBlock('links',{text:'Links: mine.'});const edited=pb.listBlocks().find(b=>b.id==='links');" +
      "pb.saveBlock('login',{enabled:false});const off=pb.render('first-turn',{});" +
      "pb.saveBlock('login',{enabled:true});pb.saveBlock('links',{text:pb.BUILTIN[0].text});" +
      "emit({edited,off,files:require('node:fs').readdirSync(pb.PROMPTS_DIR())});"
  );
  expect(out.edited).toMatchObject({ text: 'Links: mine.', edited: true, enabled: true });
  expect(out.off).toContain('Links: mine.');
  expect(out.off).not.toContain('Signing in to a service');
  expect(out.files).toEqual([]); // both back to their defaults: nothing of the owner's left
  expect(fs.existsSync(path.join(dir, 'user', 'prompts'))).toBe(true);
});

test("a block of the owner's own: first or every turn, per engine, after the built-ins and before identity; deletable", () => {
  const { out } = inChild(
    "pb.saveBlock('house-style',{text:'Write in Hebrew.',title:'House style'});" +
      "pb.saveBlock('codex-only',{text:'Codex note.',engines:['codex']});" +
      "pb.saveBlock('every',{text:'Each turn note.',when:'every-turn'});" +
      "const claude=pb.render('first-turn',{engine:'claude'});const codex=pb.render('first-turn',{engine:'codex'});" +
      "const every=pb.render('every-turn',{engine:'claude'});pb.resetBlock('house-style');" +
      "emit({claude,codex,every,ids:pb.listBlocks().map(b=>b.id),bad:(()=>{try{pb.saveBlock('Bad Id',{text:'x'})}catch(e){return e.message}})(),empty:(()=>{try{pb.saveBlock('blank',{text:'  '})}catch(e){return e.message}})()});"
  );
  expect(out.claude).toContain('Write in Hebrew.');
  expect(out.claude).not.toContain('Codex note.');
  expect(out.codex).toContain('Codex note.');
  expect(out.claude.indexOf('Write in Hebrew.')).toBeGreaterThan(out.claude.indexOf('Temporary files'));
  expect(out.claude.indexOf('Write in Hebrew.')).toBeLessThan(out.claude.indexOf('You are the agent inside Arigami'));
  expect(out.every).toContain('Each turn note.');
  expect(out.ids).not.toContain('house-style');
  expect(out.ids).toContain('codex-only');
  expect(out.bad).toMatch(/lowercase/);
  expect(out.empty).toMatch(/needs some text/);
});

test('front-matter parsing and {{vars}} filling', () => {
  const { out } = inChild(
    "emit({p:pb.parseFile('---\\ntitle: \"X\"\\nenabled: false\\n---\\nbody\\n'),none:pb.parseFile('just text'),f:pb.fill('a {{capabilities}}\\n\\n\\n\\nb {{nope}}',{capabilities:''})});"
  );
  expect(out.p).toEqual({ meta: { title: 'X', enabled: 'false' }, body: 'body\n' });
  expect(out.none).toEqual({ meta: {}, body: 'just text' });
  expect(out.f).toBe('a \n\nb');
});

test('claude.js composes the first turn from the registry: an override reaches a new session, identity keeps its hint', () => {
  const { out } = inChild(
    "pb.saveBlock('links',{text:'Links: the owner rewrote this.'});const c=await import('./server/claude.js');" +
      "const pv=c.firstTurnPreview({engine:'codex'});emit({first:pv.firstTurn,every:pv.everyTurn,id:c.identityReminder('HINT-LINE'),simple:c.chatModePrefix({chatMode:'simple'}),full:c.chatModePrefix({chatMode:'full'}),def:c.SIMPLE_MODE_REMINDER});"
  );
  expect(out.first).toContain('Links: the owner rewrote this.');
  expect(out.first).toContain('Signing in to a service');
  expect(out.id).toContain('HINT-LINE');
  expect(out.simple).toBe(out.def);
  expect(out.full).toBe('');
  expect(out.every).toBe(out.def);
});

// ---- phase 2: what an agent and a session inherit ----------------------------------------------------------------------

test('cleanLayer keeps off / on / own text, drops junk, and returns null when nothing is left', () => {
  const { out } = inChild(
    "emit({l:pb.cleanLayer({links:'off',identity:'on',login:{text:'mine',engines:['codex','x']},'Bad Id':'off',junk:42,blank:{text:'  '},flow:{text:'f',when:'every-turn'}}),n:pb.cleanLayer({x:7}),a:pb.cleanLayer([1])});"
  );
  expect(out.l).toEqual({ links: 'off', identity: 'on', login: { text: 'mine', engines: ['codex'] }, flow: { text: 'f', when: 'every-turn' } });
  expect(out.n).toBeNull();
  expect(out.a).toBeNull();
});

test('layers resolve session over agent over the owner, each block marked with the layer that decided it', () => {
  const { out } = inChild(
    "pb.saveBlock('links',{enabled:false});" +
      "const b=pb.applyLayers(pb.listBlocks(),{agent:{links:'on',login:{text:'AGENT login'},extra:{text:'AGENT own'}},session:{login:'off',identity:{text:'SESSION identity'}}});" +
      "const by=Object.fromEntries(b.map(x=>[x.id,{enabled:x.enabled,source:x.source,text:x.text.slice(0,20)}]));" +
      "emit({by,first:pb.render('first-turn',{},b)});"
  );
  expect(out.by.links).toEqual({ enabled: true, source: 'agent', text: out.by.links.text }); // the owner turned it off, the agent back on
  expect(out.by.login).toMatchObject({ enabled: false, source: 'session' }); // the session wins over the agent
  expect(out.by.identity).toMatchObject({ enabled: true, source: 'session', text: 'SESSION identity' });
  expect(out.by['host-rules'].source).toBe('default');
  expect(out.by.extra).toMatchObject({ enabled: true, source: 'agent', text: 'AGENT own' });
  expect(out.first).toContain('Arigami links');
  expect(out.first).not.toContain('AGENT login');
  expect(out.first).toContain('SESSION identity');
  expect(out.first.indexOf('AGENT own')).toBeLessThan(out.first.indexOf('SESSION identity')); // own blocks before identity
});

test("a new session gets its agent's and its own layer; the preview says which layer decided each block", () => {
  const { out } = inChild(
    "const ag=await import('./server/agents.ts');const st=await import('./server/state.ts');const c=await import('./server/claude.js');" +
      "ag.createAgent({name:'Writer',slug:'writer'});const u=ag.updateAgent('writer',{prompts:{links:{text:'WRITER links'},'Bad':'off'}});" +
      "const s=st.createSession({title:'t',metadata:{agent:'writer'}});st.patchSession(s.id,{metadata:{prompts:{'host-rules':'off'}}});" +
      "const pv=c.firstTurnPreview({session:s.id});const pa=c.firstTurnPreview({agent:'writer'});" +
      "emit({stored:u.agent.prompts,first:pv.firstTurn,blocks:pv.blocks,agentOnly:pa.firstTurn});"
  );
  expect(out.stored).toEqual({ links: { text: 'WRITER links' } });
  expect(out.first).toContain('WRITER links');
  expect(out.first).not.toContain('Temporary files go under $TMPDIR'); // the session turned host-rules off
  expect(out.blocks.find((b) => b.id === 'host-rules')).toMatchObject({ enabled: false, source: 'session' });
  expect(out.blocks.find((b) => b.id === 'links')).toMatchObject({ source: 'agent' });
  expect(out.agentOnly).toContain('WRITER links');
  expect(out.agentOnly).toContain('Temporary files go under $TMPDIR'); // the agent alone did not turn it off
});

test('only a person sets a layer: the session PATCH and the agent PATCH drop `prompts` coming from a session token (source-level)', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dir, '../server/api.ts'), 'utf8');
  const sess = src.slice(src.indexOf("'prompts' in body.metadata"), src.indexOf("'prompts' in body.metadata") + 600);
  expect(sess).toContain("me?.kind === 'session'");
  expect(sess).toContain('cleanLayer');
  expect(src).toMatch(/auth\?\.kind === 'session'\) delete \(patch as Record<string, unknown>\)\.prompts/);
});
