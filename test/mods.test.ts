// MODS — Arigami's runtime for Claude Code mods (server/mods.ts), driven the way the codex adapter drives it:
// PreToolUse → toolPre (chain runs to next() and suspends), PostToolUse → toolPost (result handed back), and the
// host's own prompt.submit. The fixture is a plain Claude Code mod, written against Claude Code's API only.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInChild } from './_child.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-mods-'));
const env = (dir: string) => ({ ARIGAMI_DIR: dir, ARIGAMI_PORT: '', ARIGAMI_STATE_FILE: path.join(dir, 'state.json'), ARIGAMI_CHAT_DIR: path.join(dir, 'chat') });

const GUARD = `
let calls = 0
export function register(on) {
  on('session.start', async ($, e, next) => { await $.store.set('started', true); return next(e) })
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    calls++
    if (/rm -rf/.test(e.command)) return { deny: 'no rm -rf here' }
    if (e.command === 'ls -la') return next({ ...e, command: 'ls' })
    const res = await next(e)
    if (typeof res.result === 'string' && res.result.includes('SECRET')) {
      $.ui.log('masked a secret (call ' + calls + ')')
      return { ...res, result: res.result.replace('SECRET', '[X]') }
    }
    return res
  })
  on('tool.call', { tool: /^mcp__boom__/ }, async () => { throw new Error('kaboom') })
  on('prompt.submit', async ($, e, next) => {
    if (e.text.includes('drop me')) return { drop: 'not this one' }
    if (e.text.includes('mask')) return next({ ...e, text: e.text.replace('mask', '****'), context: [...(e.context || []), 'checked by guard'] })
    return next(e)
  })
  on('ui.render', { component: 'Spinner' }, async ($, e, next) => next(e))
}
`;
const UNSUPPORTED_API = `
export function register(on) {
  on('tool.call', { tool: 'Read' }, async ($, e, next) => { await $.model.complete({ prompt: 'x' }); return next(e) })
}
`;

function fixture(dir: string): void {
  const ext = path.join(dir, 'user', 'extensions', 'guard');
  for (const [name, src] of [['guard-mod', GUARD], ['model-mod', UNSUPPORTED_API]]) {
    fs.mkdirSync(path.join(ext, name, '.claude-plugin'), { recursive: true });
    fs.mkdirSync(path.join(ext, name, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(ext, name, '.claude-plugin', 'plugin.json'), JSON.stringify({ name }));
    fs.writeFileSync(path.join(ext, name, 'hooks', 'hooks.json'), JSON.stringify({ modules: ['./register.js'] }));
    fs.writeFileSync(path.join(ext, name, 'hooks', 'register.js'), src);
  }
  fs.writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify({ name: 'guard', version: '0.1.0', apiVersion: 1, title: 'Guard', description: 'test mods', mods: ['guard-mod', 'model-mod'] }));
}

