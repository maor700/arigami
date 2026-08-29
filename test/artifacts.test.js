// A1 published artifacts: copy with exclusions/symlink refusal, size cap,
// versioning on re-publish, <base href> injection, traversal-guarded serving
// path, retention sweep. Pure helpers run in-process; anything touching
// state/config runs in a child with its own ARIGAMI_DIR (see _child.js).
import { test, expect, describe } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { walkSource, injectBase, scanHtmlWarnings, sweepArtifactsDir, ARTIFACT_CSP, MIME } from '../server/artifacts.ts';
import { runInChild } from './_child.js';

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

function makeSite(root) {
  fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules', 'x'), { recursive: true });
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><html><head><title>t</title></head><body><img src="./assets/a.png"><script src="./assets/app.js"></script></body></html>');
  fs.writeFileSync(path.join(root, 'assets', 'app.js'), 'console.log(1)');
  fs.writeFileSync(path.join(root, 'assets', 'a.png'), Buffer.alloc(100, 1));
  fs.writeFileSync(path.join(root, 'node_modules', 'x', 'i.js'), 'nope');
  fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref');
  fs.writeFileSync(path.join(root, '.env'), 'SECRET=1');
  fs.writeFileSync(path.join(root, '.env.local'), 'SECRET=2');
  try { fs.symlinkSync('/etc/passwd', path.join(root, 'passwd-link')); } catch {}
  try { fs.symlinkSync(os.homedir(), path.join(root, 'home-link')); } catch {}
}

describe('walkSource', () => {
  test('skips node_modules, .git, .env*, and never follows symlinks', () => {
    const root = tmp('art-src-');
    makeSite(root);
    const rels = walkSource(root).map((e) => e.rel).sort();
    expect(rels).toEqual(['assets/a.png', 'assets/app.js', 'index.html']);
  });
});

describe('injectBase / scanHtmlWarnings', () => {
  test('adds <base> after <head> only when missing', () => {
    expect(injectBase('<html><head><title>x</title></head></html>', '/__artifacts/a/v1/')).toBe('<html><head><base href="/__artifacts/a/v1/"><title>x</title></head></html>');
    const has = '<html><head><base href="./"></head></html>';
    expect(injectBase(has, '/x/')).toBe(has);
    expect(injectBase('<p>hi</p>', '/x/')).toBe('<base href="/x/"><p>hi</p>');
  });
  test('warns on root-absolute urls and fetch("/…")', () => {
    expect(scanHtmlWarnings('<script src="/assets/x.js"></script>').length).toBe(1);
    expect(scanHtmlWarnings('<script>fetch("/__api/sessions")</script>').length).toBe(1);
    expect(scanHtmlWarnings('<script src="./x.js"></script><a href="//cdn/x">')).toEqual([]);
  });
  test('CSP sandbox has no allow-same-origin; MIME covers spec extras', () => {
    expect(ARTIFACT_CSP.startsWith('sandbox allow-scripts allow-forms allow-popups;')).toBe(true);
    expect(ARTIFACT_CSP).not.toContain('allow-same-origin');
    for (const e of ['.webp', '.mp4', '.wasm', '.pdf']) expect(MIME[e]).toBeTruthy();
  });
});

describe('sweepArtifactsDir', () => {
  test('drops expired old versions, keeps the newest, removes fully-expired artifacts', () => {
    const root = tmp('art-sweep-');
    const now = Date.now();
    const mk = (sid, aid, v, ageMs) => {
      const d = path.join(root, sid, aid, `v${v}`);
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'index.html'), 'x');
      const t = new Date(now - ageMs);
      fs.utimesSync(d, t, t);
    };
    mk('s1', 'a', 1, 40 * 86400e3); // old version, artifact alive → removed
    mk('s1', 'a', 2, 1 * 86400e3);   // newest → kept
    mk('s1', 'b', 1, 45 * 86400e3);  // whole artifact expired → removed
    const gone = [];
    const r = sweepArtifactsDir(root, 30 * 86400e3, now, (sid, aid) => gone.push(`${sid}/${aid}`));
    expect(r).toEqual({ removedVersions: 1, removedArtifacts: 1 });
    expect(fs.existsSync(path.join(root, 's1', 'a', 'v1'))).toBe(false);
    expect(fs.existsSync(path.join(root, 's1', 'a', 'v2'))).toBe(true);
    expect(fs.existsSync(path.join(root, 's1', 'b'))).toBe(false);
    expect(gone).toEqual(['s1/b']);
  });
});

// ---- stateful: publish / versions / traversal / size cap (own ARIGAMI_DIR) ----

