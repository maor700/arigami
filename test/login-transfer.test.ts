// Per-site login handover (login-sites.ts, site-state.ts, login-vault.ts),
// against REAL headless Chrome.
//
// The shape of what is being proved:
//   - a login is detected from disk, without starting Chrome, and nothing but
//     its presence comes back
//   - ONE site moves — its httpOnly cookie, its Firebase-style IndexedDB and its
//     localStorage — into another profile, and another site's cookie does not
//   - a site that keeps a non-extractable CryptoKey is refused as device-bound
//     and remembered as `never`
//   - a Firebase database on an unknown site is recognized from storage alone
import { test, expect, beforeAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInChild } from './_child.js';
import * as sites from '../server/lib/login-sites.ts';
import { findChromeBin } from '../server/lib/platform.ts';

const chrome = findChromeBin();

// ---- pure: the site list --------------------------------------------------------

test('resolve maps names, hosts and urls to the same site', () => {
  expect(sites.resolve('facebook').id).toBe('facebook.com');
  expect(sites.resolve('https://www.facebook.com/me').id).toBe('facebook.com');
  expect(sites.resolve('accounts.google.com').id).toBe('google.com');
  expect(sites.resolve('app.example.co.uk').id).toBe('example.co.uk');
  expect(sites.resolve('app.example.co.uk').known).toBe(false);
});

test('cookieBelongs matches the site and its subdomains, not look-alikes', () => {
  const g = sites.resolve('google');
  expect(sites.cookieBelongs('.google.com', g)).toBe(true);
  expect(sites.cookieBelongs('.google.co.il', g)).toBe(true); // country domains are the same account
  expect(sites.resolve('www.google.co.il').id).toBe('google.com');
  expect(sites.cookieBelongs('google.co.il.evil.io', g)).toBe(false);
  expect(sites.cookieBelongs('accounts.google.com', g)).toBe(true);
  expect(sites.cookieBelongs('notgoogle.com', g)).toBe(false);
  expect(sites.cookieBelongs('google.com.evil.io', g)).toBe(false);
});

test('Google is never copied: it does not reliably accept its session in a second browser', () => {
  const d = sites.decide(sites.resolve('google'));
  expect(d.policy).toBe('never');
  expect(d.reason).toMatch(/second browser/);
});

test('signed-out pages are recognized, including ones that look like marketing pages', async () => {
  const { isLoggedOutUrl } = await import('../server/lib/site-state.ts');
  const g = sites.resolve('google');
  // what the experiment on a real host actually landed on
  expect(isLoggedOutUrl('https://www.google.com/account/about/?hl=en-US', g.loggedOut)).toBe(true);
  expect(isLoggedOutUrl('https://accounts.google.com/v3/signin/accountchooser?continue=https://mail.google.com/mail/u/0/', g.loggedOut)).toBe(true);
  expect(isLoggedOutUrl('https://github.com/login?return_to=%2Fsettings%2Fprofile')).toBe(true);
  // a logged-in page is not a wall
  expect(isLoggedOutUrl('https://myaccount.google.com/', g.loggedOut)).toBe(false);
  expect(isLoggedOutUrl('https://github.com/settings/profile')).toBe(false);
});

test('decide: a linked-device site is never copied, whatever it stores', () => {
  const d = sites.decide(sites.resolve('web.whatsapp.com'), ['wawc']);
  expect(d.policy).toBe('never');
  expect(d.reason).toMatch(/linked device/);
});

test('decide: an unknown site holding a Firebase database is a copy of just that database', () => {
  const d = sites.decide(sites.resolve('app.unknown-firebase-site.io'), ['firebaseLocalStorageDb', 'some-cache']);
  expect(d.policy).toBe('copy');
  expect(d.source).toBe('storage');
  expect(d.authDbs).toEqual(['firebaseLocalStorageDb']);
});

test('decide: an unknown site with only cookies moves cookies, and says it is unknown', () => {
  const d = sites.decide(sites.resolve('some-forum.net'), []);
  expect(d.policy).toBe('cookies');
  expect(d.source).toBe('default');
  expect(d.reason).toMatch(/not a site the host knows/);
});

// ---- real Chrome -------------------------------------------------------------

let e2e: any = null;

