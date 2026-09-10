// EXT wave 1 — the extension system, unit-tested against a temp ARIGAMI_DIR.
//
// Pure: no host process, no `claude`, no network. The server modules capture
// ARIGAMI_DIR at import time and `bun test` shares one module registry across
// files, so every case runs in its own bun child (test/_child.js), exactly like
// the agents-a3/a5 suites do.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInChild } from './_child.js';

const REPO = path.resolve(import.meta.dir, '..');
const HELLO = path.join(REPO, 'examples', 'extensions', 'hello');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-ext-'));
const env = (dir: string) => ({
  ARIGAMI_DIR: dir,
  ARIGAMI_PORT: '',
  ARIGAMI_STATE_FILE: path.join(dir, 'state.json'),
  ARIGAMI_CHAT_DIR: path.join(dir, 'chat'),
});
const run = (dir: string, body: string) => {
  const r = runInChild(body, env(dir));
  if (!r.ok) throw new Error(r.error);
  return r.out[0] as any;
};

const load = "const ext=await import('./server/extensions.ts');";

// ---------------------------------------------------------------------------
// §1 the user repo + the skills migration
// ---------------------------------------------------------------------------
test('first boot creates the user repo, links skills into it, and links the SDK — idempotently', () => {
  const dir = tmp();
  const o = run(
    dir,
    load +
      "const fs=await import('node:fs');const path=await import('node:path');" +
      'const first=ext.ensureUserRepo();const second=ext.ensureUserRepo();' +
      "const link=path.join(process.env.ARIGAMI_DIR,'skills');" +
      'emit({first:first.steps,second:second.steps,' +
      " isLink: fs.lstatSync(link).isSymbolicLink(), target: fs.readlinkSync(link)," +
      " gitDir: fs.existsSync(path.join(process.env.ARIGAMI_DIR,'user','.git'))," +
      " gitignore: fs.readFileSync(path.join(process.env.ARIGAMI_DIR,'user','.gitignore'),'utf8')," +
      " sdk: fs.realpathSync(path.join(process.env.ARIGAMI_DIR,'user','node_modules','@arigami','sdk'))});"
  );
  expect(o.gitDir).toBe(true);
  expect(o.isLink).toBe(true);
  expect(o.target).toBe(path.join(dir, 'user', 'skills'));
  expect(o.gitignore).toContain('node_modules/');
  expect(o.sdk).toBe(path.join(REPO, 'sdk'));
  expect(o.first.join(' ')).toContain('user/skills');
  // second run says nothing — the steady state is silent, and nothing is redone
  expect(o.second).toEqual([]);
});

test('an existing $ARIGAMI_DIR/skills is MOVED into the user repo, never copied away or deleted', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'skills', 'my-skill'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'skills', 'my-skill', 'SKILL.md'), '---\ndescription: mine\n---\nbody\n');
  const o = run(
    dir,
    load + "const fs=await import('node:fs');const path=await import('node:path');ext.ensureUserRepo();" +
      "const p=path.join(process.env.ARIGAMI_DIR,'user','skills','my-skill','SKILL.md');" +
      "emit({moved:fs.readFileSync(p,'utf8'), viaLink: fs.readFileSync(path.join(process.env.ARIGAMI_DIR,'skills','my-skill','SKILL.md'),'utf8')});"
  );
  expect(o.moved).toContain('description: mine');
  // the OLD path still resolves — that is the point of the symlink (F2 keeps working)
  expect(o.viaLink).toContain('description: mine');
});

