// VAULT4 end-to-end, the owner's side of a vault_fill: a real host (auth on), a real headless Chrome as the SESSION
// browser on a local page with named fields, a second real Chrome as the owner's COCKPIT tab (the built web/dist, the
// vault worker, a KDBX this script minted and uploaded as ciphertext), and the agent's blocking vault/fill call.
// Reports what the owner sees and what the agent gets — never a value in a message. Run with ARIGAMI_DIR set (and
// ARIGAMI_ROOT to serve another build of the cockpit); emits one object. Child of test/vault-card-e2e.test.ts.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = process.env.ARIGAMI_DIR!;
const SECRET = 'vault-card-e2e-secret-32chars-xxxx';
const MASTER = 'e2e-master-pass';
const ID_VALUE = '123456782';
const PHONE_VALUE = '0500000000';
const ho = await import('../server/handoff.ts');
const { chromeSessionDir } = await import('../server/lib/chrome.ts');
const { findChromeBin } = await import('../server/lib/platform.ts');
const cdp = await import('../server/lib/chrome-cdp.ts');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const freePort = (): Promise<number> => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); }); });
/** One open DevTools session to a target: Network.* state (blocked URLs, offline) lives as long as it does. */
class Cdp {
  private id = 0;
  private waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private constructor(private ws: WebSocket) {
    ws.onmessage = (ev) => { const m = JSON.parse(String(ev.data)); const w = this.waiting.get(m.id); if (!w) return; this.waiting.delete(m.id); m.error ? w.reject(new Error(m.error.message)) : w.resolve(m.result); };
  }
  static open(url: string): Promise<Cdp> {
    return new Promise((resolve, reject) => { const ws = new WebSocket(url); ws.onopen = () => resolve(new Cdp(ws)); ws.onerror = () => reject(new Error('cdp open failed')); });
  }
  call(method: string, params: Record<string, unknown> = {}, timeoutMs = 8000): Promise<any> {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.waiting.delete(id); reject(new Error(`cdp timeout ${method}`)); }, timeoutMs);
      this.waiting.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { try { this.ws.close(); } catch {} }
}
let step_ = 'boot';
const at = (s: string) => { step_ = s; console.error(`[e2e] ${s}`); };
async function until<T>(fn: () => Promise<T | null | undefined | false>, ms = 20000, step = 150): Promise<T> {
  const end = Date.now() + ms;
  let last: unknown = null;
  for (;;) {
    const v = await fn().catch((e) => { last = e?.message || e; return null; });
    if (v) return v as T;
    if (Date.now() > end) throw new Error(`timeout at ${step_}${last ? ` (last error: ${String(last).slice(0, 160)})` : ''}`);
    await sleep(step);
  }
}

// ---- the page the agent works on: two named fields, two origins (127.0.0.1 and localhost) --------------------------
const page = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('<!doctype html><title>form</title><form onsubmit="event.preventDefault()"><label for="idn">ID number</label><input id="idn" name="idNumber"><label for="ph">Phone</label><input id="ph" name="phone"><button type="submit">Go</button></form>', { headers: { 'content-type': 'text/html' } }) });
const pageBase = `http://127.0.0.1:${page.port}`;
const otherBase = `http://localhost:${page.port}`;

