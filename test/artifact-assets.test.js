// F5 — sandboxed artifact documents (opaque origin, no cookie on sub-requests)
// load their own assets through a host-minted, artifact-scoped 24h token in
// `<base href="/__artifacts/<id>/~t/<token>/v<N>/">`. Over real HTTP in a
// child with its own ARIGAMI_DIR (see _child.js).
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInChild } from './_child.js';

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

function makeSite(root) {
  fs.mkdirSync(path.join(root, 'img'), { recursive: true });
  fs.writeFileSync(path.join(root, 'index.html'),
    '<!doctype html><html><head><base href="https://example.invalid/built/" target="_top"><link rel="stylesheet" href="style.css"></head>' +
    '<body><img src="./a.png"><img src="img/x.png"><script src="app.js"></script><a href="/__artifacts/__AID__/v1/doc.txt">abs</a></body></html>');
  fs.writeFileSync(path.join(root, 'style.css'), 'body{color:red}');
  fs.writeFileSync(path.join(root, 'app.js'), 'console.log(1)');
  fs.writeFileSync(path.join(root, 'a.png'), Buffer.alloc(10, 1));
  fs.writeFileSync(path.join(root, 'img', 'x.png'), Buffer.alloc(10, 2));
  fs.writeFileSync(path.join(root, 'doc.txt'), 'doc');
}

const BODY = (src) => `
  const http=await import('node:http');const fs=await import('node:fs');
  const state=await import('./server/state.ts');const art=await import('./server/artifacts.ts');
  const {auth}=await import('./server/auth.ts');auth.setShareGate(art.shareGate);
  const {shareTokens}=await import('./server/share-token.ts');
  const s=state.createSession({title:'t',cwd:${JSON.stringify(src)}});
  const a=art.publish(s.id,{path:'.',title:'Site'});const aid=a.artifact.id;
  // the abs-ref placeholder needs the real id → patch the snapshot in place (v1)
  const entry=art.artifactFilePath(aid,'/').file;fs.writeFileSync(entry,fs.readFileSync(entry,'utf8').replace('__AID__',aid));
  const b=art.publish(s.id,{path:'a.png',title:'Other'});const bid=b.artifact.id;
  const srv=http.createServer((req,res)=>{if(auth.gate(req,res))return;if(req.url.startsWith('/__api')){res.writeHead(200);res.end('api');return;}if(art.serve(req,res))return;res.writeHead(404);res.end();});
  await new Promise(r=>srv.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+srv.address().port;
  const get=async(p,h={})=>{const r=await fetch(base+p,{redirect:'manual',headers:h});return {status:r.status,body:await r.text(),cc:r.headers.get('cache-control'),ct:r.headers.get('content-type')};};
  const raw=(p)=>new Promise((ok)=>{http.get({host:'127.0.0.1',port:srv.address().port,path:p},(r)=>{r.resume();r.on('end',()=>ok(r.statusCode));});});
  const AUTH={authorization:'Bearer '+auth.hostToken};
  const out={};
  out.plainNoCookie=(await get('/__artifacts/'+aid+'/style.css')).status;
  out.entry=await get('/__artifacts/'+aid+'/',AUTH);
  const m=/<base href="\\/__artifacts\\/([^/]+)\\/~t\\/([^/]+)\\/v(\\d+)\\/"( target="_top")?>/.exec(out.entry.body);
  out.baseMatch=!!m;out.baseAid=m&&m[1];out.baseVer=m&&m[3];out.baseTarget=m&&m[4];const tok=m&&m[2];
  out.ownBaseGone=!out.entry.body.includes('example.invalid');
  out.absRewritten=out.entry.body.includes('href="/__artifacts/'+aid+'/~t/'+tok+'/v1/doc.txt"');
  out.entry2=await get('/__artifacts/'+aid+'/',AUTH);out.sameTok=out.entry2.body.includes(tok);
  const T='/__artifacts/'+aid+'/~t/'+tok+'/';
  out.css=await get(T+'v1/style.css');out.png1=(await get(T+'v1/a.png')).status;out.png2=(await get(T+'v1/img/x.png')).status;out.js=(await get(T+'v1/app.js')).status;
  out.bare=(await get(T+'style.css')).status;
  out.reload=await get(T);
  out.tokApi=(await get('/__api/sessions?t='+tok)).status;
  out.otherArt=(await get('/__artifacts/'+bid+'/~t/'+tok+'/')).status;
  out.otherArtQ=(await get('/__artifacts/'+bid+'/?t='+tok)).status;
  const flip=(s,i)=>s.slice(0,i)+(s[i]==='A'?'B':'A')+s.slice(i+1);
  out.forged=(await get('/__artifacts/'+aid+'/~t/'+flip(tok,tok.indexOf('.')+3)+'/v1/style.css')).status;
  out.garbage=(await get('/__artifacts/'+aid+'/~t/nope/v1/style.css')).status;
  out.traversal=await raw(T+'v1/../../../config.json');
  out.traversalEnc=await raw(T+'v1/%2e%2e/%2e%2e/share-secret');
  // expiry: a token minted by a clock that already passed 24h
  const st=shareTokens();const dead=st.sign({kind:'artifact',id:aid,days:0.00001,scope:'assets'});
  await new Promise(r=>setTimeout(r,1200));
  out.expired=(await get('/__artifacts/'+aid+'/~t/'+dead.token+'/v1/style.css')).status;
  // asset tokens are internal: not in the share list; unshare() leaves them alone
  const sh=art.share(s.id,aid,{days:2});
  out.listed=art.listShares(aid).length;out.adminList=st.list().filter(x=>x.id===aid).length;
  out.shareEntry=await get(sh.path);out.sharePinned=/~t\\/[^/]+\\/v1\\/"/.test(out.shareEntry.body)&&!out.shareEntry.body.includes(tok);
  out.unshare=art.unshare(s.id,aid).revoked;out.afterUnshare=(await get(T+'v1/style.css')).status;
  // v2: the asset token is per artifact, any version
  fs.writeFileSync(${JSON.stringify(src)}+'/index.html','<!doctype html><html><head></head><body>v2<img src="a.png"></body></html>');
  art.publish(s.id,{path:'.',title:'Site'});
  out.entryV2=await get('/__artifacts/'+aid+'/',AUTH);out.v2SameTok=out.entryV2.body.includes('~t/'+tok+'/v2/');
  out.v1ViaTok=(await get(T+'v1/style.css')).status;out.v2ViaTok=(await get(T+'v2/a.png')).status;
  // artifact removed → its asset token dies with it
  art.remove(s.id,aid);out.afterRemove=(await get(T+'v1/style.css')).status;
  out.revokedFile=JSON.parse(fs.readFileSync(st.files.revokedFile,'utf8'));
  srv.close();emit(out);
`;