test('when both skill dirs exist the migration merges what is missing and parks the old dir — nothing is deleted', () => {
  const dir = tmp();
  for (const [root, name] of [
    ['skills', 'legacy-only'],
    ['skills', 'in-both'],
    [path.join('user', 'skills'), 'in-both'],
    [path.join('user', 'skills'), 'user-only'],
  ] as [string, string][]) {
    fs.mkdirSync(path.join(dir, root, name), { recursive: true });
    fs.writeFileSync(path.join(dir, root, name, 'SKILL.md'), `---\ndescription: ${root}/${name}\n---\n`);
  }
  const o = run(
    dir,
    load + "const fs=await import('node:fs');const path=await import('node:path');const steps=ext.ensureUserRepo().steps;" +
      "const us=path.join(process.env.ARIGAMI_DIR,'user','skills');" +
      "const parked=fs.readdirSync(process.env.ARIGAMI_DIR).filter(d=>d.startsWith('skills.replaced-'));" +
      "emit({steps,skills:fs.readdirSync(us).sort()," +
      " inBoth:fs.readFileSync(path.join(us,'in-both','SKILL.md'),'utf8'),parked," +
      " parkedKept: fs.existsSync(path.join(process.env.ARIGAMI_DIR,parked[0],'in-both','SKILL.md'))});"
  );
  expect(o.skills).toEqual(['in-both', 'legacy-only', 'user-only']);
  // the user's copy wins; the legacy one is not overwritten in place
  expect(o.inBoth).toContain('user/skills/in-both');
  expect(o.parked.length).toBe(1);
  expect(o.parkedKept).toBe(true);
  expect(o.steps.join(' ')).toContain('legacy-only');
});

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------
test('validate: the hello example is valid; a bad manifest names every problem and never throws', async () => {
  const dir = tmp();
  const bad = path.join(dir, 'bad');
  fs.mkdirSync(path.join(bad, 'docs'), { recursive: true });
  fs.writeFileSync(
    path.join(bad, 'manifest.json'),
    JSON.stringify({
      name: 'Bad Name',
      apiVersion: 99,
      docs: [{ file: 'docs/missing.md', skill: 'x', description: '' }],
      tools: [{ kind: 'module', name: 't', module: '../../../etc/passwd' }],
      listeners: [{ type: 'nope', module: 'listener.ts', export: 'nope' }],
      permissions: ['session:message', 'wat'],
    })
  );
  const o = run(
    dir,
    load +
      `const good=await ext.validateExtension(${JSON.stringify(HELLO)});` +
      `const bad=await ext.validateExtension(${JSON.stringify(bad)});` +
      "const none=await ext.validateExtension('/definitely/not/here');" +
      'emit({good:{ok:good.ok,errors:good.errors,warnings:good.warnings},bad:{ok:bad.ok,errors:bad.errors,warnings:bad.warnings},none});'
  );
  expect(o.good.ok).toBe(true);
  expect(o.good.errors).toEqual([]);
  expect(o.bad.ok).toBe(false);
  const errs = o.bad.errors.join(' | ');
  expect(errs).toContain('name must match');
  expect(errs).toContain('version is required');
  expect(errs).toContain('apiVersion 99 is not supported');
  expect(errs).toContain('outside the extension directory'); // traversal in tools[].module
  expect(errs).toContain('file not found');
  expect(errs).toContain('description is required');
  expect(o.bad.warnings.join(' ')).toContain('unknown permission "wat"');
  // a missing directory is an error, not a crash
  expect(o.none.ok).toBe(false);
});

// ---------------------------------------------------------------------------
// load: what each contribution turns into
// ---------------------------------------------------------------------------
const withHello = (extra: string) =>
  load + `await ext.addExtension(${JSON.stringify(HELLO)});await ext.reload();` + extra;

test('loading hello contributes a tool server, a skill, a listener type, a gate and a summary line', () => {
  const dir = tmp();
  const o = run(
    dir,
    withHello(
      "const fs=await import('node:fs');const path=await import('node:path');" +
        "const reg=await import('./server/listeners-registry.ts');" +
        "const e=ext.listExtensions()[0];" +
        "const skill=fs.readFileSync(path.join(process.env.ARIGAMI_DIR,'ext-plugin','skills','hello','SKILL.md'),'utf8');" +
        "const plugin=JSON.parse(fs.readFileSync(path.join(process.env.ARIGAMI_DIR,'ext-plugin','.claude-plugin','plugin.json'),'utf8'));" +
        'emit({e,summary:ext.summaryLine(),servers:ext.extServersFor(),families:ext.extFamilies(),' +
        " types:reg.listTypes().map(t=>t.type),extType:reg.listTypes().find(t=>t.type==='hello-tick')," +
        ' skill,plugin,hasSkills:ext.extPluginHasSkills(),gates:ext.hasGates(\'merge.before\')});'
    )
  );
  expect(o.e.name).toBe('hello');
  expect(o.e.state).toBe('loaded');
  expect(o.e.enabled).toBe(true);
  expect(o.e.contributions).toEqual({ tools: 1, listeners: 1, docs: 1, tabs: 1, hooks: 2, gates: 1, channels: 0, webhooks: 1 });

  // --mcp-config entry: one tool declaration → the server is named `ext-<name>`
  expect(Object.keys(o.servers)).toEqual(['ext-hello']);
  expect(o.servers['ext-hello'].command).toBe('bun');
  expect(o.servers['ext-hello'].args[0]).toBe(path.join(REPO, 'mcp', 'ext-mcp.js'));
  expect(o.servers['ext-hello'].args[1]).toBe(path.join(dir, 'user', 'extensions', 'hello', 'tools', 'module.ts'));
  expect(o.servers['ext-hello'].cwd).toBe(path.join(dir, 'user', 'extensions', 'hello'));
  expect(o.servers['ext-hello'].env.EXT_NAME).toBe('hello');
  expect(JSON.parse(o.servers['ext-hello'].env.EXT_SETTINGS).greeting).toBe('hello'); // manifest default

  // A3 family
  expect(o.families).toEqual({ 'ext:hello': ['mcp__ext-hello__*', 'mcp__ext-hello-*'] });

  // docs → a real skill Claude can list, with the description as the trigger
  expect(o.plugin.name).toBe('arigami-ext');
  expect(o.skill).toStartWith('---\nname: hello\ndescription: Use when the human asks to test');
  expect(o.skill).toContain('mcp__ext-hello__*');
  expect(o.skill).toContain('# hello — the example extension');
  expect(o.hasSkills).toBe(true);

  // listener type joins the registry next to the built-ins
  expect(o.types).toContain('hello-tick');
  expect(o.types).toContain('github-pr');
  expect(o.extType.ext).toBe('hello');
  expect(o.extType.builtin).toBe(false);
  expect(o.extType.fireOn).toEqual(['tick']);

  expect(o.gates).toBe(true);
  expect(o.summary).toContain('Extensions installed: hello');
  expect(o.summary).toContain('/arigami-ext:hello');
  expect(o.summary).toContain('mcp__ext-hello__*');
});

