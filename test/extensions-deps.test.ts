// EXT — an extension's own npm dependencies (server/lib/ext-deps.ts + the loader wiring).
//
// What these pin:
//   - an install copies the extension without node_modules; with no grant nothing is downloaded and the
//     extension says "dependencies missing: …" in /__api/extensions (and its tool says why it cannot import)
//   - the grant (PATCH installDeps / a trusted profile apply) runs `bun install` with lifecycle scripts OFF and
//     no lockfile written into the extension; the listener and the tool import the package afterwards, in the
//     SAME process (Bun remembers a failed import — the loader must not)
//   - a failed install is a status, not a crash; a retry after the cause is fixed works
//   - with a lockfile the install is frozen: a package.json that drifted from it fails instead of resolving afresh
//   - a profile update that changes package.json re-installs; a hand-run install is picked up by the mtime poll
//   - export keeps package.json + the lockfile, never node_modules, and warns when deps are not pinned
//
// No network anywhere: every dependency is a `file:` package vendored into the test's temp dir.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInChild } from './_child.js';

const tmp = (p = 'arigami-extdeps-') => fs.mkdtempSync(path.join(os.tmpdir(), p));
const env = (dir: string, extra: Record<string, string> = {}) => ({
  ARIGAMI_DIR: dir,
  ARIGAMI_PORT: '',
  ARIGAMI_STATE_FILE: path.join(dir, 'state.json'),
  ARIGAMI_CHAT_DIR: path.join(dir, 'chat'),
  ...extra,
});
const run = (dir: string, body: string, extra: Record<string, string> = {}) => {
  const r = runInChild("const ext=await import('./server/extensions.ts');" + body, env(dir, extra));
  if (!r.ok) throw new Error(r.error);
  return r.out[0] as any;
};
const write = (f: string, s: string) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, s);
};

/** A tiny package on disk. Its postinstall would leave a marker file — it must never run. */
function vendor(root: string, version: string, answer: number): string {
  const dir = path.join(root, `tinydep-${version}`);
  write(path.join(dir, 'package.json'), JSON.stringify({ name: 'tinydep', version, main: 'index.js', scripts: { postinstall: `touch ${path.join(root, 'DEP_POSTINSTALL_RAN')}` } }));
  write(path.join(dir, 'index.js'), `module.exports = { answer: ${answer} };`);
  return dir;
}

/** An extension whose listener AND tool import `tinydep`. Its own preinstall must never run either. */
function extension(root: string, depDir: string, name = 'depx', opts: { listener?: boolean } = {}): string {
  const dir = path.join(root, 'src', name);
  const listener = opts.listener !== false;
  write(
    path.join(dir, 'manifest.json'),
    JSON.stringify({
      name,
      version: '1.0.0',
      apiVersion: 1,
      description: 'needs a package',
      ...(listener ? { listeners: [{ type: `${name}-l`, module: 'listener.ts', export: 'provider' }] } : {}),
      tools: [{ name: 't', kind: 'module', module: 'tools/module.ts' }],
    })
  );
  if (listener)
    write(path.join(dir, 'listener.ts'), `import dep from 'tinydep';\nexport const provider = { type: '${name}-l', register() {}, async poll() { return { events: [], cursor: String(dep.answer) }; } };\n`);
  write(path.join(dir, 'tools', 'module.ts'), `import dep from 'tinydep';\nexport const tools = [{ name: 'answer', run: async () => dep.answer }];\n`);
  write(path.join(dir, 'package.json'), JSON.stringify({ name, private: true, scripts: { preinstall: `touch ${path.join(root, 'EXT_PREINSTALL_RAN')}` }, dependencies: { tinydep: `file:${depDir}` } }));
  return dir;
}