beforeAll(() => {
  if (!chrome) return;
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'login-e2e-'));
  const vault = path.join(sandbox, 'vault');
  const target = path.join(sandbox, 'target');

  const r = runInChild(
    `const { Cdp, exportSite, importSite } = await import('./server/lib/site-state.ts');
     const vault = await import('./server/lib/login-vault.ts');
     const sites = await import('./server/lib/login-sites.ts');
     const { spawn } = await import('node:child_process');
     const fs = await import('node:fs');
     const path = await import('node:path');
     // The site lives IN this child: the parent test process is blocked in
     // spawnSync while this runs, so a server there could never answer.
     const server = Bun.serve({ port: 0, fetch(req) {
       const u = new URL(req.url);
       if (u.pathname === '/login') return new Response('<!doctype html><title>login</title>ok', { headers: { 'content-type': 'text/html',
         // httpOnly + Secure: the kind a real session cookie is (localhost is a secure context)
         'set-cookie': 'sid=SECRET-SESSION; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400' } });
       return new Response('<!doctype html><title>page</title>ok', { headers: { 'content-type': 'text/html' } });
     } });
     const ORIGIN = 'http://localhost:' + server.port;

     // 1. the owner signs in, in "my browser" (the vault), headless for the test
     await vault.withVault(async (cdp) => {
       const { targetId } = await cdp.send('Target.createTarget', { url: ORIGIN + '/login' });
       const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
       for (let i = 0; i < 40; i++) { const r = await cdp.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true }, sessionId); if (r.result.value === 'complete') break; await new Promise(r => setTimeout(r, 100)); }
       // what the Firebase SDK writes, plus a cache db that must NOT move, plus localStorage
       await cdp.send('Runtime.evaluate', { awaitPromise: true, expression: \`(async () => {
         const put = (name, store, key, val) => new Promise((res, rej) => { const r = indexedDB.open(name, 1); r.onupgradeneeded = () => r.result.createObjectStore(store); r.onsuccess = () => { const tx = r.result.transaction(store, 'readwrite'); tx.objectStore(store).put(val, key); tx.oncomplete = () => { r.result.close(); res(); }; }; r.onerror = () => rej(r.error); });
         await put('firebaseLocalStorageDb', 'firebaseLocalStorage', 'firebase:authUser:KEY:[DEFAULT]', { fbase_key: 'firebase:authUser:KEY:[DEFAULT]', value: { uid: 'u1', stsTokenManager: { refreshToken: 'REFRESH-TOKEN', expirationTime: 1 } }, when: new Date('2026-01-01') });
         await put('big-cache', 'c', 'k', 'cached stuff');
         localStorage.setItem('app:tenant', 'acme');
       })()\` }, sessionId);
       // a cookie of ANOTHER site, which must stay behind
       await cdp.send('Storage.setCookies', { cookies: [{ name: 'other', value: 'NOPE', domain: 'other.test', path: '/', secure: true, httpOnly: true }] });
     }, ${JSON.stringify(vault)});

     // 2. detection from disk, no Chrome running
     const det = vault.detect('localhost', ${JSON.stringify(vault)});
     const listed = vault.list(${JSON.stringify(vault)});

     // 3. export ONE site from the vault …
     const site = sites.resolve('localhost');
     const dec = sites.decide(site, ['firebaseLocalStorageDb', 'big-cache']);
     const state = await vault.withVault((cdp) => exportSite(cdp, (d) => sites.cookieBelongs(d, site), [ORIGIN], dec.authDbs), ${JSON.stringify(vault)});

     // … and import it into a separate, empty profile
     const proc = spawn(${JSON.stringify(chrome)}, ['--headless=new', '--user-data-dir=${target}', '--remote-debugging-port=0', '--no-first-run', '--password-store=basic', 'about:blank'], { stdio: 'ignore' });
     let port = null;
     for (let i = 0; i < 100 && !port; i++) { try { port = Number(fs.readFileSync(path.join(${JSON.stringify(target)}, 'DevToolsActivePort'), 'utf8').split('\\n')[0]); } catch {} await new Promise(r => setTimeout(r, 100)); }
     const cdp = await Cdp.connect(port);
     const moved = await importSite(cdp, state);
     const { cookies } = await cdp.send('Storage.getCookies', {});
     const { targetId } = await cdp.send('Target.createTarget', { url: ORIGIN + '/page' });
     const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
     for (let i = 0; i < 40; i++) { const r = await cdp.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true }, sessionId); if (r.result.value === 'complete') break; await new Promise(r => setTimeout(r, 100)); }
     const seen = (await cdp.send('Runtime.evaluate', { awaitPromise: true, returnByValue: true, expression: \`(async () => {
       const dbs = (await indexedDB.databases()).map(d => d.name).sort();
       const user = await new Promise((res) => { const r = indexedDB.open('firebaseLocalStorageDb'); r.onsuccess = () => { const g = r.result.transaction('firebaseLocalStorage').objectStore('firebaseLocalStorage').get('firebase:authUser:KEY:[DEFAULT]'); g.onsuccess = () => { r.result.close(); res(g.result); }; }; });
       return { dbs, refresh: user?.value?.stsTokenManager?.refreshToken, whenIsDate: user?.when instanceof Date, tenant: localStorage.getItem('app:tenant') };
     })()\` }, sessionId)).result.value;
     await cdp.send('Browser.close').catch(() => {}); cdp.close();

     // 4. a site whose session is a non-extractable key
     let deviceBound = null;
     try {
       await vault.withVault(async (c) => {
         const { targetId } = await c.send('Target.createTarget', { url: ORIGIN + '/page' });
         const { sessionId } = await c.send('Target.attachToTarget', { targetId, flatten: true });
         for (let i = 0; i < 40; i++) { const r = await c.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true }, sessionId); if (r.result.value === 'complete') break; await new Promise(r => setTimeout(r, 100)); }
         await c.send('Runtime.evaluate', { awaitPromise: true, expression: \`(async () => {
           const key = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
           await new Promise((res) => { const r = indexedDB.open('device-keys', 1); r.onupgradeneeded = () => r.result.createObjectStore('k'); r.onsuccess = () => { const tx = r.result.transaction('k', 'readwrite'); tx.objectStore('k').put(key.privateKey, 'priv'); tx.oncomplete = () => { r.result.close(); res(); }; }; });
         })()\` }, sessionId);
         return exportSite(c, () => false, [ORIGIN], ['device-keys']);
       }, ${JSON.stringify(vault)});
     } catch (e) { deviceBound = e.message; }

     server.stop(true);
     emit({ det: { present: det.present, cookies: det.cookies, authCookies: det.authCookies, storageOrigins: det.storageOrigins, keys: Object.keys(det) }, listed, dec, exportedCookieNames: state.cookies.map(c => c.name), exportedDbs: state.origins.flatMap(o => o.idb.map(d => d.name)), moved, targetCookies: cookies.map(c => c.name + '@' + c.domain), seen, deviceBound });`,
    { ARIGAMI_DIR: path.join(sandbox, 'host'), ARIGAMI_STATE_FILE: path.join(sandbox, 'host', 'state.json'), CHROME_BIN: chrome }
  );
  if (!r.ok) throw new Error(r.error);
  e2e = r.out[0];
}, 120_000);