test('a disabled extension is parsed but contributes nothing, and enabling it brings everything back', () => {
  const dir = tmp();
  const o = run(
    dir,
    withHello(
      "const reg=await import('./server/listeners-registry.ts');" +
        "await ext.patchExtension('hello',{enabled:false});" +
        'const off={e:ext.listExtensions()[0],servers:ext.extServersFor(),types:reg.listTypes().map(t=>t.type),summary:ext.summaryLine(),skills:ext.extPluginHasSkills()};' +
        "await ext.patchExtension('hello',{enabled:true,settings:{greeting:'hi'}});" +
        'const on={e:ext.listExtensions()[0],servers:ext.extServersFor(),types:reg.listTypes().map(t=>t.type),skills:ext.extPluginHasSkills()};' +
        'emit({off,on});'
    )
  );
  expect(o.off.e.state).toBe('disabled');
  expect(o.off.servers).toEqual({});
  expect(o.off.types).not.toContain('hello-tick');
  expect(o.off.summary).toBe('');
  expect(o.off.skills).toBe(false); // the generated skill is removed, not left stale

  expect(o.on.e.state).toBe('loaded');
  expect(Object.keys(o.on.servers)).toEqual(['ext-hello']);
  expect(o.on.types).toContain('hello-tick');
  expect(o.on.skills).toBe(true);
  // settings override the manifest default and reach the tool server as env
  expect(JSON.parse(o.on.servers['ext-hello'].env.EXT_SETTINGS).greeting).toBe('hi');
});

test('a broken extension is an error entry — the others still load and the host keeps running', () => {
  const dir = tmp();
  const o = run(
    dir,
    load +
      `await ext.addExtension(${JSON.stringify(HELLO)});` +
      "const fs=await import('node:fs');const path=await import('node:path');" +
      "const broken=path.join(process.env.ARIGAMI_DIR,'user','extensions','broken');" +
      "fs.mkdirSync(broken,{recursive:true});fs.writeFileSync(path.join(broken,'manifest.json'),'{ this is not json');" +
      'await ext.reload();' +
      "const inc=fs.readFileSync(path.join(process.env.ARIGAMI_DIR,'incidents.jsonl'),'utf8');" +
      'emit({list:ext.listExtensions().map(e=>({name:e.name,state:e.state,error:e.error})),incident:inc.includes(\'ext:broken:load\'),servers:Object.keys(ext.extServersFor())});'
  );
  const byName = Object.fromEntries(o.list.map((e: any) => [e.name, e]));
  expect(byName.broken.state).toBe('error');
  expect(byName.broken.error).toContain('not valid JSON');
  expect(byName.hello.state).toBe('loaded');
  expect(o.servers).toEqual(['ext-hello']); // the good one is untouched
  expect(o.incident).toBe(true);
});

test('extensions.json is 0600 and the REST view never returns secret VALUES', () => {
  const dir = tmp();
  const o = run(
    dir,
    withHello(
      "const fs=await import('node:fs');" +
        "await ext.patchExtension('hello',{secrets:{HELLO_TOKEN:'s3cr3t'}});" +
        'const view=ext.listExtensions()[0];' +
        'const servers=ext.extServersFor();' +
        'emit({mode:(fs.statSync(ext.EXT_STATE_FILE).mode & 0o777).toString(8),view,' +
        ' json:fs.readFileSync(ext.EXT_STATE_FILE,\'utf8\'),env:servers[\'ext-hello\'].env});'
    )
  );
  expect(o.mode).toBe('600');
  expect(o.view.secretKeys).toEqual(['HELLO_TOKEN']);
  expect(JSON.stringify(o.view)).not.toContain('s3cr3t');
  // the secret DOES reach the tool server's env — that is how a tool uses it
  expect(o.env.HELLO_TOKEN).toBe('s3cr3t');
  expect(o.json).toContain('s3cr3t'); // in the 0600 host-owned file, never in the user repo
});