test('F5: authenticated entry gets a tokenized <base>; assets load cookie-less; token scoped to that artifact; forged/expired/other → 401; traversal 403', () => {
  const src = tmp('f5-src-');
  makeSite(src);
  const dir = tmp('f5-home-');
  const r = runInChild(BODY(src), { ARIGAMI_DIR: dir, ARIGAMI_PORT: '3497', ARIGAMI_AUTH: 'pairing' });
  expect(r.ok).toBe(true);
  const o = r.out[0];
  expect(o.plainNoCookie).toBe(401);             // the bug: plain asset path, no cookie
  expect(o.entry.status).toBe(200);
  expect(o.baseMatch).toBe(true);                // <base> routed through ~t/<token>/
  expect(o.baseVer).toBe('1');
  expect(o.baseTarget).toBe(' target="_top"');   // the document's own target survives the override
  expect(o.ownBaseGone).toBe(true);              // the document's own href does not
  expect(o.absRewritten).toBe(true);             // root-absolute /__artifacts/<id>/… refs tokenized too
  expect(o.sameTok).toBe(true);                  // cached per artifact, not re-minted per request
  expect(o.css.status).toBe(200);                // relative assets, no cookie, no bearer
  expect(o.css.ct).toContain('text/css');
  expect(o.css.cc).toContain('immutable');
  expect(o.png1).toBe(200);
  expect(o.png2).toBe(200);
  expect(o.js).toBe(200);
  expect(o.bare).toBe(200);                      // no v<N>/ → current version
  expect(o.reload.status).toBe(200);             // the tokenized entry itself (reload in a window)
  expect(o.reload.body).toContain('/~t/');
  expect(o.tokApi).toBe(401);                    // token grants no API
  expect(o.otherArt).toBe(401);                  // A's token never opens B
  expect(o.otherArtQ).toBe(401);
  expect(o.forged).toBe(401);
  expect(o.garbage).toBe(401);
  expect(o.traversal).toBe(403);
  expect(o.traversalEnc).toBe(403);
  expect(o.expired).toBe(401);
  expect(o.listed).toBe(1);                      // share list shows the share link only
  expect(o.adminList).toBe(1);
  expect(o.shareEntry.status).toBe(200);
  expect(o.sharePinned).toBe(true);              // share links keep their own pinned token
  expect(o.unshare).toBe(1);                     // unshare revokes the link, not the asset token
  expect(o.afterUnshare).toBe(200);
  expect(o.v2SameTok).toBe(true);
  expect(o.v1ViaTok).toBe(200);
  expect(o.v2ViaTok).toBe(200);
  expect(o.afterRemove).toBe(401);
  expect(Object.keys(o.revokedFile).length).toBeGreaterThanOrEqual(2); // link + asset token
});