test('no grant → nothing is installed and the status says "dependencies missing"; the grant installs (no scripts, no lockfile) and the same process then imports it', () => {
  const root = tmp();
  const adir = path.join(root, 'home');
  const src = extension(root, vendor(root, '1.0.0', 42));
  const o = run(
    adir,
    `const a=await ext.addExtension(${JSON.stringify(src)});` +
      `const before=ext.listExtensions()[0];` +
      `const stamp0=JSON.stringify(ext.extServersFor());` +
      `const p=await ext.patchExtension('depx',{installDeps:true});` +
      `const after=ext.listExtensions()[0];` +
      `const call=await ext.callExtTool('depx','answer',{});` +
      `emit({a:{deps:a.deps,warnings:a.warnings},before:{state:before.state,error:before.error,deps:before.deps},p:p.deps,after:{state:after.state,error:after.error,deps:after.deps,listenerTypes:after.listenerTypes},call,stampChanged:stamp0!==JSON.stringify(ext.extServersFor())});`
  );
  // 1. installed WITHOUT dependencies, and saying so
  expect(o.a.deps.status).toBe('not-allowed');
  expect(o.before.deps).toMatchObject({ needed: true, state: 'missing', allowed: false, missing: ['tinydep'], lockfile: null });
  expect(o.before.error).toStartWith('dependencies missing: tinydep');
  expect(o.before.error).toContain('bin/host ext deps depx');
  // 2. the grant installs, and the listener (imported in this same process) now loads
  expect(o.p).toMatchObject({ ok: true, status: 'installed' });
  expect(o.after.state).toBe('loaded');
  expect(o.after.error).toBe(null);
  expect(o.after.deps).toMatchObject({ state: 'ok', allowed: true });
  expect(o.after.listenerTypes).toEqual(['depx-l']);
  expect(o.call).toEqual({ ok: true, result: [{ type: 'text', text: '42' }] });
  // a shared tool server is keyed by its spec — the spec moved, so the next call is a fresh process
  expect(o.stampChanged).toBe(true);
  // 3. no lifecycle script ran — neither the extension's preinstall nor the dependency's postinstall
  expect(fs.existsSync(path.join(root, 'EXT_PREINSTALL_RAN'))).toBe(false);
  expect(fs.existsSync(path.join(root, 'DEP_POSTINSTALL_RAN'))).toBe(false);
  // 4. the extension directory still matches its source: no lockfile was written into it
  const installed = path.join(adir, 'user', 'extensions', 'depx');
  expect(fs.existsSync(path.join(installed, 'bun.lock'))).toBe(false);
  expect(fs.existsSync(path.join(installed, 'node_modules', 'tinydep', 'package.json'))).toBe(true);
  // the grant is host state, not something the extension can claim
  expect(JSON.parse(fs.readFileSync(path.join(adir, 'extensions.json'), 'utf8')).deps).toEqual({ depx: true });
}, 60_000);

test('a tool whose package is missing says WHY instead of only "Cannot find package"', () => {
  const root = tmp();
  const src = extension(root, vendor(root, '1.0.0', 1), 'toolonly', { listener: false });
  const o = run(path.join(root, 'home'), `await ext.addExtension(${JSON.stringify(src)});emit(await ext.callExtTool('toolonly','answer',{}));`);
  expect(o.ok).toBe(false);
  expect(o.error).toContain('dependencies missing: tinydep');
  expect(o.error).toContain("Cannot find package 'tinydep'");
}, 60_000);

test('a failed install (the package cannot be fetched) is a clear status, not a crash — and a retry after the fix installs', () => {
  const root = tmp();
  const missing = path.join(root, 'not-there-yet');
  const src = extension(root, missing);
  const adir = path.join(root, 'home');
  const o = run(adir, `const a=await ext.addExtension(${JSON.stringify(src)},{installDeps:true});const e=ext.listExtensions()[0];emit({a:a.deps,error:e.error,deps:e.deps});`);
  expect(o.a.ok).toBe(false);
  expect(o.a.status).toBe('missing');
  expect(o.deps.state).toBe('missing');
  expect(o.deps.allowed).toBe(true);
  expect(o.deps.error).toStartWith('dependencies missing: ');
  expect(o.deps.error).not.toContain('not installed yet'); // it carries bun's own reason, not a guess
  expect(o.error).toStartWith('dependencies missing: ');

  // the package shows up (the registry is back): the retry — `ext deps`, or the card's button — installs it
  fs.cpSync(vendor(root, '1.0.0', 7), missing, { recursive: true });
  const r = run(adir, `await ext.reload();const p=await ext.patchExtension('depx',{installDeps:true});emit({p:p.deps,state:p.extension.state,call:await ext.callExtTool('depx','answer',{})});`);
  expect(r.p).toMatchObject({ ok: true, status: 'installed' });
  expect(r.state).toBe('loaded');
  expect(r.call.result[0].text).toBe('7');
}, 60_000);