test('mods runtime: tool.call across Pre/Post, input rewrite, deny, prompt.submit, errors and unsupported surfaces', () => {
  const dir = tmp();
  fixture(dir);
  const r = runInChild(
    "const ext=await import('./server/extensions.ts');await ext.reload();" +
      "const mods=await import('./server/mods.ts');const cards=[];" +
      "const ctx={id:'s1',cwd:process.env.ARIGAMI_DIR,env:{},card:(m,t)=>cards.push(m+': '+t)};" +
      "const validated=await ext.validateExtension(require('node:path').join(process.env.ARIGAMI_DIR,'user','extensions','guard'));" +
      "const denied=await mods.toolPre(ctx,{tool:'Bash',input:{command:'rm -rf /'},id:'a'});" +
      "const rewritten=await mods.toolPre(ctx,{tool:'Bash',input:{command:'ls -la'},id:'b'});" +
      "const postB=await mods.toolPost(ctx,{id:'b',output:'file1'});" +
      "const pre=await mods.toolPre(ctx,{tool:'Bash',input:{command:'cat env'},id:'c'});" +
      "const masked=await mods.toolPost(ctx,{id:'c',output:'KEY=SECRET'});" +
      "const other=await mods.toolPre(ctx,{tool:'Glob',input:{pattern:'*'},id:'d'});" +
      "const boom=await mods.toolPre(ctx,{tool:'mcp__boom__x',input:{},id:'e'});" +
      "const unknownPost=await mods.toolPost(ctx,{id:'never-seen',output:'x'});" +
      "const strictPre=await mods.toolPre(ctx,{tool:'Read',input:{file_path:'a'},id:'f'});" +
      "const dropped=await mods.promptSubmit(ctx,'please drop me');" +
      "const prompt=await mods.promptSubmit(ctx,'mask this');" +
      "const plain=await mods.promptSubmit(ctx,'hello');" +
      "const started=JSON.parse(require('node:fs').readFileSync(require('node:path').join(process.env.ARIGAMI_DIR,'mods-store','guard-mod.json'),'utf8')).started;" +
      'emit({validated:validated.ok,denied,rewritten,postB,pre,masked,other,boom,unknownPost,strictPre,dropped,prompt,plain,started,cards,hasMods:mods.hasMods()});',
    env(dir)
  );
  if (!r.ok) throw new Error(r.error);
  const o = r.out[0] as any;
  expect(o.validated).toBe(true);
  expect(o.hasMods).toBe(true);
  expect(o.denied).toEqual({ allow: false, reason: 'no rm -rf here' }); // answered without next(): the tool never runs
  expect(o.rewritten).toEqual({ allow: true, input: { command: 'ls' } }); // next() got changed arguments
  expect(o.postB).toEqual({ pass: true });
  expect(o.pre).toEqual({ allow: true });
  expect(o.masked).toEqual({ replace: 'KEY=[X]' }); // the hook's code after next() rewrote the result
  expect(o.other).toEqual({ allow: true }); // matcher: Bash-only hooks never see Glob
  expect(o.boom).toEqual({ allow: true }); // a hook that throws before next() is skipped, as in Claude Code…
  expect(o.cards.some((c: string) => /kaboom/.test(c))).toBe(true); // …and it is said, not swallowed
  expect(o.unknownPost).toEqual({ pass: true });
  expect(o.strictPre).toEqual({ allow: true }); // $.model is not implemented: the hook fails loudly and is skipped
  expect(o.cards.some((c: string) => /\$\.model\.complete is not available/.test(c))).toBe(true);
  expect(o.dropped).toEqual({ drop: 'not this one' });
  expect(o.prompt).toEqual({ text: '**** this\n\nchecked by guard' }); // rewritten text + context lines for the model
  expect(o.plain).toEqual({ text: 'hello' });
  expect(o.started).toBe(true); // session.start ran once, before the first event
  expect(o.cards.some((c: string) => /masked a secret/.test(c))).toBe(true); // $.ui.log → a chat card
  expect(o.cards.some((c: string) => /not run by this engine.*ui\.render/.test(c))).toBe(true);
});

test('mods: an extension without mods contributes none, and a broken mod dir fails validation', () => {
  const dir = tmp();
  const ext = path.join(dir, 'user', 'extensions', 'broken');
  fs.mkdirSync(path.join(ext, 'm'), { recursive: true });
  fs.writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify({ name: 'broken', version: '0.1.0', apiVersion: 1, title: 'B', description: 'd', mods: ['m'] }));
  const r = runInChild(
    "const ext=await import('./server/extensions.ts');const v=await ext.validateExtension(require('node:path').join(process.env.ARIGAMI_DIR,'user','extensions','broken'));" +
      'emit({ok:v.ok,errors:v.errors});',
    env(dir)
  );
  if (!r.ok) throw new Error(r.error);
  const o = r.out[0] as any;
  expect(o.ok).toBe(false);
  expect(o.errors.join('\n')).toContain('plugin.json is missing');
});
