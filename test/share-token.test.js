// K2 — server/share-token.ts (sign/verify/expiry/revoke/tamper/kind+id
// binding/secret handling) in-process against a tmp dir with a fake clock;
// the URL helpers of artifacts.ts in-process; and the real auth.gate +
// artifacts.serve path-scoping matrix over HTTP in a child with its own
// ARIGAMI_DIR (see _child.js).
import { test, expect, describe } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createShareTokens, clampDays } from '../server/share-token.ts';
import { rewriteAbsoluteRefs } from '../server/artifacts.ts';
import { parseArtifactUrl, rewriteBaseForShare } from '../server/artifacts.ts';
import { runInChild } from './_child.js';

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const DAY = 86_400_000;

function mk(over = {}) {
  let t = 1_800_000_000_000;
  const clock = { now: () => t, tick: (ms) => { t += ms; } };
  const st = createShareTokens({ dir: tmp('share-'), now: clock.now, ...over });
  return { st, clock };
}

describe('share-token: sign/verify', () => {
  test('round-trip, payload fields, default expiry 7d', () => {
    const { st, clock } = mk();
    const r = st.sign({ kind: 'artifact', id: 'abc', ver: 2, label: 'Report' });
    expect(r.token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(r.exp).toBe(clock.now() + 7 * DAY);
    const v = st.verify(r.token, { kind: 'artifact', id: 'abc' });
    expect(v.ok).toBe(true);
    expect(v.payload).toEqual({ kind: 'artifact', id: 'abc', exp: r.exp, nonce: r.nonce, ver: 2 });
    // registry lists nonce + meta, never the token
    const listed = st.list();
    expect(listed).toEqual([{ nonce: r.nonce, kind: 'artifact', id: 'abc', exp: r.exp, ver: 2, label: 'Report', createdAt: expect.any(String) }]);
    expect(fs.readFileSync(st.files.issuedFile, 'utf8')).not.toContain(r.token.split('.')[1]);
  });

  test('secret file is 0600, 32 bytes hex, reused across instances', () => {
    const dir = tmp('share-');
    const a = createShareTokens({ dir });
    const r = a.sign({ kind: 'artifact', id: 'x' });
    const mode = fs.statSync(path.join(dir, 'share-secret')).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(fs.readFileSync(path.join(dir, 'share-secret'), 'utf8').trim()).toMatch(/^[0-9a-f]{64}$/);
    const b = createShareTokens({ dir });
    expect(b.verify(r.token, { kind: 'artifact', id: 'x' }).ok).toBe(true);
  });

  test('expiry: valid until exp, dead after; custom days; clamp to maxDays', () => {
    const { st, clock } = mk({ maxDays: 10 });
    const r = st.sign({ kind: 'artifact', id: 'a', days: 3 });
    expect(r.exp).toBe(clock.now() + 3 * DAY);
    clock.tick(3 * DAY - 1);
    expect(st.verify(r.token, { kind: 'artifact', id: 'a' }).ok).toBe(true);
    clock.tick(1);
    const v = st.verify(r.token, { kind: 'artifact', id: 'a' });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('link expired');
    const big = st.sign({ kind: 'artifact', id: 'a', days: 500 });
    expect(big.exp).toBe(clock.now() + 10 * DAY);
    expect(clampDays(0, 90)).toBe(7);
    expect(clampDays('nope', 90)).toBe(7);
    expect(clampDays(120, 90)).toBe(90);
    expect(clampDays(2, 90)).toBe(2);
  });

  test('bound to kind + id: another artifact or a webhook token never opens it', () => {
    const { st } = mk();
    const a = st.sign({ kind: 'artifact', id: 'one' });
    expect(st.verify(a.token, { kind: 'artifact', id: 'two' }).ok).toBe(false);
    expect(st.verify(a.token, { kind: 'webhook', id: 'one' }).ok).toBe(false);
    const w = st.sign({ kind: 'webhook', id: 'sms' });
    expect(st.verify(w.token, { kind: 'webhook', id: 'sms' }).ok).toBe(true);
    expect(st.verify(w.token, { kind: 'artifact', id: 'sms' }).ok).toBe(false);
    expect(() => st.sign({ kind: 'nope', id: 'x' })).toThrow();
    expect(() => st.sign({ kind: 'artifact', id: '../x' })).toThrow();
  });

  test('tamper: flipped signature byte, flipped payload byte, garbage, missing parts → rejected before parse', () => {
    const { st } = mk();
    const { token } = st.sign({ kind: 'artifact', id: 'a' });
    const [p, sig] = token.split('.');
    const flip = (s, i) => s.slice(0, i) + (s[i] === 'A' ? 'B' : 'A') + s.slice(i + 1);
    expect(st.verify(`${p}.${flip(sig, 5)}`, { kind: 'artifact', id: 'a' }).reason).toBe('invalid signature');
    expect(st.verify(`${flip(p, 3)}.${sig}`, { kind: 'artifact', id: 'a' }).reason).toBe('invalid signature');
    // forged payload with a longer exp, same sig
    const forged = Buffer.from(JSON.stringify({ kind: 'artifact', id: 'a', exp: 9e15, nonce: 'z' })).toString('base64url');
    expect(st.verify(`${forged}.${sig}`, { kind: 'artifact', id: 'a' }).ok).toBe(false);
    for (const bad of ['', 'x', '.', 'a.', '.b', 'a.b.c', token + '.', 42, null, undefined, 'x'.repeat(3000)])
      expect(st.verify(bad, { kind: 'artifact', id: 'a' }).ok).toBe(false);
    // a different instance (different secret) never accepts it
    const { st: other } = mk();
    expect(other.verify(token, { kind: 'artifact', id: 'a' }).ok).toBe(false);
  });

  test('revoke one / revokeFor / revokeAll (secret rotation); revocation list GCs after expiry', () => {
    const { st, clock } = mk();
    const a1 = st.sign({ kind: 'artifact', id: 'a', days: 2 });
    const a2 = st.sign({ kind: 'artifact', id: 'a', days: 5 });
    const b = st.sign({ kind: 'artifact', id: 'b' });
    expect(st.revoke(a1.nonce)).toBe(true);
    expect(st.revoke(a1.nonce)).toBe(false);
    expect(st.verify(a1.token, { kind: 'artifact', id: 'a' }).reason).toBe('link revoked');
    expect(st.verify(a2.token, { kind: 'artifact', id: 'a' }).ok).toBe(true);
    expect(st.list().map((x) => x.nonce).sort()).toEqual([a2.nonce, b.nonce].sort());
    expect(st.revokeFor('artifact', 'a')).toBe(1);
    expect(st.verify(a2.token, { kind: 'artifact', id: 'a' }).ok).toBe(false);
    expect(st.verify(b.token, { kind: 'artifact', id: 'b' }).ok).toBe(true);
    expect(st.listFor('artifact', 'b').length).toBe(1);
    // the a1 entry disappears from share-revoked.json once it would have expired
    expect(Object.keys(JSON.parse(fs.readFileSync(st.files.revokedFile, 'utf8')))).toContain(a1.nonce);
    clock.tick(2 * DAY + 1);
    st.verify(b.token, { kind: 'artifact', id: 'b' });
    expect(Object.keys(JSON.parse(fs.readFileSync(st.files.revokedFile, 'utf8')))).not.toContain(a1.nonce);
    // rotate
    const before = fs.readFileSync(st.files.secretFile, 'utf8');
    expect(st.revokeAll()).toBe(1);
    expect(fs.readFileSync(st.files.secretFile, 'utf8')).not.toBe(before);
    expect(st.verify(b.token, { kind: 'artifact', id: 'b' }).reason).toBe('invalid signature');
    expect(st.list()).toEqual([]);
    expect(st.sign({ kind: 'artifact', id: 'c' }).token).toBeTruthy();
  });
});

describe('share-token: asset scope (F5)', () => {
  test('scope rides in the payload; hidden from list()/listFor; unshare-style revokeFor spares it, includeAssets kills it', () => {
    const dir = tmp('st-scope-');
    const st = createShareTokens({ dir });
    const link = st.sign({ kind: 'artifact', id: 'A', days: 3, ver: 1 });
    const asset = st.sign({ kind: 'artifact', id: 'A', days: 1, scope: 'assets' });
    expect(st.verify(asset.token, { kind: 'artifact', id: 'A' })).toMatchObject({ ok: true, payload: { scope: 'assets', id: 'A' } });
    expect(st.verify(asset.token, { kind: 'artifact', id: 'B' }).ok).toBe(false);
    expect(st.verify(link.token, { kind: 'artifact', id: 'A' }).payload.scope).toBeUndefined();
    expect(st.list().map((x) => x.nonce)).toEqual([link.nonce]);
    expect(st.listFor('artifact', 'A').map((x) => x.nonce)).toEqual([link.nonce]);
    expect(st.revokeFor('artifact', 'A')).toBe(1);
    expect(st.verify(link.token, { kind: 'artifact', id: 'A' }).ok).toBe(false);
    expect(st.verify(asset.token, { kind: 'artifact', id: 'A' }).ok).toBe(true);
    expect(st.revokeFor('artifact', 'A', { includeAssets: true })).toBe(1);
    expect(st.verify(asset.token, { kind: 'artifact', id: 'A' })).toMatchObject({ ok: false, reason: 'link revoked' });
  });
});

describe('artifacts: share URL helpers (pure)', () => {
  test('parseArtifactUrl: query form, path form, redirect form, escapes', () => {
    expect(parseArtifactUrl('/__artifacts/abc/?t=TOK')).toEqual({ aid: 'abc', rel: '/', token: 'TOK', query: '?t=TOK', hadTrailing: true });
    expect(parseArtifactUrl('/__artifacts/abc?t=TOK')).toEqual({ aid: 'abc', rel: '', token: 'TOK', query: '?t=TOK', hadTrailing: false });
    expect(parseArtifactUrl('/__artifacts/abc/~t/TOK/v1/assets/app.js')).toEqual({ aid: 'abc', rel: '/v1/assets/app.js', token: 'TOK', query: '', hadTrailing: true });
    expect(parseArtifactUrl('/__artifacts/abc/~t/TOK/')).toEqual({ aid: 'abc', rel: '/', token: 'TOK', query: '', hadTrailing: true });
    expect(parseArtifactUrl('/__artifacts/abc/~t/TOK')).toEqual({ aid: 'abc', rel: '/', token: 'TOK', query: '', hadTrailing: true });
    expect(parseArtifactUrl('/__artifacts/abc/v2/x.css')).toEqual({ aid: 'abc', rel: '/v2/x.css', token: null, query: '', hadTrailing: true });
    expect(parseArtifactUrl('/__artifacts/')).toBeNull();
    expect(parseArtifactUrl('/__host/')).toBeNull();
    expect(parseArtifactUrl('/__artifacts/%zz')).toBeNull();
  });
  test('rewriteAbsoluteRefs (F5): root-absolute refs to THIS artifact get the token; others untouched; idempotent', () => {
    const html = '<base href="/__artifacts/A1/~t/T/v1/"><img src="/__artifacts/A1/v1/x.png"><a href=\'/__artifacts/A1/doc.pdf\'>d</a><img src="/__artifacts/B2/y.png"><img src="./z.png"><a href="/__api/x">';
    const out = rewriteAbsoluteRefs(html, 'A1', 'T');
    expect(out).toContain('src="/__artifacts/A1/~t/T/v1/x.png"');
    expect(out).toContain("href='/__artifacts/A1/~t/T/doc.pdf'");
    expect(out).toContain('src="/__artifacts/B2/y.png"');
    expect(out).toContain('src="./z.png"');
    expect(out).toContain('href="/__api/x"');
    expect(out.startsWith('<base href="/__artifacts/A1/~t/T/v1/">')).toBe(true);
    expect(rewriteAbsoluteRefs(out, 'A1', 'T')).toBe(out);
  });
  test('rewriteBaseForShare: only the injected base of that artifact, idempotent', () => {
    const html = '<html><head><base href="/__artifacts/abc/v3/"><title>x</title></head><body><a href="/__artifacts/abc/v3/">no</a></body></html>';
    const out = rewriteBaseForShare(html, 'abc', 'TOK');
    expect(out).toBe('<html><head><base href="/__artifacts/abc/~t/TOK/v3/"><title>x</title></head><body><a href="/__artifacts/abc/v3/">no</a></body></html>');
    expect(rewriteBaseForShare(out, 'abc', 'TOK')).toBe(out);
    expect(rewriteBaseForShare(html, 'other', 'TOK')).toBe(html);
  });
});

// ---- middleware path scoping, over real HTTP in a child --------------------------
function makeSite(root) {
  fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><html><head><title>t</title></head><body><script src="./assets/app.js"></script></body></html>');
  fs.writeFileSync(path.join(root, 'assets', 'app.js'), 'console.log(1)');
}

const GATE_BODY = (src) => `
  const http=await import('node:http');const fs=await import('node:fs');
  const state=await import('./server/state.ts');const art=await import('./server/artifacts.ts');
  const {auth}=await import('./server/auth.ts');auth.setShareGate(art.shareGate);
  const s=state.createSession({title:'t',cwd:${JSON.stringify(src)}});
  const r1=art.publish(s.id,{path:'.',title:'Report'});const aid=r1.artifact.id;
  const sh1=art.share(s.id,aid,{days:3});
  fs.writeFileSync(${JSON.stringify(src)}+'/index.html','<!doctype html><html><head><title>t2</title></head><body>v2</body></html>');
  const r2=art.publish(s.id,{path:'.',title:'Report'});
  const other=art.publish(s.id,{path:'assets/app.js',title:'other'});
  const srv=http.createServer((req,res)=>{if(auth.gate(req,res))return;if(req.url.startsWith('/__api')){res.writeHead(200);res.end('api');return;}if(art.serve(req,res))return;res.writeHead(404);res.end();});
  await new Promise(r=>srv.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+srv.address().port;
  const get=async(p)=>{const r=await fetch(base+p,{redirect:'manual'});return {status:r.status,body:await r.text(),loc:r.headers.get('location'),csp:r.headers.get('content-security-policy'),cookie:r.headers.get('set-cookie')};};
  const raw=(p)=>new Promise((ok)=>{http.get({host:'127.0.0.1',port:srv.address().port,path:p},(r)=>{r.resume();r.on('end',()=>ok(r.statusCode));});});
  const tok=sh1.path.split('?t=')[1];
  const flip=(s,i)=>s.slice(0,i)+(s[i]==='A'?'B':'A')+s.slice(i+1);
  const sigAt=sh1.path.indexOf('.',sh1.path.indexOf('?t='))+5;
  const out={};
  out.noCookie=await get('/__artifacts/'+aid+'/');
  out.withTok=await get(sh1.path);
  out.assetViaPath=(await get('/__artifacts/'+aid+'/~t/'+tok+'/v1/assets/app.js')).status;
  out.assetV2=(await get('/__artifacts/'+aid+'/~t/'+tok+'/v2/assets/app.js')).status;
  out.explicitV1=(await get('/__artifacts/'+aid+'/v1/?t='+tok)).status;
  out.explicitV2=(await get('/__artifacts/'+aid+'/v2/?t='+tok)).status;
  out.apiWithTok=(await get('/__api/sessions?t='+tok)).status;
  out.otherArt=(await get(other.artifact.path+'?t='+tok)).status;
  out.otherViaPath=(await get(other.artifact.path+'~t/'+tok+'/')).status;
  out.tampered=await get(flip(sh1.path,sigAt));
  out.redirect=await get('/__artifacts/'+aid+'?t='+tok);
  out.traversal=await raw('/__artifacts/'+aid+'/~t/'+tok+'/v1/../../../config.json');
  out.traversalEnc=await raw('/__artifacts/'+aid+'/~t/'+tok+'/v1/%2e%2e/%2e%2e/config.json');
  out.warnings=sh1.warnings;out.rec=state.getSession(s.id).artifacts.find(a=>a.id===aid);
  out.listed=art.listShares(aid).map(x=>({ver:x.ver,label:x.label}));
  const sh2=art.share(s.id,aid);out.sh2=await get(sh2.path);out.sh2Version=sh2.version;
  out.sh1StillV1=(await get(sh1.path)).body.includes('/v1/');
  out.unshare=art.unshare(s.id,aid);
  out.afterRevoke1=(await get(sh1.path)).status;out.afterRevoke2=(await get(sh2.path)).status;
  out.recAfter=state.getSession(s.id).artifacts.find(a=>a.id===aid);
  srv.close();
  emit(out);
`;

test('gate + serve: a share token opens ONE artifact at ONE version, cookie-less, nothing else', () => {
  const src = tmp('share-src-');
  makeSite(src);
  const dir = tmp('share-home-');
  const r = runInChild(GATE_BODY(src), { ARIGAMI_DIR: dir, ARIGAMI_PORT: '3497', ARIGAMI_AUTH: 'pairing' });
  expect(r.ok).toBe(true);
  const o = r.out[0];
  expect(o.noCookie.status).toBe(401);                     // plain artifact URL → gate
  expect(o.withTok.status).toBe(200);                      // ?t= → the entry
  expect(o.withTok.cookie).toBeNull();                     // no cookie minted
  expect(o.withTok.csp).toContain('sandbox');
  expect(o.withTok.body).toContain(`<base href="/__artifacts/${o.rec.id}/~t/`);
  expect(o.withTok.body).toContain('/v1/">');              // pinned to the version signed
  expect(o.withTok.body).not.toContain('v2');
  expect(o.assetViaPath).toBe(200);                        // sub-resource via the path form
  expect(o.assetV2).toBe(403);                             // other version refused
  expect(o.explicitV1).toBe(200);
  expect(o.explicitV2).toBe(403);
  expect(o.apiWithTok).toBe(401);                          // token grants no API
  expect(o.otherArt).toBe(401);                            // token bound to its artifact
  expect(o.otherViaPath).toBe(401);
  expect(o.tampered.status).toBe(401);
  expect(o.tampered.body).toContain('Link expired');
  expect(o.redirect.status).toBe(302);
  expect(o.redirect.loc).toBe(`/__artifacts/${o.rec.id}/?t=${o.withTok.body.match(/~t\/([^/]+)\//)[1]}`);
  expect(o.traversal).toBe(403);
  expect(o.traversalEnc).toBe(403);
  expect(o.warnings.some((w) => w.includes('ARIGAMI_PUBLIC_URL'))).toBe(true); // relative link, no public url
  expect(o.rec.shareVersion).toBe(1);
  expect(o.rec.shareExp).toMatch(/^\d{4}-/);
  expect(o.listed).toEqual([{ ver: 1, label: 'Report' }]);
  // re-share after re-publish → new link on v2, old link still v1
  expect(o.sh2Version).toBe(2);
  expect(o.sh2.status).toBe(200);
  expect(o.sh2.body).toContain('/v2/">');
  expect(o.sh1StillV1).toBe(true);
  // unshare revokes both immediately
  expect(o.unshare).toEqual({ revoked: 2 });
  expect(o.afterRevoke1).toBe(401);
  expect(o.afterRevoke2).toBe(401);
  expect(o.recAfter.shareNonce).toBeUndefined();
  expect(o.recAfter.shareExp).toBeUndefined();
  // secret + lists live in the instance dir, secret 0600
  expect(fs.statSync(path.join(dir, 'share-secret')).mode & 0o777).toBe(0o600);
  expect(fs.existsSync(path.join(dir, 'share-revoked.json'))).toBe(true);
});
