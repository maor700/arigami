// EXT3 — an extension tab is served under CSP `sandbox` (opaque origin), so
// every sub-resource it fetches is a cross-site request that carries NO
// SameSite=Lax session cookie. Before the fix `<script src="/__ext-sdk.js">`
// came back 401, `window.arigami` never existed and the tab's buttons stayed
// disabled forever. The cure mirrors the artifact asset tokens (F5): the SDK
// is a public path, and the entry HTML gets a `<base>` routed through a
// `~t/<token>/` capability bound to that one extension.
//
// Over real HTTP, with auth ON, in a child with its own ARIGAMI_DIR (_child.js).
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInChild } from './_child.js';
import { parseExtUrl, EXT_CSP } from '../server/ext-serve.ts';
import { injectBase, rewriteBaseForToken, rewriteAbsoluteRefs, stripTokenSegment } from '../server/lib/asset-base.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-ext3-'));

// A tab extension whose page has exactly the sub-resources that used to 401:
// the host SDK (root-absolute), its own script/stylesheet (relative), an image
// in a sub-directory, and a root-absolute reference to its own mount.
function makeExt(dir, name = 'hello') {
  const root = path.join(dir, 'user', 'extensions', name);
  fs.mkdirSync(path.join(root, 'ui', 'img'), { recursive: true });
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({
    name, version: '1.0.0', apiVersion: 1, title: 'Hello',
    tabs: [{ id: 'main', title: 'Hello', entry: 'ui/index.html' }],
  }, null, 2));
  fs.writeFileSync(path.join(root, 'ui', 'index.html'),
    '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="style.css"></head>' +
    '<body><img src="img/x.png"><a href="/__ext/' + name + '/page.html">abs</a>' +
    '<script src="/__ext-sdk.js"></script><script src="app.js"></script></body></html>');
  fs.writeFileSync(path.join(root, 'ui', 'style.css'), 'body{color:red}');
  fs.writeFileSync(path.join(root, 'ui', 'app.js'), 'window.__ok=1');
  fs.writeFileSync(path.join(root, 'ui', 'page.html'), '<!doctype html><html><head></head><body>page</body></html>');
  fs.writeFileSync(path.join(root, 'ui', 'img', 'x.png'), Buffer.alloc(8, 3));
  return root;
}

// A directory under user/extensions that declares NO tab — must stay unreadable.
function makeTabless(dir, name = 'notab') {
  const root = path.join(dir, 'user', 'extensions', name);
  fs.mkdirSync(path.join(root, 'ui'), { recursive: true });
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ name, version: '1.0.0', apiVersion: 1, title: 'No tab' }));
  fs.writeFileSync(path.join(root, 'ui', 'index.html'), '<!doctype html>secret');
  return root;
}