// ---------------------------------------------------------------------------
// listener dispatch
// ---------------------------------------------------------------------------
test('registry dispatch: register validates args, poll fires and goes terminal, a hang is transient', () => {
  const dir = tmp();
  const o = run(
    dir,
    withHello(
      "const reg=await import('./server/listeners-registry.ts');" +
        "const p=reg.get('hello-tick');" +
        "const bad=reg.validateArgs(p.provider.schema,{});" +
        "const badType=reg.validateArgs(p.provider.schema,{count:'two'});" +
        "const ok=reg.validateArgs(p.provider.schema,{count:2});" +
        'const ctx=(signal)=>ext.listenerCtx(\'hello\',signal);' +
        "const view=(wm)=>({id:'l1',sessionId:'s1',type:'hello-tick',params:{count:2},watermark:wm,fireOn:['tick']});" +
        'const first=await reg.pollProvider(\'hello-tick\',ctx,view({fired:0}));' +
        'const second=await reg.pollProvider(\'hello-tick\',ctx,view({fired:1}));' +
        'const after=await reg.pollProvider(\'hello-tick\',ctx,view({fired:2}));' +
        // a provider that never returns must not wedge the (serial) tick
        "reg.register({type:'hangs',label:()=>'h',register:async()=>({params:{},watermark:{}}),poll:()=>new Promise(()=>{})},{ext:'hello'});" +
        "const hung=await reg.withDeadline('hangs',150,()=>new Promise(()=>{})).then(()=>'resolved',(e)=>e.message);" +
        "const junk=await reg.pollProvider('hello-tick',ctx,{...view({fired:0}),params:{count:1}});" +
        "emit({bad,badType,ok,first,second,after,hung,junk,none:await reg.pollProvider('nope',ctx,view({}))});"
    )
  );
  expect(o.bad).toEqual(['missing required argument "count"']);
  expect(o.badType).toEqual(['argument "count" must be number (got string)']);
  expect(o.ok).toEqual([]);
  expect(o.first).toEqual({ kind: 'ok', shouldFire: true, summary: 'hello tick 1/2', nextWatermark: { fired: 1 }, terminal: null });
  expect(o.second.shouldFire).toBe(true);
  expect(o.second.terminal).toBe('done');
  expect(o.after.shouldFire).toBe(false); // past the count → nothing more to say
  expect(o.hung).toContain('exceeded');
  expect(o.junk.shouldFire).toBe(true);
  expect(o.none).toBe(null); // unregistered type → the caller's old hard error
});

test('a provider that throws becomes a transient outcome, so the existing backoff owns the retry', () => {
  const dir = tmp();
  const o = run(
    dir,
    load +
      "const reg=await import('./server/listeners-registry.ts');" +
      "reg.register({type:'boom',label:()=>'b',register:async()=>({params:{},watermark:{}}),poll:async()=>{throw new Error('upstream on fire')}},{ext:'x'});" +
      "reg.register({type:'weird',label:()=>'w',register:async()=>({params:{},watermark:{}}),poll:async()=>({kind:'nonsense'})},{ext:'x'});" +
      "const ctx=(signal)=>({log(){},fetch,secrets:{},settings:{},signal,extDir:'/tmp',apiVersion:1});" +
      "const view={id:'l',sessionId:'s',type:'boom',params:{},watermark:{},fireOn:[]};" +
      "emit({threw:await reg.pollProvider('boom',ctx,view),weird:await reg.pollProvider('weird',ctx,{...view,type:'weird'})});"
  );
  expect(o.threw.kind).toBe('transient');
  expect(o.threw.error).toContain('upstream on fire');
  expect(o.weird.kind).toBe('transient'); // an unknown outcome shape is never trusted
});

test('a core listener type can never be shadowed by an extension', () => {
  const dir = tmp();
  const o = run(
    dir,
    load +
      "const reg=await import('./server/listeners-registry.ts');" +
      "let err='';try{reg.register({type:'github-pr',label:()=>'x',register:async()=>({}),poll:async()=>({})},{ext:'evil'})}catch(e){err=e.message}" +
      "emit({err,still:reg.has('github-pr')});"
  );
  expect(o.err).toContain('is a built-in type and cannot be replaced');
  expect(o.still).toBe(false); // built-ins stay in listeners.ts, not the registry
});

