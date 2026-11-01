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
const host = spawn('bun', ['server/index.ts'], {
  cwd: ROOT,
  env: { ...process.env, HOME: home, ARIGAMI_DIR: DIR, ARIGAMI_PORT: String(port), ARIGAMI_AUTH: 'pairing', ARIGAMI_HANDOFF_SECRET: SECRET, ARIGAMI_SCREEN_ENABLED: '0', ARIGAMI_TELEMETRY: '0', ARIGAMI_CLAUDE_BIN: stub, ARIGAMI_DEFAULT_CWD: ws, COMPOSIO_API_KEY: '', GH_TOKEN: '', GITHUB_TOKEN: '', ...(process.env.E2E_ROOT ? { ARIGAMI_ROOT: process.env.E2E_ROOT } : {}) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
host.stdout!.on('data', (d) => fs.appendFileSync(hostLog, String(d)));
host.stderr!.on('data', (d) => fs.appendFileSync(hostLog, String(d)));

const out: Record<string, unknown> = {};
let chromeS: ReturnType<typeof spawn> | null = null;
let chromeC: ReturnType<typeof spawn> | null = null;
try {
  at('host health');
  await until(async () => (await fetch(base + '/__health', { signal: AbortSignal.timeout(2000) })).ok, 45000);
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
  const ctab = async () => (await cdp.listTabs('cockpit', cport)).find((t) => t.type === 'page' && t.webSocketDebuggerUrl)!;
  const evC = async (expr: string, timeoutMs = 4000) => {
    const t = await ctab();
    const r = await cdp.cdpCall(t.webSocketDebuggerUrl!, 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, timeoutMs);
    if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'cockpit evaluate failed');
    return r?.result?.value;
  };
  const cwsOf = async () => (await ctab()).webSocketDebuggerUrl!;
  at('cockpit ready');
  await until(async () => (await ctab()) && (await evC('document.readyState')) === 'complete', 15000);
  const [cname, cvalue] = cookie.split('=');
  await cdp.cdpCall(await cwsOf(), 'Network.setCookie', { name: cname, value: cvalue, url: base, httpOnly: true });
  await evC("sessionStorage.setItem('arigami.wizardDismissed', '1'); 1");
  await cdp.cdpCall(await cwsOf(), 'Page.navigate', { url: `${base}/__host/?session=${encodeURIComponent(sid)}` });
  // a real mouse click at the element's centre (what a tap is) — a disabled button swallows it, as on the owner's screen
  const click = async (sel: string) => {
    const rect = await evC(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    if (!rect) throw new Error(`no element ${sel}`);
    const wsu = await cwsOf();
    await cdp.cdpCall(wsu, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y });
    await cdp.cdpCall(wsu, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
    await cdp.cdpCall(wsu, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
  };
  const type = async (sel: string, text: string) => {
    await evC(`document.querySelector(${JSON.stringify(sel)}).focus(); 1`);
    await cdp.cdpCall(await cwsOf(), 'Input.insertText', { text });
  };
  const card = () => evC(`(() => { const c = document.querySelector('[data-credential-request]'); if (!c) return null; const f = c.querySelector('[data-cred-fill]'); const st = c.querySelector('[data-cred-state]'); const er = c.querySelector('[data-cred-error]'); return { id: c.getAttribute('data-credential-request'), fillDisabled: f ? f.disabled : null, fillText: f ? f.textContent : null, state: st ? st.getAttribute('data-cred-state') : null, error: er ? er.textContent : null, unlockRow: !!c.querySelector('input[aria-label="Vault password"]'), fillFrom: [...c.querySelectorAll('[data-fill-from]')].map((b) => b.getAttribute('data-fill-from')), grant: !!c.querySelector('[data-cred-grant]'), grantOn: !!c.querySelector('[data-cred-grant-on]'), autoError: (c.querySelector('[data-cred-auto-error]') || {}).textContent || null }; })()`);
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
  if ((await card())?.unlockRow) {
    await type('input[aria-label="Vault password"]', MASTER);
    await click('button[data-variant="secondary"]:not([data-cred-manual])'); // Unlock
  }
  at('unlock → fill-from');
  const c2 = await until(async () => { const c = await card(); return c && c.fillFrom.length ? c : null; }, 30000);
  out.cardUnlocked = c2;
  if (c2.grant) await click('[data-cred-grant] input');
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