test.skipIf(!chrome)('detection reads the login from disk and returns no values', () => {
  expect(e2e.det.present).toBe(true);
  expect(e2e.det.authCookies).toBe(1);
  expect(e2e.det.storageOrigins.length).toBe(1);
  // presence only — no cookie value, no token anywhere in what detection returns
  expect(JSON.stringify(e2e.det)).not.toContain('SECRET-SESSION');
  expect(e2e.listed.map((s: any) => s.id)).toContain('localhost');
});

test.skipIf(!chrome)('only the site moves: its cookie, its auth database, its localStorage', () => {
  expect(e2e.exportedCookieNames).toEqual(['sid']); // the other.test cookie stayed behind
  expect(e2e.exportedDbs).toEqual(['firebaseLocalStorageDb']); // the cache db stayed behind
  expect(e2e.targetCookies).toEqual([expect.stringMatching(/^sid@localhost$/)]);
  expect(e2e.seen.dbs).toEqual(['firebaseLocalStorageDb']);
  expect(e2e.seen.refresh).toBe('REFRESH-TOKEN');
  expect(e2e.seen.whenIsDate).toBe(true); // tagged JSON kept the Date a Date
  expect(e2e.seen.tenant).toBe('acme');
});

test.skipIf(!chrome)('a non-extractable key is refused as device-bound', () => {
  expect(e2e.deviceBound).toMatch(/DEVICE_BOUND/);
});