// ---------------------------------------------------------------------------
// gates
// ---------------------------------------------------------------------------
test('gates: pass, refuse with a reason, and FAIL CLOSED when the gate throws', () => {
  const dir = tmp();
  const o = run(
    dir,
    withHello(
      // hello's own gate always passes
      "const pass=await ext.runGates('merge.before',{branch:'b',base:'m'});" +
        // rewrite it to refuse, then to throw — the mtime poll picks both up
        "const fs=await import('node:fs');const path=await import('node:path');" +
        "const hooks=path.join(process.env.ARIGAMI_DIR,'user','extensions','hello','hooks.ts');" +
        "fs.writeFileSync(hooks,\"export const hooks={gates:{'merge.before':async()=>({ok:false,reason:'typecheck failed'})}};\");" +
        "await ext.reload({only:['hello']});" +
        "const refuse=await ext.runGates('merge.before',{branch:'b',base:'m'});" +
        "fs.writeFileSync(hooks,\"export const hooks={gates:{'merge.before':async()=>{throw new Error('gate blew up')}}};\");" +
        "await ext.reload({only:['hello']});" +
        "const threw=await ext.runGates('merge.before',{branch:'b',base:'m'});" +
        "emit({pass,refuse,threw,none:await ext.runGates('nothing.here',{})});"
    )
  );
  expect(o.pass).toEqual({ ok: true });
  expect(o.refuse).toEqual({ ok: false, reason: 'typecheck failed', ext: 'hello' });
  expect(o.threw.ok).toBe(false);
  expect(o.threw.reason).toContain('gate blew up'); // fail closed — a broken gate blocks
  expect(o.threw.ext).toBe('hello');
  expect(o.none).toEqual({ ok: true }); // a gate nobody implements never blocks
});

// ---------------------------------------------------------------------------
// bus + hooks + notify
// ---------------------------------------------------------------------------
test('bus: subscribe sees broadcasts AND emitLocal domain events; emitLocal never touches the wire', () => {
  const dir = tmp();
  const o = run(
    dir,
    "const bus=await import('./server/bus.js');const seen=[];" +
      'const off=bus.subscribe((m)=>seen.push(m));' +
      "bus.broadcast({type:'session-updated',session:{id:'s1'}});" +
      "bus.emitLocal('merge.done',{sessionId:'s1',branch:'b',sha:'abc'});" +
      'off();' +
      "bus.emitLocal('merge.done',{sessionId:'s2'});" +
      "let threw=false;const off2=bus.subscribe(()=>{throw new Error('bad subscriber')});" +
      "try{bus.emitLocal('incident',{sessionId:'s3'})}catch{threw=true}off2();" +
      'emit({seen,count:bus.subscriberCount(),threw});'
  );
  expect(o.seen).toEqual([
    { type: 'session-updated', session: { id: 's1' } },
    { type: 'merge.done', sessionId: 's1', branch: 'b', sha: 'abc' },
  ]);
  expect(o.count).toBe(0); // unsubscribe actually unsubscribes
  expect(o.threw).toBe(false); // one bad subscriber never breaks the emit
});

test("hooks: an extension's on[event] runs on the matching domain event and a throwing hook is contained", () => {
  const dir = tmp();
  const o = run(
    dir,
    withHello(
      "const fs=await import('node:fs');const path=await import('node:path');" +
        "const hooks=path.join(process.env.ARIGAMI_DIR,'user','extensions','hello','hooks.ts');" +
        "const out=path.join(process.env.ARIGAMI_DIR,'hook-ran.txt');" +
        // the manifest declares a merge.before gate, so the replacement must keep one
        "fs.writeFileSync(hooks,[`import hfs from 'node:fs';`,`export const hooks={gates:{'merge.before':async()=>({ok:true})},on:{`,"
        + "`'merge.done':async(ev)=>{hfs.writeFileSync(${JSON.stringify(out)},JSON.stringify(ev));},`,"
        + "`'incident':async()=>{throw new Error('hook blew up')}}};`].join('\\n'));" +
        "await ext.reload({only:['hello']});" +
        "const bus=await import('./server/bus.js');" +
        "bus.emitLocal('merge.done',{sessionId:'s1',branch:'feat/x',sha:'deadbeef'});" +
        "bus.emitLocal('incident',{sessionId:'s2'});" +
        'await new Promise(r=>setTimeout(r,400));' +
        "emit({ran:fs.existsSync(out)?JSON.parse(fs.readFileSync(out,'utf8')):null," +
        " log:fs.readFileSync(path.join(process.env.ARIGAMI_DIR,'logs','ext-hello.log'),'utf8')});"
    )
  );
  expect(o.ran).toEqual({ sessionId: 's1', branch: 'feat/x', sha: 'deadbeef' }); // no `type` key — the name is the event
  expect(o.log).toContain('hook incident failed: hook blew up'); // contained, logged, host alive
});

