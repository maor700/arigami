// EXT — the TRUSTED tier: an extension whose tab is served WITHOUT the CSP
// sandbox, so it is same-origin with the cockpit (it keeps the session cookie
// and can use the host proxy's service worker).
//
// The property under test is that the tier takes TWO yeses: `"trusted": true`
// in the manifest AND a grant recorded in $ARIGAMI_DIR/extensions.json. A
// manifest alone escalates nothing, so a `git pull` into an installed extension
// cannot quietly move it into the cockpit's origin.
//
// Over real HTTP with auth ON, in a child with its own ARIGAMI_DIR — the same
// shape as test/ext-assets.test.js.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInChild } from './_child.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-ext-trust-'));

/** Two extensions: one asks for the tier, one does not. */
function makeExts(dir: string) {
  const mk = (name: string, extra: Record<string, unknown>) => {
    const root = path.join(dir, 'user', 'extensions', name);
    fs.mkdirSync(path.join(root, 'ui'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'manifest.json'),
      JSON.stringify({ name, version: '1.0.0', apiVersion: 1, title: name, tabs: [{ id: 'main', title: name, entry: 'ui/index.html' }], ...extra }, null, 2)
    );
    fs.writeFileSync(
      path.join(root, 'ui', 'index.html'),
      '<!doctype html><html><head><link rel="stylesheet" href="style.css"></head>' +
        '<body><a href="/__ext/' + name + '/page.html">abs</a><script src="/__ext-sdk.js"></script></body></html>'
    );
    fs.writeFileSync(path.join(root, 'ui', 'style.css'), 'body{color:red}');
    fs.writeFileSync(path.join(root, 'ui', 'page.html'), '<!doctype html><html><body>page</body></html>');
  };
  mk('trusty', { trusted: true });
  mk('plain', {});
}

const BODY = `
  const http=await import('node:http');const fs=await import('node:fs');const path=await import('node:path');
  const es=await import('./server/ext-serve.ts');
  const {auth}=await import('./server/auth.ts');auth.setExtGate(es.shareGate);
  const ext=await import('./server/extensions.ts');
  await ext.reload({reason:'test'});
  // exactly the two resolvers server/index.ts installs
  es.setResolver((name)=>{const e=ext.getExtension(name);
    if(!e||e.state!=='loaded'||!(e.manifest&&e.manifest.tabs||[]).length)return null;
    return path.join(e.dir,'ui');});
  es.setTrustResolver((name)=>ext.getExtension(name)?.trusted===true);
  const SDK=path.join(process.cwd(),'sdk','browser','ext-sdk.js');
  const srv=http.createServer((req,res)=>{
    if(auth.gate(req,res))return;
    const p=(req.url||'/').split('?')[0];
    if(p==='/__ext-sdk.js'){res.writeHead(200,{'content-type':'application/javascript'});res.end(fs.readFileSync(SDK));return;}
    if(es.serve(req,res))return;
    res.writeHead(404);res.end();
  });
  await new Promise(r=>srv.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+srv.address().port;
  const get=async(p,h={})=>{const r=await fetch(base+p,{redirect:'manual',headers:h});
    return {status:r.status,body:await r.text(),csp:r.headers.get('content-security-policy')};};
  const AUTH={authorization:'Bearer '+auth.hostToken};
  const view=(n)=>ext.listExtensions().find(e=>e.name===n);
  const out={mode:auth.publicInfo().authMode};

  // 1. manifest asks, state file has NOT granted → still sandboxed, and it says so
  out.beforeEntry=await get('/__ext/trusty/',AUTH);
  out.beforeView=view('trusty');
  out.beforeWarn=(out.beforeView.warnings||[]).join(' | ');

  // 2. grant it — the tier flips with no reinstall and no restart
  await ext.patchExtension('trusty',{trusted:true});
  out.afterEntry=await get('/__ext/trusty/',AUTH);
  out.afterView=view('trusty');
  out.stateFile=JSON.parse(fs.readFileSync(path.join(process.env.ARIGAMI_DIR,'extensions.json'),'utf8'));
  // a trusted page keeps the cookie, so its own assets need no token at all
  out.trustedCss=await get('/__ext/trusty/style.css',AUTH);
  out.trustedCssAnon=(await get('/__ext/trusty/style.css')).status;

  // 3. the extension that never asked is untouched by any of this
  out.plainEntry=await get('/__ext/plain/',AUTH);
  out.plainView=view('plain');
  const m=/<base href="\\/__ext\\/plain\\/~t\\/([^/]+)\\/">/.exec(out.plainEntry.body);
  out.plainTokenized=!!m;
  out.plainAssetNoAuth=m?(await get('/__ext/plain/~t/'+m[1]+'/style.css')).status:0;
  // granting trust to a manifest that does not ask for it changes nothing
  await ext.patchExtension('plain',{trusted:true});
  out.plainAfterGrant=view('plain');
  out.plainEntryAfterGrant=(await get('/__ext/plain/',AUTH)).csp;

  // 4. revoking puts the sandbox back
  await ext.patchExtension('trusty',{trusted:false});
  out.revokedEntry=await get('/__ext/trusty/',AUTH);
  out.revokedView=view('trusty');

  // 5. add --trust vs add without it, on a fresh copy of the same source
  const src=path.join(process.env.ARIGAMI_DIR,'src-trusty');
  fs.cpSync(path.join(process.env.ARIGAMI_DIR,'user','extensions','trusty'),src,{recursive:true});
  const mf=JSON.parse(fs.readFileSync(path.join(src,'manifest.json'),'utf8'));
  mf.name='trusty2';fs.writeFileSync(path.join(src,'manifest.json'),JSON.stringify(mf));
  out.addNoTrust=await ext.addExtension(src);
  out.addNoTrustView=view('trusty2');
  await ext.removeExtension('trusty2');
  out.addTrust=await ext.addExtension(src,{trust:true});
  out.addTrustView=view('trusty2');

  srv.close();emit(out);
`;