const BODY = `
  const http=await import('node:http');const fs=await import('node:fs');const path=await import('node:path');
  const es=await import('./server/ext-serve.ts');
  const {auth}=await import('./server/auth.ts');auth.setExtGate(es.shareGate);
  const {shareTokens}=await import('./server/share-token.ts');
  const ext=await import('./server/extensions.ts');
  await ext.reload({reason:'test'});
  // the same resolver index.ts installs: loaded + enabled + declares a tab
  es.setResolver((name)=>{const e=ext.getExtension(name);
    if(!e||e.state!=='loaded'||!(e.manifest&&e.manifest.tabs||[]).length)return null;
    return path.join(e.dir,'ui');});
  const SDK=path.join(process.cwd(),'sdk','browser','ext-sdk.js');
  const srv=http.createServer((req,res)=>{
    if(auth.gate(req,res))return;
    const p=(req.url||'/').split('?')[0];
    if(p==='/__ext-sdk.js'){const b=fs.readFileSync(SDK);res.writeHead(200,{'content-type':'application/javascript; charset=utf-8','cache-control':'public, max-age=3600',etag:'W/"x"'});res.end(b);return;}
    if(p.startsWith('/__api')){res.writeHead(200);res.end('api');return;}
    if(es.serve(req,res))return;
    res.writeHead(404);res.end();
  });
  await new Promise(r=>srv.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+srv.address().port;
  const get=async(p,h={})=>{const r=await fetch(base+p,{redirect:'manual',headers:h});
    return {status:r.status,body:await r.text(),csp:r.headers.get('content-security-policy'),ct:r.headers.get('content-type'),cc:r.headers.get('cache-control'),etag:r.headers.get('etag'),loc:r.headers.get('location')};};
  const raw=(p)=>new Promise((ok)=>{http.get({host:'127.0.0.1',port:srv.address().port,path:p},(r)=>{r.resume();r.on('end',()=>ok(r.statusCode));});});
  const AUTH={authorization:'Bearer '+auth.hostToken};
  const out={mode:auth.publicInfo().authMode};

  // 1. the SDK is public — this is the request that used to 401
  out.sdk=await get('/__ext-sdk.js');
  // 2. the entry itself still needs a principal
  out.entryAnon=(await get('/__ext/hello/')).status;
  // 3. authenticated entry → tokenized <base>
  out.entry=await get('/__ext/hello/',AUTH);
  const m=/<base href="\\/__ext\\/hello\\/~t\\/([^/]+)\\/">/.exec(out.entry.body);
  out.baseMatch=!!m;const tok=m&&m[1];
  out.absRewritten=out.entry.body.includes('href="/__ext/hello/~t/'+tok+'/page.html"');
  out.sdkRefUntouched=out.entry.body.includes('src="/__ext-sdk.js"');
  out.entry2=await get('/__ext/hello/',AUTH);out.sameTok=out.entry2.body.includes(tok);
  const T='/__ext/hello/~t/'+tok+'/';
  // 4. every sub-resource loads with NO auth at all
  out.css=await get(T+'style.css');out.js=(await get(T+'app.js')).status;out.png=(await get(T+'img/x.png')).status;
  out.reload=await get(T);
  out.reloadKeepsTok=out.reload.body.includes('~t/'+tok+'/');
  // 5. a nested HTML gets a <base> for ITS directory
  out.nested=await get(T+'page.html');
  // 6. the token is a capability for ONE extension and nothing else
  out.tokApi=(await get('/__api/sessions?t='+tok)).status;
  out.otherExt=(await get('/__ext/notab/~t/'+tok+'/index.html')).status;
  out.tablessAuthed=(await get('/__ext/notab/',AUTH)).status;
  const flip=(s,i)=>s.slice(0,i)+(s[i]==='A'?'B':'A')+s.slice(i+1);
  out.forged=(await get('/__ext/hello/~t/'+flip(tok,tok.indexOf('.')+3)+'/style.css')).status;
  out.garbage=(await get('/__ext/hello/~t/nope/style.css')).status;
  // 7. traversal is still refused, tokenized or not
  out.traversal=await raw(T+'../../../config.json');
  out.traversalEnc=await raw(T+'%2e%2e/%2e%2e/share-secret');
  out.traversalAuthed=(await get('/__ext/hello/../../config.json',AUTH)).status;
  // 8. /__ext/<name> (no slash) → redirect that keeps the token
  out.noSlash=await get('/__ext/hello',AUTH);
  // 9. expiry
  const st=shareTokens();const dead=st.sign({kind:'extension',id:'hello',days:0.00001,scope:'assets'});
  await new Promise(r=>setTimeout(r,1200));
  out.expired=(await get('/__ext/hello/~t/'+dead.token+'/style.css')).status;
  // 10. disabling the extension kills its live token immediately
  await ext.patchExtension('hello',{enabled:false});
  await ext.reload({reason:'test-disable'});
  out.afterDisable=(await get(T+'style.css')).status;
  out.afterDisableEntry=(await get('/__ext/hello/',AUTH)).status;
  srv.close();emit(out);
`;