test('a lockfile makes the install frozen: a package.json that drifted from it fails instead of resolving afresh', () => {
  const root = tmp();
  const v1 = vendor(root, '1.0.0', 1);
  const v2 = vendor(root, '2.0.0', 2);
  const src = extension(root, v1);
  // the author's lockfile, for v1
  const lock = Bun.spawnSync(['bun', 'install', '--ignore-scripts'], { cwd: src });
  expect(lock.exitCode).toBe(0);
  fs.rmSync(path.join(src, 'node_modules'), { recursive: true, force: true });
  expect(fs.existsSync(path.join(src, 'bun.lock'))).toBe(true);
  // …and a package.json edited afterwards without re-locking
  const pkg = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8'));
  pkg.dependencies.tinydep = `file:${v2}`;
  fs.writeFileSync(path.join(src, 'package.json'), JSON.stringify(pkg));
  const o = run(path.join(root, 'home'), `const a=await ext.addExtension(${JSON.stringify(src)},{installDeps:true});emit({a:a.deps,deps:ext.listExtensions()[0].deps});`);
  expect(o.a.ok).toBe(false);
  expect(o.a.error).toContain('lockfile');
  expect(o.deps.lockfile).toBe('bun.lock');
}, 60_000);

test('a hung install is bounded by the timeout', () => {
  const root = tmp();
  const fake = path.join(root, 'slow-bun.sh');
  write(fake, '#!/bin/sh\nsleep 20\n');
  fs.chmodSync(fake, 0o755);
  const src = extension(root, vendor(root, '1.0.0', 1));
  const t0 = Date.now();
  const o = run(path.join(root, 'home'), `const a=await ext.addExtension(${JSON.stringify(src)},{installDeps:true});emit(a.deps);`, {
    ARIGAMI_EXT_BUN: fake,
    ARIGAMI_EXT_DEPS_TIMEOUT_MS: '800',
  });
  expect(o.ok).toBe(false);
  expect(o.error).toContain('timed out');
  expect(Date.now() - t0).toBeLessThan(15_000);
}, 60_000);

test('an install run by hand is picked up by the mtime poll — no restart, no stale failed import', () => {
  const root = tmp();
  const adir = path.join(root, 'home');
  const src = extension(root, vendor(root, '1.0.0', 5));
  const o = run(
    adir,
    `await ext.addExtension(${JSON.stringify(src)});const before=ext.listExtensions()[0].state;` +
      // what `cd user/extensions/depx && bun install` would do, out of the host's sight
      `const r=Bun.spawnSync(['bun','install','--ignore-scripts','--no-save'],{cwd:ext.EXT_DIR+'/depx'});` +
      `const changed=await ext.pollMtimes();const e=ext.listExtensions()[0];` +
      `emit({before,rc:r.exitCode,changed,state:e.state,deps:e.deps.state,listenerTypes:e.listenerTypes});`
  );
  expect(o.before).toBe('error'); // the listener could not import tinydep
  expect(o.rc).toBe(0);
  expect(o.changed).toContain('depx');
  expect(o.state).toBe('loaded');
  expect(o.deps).toBe('ok');
  expect(o.listenerTypes).toEqual(['depx-l']);
}, 60_000);

// ---- profile apply + export ------------------------------------------------------

function applyBundle(bdir: string, adir: string) {
  const r = runInChild(
    `const pf=await import('./server/profiles.ts');const ex=await import('./server/extensions.ts');` +
      `const rep=await pf.applyBundle({...pf.loadBundle(${JSON.stringify(bdir)}),trusted:true});` +
      `emit({rep:rep.extensions,errors:rep.errors,list:ex.listExtensions().map(e=>({state:e.state,deps:e.deps.state}))});`,
    env(adir)
  );
  if (!r.ok) throw new Error(r.error);
  return r.out[0] as any;
}