test('the trusted tier needs BOTH the manifest and the state file; a manifest alone stays sandboxed', () => {
  const dir = tmp();
  makeExts(dir);
  const r = runInChild(BODY, {
    ARIGAMI_DIR: dir,
    ARIGAMI_PORT: '',
    ARIGAMI_STATE_FILE: path.join(dir, 'state.json'),
    ARIGAMI_CHAT_DIR: path.join(dir, 'chat'),
  });
  if (!r.ok) throw new Error(r.error);
  const o = r.out[0] as any;

  // auth really is on — otherwise the cookie-less assertions are vacuous
  expect(o.mode).toBe('pairing');

  // 1 — the manifest asked and nothing else did: sandboxed, tier reported, warned
  expect(o.beforeEntry.status).toBe(200);
  expect(o.beforeEntry.csp).toContain('sandbox allow-scripts');
  expect(o.beforeEntry.csp).not.toContain('allow-same-origin');
  expect(o.beforeView.tier).toBe('sandboxed');
  expect(o.beforeView.trusted).toBe(false);
  expect(o.beforeView.trustRequested).toBe(true);
  expect(o.beforeWarn).toContain('TRUSTED');
  // sandboxed → the entry still routes its own assets through the token
  expect(o.beforeEntry.body).toContain('/__ext/trusty/~t/');

  // 2 — granted: no CSP sandbox header at all, no token in the HTML, and the
  // assets are ordinary same-origin requests again
  expect(o.afterEntry.status).toBe(200);
  expect(o.afterEntry.csp).toBe(null);
  expect(o.afterEntry.body).toContain('<base href="/__ext/trusty/">');
  expect(o.afterEntry.body).not.toContain('~t/');
  expect(o.afterEntry.body).toContain('href="/__ext/trusty/page.html"'); // not rewritten
  expect(o.afterView.tier).toBe('trusted');
  expect(o.afterView.trusted).toBe(true);
  expect(o.afterView.warnings).toEqual([]);
  expect(o.stateFile.trusted).toEqual({ trusty: true });
  expect(o.trustedCss.status).toBe(200);
  expect(o.trustedCss.csp).toBe(null);
  expect(o.trustedCssAnon).toBe(401); // trusted is not public — it is same-ORIGIN

  // 3 — a sandboxed extension is unaffected, and a grant it never asked for is inert
  expect(o.plainEntry.csp).toContain('sandbox allow-scripts');
  expect(o.plainView.tier).toBe('sandboxed');
  expect(o.plainView.trustRequested).toBe(false);
  expect(o.plainTokenized).toBe(true);
  expect(o.plainAssetNoAuth).toBe(200); // EXT3: tokenized assets still work
  expect(o.plainAfterGrant.tier).toBe('sandboxed');
  expect(o.plainAfterGrant.trusted).toBe(false);
  expect(o.plainEntryAfterGrant).toContain('sandbox allow-scripts');

  // 4 — revoke
  expect(o.revokedEntry.csp).toContain('sandbox allow-scripts');
  expect(o.revokedView.tier).toBe('sandboxed');
  expect(o.revokedView.trustRequested).toBe(true);

  // 5 — install-time grant is opt-in, never implied by the manifest
  expect(o.addNoTrust.trustRequested).toBe(true);
  expect(o.addNoTrust.trusted).toBe(false);
  expect(o.addNoTrustView.tier).toBe('sandboxed');
  expect(o.addTrust.trusted).toBe(true);
  expect(o.addTrustView.tier).toBe('trusted');
});