test('EXT3: the SDK is public; a sandboxed tab loads its own assets through an extension-scoped token; forged/expired/other-ext/disabled → 401; traversal → 403', () => {
  const dir = tmp();
  makeExt(dir);
  makeTabless(dir);
  const r = runInChild(BODY, {
    ARIGAMI_DIR: dir,
    ARIGAMI_PORT: '',
    ARIGAMI_STATE_FILE: path.join(dir, 'state.json'),
    ARIGAMI_CHAT_DIR: path.join(dir, 'chat'),
  });
  if (!r.ok) throw new Error(r.error);
  const o = r.out[0];

  // auth really is on — otherwise every assertion below is vacuous
  expect(o.mode).toBe('pairing');

  // 1/2 — the public SDK, and an entry that still demands a principal
  expect(o.sdk.status).toBe(200);
  expect(o.sdk.ct).toContain('javascript');
  expect(o.sdk.cc).toContain('max-age=3600');
  expect(o.sdk.etag).toBeTruthy();
  expect(o.entryAnon).toBe(401);

  // 3 — the authenticated entry carries a tokenized <base>, stable across loads
  expect(o.entry.status).toBe(200);
  expect(o.baseMatch).toBe(true);
  expect(o.entry.csp).toContain('sandbox allow-scripts');
  expect(o.entry.csp).not.toContain('allow-same-origin');
  expect(o.absRewritten).toBe(true);
  expect(o.sdkRefUntouched).toBe(true); // the SDK is public — never tokenized
  expect(o.sameTok).toBe(true);

  // 4 — this is the bug: sub-resources now load with no cookie and no bearer
  expect(o.css.status).toBe(200);
  expect(o.css.ct).toContain('text/css');
  expect(o.css.csp).toContain('sandbox');
  expect(o.js).toBe(200);
  expect(o.png).toBe(200);
  expect(o.reload.status).toBe(200);
  expect(o.reloadKeepsTok).toBe(true);

  // 5 — a nested page resolves relative URLs against its own directory
  expect(o.nested.status).toBe(200);
  expect(o.nested.body).toContain('<base href="/__ext/hello/~t/');

  // 6 — scope: not /__api, not another extension, not a forgery
  expect(o.tokApi).toBe(401);
  expect(o.otherExt).toBe(401);
  expect(o.tablessAuthed).toBe(404); // a tabless dir stays unreadable even authenticated
  expect(o.forged).toBe(401);
  expect(o.garbage).toBe(401);

  // 7 — traversal
  expect(o.traversal).toBe(403);
  expect(o.traversalEnc).toBe(403);
  expect(o.traversalAuthed).toBe(404); // normalized away by fetch before it ships

  // 8 — the trailing-slash redirect keeps the query
  expect(o.noSlash.status).toBe(302);
  expect(o.noSlash.loc).toBe('/__ext/hello/');

  // 9/10 — a dead token, and a token whose extension was disabled
  expect(o.expired).toBe(401);
  expect(o.afterDisable).toBe(401);
  expect(o.afterDisableEntry).toBe(404);
});


// ---------------------------------------------------------------------------
// the pure pieces, in-process
// ---------------------------------------------------------------------------
test('parseExtUrl: splits the name, the ~t/ token and the rest; ?t= works too', () => {
  expect(parseExtUrl('/__ext/hello/')).toMatchObject({ name: 'hello', rel: '/', token: null, hadTrailing: true });
  expect(parseExtUrl('/__ext/hello')).toMatchObject({ name: 'hello', rel: '', token: null, hadTrailing: false });
  expect(parseExtUrl('/__ext/hello/~t/TOK/')).toMatchObject({ name: 'hello', rel: '/', token: 'TOK' });
  expect(parseExtUrl('/__ext/hello/~t/TOK/img/x.png')).toMatchObject({ name: 'hello', rel: '/img/x.png', token: 'TOK' });
  expect(parseExtUrl('/__ext/hello/style.css?t=TOK')).toMatchObject({ name: 'hello', rel: '/style.css', token: 'TOK', query: '?t=TOK' });
  // a ~t segment beats a query token, and an empty one is not a token
  expect(parseExtUrl('/__ext/hello/~t/A/x?t=B')).toMatchObject({ token: 'A', rel: '/x' });
  expect(parseExtUrl('/__ext/hello/~t/')).toMatchObject({ rel: '/~t/', token: null });
  expect(parseExtUrl('/__artifacts/a/')).toBe(null);
  expect(parseExtUrl('/__ext-sdk.js')).toBe(null);
});

test('EXT_CSP sandboxes without allow-same-origin — that is the whole reason the token exists', () => {
  expect(EXT_CSP).toContain('sandbox allow-scripts allow-forms allow-popups');
  expect(EXT_CSP).not.toContain('allow-same-origin');
});

test('the shared base/ref rewriters are prefix-scoped and idempotent', () => {
  const html = '<html><head><base href="./"></head><body><img src="/__ext/a/x.png"><img src="/__ext/ab/y.png"></body></html>';
  const once = rewriteAbsoluteRefs(rewriteBaseForToken(injectBase(html, '/__ext/a/'), '/__ext/a/', 'T'), '/__ext/a/', 'T');
  expect(once).toContain('<base href="/__ext/a/~t/T/">');
  expect(once).toContain('src="/__ext/a/~t/T/x.png"');
  expect(once).toContain('src="/__ext/ab/y.png"'); // a different extension, untouched
  expect(rewriteAbsoluteRefs(rewriteBaseForToken(once, '/__ext/a/', 'T'), '/__ext/a/', 'T')).toBe(once);
  expect(stripTokenSegment('/~t/T/a/b')).toEqual({ rel: '/a/b', token: 'T' });
  expect(stripTokenSegment('/a/b')).toEqual({ rel: '/a/b', token: null });
});
