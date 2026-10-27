// The owner's everyday Chrome as a second, read-only source of logins (owner-chrome.ts + login-vault.ts):
//   - which profile, if any: config/env, Linux-only auto, never in a container, never chrome-base
//   - detection from its disk next to the vault's, keyring-encrypted cookies (v11) not offered
//   - against REAL headless Chrome: one site's login read from a snapshot copy, the original untouched, the copy gone
import { test, expect, beforeAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import { runInChild } from './_child.js';
import { findChromeBin } from '../server/lib/platform.ts';
import { resolveOwnerProfile, idbDirName, snapshot, removeSnapshot } from '../server/lib/owner-chrome.ts';
import * as lv from '../server/lib/login-vault.ts';
import { tmpDir } from './_tmp.js';

const chrome = findChromeBin();

function fakeChrome(root: string, profile: string, rows: [string, string, number, number, string][]): void {
  fs.mkdirSync(path.join(root, profile), { recursive: true });
  fs.writeFileSync(path.join(root, 'Local State'), JSON.stringify({ profile: { last_used: profile } }));
  const db = new Database(path.join(root, profile, 'Cookies'));
  db.run('create table cookies (host_key text, name text, expires_utc integer, is_httponly integer, is_secure integer, encrypted_value blob)');
  for (const [host, name, httpOnly, secure, tag] of rows)
    db.run('insert into cookies values (?, ?, 0, ?, ?, ?)', [host, name, httpOnly, secure, Buffer.from(tag + 'xxxxxxxx')]);
  db.close();
}

test('resolveOwnerProfile: Linux auto from Local State; off in a container, elsewhere, or when told', () => {
  const home = tmpDir('owner-home-');
  const ud = path.join(home, '.config', 'google-chrome');
  fakeChrome(ud, 'Profile 1', []);
  const p = resolveOwnerProfile({ home, platform: 'linux', env: {} });
  expect(p).toEqual({ userDataDir: ud, profileDir: 'Profile 1', profilePath: path.join(ud, 'Profile 1') });
  expect(resolveOwnerProfile({ home, platform: 'linux', inContainer: true, env: {} })).toBe(null); // Docker / a pod
  expect(resolveOwnerProfile({ home, platform: 'darwin', env: {} })).toBe(null); // no auto outside Linux
  expect(resolveOwnerProfile({ home, platform: 'linux', env: { ARIGAMI_OWNER_CHROME: '0' } })).toBe(null);
  expect(resolveOwnerProfile({ home, platform: 'linux', config: false, env: {} })).toBe(null);
  expect(resolveOwnerProfile({ home, platform: 'linux', env: {}, exclude: [ud] })).toBe(null); // never the vault itself
  expect(resolveOwnerProfile({ home: tmpDir('empty-home-'), platform: 'linux', env: {} })).toBe(null); // no Chrome there
  // explicit: any platform, a chosen profile
  fakeChrome(ud, 'Default', []);
  expect(resolveOwnerProfile({ platform: 'win32', env: { ARIGAMI_OWNER_CHROME: ud, ARIGAMI_OWNER_CHROME_PROFILE: 'Default' } })?.profileDir).toBe('Default');
  expect(resolveOwnerProfile({ platform: 'linux', config: { userDataDir: ud, profile: '../x' }, env: {} })).toBe(null);
});

test('config.json: "ownerChrome": false reaches the host (it used to be dropped as an unknown key), {userDataDir} too', () => {
  const read = (conf: unknown) => {
    const dir = tmpDir('owner-cfg-');
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(conf));
    const r = runInChild(`const { cfg } = await import('./server/lib/config.ts'); emit(cfg.ownerChrome ?? null);`, { ARIGAMI_DIR: dir });
    if (!r.ok) throw new Error(r.error);
    return r.out[0];
  };
  expect(read({ ownerChrome: false })).toBe(false);
  expect(read({ ownerChrome: { userDataDir: '/x', profile: 'Profile 2' } })).toEqual({ userDataDir: '/x', profile: 'Profile 2' });
  expect(read({})).toEqual({}); // auto
});