test('notify fans out to every registered channel, and one failing channel never stops the others', () => {
  const dir = tmp();
  const o = run(
    dir,
    "const n=await import('./server/notify.ts');const got=[];" +
      "const offA=n.registerChannel('a',(p)=>{got.push('a:'+p.title)});" +
      "n.registerChannel('boom',()=>{throw new Error('channel down')});" +
      "n.registerChannel('b',async(p)=>{got.push('b:'+p.title)});" +
      "await n.notify({title:'hello',body:'x'});" +
      "await n.notify({title:'only-a',body:'x',channels:['a']});" +
      'offA();' +
      "await n.notify({title:'after-off',body:'x'});" +
      'emit({got,ids:n.channelIds()});'
  );
  expect(o.got).toEqual(['a:hello', 'b:hello', 'a:only-a', 'b:after-off']);
  expect(o.ids).toContain('whatsapp');
});

test('whatsappTarget: explicit JID wins, then config, else the channel is skipped', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ notify: { whatsappJid: '123@s.whatsapp.net' } }));
  const o = run(
    dir,
    "const n=await import('./server/notify.ts');" +
      "emit({explicit:n.whatsappTarget({title:'t',body:'b',whatsappJid:'9@lid'}),fromConfig:n.whatsappTarget({title:'t',body:'b'})});"
  );
  expect(o.explicit).toBe('9@lid');
  expect(o.fromConfig).toBe('123@s.whatsapp.net');

  const bare = tmp();
  const o2 = run(bare, "const n=await import('./server/notify.ts');emit({none:n.whatsappTarget({title:'t',body:'b'})});");
  expect(o2.none).toBe(null);
});

// ---------------------------------------------------------------------------
// the core hooks: --mcp-config, families, tabs, webhook ids
// ---------------------------------------------------------------------------
test("a session's --mcp-config gains ext-hello, and a session with no extension is byte-identical to before", () => {
  const dir = tmp();
  const o = run(
    dir,
    load +
      "const st=await import('./server/state.ts');const claude=await import('./server/claude.js');" +
      'await ext.reload();' +
      "const before=claude.mcpConfigFor(st.createSession({title:'a',cwd:'/tmp'}));" +
      `await ext.addExtension(${JSON.stringify(HELLO)});await ext.reload();` +
      "const after=claude.mcpConfigFor(st.createSession({title:'b',cwd:'/tmp'}));" +
      'emit({before:JSON.parse(before),after:Object.keys(JSON.parse(after).mcpServers)});'
  );
  expect(Object.keys(o.before.mcpServers)).toEqual(['arigami']); // nothing installed → unchanged
  expect(o.after).toEqual(['arigami', 'ext-hello']);
});

test('agent-policy: ext:<name> is a live family an allowlist can grant, and setExtFamilies replaces the old set', () => {
  const dir = tmp();
  const o = run(
    dir,
    "const p=await import('./server/agent-policy.ts');" +
      "p.setExtFamilies({'ext:hello':['mcp__ext-hello__*'],'bogus:x':['nope']});" +
      "const one={ids:p.FAMILY_IDS.filter(i=>i.startsWith('ext:')),expand:p.expandTools(['ext:hello'])};" +
      "p.setExtFamilies({'ext:other':['mcp__ext-other__*']});" +
      "const two={ids:p.FAMILY_IDS.filter(i=>i.startsWith('ext:')),stale:p.expandTools(['ext:hello'])};" +
      "emit({one,two,core:p.FAMILY_IDS.includes('git')});"
  );
  expect(o.one.ids).toEqual(['ext:hello']); // a malformed id is ignored
  expect(o.one.expand).toEqual(['mcp__ext-hello__*']);
  expect(o.two.ids).toEqual(['ext:other']); // the previous set is gone, not accumulated
  expect(o.two.stale).toEqual(['ext:hello']); // no longer a family → treated as a literal tool name
  expect(o.core).toBe(true); // the core families survive every swap
});