// ---- the host ------------------------------------------------------------------------------------------------------------
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const home = path.join(DIR, 'home');
const ws = path.join(DIR, 'ws');
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(ws, { recursive: true });
const tokenFile = path.join(DIR, 'session-token');
const stub = path.join(DIR, 'claude-stub.js');
fs.writeFileSync(stub, `#!/usr/bin/env bun
if (process.env.ARIGAMI_SESSION_ID) require('node:fs').writeFileSync(${JSON.stringify(tokenFile)} + '.' + process.env.ARIGAMI_SESSION_ID, process.env.ARIGAMI_TOKEN || '');
const sidIdx=process.argv.indexOf('--session-id');const rsIdx=process.argv.indexOf('--resume');
const sid=sidIdx>0?process.argv[sidIdx+1]:rsIdx>0?process.argv[rsIdx+1]:'stub';
const out=(o)=>process.stdout.write(JSON.stringify(o)+'\\n');
out({type:'system',subtype:'init',session_id:sid,model:'claude-stub',tools:[],mcp_servers:[]});
let buf='';
process.stdin.on('data',(d)=>{buf+=d;let i;while((i=buf.indexOf('\\n'))>=0){const line=buf.slice(0,i);buf=buf.slice(i+1);
  let j={};try{j=JSON.parse(line);}catch{}
  if(j.type!=='user')continue;
  out({type:'assistant',message:{role:'assistant',content:[{type:'text',text:'ok'}],usage:{input_tokens:1,output_tokens:1}}});
  out({type:'result',subtype:'success',session_id:sid,is_error:false,result:'ok',duration_ms:1,num_turns:1,total_cost_usd:0});
}});
setInterval(()=>{},1e6);
`, { mode: 0o755 });
const hostLog = path.join(DIR, 'host.log');
const bootHost = () => {
  const h = spawn('bun', ['server/index.ts'], {
    cwd: ROOT,
    env: { ...process.env, HOME: home, ARIGAMI_DIR: DIR, ARIGAMI_PORT: String(port), ARIGAMI_AUTH: 'pairing', ARIGAMI_HANDOFF_SECRET: SECRET, ARIGAMI_SCREEN_ENABLED: '0', ARIGAMI_TELEMETRY: '0', ARIGAMI_CLAUDE_BIN: stub, ARIGAMI_DEFAULT_CWD: ws, COMPOSIO_API_KEY: '', GH_TOKEN: '', GITHUB_TOKEN: '', ...(process.env.E2E_ROOT ? { ARIGAMI_ROOT: process.env.E2E_ROOT } : {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  h.stdout!.on('data', (d) => fs.appendFileSync(hostLog, String(d)));
  h.stderr!.on('data', (d) => fs.appendFileSync(hostLog, String(d)));
  return h;
};
let host = bootHost();

const out: Record<string, unknown> = {};
let chromeS: ReturnType<typeof spawn> | null = null;
let chromeC: ReturnType<typeof spawn> | null = null;
try {
  at('host health');
  // Bun 1.4.0 now and then spins at boot with no output: a host silent for 25 s is replaced, up to three times
  for (let attempt = 1; ; attempt++) {
    try {
      await until(async () => (await fetch(base + '/__health', { signal: AbortSignal.timeout(2000) })).ok, 25000);
      break;
    } catch (e) {
      const silent = !fs.existsSync(hostLog) || fs.statSync(hostLog).size === 0;
      if (attempt >= 3 || !silent) throw e;
      console.error(`[e2e] host silent for 25 s (boot spin) — respawning (${attempt})`);
      try { host.kill('SIGKILL'); } catch {}
      host = bootHost();
    }
  }
  const hr = await fetch(`${base}/__api/auth/handoff?t=${encodeURIComponent(ho.mint(SECRET, 'owner@fake-org.test'))}`, { redirect: 'manual' });
  const cookie = (hr.headers.get('set-cookie') || '').split(';')[0];
  const person = (method: string, p: string, body?: unknown) => fetch(base + p, { method, headers: { cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const created = await (await person('POST', '/__api/sessions', { title: 'vault e2e', cwd: ws })).json();
  const sid: string = created.id;
  await person('POST', `/__api/sessions/${sid}/message`, { text: 'hello' });
  at('session token');
  const token = await until(async () => (fs.existsSync(`${tokenFile}.${sid}`) ? fs.readFileSync(`${tokenFile}.${sid}`, 'utf8').trim() || null : null), 30000);
  out.agentProbe = (await fetch(`${base}/__api/sessions/${sid}/vault/fields?site=127.0.0.1`, { headers: { authorization: `Bearer ${token}` } })).status;
  const agent = (p: string, body: unknown) => fetch(base + p, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  const pending = async () => ((await (await person('GET', `/__api/sessions/${sid}`)).json()).credentialRequest ?? null);

  at('vault upload');
  // ---- the vault: a real KDBX 4 with one entry for the page's origin (two named fields), uploaded as ciphertext ----
  const kdbxweb = await import('../web/node_modules/kdbxweb/dist/kdbxweb.js');
  const { argon2id, argon2d } = await import('../web/node_modules/hash-wasm/dist/index.esm.js');
  (kdbxweb as any).CryptoEngine.setArgon2Impl((pw: ArrayBuffer, salt: ArrayBuffer, memory: number, iterations: number, length: number, parallelism: number, type: number) =>
    (type === 2 ? argon2id : argon2d)({ password: new Uint8Array(pw), salt: new Uint8Array(salt), memorySize: memory, iterations, hashLength: length, parallelism, outputType: 'binary' }).then((r: Uint8Array) => r.buffer));
  const db = (kdbxweb as any).Kdbx.create(new (kdbxweb as any).Credentials((kdbxweb as any).ProtectedValue.fromString(MASTER)), 'Arigami');
  db.setKdf((kdbxweb as any).Consts.KdfId.Argon2id);
  const e = db.createEntry(db.getDefaultGroup());
  e.fields.set('Title', 'Dana');
  e.fields.set('URL', pageBase);
  e.fields.set('Arigami origin', pageBase);
  e.fields.set('UserName', '');
  e.fields.set('id_number', (kdbxweb as any).ProtectedValue.fromString(ID_VALUE));
  e.fields.set('phone', (kdbxweb as any).ProtectedValue.fromString(PHONE_VALUE));
  e.fields.set('Arigami field types', JSON.stringify({ phone: 'phone' }));
  const file = Buffer.from(await db.save());
  out.vaultPut = (await fetch(base + '/__api/vault/file', { method: 'PUT', headers: { cookie, 'content-type': 'application/octet-stream', 'if-match': '*' }, body: file })).status;
  out.catalogPut = (await person('PUT', '/__api/vault/catalog', { entries: [{ id: e.uuid.id, title: 'Dana', origin: pageBase, fields: [{ name: 'id_number', type: 'secret' }, { name: 'phone', type: 'phone' }] }] })).status;

  at('session chrome');
  // ---- the session browser on the page ---------------------------------------------------------------------------------
  const sdir = chromeSessionDir(sid);
  fs.mkdirSync(sdir, { recursive: true });
  const chromeBin = findChromeBin()!;
  const chromeArgs = (dir: string, url: string) => ['--headless=new', '--no-sandbox', `--user-data-dir=${dir}`, '--remote-debugging-port=0', '--no-first-run', '--window-size=1400,1000', url];
  chromeS = spawn(chromeBin, chromeArgs(sdir, `${pageBase}/form`), { stdio: 'ignore', env: { ...process.env, TMPDIR: '/tmp' } });
  await until(async () => (await cdp.listTabs(sid)).some((t) => t.url.startsWith(pageBase)), 20000);
  const evS = (expr: string) => cdp.pageEvaluate(sid, expr);
  await until(async () => evS("!!document.querySelector('#idn')"), 15000);

  at('cockpit chrome');
  // ---- the owner's cockpit tab: its own Chrome, the owner's cookie, the session's view ------------------------------------
  const cdir = path.join(DIR, 'cockpit-chrome');
  fs.mkdirSync(cdir, { recursive: true });
  chromeC = spawn(chromeBin, chromeArgs(cdir, `${base}/__health`), { stdio: 'ignore', env: { ...process.env, TMPDIR: '/tmp' } });
  const cport = await until(async () => cdp.cdpPort('cockpit', cdir), 20000);
  const [cname, cvalue] = cookie.split('=');
  const CARD_JS = `(() => { const c = document.querySelector('[data-credential-request]'); if (!c) return null; const f = c.querySelector('[data-cred-fill]'); const st = c.querySelector('[data-cred-state]'); const er = c.querySelector('[data-cred-error]'); const dn = c.querySelector('[data-cred-done]'); return { id: c.getAttribute('data-credential-request'), fillDisabled: f ? f.disabled : null, fillText: f ? f.textContent : null, state: st ? st.getAttribute('data-cred-state') : null, error: er ? er.textContent : null, unlockRow: !!c.querySelector('input[aria-label="Vault password"]'), fillFrom: [...c.querySelectorAll('[data-fill-from]')].map((b) => b.getAttribute('data-fill-from')), grant: !!c.querySelector('[data-cred-grant]'), grantText: (c.querySelector('[data-cred-grant]') || {}).textContent || null, grantOn: !!c.querySelector('[data-cred-grant-on]'), grantOnText: (c.querySelector('[data-cred-grant-on]') || {}).textContent || null, autoError: (c.querySelector('[data-cred-auto-error]') || {}).textContent || null, done: dn ? dn.getAttribute('data-cred-done') : null, doneText: dn ? dn.textContent : null, buttons: c.querySelectorAll('button').length }; })()`;
  /** One cockpit tab: the owner's cookie, the wizard dismissed, the session's view; real mouse taps and real typing. */
  async function cockpitTab(targetId?: string) {
    const tab = await until(async () => (await cdp.listTabs('cockpit', cport)).find((t) => t.type === 'page' && t.webSocketDebuggerUrl && (targetId ? t.id === targetId : true)), 15000);
    const c = await Cdp.open(tab.webSocketDebuggerUrl!);
    const ev = async (expr: string, timeoutMs = 4000) => {
      const r = await c.call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, timeoutMs);
      if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'cockpit evaluate failed');
      return r?.result?.value;
    };
    await until(async () => (await ev('document.readyState')) === 'complete', 15000);
    await c.call('Network.setCookie', { name: cname, value: cvalue, url: base, httpOnly: true });
    await ev("sessionStorage.setItem('arigami.wizardDismissed', '1'); 1");
    // every socket the cockpit opens is kept in reach, so the test can cut the tab's link to the host and keep it cut
    await c.call('Page.enable');
    await c.call('Page.addScriptToEvaluateOnNewDocument', { source: "(() => { const W = window.WebSocket; window.__sockets = []; window.__wsDead = false; const P = function (u, p) { if (window.__wsDead) return { readyState: 0, send() {}, close() {}, addEventListener() {}, removeEventListener() {} }; const s = p === undefined ? new W(u) : new W(u, p); window.__sockets.push(s); return s; }; P.prototype = W.prototype; P.CONNECTING = 0; P.OPEN = 1; P.CLOSING = 2; P.CLOSED = 3; window.WebSocket = P; })();" });
    await c.call('Page.navigate', { url: `${base}/__host/?session=${encodeURIComponent(sid)}` });
    // a real mouse click at the element's centre (what a tap is) — a disabled button swallows it, as on the owner's screen
    const click = async (sel: string) => {
      const rect = await ev(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
      if (!rect) throw new Error(`no element ${sel}`);
      await c.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y });
      await c.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
      await c.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
    };
    const type = async (sel: string, text: string) => { await ev(`document.querySelector(${JSON.stringify(sel)}).focus(); 1`); await c.call('Input.insertText', { text }); };
    const card = () => ev(CARD_JS);
    const unlock = async () => { await type('input[aria-label="Vault password"]', MASTER); await click('button[data-variant="secondary"]:not([data-cred-manual])'); };
    /** The tab's link to the host dies and cannot come back (every reconnect gets a socket that never opens); HTTP still works. */
    const cutSocket = async () => {
      await ev('window.__wsDead = true; window.__sockets.forEach((s) => s.close()); window.__sockets.length');
      await sleep(800);
    };
    return { id: tab.id, c, ev, click, type, card, unlock, cutSocket };
  }
  const A = await cockpitTab();
  const evC = A.ev, click = A.click, type = A.type, card = A.card;
  const race = <T,>(p: Promise<T>, ms: number): Promise<T | 'pending'> => Promise.race([p, sleep(ms).then(() => 'pending' as const)]);

  at('card 1');
  // ---- 1. the agent asks for id_number; the owner sees the card with the vault LOCKED in this tab ---------------------------
  const fill1 = agent(`/__api/sessions/${sid}/vault/fill`, { site: '127.0.0.1', field: 'id_number', target: 'id number', reason: 'e2e' });
  await sleep(1500);
  out.fill1Immediate = await race(fill1, 10);
  out.hostPending1 = await pending();
  const c1 = await until(card, 30000);
  out.cardLocked = c1;
  out.pageVisible = await evC("!!document.querySelector('[data-credential-request]')");
  // the owner taps Fill with nothing typed
  await click('[data-cred-fill]');
  await sleep(1200);
  out.afterFillTap = await card();
  out.stillPendingAfterTap = !!(await pending());
  out.fill1Early = await race(fill1, 10);
  // ---- 2. unlock on the card, fill from the saved entry, and grant the rest -------------------------------------------------
  if ((await card())?.unlockRow) await A.unlock();
  at('unlock → fill-from');
  const c2 = await until(async () => { const c = await card(); return c && c.fillFrom.length ? c : null; }, 30000);
  out.cardUnlocked = c2;
  if (c2.grant) await click('[data-cred-grant] input');
  out.grantText = c2.grantText;
  const t1 = Date.now();
  await click('[data-fill-from]');
  out.fill1 = await race(fill1, 20000);
  out.fill1Ms = Date.now() - t1;
  out.page1 = await evS("({ id: document.querySelector('#idn').value, masked: getComputedStyle(document.querySelector('#idn')).webkitTextSecurity, phone: document.querySelector('#ph').value })");
  out.cardGoneAfterFill = !(await until(async () => !(await card()), 10000).then(() => false, () => true));
  at('fill 2 (grant)');
  // ---- 3. the next field of the same session + origin: filled with no tap under the grant ---------------------------------
  await evS("document.querySelector('#ph').focus(); 1");
  const t2 = Date.now();
  const fill2 = agent(`/__api/sessions/${sid}/vault/fill`, { site: '127.0.0.1', field: 'phone', reason: 'e2e auto' });
  out.fill2 = await race(fill2, 15000);
  out.fill2Ms = Date.now() - t2;
  out.card2 = await card();
  out.page2 = await evS("({ phone: document.querySelector('#ph').value, masked: getComputedStyle(document.querySelector('#ph')).webkitTextSecurity })");
  const chat = await (await person('GET', `/__api/sessions/${sid}/chat`)).json();
  const lines: string[] = (Array.isArray(chat?.events) ? chat.events : Array.isArray(chat) ? chat : chat?.chat || []).map((ev: any) => String(ev?.text || ev?.content || '')).filter(Boolean);
  out.grantLine = lines.some((l) => l.includes('one-time approval'));
  out.leak = lines.some((l) => l.includes(ID_VALUE) || l.includes(PHONE_VALUE)) || fs.readFileSync(hostLog, 'utf8').includes(ID_VALUE);
  at('other origin');
  // ---- 4. another origin (localhost): the grant does not reach it — the card waits for the owner, who cancels ---------------
  if (out.fill2 !== 'pending') {
    await cdp.pageNavigate(sid, `${otherBase}/form`);
    await until(async () => evS("!!document.querySelector('#idn')"), 15000);
    await evS("document.querySelector('#idn').focus(); 1");
    const fill3 = agent(`/__api/sessions/${sid}/vault/fill`, { site: 'localhost', field: 'id_number', reason: 'e2e other origin' });
    const c3 = await until(card, 30000);
    await sleep(2500);
    out.otherPending = !!(await pending());
    out.card3 = await card();
    out.fill3Early = await race(fill3, 10);
    void c3;
    await click('button[data-variant="quiet"]'); // Cancel
    out.fill3 = await race(fill3, 15000);
    out.page3 = await evS("document.querySelector('#idn').value");

    // ---- 5. a field the grant does not name (saved later, or never): the card waits; Stop revokes the grant ------------------
    at('unlisted field + Stop');
    await cdp.pageNavigate(sid, `${pageBase}/form`);
    await until(async () => evS("!!document.querySelector('#idn')"), 15000);
    await evS("document.querySelector('#idn').focus(); 1");
    const fill5 = agent(`/__api/sessions/${sid}/vault/fill`, { site: '127.0.0.1', field: 'email', reason: 'e2e unlisted' });
    await until(card, 30000);
    await sleep(2000);
    out.card5 = await card();
    out.fill5Early = await race(fill5, 10);
    if (out.card5?.grantOn) await click('[data-cred-grant-on] button'); // Stop
    await sleep(300);
    out.card5AfterStop = await card();
    await click('button[data-variant="quiet"]'); // Cancel
    out.fill5 = await race(fill5, 15000);

    // ---- 6. a second cockpit tab; tab A loses its socket; B answers the card; A's copy is stale → the host says so ------------
    at('two tabs, stale card');
    const browser = (await (await fetch(`http://127.0.0.1:${cport}/json/version`)).json()) as any;
    const bws = await Cdp.open(browser.webSocketDebuggerUrl);
    const { targetId } = await bws.call('Target.createTarget', { url: `${base}/__health` });
    const B = await cockpitTab(targetId);
    await cdp.pageNavigate(sid, `${pageBase}/form`);
    await until(async () => evS("!!document.querySelector('#idn')"), 15000);
    await evS("document.querySelector('#idn').focus(); 1");
    const fill6 = agent(`/__api/sessions/${sid}/vault/fill`, { site: '127.0.0.1', field: 'id_number', target: 'id number', reason: 'e2e stale' });
    await until(A.card, 30000);
    await until(B.card, 30000);
    await A.cutSocket();
    if ((await B.card())?.unlockRow) await B.unlock();
    await until(async () => { const c = await B.card(); return c && c.fillFrom.length ? c : null; }, 30000);
    await B.click('[data-fill-from]');
    out.fill6 = await race(fill6, 20000);
    await sleep(1500);
    out.bCardGone = !(await B.card());
    out.aStale = await A.card(); // still up: A heard nothing
    if (out.aStale) {
      await A.click('[data-fill-from]');
      out.aAfterStaleTap = await until(async () => { const c = await A.card(); return c && (c.done || c.error) ? c : null; }, 10000);
    }
    out.page6 = await evS("document.querySelector('#idn').value");

    // ---- 7. B's socket dies too; its tap still lands over HTTP and the card shows the outcome itself ----------------------------
    at('success without socket');
    await evS("document.querySelector('#ph').focus(); 1");
    const fill7 = agent(`/__api/sessions/${sid}/vault/fill`, { site: '127.0.0.1', field: 'phone', reason: 'e2e no socket' });
    await until(async () => { const c = await B.card(); return c && c.fillFrom.length ? c : null; }, 30000);
    await B.cutSocket();
    await B.click('[data-fill-from]');
    out.fill7 = await race(fill7, 20000);
    out.bDone = await until(async () => { const c = await B.card(); return c && c.done ? c : null; }, 10000);
    out.page7 = await evS("document.querySelector('#ph').value");
    A.c.close(); B.c.close(); bws.close();
  }
} catch (e) {
  out.error = String((e as Error)?.message || e);
  try {
    const t = (await cdp.listTabs('cockpit', cdp.cdpPort('cockpit', path.join(DIR, 'cockpit-chrome')) || 0)).find((x) => x.type === 'page');
    if (t) {
      const r = await cdp.cdpCall(t.webSocketDebuggerUrl!, 'Runtime.evaluate', { expression: "({ href: location.href, title: document.title, text: document.body.innerText.slice(0, 400), card: !!document.querySelector('[data-credential-request]'), login: !!document.querySelector('input[type=password], [data-login]') })", returnByValue: true }, 3000);
      out.cockpit = r?.result?.value;
    }
  } catch (e2) { out.cockpitDiag = String((e2 as Error)?.message || e2); }
  out.hostLogTail = fs.existsSync(hostLog) ? fs.readFileSync(hostLog, 'utf8').split('\n').filter((l) => /vault|sign-in|cred|error|401|403/i.test(l)).slice(-8) : [];
} finally {
  try { chromeS?.kill('SIGKILL'); } catch {}
  try { chromeC?.kill('SIGKILL'); } catch {}
  try { host.kill('SIGTERM'); } catch {}
  page.stop(true);
}
(globalThis as any).emit(out);