test('detect / list: the owner Chrome joins the vault; keyring cookies are not offered', () => {
  const vault = tmpDir('owner-vault-');
  const ud = tmpDir('owner-ud-');
  fakeChrome(ud, 'Profile 1', [
    ['.todoist.com', 'session', 1, 1, 'v10'],
    ['.ads.example', 'track', 0, 0, 'v10'],
    ['.keyring.example', 'sid', 1, 1, 'v11'],
  ]);
  const own = resolveOwnerProfile({ platform: 'linux', env: { ARIGAMI_OWNER_CHROME: ud } })!;
  const d = lv.detect('todoist.com', vault, own);
  expect(d.present).toBe(true);
  expect(d.sources).toEqual(['chrome']);
  expect(lv.detect('keyring.example', vault, own).present).toBe(false);
  expect(lv.detect('todoist.com', vault, null).present).toBe(false); // no owner Chrome: the vault alone, as before
  const ids = lv.list(vault, own).map((s) => `${s.id}:${s.sources.join('+')}`);
  expect(ids).toContain('todoist.com:chrome');
  expect(ids.join()).not.toContain('keyring.example');
  expect(ids.join()).not.toContain('ads.example'); // not a login
  expect(JSON.stringify(lv.list(vault, own))).not.toContain('xxxxxxxx'); // names only
});

test('idbDirName follows Chrome naming', () => {
  expect(idbDirName('https://app.todoist.com')).toBe('https_app.todoist.com_0');
  expect(idbDirName('http://localhost:8080')).toBe('http_localhost_8080');
});

test('snapshot copies only the site share and never the original LOCKs; removeSnapshot cleans up', () => {
  const ud = tmpDir('owner-snap-');
  fakeChrome(ud, 'Default', [['.a.test', 's', 1, 1, 'v10']]);
  const prof = path.join(ud, 'Default');
  fs.mkdirSync(path.join(prof, 'IndexedDB', 'https_app.a.test_0.indexeddb.leveldb'), { recursive: true });
  fs.writeFileSync(path.join(prof, 'IndexedDB', 'https_app.a.test_0.indexeddb.leveldb', 'LOCK'), '');
  fs.writeFileSync(path.join(prof, 'IndexedDB', 'https_app.a.test_0.indexeddb.leveldb', '000001.log'), 'a');
  fs.mkdirSync(path.join(prof, 'IndexedDB', 'https_other.test_0.indexeddb.leveldb'), { recursive: true });
  fs.mkdirSync(path.join(prof, 'Local Storage', 'leveldb'), { recursive: true });
  fs.writeFileSync(path.join(prof, 'Local Storage', 'leveldb', 'LOCK'), '');
  const own = resolveOwnerProfile({ platform: 'linux', env: { ARIGAMI_OWNER_CHROME: ud } })!;
  const root = snapshot(own, ['https://app.a.test'], true);
  const idb = fs.readdirSync(path.join(root, 'Default', 'IndexedDB'));
  expect(idb).toEqual(['https_app.a.test_0.indexeddb.leveldb']);
  expect(fs.existsSync(path.join(root, 'Default', 'IndexedDB', idb[0], '000001.log'))).toBe(true);
  expect(fs.existsSync(path.join(root, 'Default', 'IndexedDB', idb[0], 'LOCK'))).toBe(false);
  expect(fs.existsSync(path.join(root, 'Default', 'Local Storage', 'leveldb', 'LOCK'))).toBe(false);
  expect(fs.existsSync(path.join(prof, 'Local Storage', 'leveldb', 'LOCK'))).toBe(true); // the original keeps its own
  removeSnapshot(root);
  expect(fs.existsSync(root)).toBe(false);
});

// ---- real Chrome -------------------------------------------------------------

let e2e: any = null;