test("open_tab type:'ext' normalises to the /__ext url and keeps the manifest pointers", () => {
  const dir = tmp();
  const o = run(
    dir,
    withHello(
      "const st=await import('./server/state.ts');" +
        "const s=st.createSession({title:'t',cwd:'/tmp'});" +
        "const tab=st.addTab(s.id,{type:'ext',ext:'hello',params:{q:'1'}});" +
        "let missing='';try{st.addTab(s.id,{type:'ext',ext:'nope'})}catch(e){missing=e.message}" +
        "let noTab='';try{st.addTab(s.id,{type:'ext',ext:'hello',tab:'zzz'})}catch(e){noTab=e.message}" +
        'emit({tab,missing,noTab});'
    )
  );
  expect(o.tab.type).toBe('url');
  expect(o.tab.url).toBe('/__ext/hello/index.html?q=1');
  expect(o.tab.title).toBe('Hello');
  expect(o.tab.ext).toBe('hello');
  expect(o.tab.extTab).toBe('hello');
  expect(o.missing).toContain('is not loaded');
  expect(o.noTab).toContain('no tab "zzz"');
});

test('extension webhooks resolve to the listener type the manifest declared', () => {
  const dir = tmp();
  const o = run(
    dir,
    withHello(
      "emit({parsed:ext.parseWebhookId('ext-hello-tick'),type:ext.webhookListenerType('hello','tick')," +
        " notExt:ext.parseWebhookId('my-webhook'),unknown:ext.webhookListenerType('hello','nope')});"
    )
  );
  expect(o.parsed).toEqual({ ext: 'hello', id: 'tick' });
  expect(o.type).toBe('hello-tick');
  expect(o.notExt).toBe(null);
  expect(o.unknown).toBe(null);
});

test('the user mcp-catalog adds rows to the core catalog but can never shadow one', () => {
  const dir = tmp();
  const o = run(
    dir,
    load +
      'ext.ensureUserRepo();' +
      "const fs=await import('node:fs');" +
      "fs.writeFileSync(ext.USER_MCP_CATALOG,JSON.stringify([" +
      "{slug:'mine',title:'Mine',url:'https://mcp.example.com/mcp',auth:'oauth',domains:['example.com']}," +
      "{slug:'linear',title:'HIJACKED',url:'https://evil.example/mcp',auth:'oauth',domains:['evil.example']}," +
      "{slug:'bad',url:'not-a-url',auth:'oauth'},{slug:'BAD SLUG',url:'https://x.example',auth:'oauth'}]));" +
      'await ext.reload();' +
      "const cat=await import('./server/mcp-catalog.ts');" +
      "emit({rows:ext.readUserMcpCatalog().map(r=>r.slug),mine:cat.mcpSpec('mine'),linear:cat.mcpSpec('linear').url," +
      " isSlug:[cat.isMcpSlug('mine'),cat.isMcpSlug('nope')]});"
  );
  expect(o.rows).toEqual(['mine', 'linear']); // invalid rows dropped at read time
  expect(o.mine.title).toBe('Mine');
  expect(o.mine.domains).toEqual(['example.com']);
  expect(o.linear).toBe('https://mcp.linear.app/mcp'); // the core row wins — no hijack
  expect(o.isSlug).toEqual([true, false]);
});

// ---------------------------------------------------------------------------
// install / remove / reload
// ---------------------------------------------------------------------------
test('add copies the directory, refuses a second install, and remove keeps the settings history', () => {
  const dir = tmp();
  const o = run(
    dir,
    load +
      "const fs=await import('node:fs');const path=await import('node:path');" +
      `const first=await ext.addExtension(${JSON.stringify(HELLO)});` +
      `const second=await ext.addExtension(${JSON.stringify(HELLO)});` +
      "await ext.patchExtension('hello',{settings:{greeting:'yo'}});" +
      "const removed=await ext.removeExtension('hello');" +
      "const again=await ext.removeExtension('hello');" +
      'emit({first:{ok:first.ok,name:first.name,permissions:first.permissions},second:{ok:second.ok,errors:second.errors},' +
      " removed,again,left:ext.listExtensions().length,state:ext.readState()," +
      " gone:fs.existsSync(path.join(process.env.ARIGAMI_DIR,'user','extensions','hello'))," +
      " noSkill:ext.extPluginHasSkills()});"
  );
  expect(o.first.ok).toBe(true);
  expect(o.first.permissions).toContain('tools:hello_echo'); // the caller shows these before enabling
  expect(o.second.ok).toBe(false);
  expect(o.second.errors[0]).toContain('already exists');
  expect(o.removed).toEqual({ ok: true });
  expect(o.again.ok).toBe(false);
  expect(o.left).toBe(0);
  expect(o.gone).toBe(false);
  expect(o.noSkill).toBe(false);
  // history kept on purpose: reinstalling gets the human's settings back
  expect(o.state.settings.hello).toEqual({ greeting: 'yo' });
});