const PUBLISH_BODY = (src) => `
  const fs=await import('node:fs');const path=await import('node:path');
  const state=await import('./server/state.ts');const art=await import('./server/artifacts.ts');
  const s=state.createSession({title:'t',cwd:${JSON.stringify(src)}});
  const r1=art.publish(s.id,{path:'.',title:'Report'});
  const r2=art.publish(s.id,{path:${JSON.stringify(src)},title:'Report again'});
  const a=r2.artifact;
  const list=(v,rel)=>fs.readdirSync(path.join(art.ARTIFACTS_DIR,s.id,a.id,'v'+v,rel||'')).sort();
  const html=fs.readFileSync(path.join(art.ARTIFACTS_DIR,s.id,a.id,'v2','index.html'),'utf8');
  const fp=(rel)=>{const h=art.artifactFilePath(a.id,rel);return h?{file:h.file.slice(art.ARTIFACTS_DIR.length),version:h.version}:null;};
  emit({
    sameId:r1.artifact.id===a.id, v1:r1.artifact.version, v2:a.version, path:a.path, files:a.files, bytes:a.bytes,
    v1root:list(1), v2assets:list(2,'assets'), html, warnings:r2.warnings,
    inState:state.getSession(s.id).artifacts.length,
    root:fp(''), pinned:fp('v1/'), pinnedAsset:fp('v1/assets/app.js'), current:fp('assets/app.js'),
    trav1:fp('../../config.json'), trav2:fp('v2/../../x'), missing:fp('nope.html'), dot:fp('./index.html'),
    single:(()=>{const r=art.publish(s.id,{path:'assets/app.js',title:'one file'});return {entry:r.artifact.entry,files:r.artifact.files,path:r.artifact.path};})(),
    envRefused:(()=>{try{art.publish(s.id,{path:'.env',title:'x'});return null;}catch(e){return e.status;}})(),
    notFound:(()=>{try{art.publish(s.id,{path:'does-not-exist',title:'x'});return null;}catch(e){return e.status;}})(),
    badEntry:(()=>{try{art.publish(s.id,{path:'.',title:'x',entry:'../index.html'});return null;}catch(e){return e.status;}})(),
    removed:art.remove(s.id,a.id), dirGone:!fs.existsSync(path.join(art.ARTIFACTS_DIR,s.id,a.id)),
  });
`;

test('publish: snapshot copy with exclusions, versioning, base injection, guarded file resolution', () => {
  const dir = tmp('art-home-');
  const src = tmp('art-site-');
  makeSite(src);
  const r = runInChild(PUBLISH_BODY(src), { ARIGAMI_DIR: dir, ARIGAMI_PORT: '3497' });
  expect(r.ok).toBe(true);
  const o = r.out[0];
  expect(o.sameId).toBe(true);
  expect(o.v1).toBe(1);
  expect(o.v2).toBe(2);
  expect(o.path).toMatch(/^\/__artifacts\/[A-Za-z0-9_-]+\/$/);
  expect(o.files).toBe(3);
  expect(o.v1root).toEqual(['assets', 'index.html']); // no node_modules/.git/.env*/symlinks
  expect(o.v2assets).toEqual(['a.png', 'app.js']);
  expect(o.html).toContain(`<head><base href="/__artifacts/`);
  expect(o.html).toContain('/v2/">');
  expect(o.warnings).toEqual([]);
  expect(o.inState).toBe(1);
  // resolution: root → entry of the CURRENT version; v1/ pins the old one
  expect(o.root.version).toBe(2);
  expect(o.root.file.endsWith('/v2/index.html')).toBe(true);
  expect(o.pinned.version).toBe(1);
  expect(o.pinnedAsset.file.endsWith('/v1/assets/app.js')).toBe(true);
  expect(o.current.file.endsWith('/v2/assets/app.js')).toBe(true);
  expect(o.trav1).toBeNull();
  expect(o.trav2).toBeNull();
  expect(o.missing).toBeNull();
  expect(o.dot).toBeNull();
  expect(o.single).toEqual({ entry: 'app.js', files: 1, path: expect.stringMatching(/^\/__artifacts\//) });
  expect(o.envRefused).toBe(400);
  expect(o.notFound).toBe(404);
  expect(o.badEntry).toBe(400);
  expect(o.removed).toBe(true);
  expect(o.dirGone).toBe(true);
  // ~/.ssh-style symlink content never landed in the snapshot tree
  const all = [];
  const walk = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.lstatSync(p).isDirectory()) walk(p); else all.push(f); } };
  walk(path.join(dir, 'uploads', 'artifacts'));
  expect(all).not.toContain('passwd-link');
  expect(all).not.toContain('.env');
});

test('publish: size cap → 413 with a clear message; state dir refused', () => {
  const dir = tmp('art-home-');
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ artifacts: { maxMb: 0.0001 } })); // ~100 bytes
  const src = tmp('art-site-');
  fs.writeFileSync(path.join(src, 'index.html'), '<html>' + 'x'.repeat(2000) + '</html>');
  const body = `
    const state=await import('./server/state.ts');const art=await import('./server/artifacts.ts');
    const s=state.createSession({title:'t',cwd:${JSON.stringify(src)}});
    let cap=null;try{art.publish(s.id,{path:'.',title:'big'});}catch(e){cap={status:e.status,msg:e.message};}
    let st=null;try{art.publish(s.id,{path:${JSON.stringify(dir)},title:'state'});}catch(e){st=e.status;}
    emit({cap,st});`;
  const r = runInChild(body, { ARIGAMI_DIR: dir, ARIGAMI_PORT: '3497' });
  expect(r.ok).toBe(true);
  expect(r.out[0].cap.status).toBe(413);
  expect(r.out[0].cap.msg).toMatch(/too large/);
  expect(r.out[0].st).toBe(403);
});