beforeAll(() => {
  if (!chrome) return;
  const sandbox = tmpDir('owner-e2e-');
  const ownerDir = path.join(sandbox, 'owner-chrome');
  const vault = path.join(sandbox, 'vault');
  fs.mkdirSync(vault, { recursive: true });
  const r = runInChild(
    `const lv = await import('./server/lib/login-vault.ts');
     const oc = await import('./server/lib/owner-chrome.ts');
     const sites = await import('./server/lib/login-sites.ts');
     const { exportSite, idbNames } = await import('./server/lib/site-state.ts');
     const fs = await import('node:fs');
     const path = await import('node:path');
     const crypto = await import('node:crypto');
     const server = Bun.serve({ port: 0, fetch(req) {
       const u = new URL(req.url);
       if (u.pathname === '/login') return new Response('<!doctype html>ok', { headers: { 'content-type': 'text/html',
         'set-cookie': 'sid=OWNER-SESSION; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400' } });
       return new Response('<!doctype html>ok', { headers: { 'content-type': 'text/html' } });
     } });
     const ORIGIN = 'http://localhost:' + server.port;
     const OWNER = ${JSON.stringify(ownerDir)};
     // the owner signs in in their everyday Chrome (a real profile written by Chrome itself, basic store = v10)
     await lv.withVault(async (cdp) => {
       const { targetId } = await cdp.send('Target.createTarget', { url: ORIGIN + '/login' });
       const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
       for (let i = 0; i < 40; i++) { const r = await cdp.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true }, sessionId); if (r.result.value === 'complete') break; await new Promise(r => setTimeout(r, 100)); }
       await cdp.send('Runtime.evaluate', { awaitPromise: true, expression: \`(async () => {
         await new Promise((res, rej) => { const r = indexedDB.open('firebaseLocalStorageDb', 1); r.onupgradeneeded = () => r.result.createObjectStore('firebaseLocalStorage'); r.onsuccess = () => { const tx = r.result.transaction('firebaseLocalStorage', 'readwrite'); tx.objectStore('firebaseLocalStorage').put({ value: { refresh: 'OWNER-REFRESH' } }, 'firebase:authUser:K:[DEFAULT]'); tx.oncomplete = () => { r.result.close(); res(); }; }; r.onerror = () => rej(r.error); });
         localStorage.setItem('who', 'owner');
       })()\` }, sessionId);
     }, OWNER);
     // … in a NAMED profile, as an everyday Chrome has
     fs.renameSync(path.join(OWNER, 'Default'), path.join(OWNER, 'Profile 1'));
     const ls = JSON.parse(fs.readFileSync(path.join(OWNER, 'Local State'), 'utf8')); ls.profile = { ...(ls.profile || {}), last_used: 'Profile 1' };
     fs.writeFileSync(path.join(OWNER, 'Local State'), JSON.stringify(ls));
     const hash = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
     const cookiesFile = path.join(OWNER, 'Profile 1', 'Cookies');
     const before = hash(cookiesFile);
     const own = oc.resolveOwnerProfile({ platform: 'linux', env: { ARIGAMI_OWNER_CHROME: OWNER } });
     const det = lv.detect('localhost', ${JSON.stringify(vault)}, own);
     const site = sites.resolve('localhost');
     const TMP = process.env.TMPDIR || '/tmp';
     const snapsBefore = fs.readdirSync(TMP).filter((n) => n.startsWith('arigami-owner-chrome-')).length;
     let names = null;
     const state = await lv.withOwnerChrome(own, det.storageOrigins, true, async (cdp) => {
       names = await idbNames(cdp, ORIGIN); // what decide() refines an unknown site's copy with
       return exportSite(cdp, (d) => sites.cookieBelongs(d, site), [ORIGIN], ['firebaseLocalStorageDb']);
     });
     const snapsAfter = fs.readdirSync(TMP).filter((n) => n.startsWith('arigami-owner-chrome-')).length;
     server.stop(true);
     emit({ names, profileDir: own.profileDir, sources: det.sources, storage: det.storageOrigins.length,
       cookies: state.cookies.map((c) => c.name + '=' + c.value + '@' + c.domain),
       dbs: state.origins.flatMap((o) => o.idb.map((d) => d.name)), local: state.origins.map((o) => o.local.who),
       untouched: hash(cookiesFile) === before, snapsLeft: snapsAfter - snapsBefore });`,
    { ARIGAMI_DIR: path.join(sandbox, 'host'), ARIGAMI_STATE_FILE: path.join(sandbox, 'host', 'state.json'), CHROME_BIN: chrome }
  );
  if (!r.ok) throw new Error(r.error);
  e2e = r.out[0];
}, 120_000);

test.skipIf(!chrome)("a login in the owner's Chrome is detected from disk and read from a snapshot — the original untouched", () => {
  expect(e2e.profileDir).toBe('Profile 1');
  expect(e2e.sources).toEqual(['chrome']);
  expect(e2e.storage).toBe(1);
  expect(e2e.cookies).toEqual([expect.stringMatching(/^sid=OWNER-SESSION@localhost$/)]); // decrypted by our Chrome
  expect(e2e.dbs).toEqual(['firebaseLocalStorageDb']);
  expect(e2e.names).toEqual(['firebaseLocalStorageDb']); // read in a page of the origin (not on the browser target)
  expect(e2e.local).toEqual(['owner']);
  expect(e2e.untouched).toBe(true);
  expect(e2e.snapsLeft).toBe(0);
});