test('a trusted profile installs the dependencies; an update that changes package.json re-installs them', () => {
  const root = tmp();
  const adir = path.join(root, 'home');
  const v1 = vendor(root, '1.0.0', 1);
  const v2 = vendor(root, '2.0.0', 2);
  const bdir = path.join(root, 'bundle');
  write(path.join(bdir, 'profile.json'), JSON.stringify({ name: 'org-profile', version: '1.0.0', extensions: [{ name: 'depx' }] }));
  write(path.join(bdir, 'README.md'), '# org\n');
  fs.cpSync(extension(root, v1), path.join(bdir, 'extensions', 'depx'), { recursive: true });

  const r1 = applyBundle(bdir, adir);
  expect(r1.errors).toEqual([]);
  expect(r1.rep).toEqual([{ name: 'depx', status: 'installed', deps: 'ok' }]);
  expect(r1.list).toEqual([{ state: 'loaded', deps: 'ok' }]);
  const installed = path.join(adir, 'user', 'extensions', 'depx', 'node_modules', 'tinydep', 'package.json');
  expect(JSON.parse(fs.readFileSync(installed, 'utf8')).version).toBe('1.0.0');

  // the same bundle again: nothing to do
  expect(applyBundle(bdir, adir).rep).toEqual([{ name: 'depx', status: 'unchanged', deps: 'ok' }]);

  // the org bumps the dependency: the extension is updated AND re-installed
  const pkgFile = path.join(bdir, 'extensions', 'depx', 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
  pkg.dependencies.tinydep = `file:${v2}`;
  fs.writeFileSync(pkgFile, JSON.stringify(pkg));
  const r3 = applyBundle(bdir, adir);
  expect(r3.rep).toEqual([{ name: 'depx', status: 'updated', deps: 'ok' }]);
  expect(JSON.parse(fs.readFileSync(installed, 'utf8')).version).toBe('2.0.0');
  expect(fs.existsSync(path.join(root, 'DEP_POSTINSTALL_RAN'))).toBe(false);
}, 120_000);

test('export keeps package.json + the lockfile and drops node_modules; unpinned dependencies are a warning', () => {
  const adir = tmp();
  const root = path.join(adir, 'user', 'extensions');
  for (const n of ['pinned', 'unpinned']) {
    write(path.join(root, n, 'manifest.json'), JSON.stringify({ name: n, version: '1.0.0', apiVersion: 1 }));
    write(path.join(root, n, 'package.json'), JSON.stringify({ dependencies: { tinydep: '^1.0.0' } }));
    write(path.join(root, n, 'node_modules', 'tinydep', 'package.json'), JSON.stringify({ name: 'tinydep', version: '1.0.0' }));
  }
  write(path.join(root, 'pinned', 'bun.lock'), '{ "lockfileVersion": 1 }\n');
  const out = path.join(tmp(), 'bundle');
  const r = runInChild(
    `const bk=await import('./server/backup.ts');emit(bk.exportBundle({out:${JSON.stringify(out)},name:'org-profile',cron:[],memory:false}));`,
    { ARIGAMI_DIR: adir, ARIGAMI_PORT: '' }
  );
  if (!r.ok) throw new Error(r.error);
  const res = r.out[0] as any;
  expect(res.extensions).toEqual(['pinned', 'unpinned']);
  for (const n of ['pinned', 'unpinned']) {
    expect(fs.existsSync(path.join(out, 'extensions', n, 'package.json'))).toBe(true);
    expect(fs.existsSync(path.join(out, 'extensions', n, 'node_modules'))).toBe(false);
  }
  expect(fs.readFileSync(path.join(out, 'extensions', 'pinned', 'bun.lock'), 'utf8')).toContain('lockfileVersion');
  expect(res.warnings.length).toBe(1);
  expect(res.warnings[0]).toContain('"unpinned"');
  expect(res.warnings[0]).toContain('no bun.lock');
  expect(fs.readFileSync(path.join(out, 'README.md'), 'utf8')).toContain('no bun.lock');
}, 60_000);