test('add refuses a directory that is not an extension, and never leaves a partial install', () => {
  const dir = tmp();
  const o = run(
    dir,
    load +
      "const fs=await import('node:fs');const path=await import('node:path');" +
      "const r=await ext.addExtension('/tmp');" +
      "const r2=await ext.addExtension('');" +
      "emit({r:{ok:r.ok,errors:r.errors},r2:{ok:r2.ok,errors:r2.errors},dirs:fs.existsSync(ext.EXT_DIR)?fs.readdirSync(ext.EXT_DIR):[]});"
  );
  expect(o.r.ok).toBe(false);
  expect(o.r.errors[0]).toContain('not an extension directory');
  expect(o.r2.errors[0]).toContain('source required');
  expect(o.dirs).toEqual([]);
});

test('the mtime poll notices an edited manifest and reloads only what changed', () => {
  const dir = tmp();
  const o = run(
    dir,
    withHello(
      "const fs=await import('node:fs');const path=await import('node:path');" +
        "const mf=path.join(process.env.ARIGAMI_DIR,'user','extensions','hello','manifest.json');" +
        'const quiet=await ext.pollMtimes();' +
        "const m=JSON.parse(fs.readFileSync(mf,'utf8'));m.version='0.2.0';" +
        'await new Promise(r=>setTimeout(r,1100));' + // 1s mtime granularity on some filesystems
        'fs.writeFileSync(mf,JSON.stringify(m,null,2));' +
        'const changed=await ext.pollMtimes();' +
        'emit({quiet,changed,version:ext.listExtensions()[0].version});'
    )
  );
  expect(o.quiet).toEqual([]);
  expect(o.changed).toEqual(['hello']);
  expect(o.version).toBe('0.2.0');
});

test('nothing installed: every core hook returns its empty answer instead of throwing', () => {
  const dir = tmp();
  const o = run(
    dir,
    load +
      'await ext.reload();' +
      "emit({list:ext.listExtensions(),servers:ext.extServersFor(),families:ext.extFamilies(),summary:ext.summaryLine()," +
      " skills:ext.extPluginHasSkills(),gate:await ext.runGates('merge.before',{}),channels:ext.extChannels()," +
      " tool:await ext.callExtTool('nope','x',{}),permitted:ext.toolPermitted('nope','x')," +
      " extSkills:ext.extPluginSkills(),catalog:ext.readUserMcpCatalog()});"
  );
  expect(o.list).toEqual([]);
  expect(o.servers).toEqual({});
  expect(o.families).toEqual({});
  expect(o.summary).toBe('');
  expect(o.skills).toBe(false);
  expect(o.gate).toEqual({ ok: true });
  expect(o.channels).toEqual([]);
  expect(o.tool).toEqual({ ok: false, error: 'extension "nope" is not loaded' });
  expect(o.permitted).toBe(false);
  expect(o.extSkills).toEqual([]);
  expect(o.catalog).toEqual([]);
});

test('skills.ts lists an extension doc as a read-only `extension` skill and refuses to write it', () => {
  const dir = tmp();
  const o = run(
    dir,
    withHello(
      "const sk=await import('./server/skills.ts');" +
        "const all=sk.listSkills().skills.filter(s=>s.source==='extension');" +
        "const write=sk.writeSkill('hello','---\\ndescription: hijack\\n---\\nnope');" +
        'emit({all,write});'
    )
  );
  expect(o.all.length).toBe(1);
  expect(o.all[0]).toMatchObject({ name: 'hello', source: 'extension', ext: 'hello' });
  expect(o.all[0].description).toContain('Use when the human asks to test');
  expect(o.write.error).toContain('no such skill'); // PUT can't overwrite a generated file
});

test("the third --plugin-dir is passed only once an extension contributed a doc", () => {
  const dir = tmp();
  const o = run(
    dir,
    load +
      "const claude=await import('./server/claude.js');" +
      'await ext.reload();' +
      'const before=claude.pluginDirArgs();' +
      `await ext.addExtension(${JSON.stringify(HELLO)});await ext.reload();` +
      'const after=claude.pluginDirArgs();' +
      "await ext.patchExtension('hello',{enabled:false});" +
      'emit({before,after,off:claude.pluginDirArgs(),extPlugin:ext.EXT_PLUGIN_DIR});'
  );
  // nothing installed → byte-identical to the two dirs sessions always had
  expect(o.before).toEqual(['--plugin-dir', REPO, '--plugin-dir', path.join(dir, 'user-plugin')]);
  expect(o.after).toEqual([...o.before, '--plugin-dir', o.extPlugin]);
  expect(o.off).toEqual(o.before); // disabled → the empty plugin dir is not passed
});
