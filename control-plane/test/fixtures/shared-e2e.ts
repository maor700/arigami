// Shared workspaces, end to end WITHOUT Kubernetes — and with screenshots.
//
// Same idea as local-e2e.ts, plus the piece that one leaves out: an EDGE. Every request to a tenant host goes
// through GET /auth/verify first (what Caddy's forward_auth does in deploy/gke-lab/edge.yaml), the control-plane
// cookie is stripped before the request reaches the tenant, and websockets are proxied too. Real: the mock-IdP
// OIDC round-trip, the control-plane app, the gate, the handoff, the roster push, and a REAL tenant host booted the
// way the chart boots a shared one (ARIGAMI_SHARED_WORKSPACE=1). Simulated: Kubernetes (instant fake provisioner,
// roster pushed over plain loopback HTTP instead of kubectl exec).
//
// Everything listens on ONE free port P. Chrome maps *.localtest.me:80 -> 127.0.0.1:P (--host-resolver-rules), so
// the hostnames are the production shape (cp.localtest.me, u-<hex>.localtest.me) with no port in them, and the
// session cookie can be scoped to the parent domain exactly as CP_COOKIE_PARENT_DOMAIN=1 does.
//
//   bun test/fixtures/shared-e2e.ts <out-dir>     # writes 0N-*.png + shots.json, then tears everything down
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../src/config.js';
import { openDb, createStore, tenantIdFor, type Store, type Tenant } from '../../src/db.js';
import { createApp, type Provisioner, type AdminOps } from '../../src/server.js';
import { EMPTY_SNAPSHOT } from '../../src/progress.js';

const CP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const REPO_ROOT = path.resolve(CP_ROOT, '..');
const OUT = path.resolve(process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'shared-ws-shots-')));
fs.mkdirSync(OUT, { recursive: true });
const SECRET = crypto.randomBytes(32).toString('base64url');
const DOMAIN = 'localtest.me';
const SHARED_NS = `u-${tenantIdFor('shared:team')}`;
const SHARED_HOST = `${SHARED_NS}.${DOMAIN}`;

const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(url: string, ms = 30_000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(1500) })).ok) return;
    } catch {}
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${url}`);
}

const children: ChildProcess[] = [];
const tmpDirs: string[] = [];
function cleanup(): void {
  for (const c of children) { try { c.kill('SIGKILL'); } catch {} }
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
}
process.on('SIGINT', () => { cleanup(); process.exit(130); });
process.on('exit', cleanup);

const [idpPort, hostPort, edgePort, cdpPort] = [await freePort(), await freePort(), await freePort(), await freePort()];

// 1. mock IdP
children.push(spawn('bun', ['test/fixtures/mock-idp.ts', String(idpPort)], { cwd: CP_ROOT, stdio: ['ignore', 'ignore', 'inherit'] }));
await waitFor(`http://127.0.0.1:${idpPort}/.well-known/openid-configuration`);

// 2. the shared tenant: a real host, started like the chart starts a shared workspace
const hostDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-shared-e2e-'));
tmpDirs.push(hostDir);
fs.mkdirSync(path.join(hostDir, 'home'), { recursive: true });
fs.mkdirSync(path.join(hostDir, 'workspace'), { recursive: true });
children.push(spawn('bun', ['server/index.ts'], {
  cwd: REPO_ROOT,
  env: {
    ...process.env,
    HOME: path.join(hostDir, 'home'),
    ARIGAMI_DIR: hostDir,
    ARIGAMI_PORT: String(hostPort),
    ARIGAMI_PUBLIC_URL: `http://${SHARED_HOST}`,
    ARIGAMI_AUTH: 'pairing',
    ARIGAMI_HANDOFF_SECRET: SECRET,
    ARIGAMI_SHARED_WORKSPACE: '1',
    ARIGAMI_ORG_HOST: '1',
    ARIGAMI_SCREEN_ENABLED: '0',
    ARIGAMI_TELEMETRY: '0',
    ARIGAMI_DEFAULT_CWD: path.join(hostDir, 'workspace'),
    COMPOSIO_API_KEY: '', GH_TOKEN: '', GITHUB_TOKEN: '',
  },
  stdio: ['ignore', 'ignore', 'inherit'],
}));
await waitFor(`http://127.0.0.1:${hostPort}/__health`);

// 3. control plane
const cfg = loadConfig({
  CP_PORT: String(edgePort),
  CP_PUBLIC_URL: `http://cp.${DOMAIN}`,
  CP_COOKIE_PARENT_DOMAIN: '1',
  CP_OIDC_ISSUER: `http://127.0.0.1:${idpPort}`,
  CP_OIDC_CLIENT_ID: 'arigami-shared-e2e',
  CP_OIDC_CLIENT_SECRET: 'shared-e2e',
  ALLOWED_EMAIL_DOMAINS: 'example.com',
  CP_ORG_DOMAIN: DOMAIN,
  CP_ORG_NAME: 'Example Org',
  CP_URL_SCHEME: 'http',
  CP_IMAGE_TAG: 'shared-e2e',
  CP_RECONCILE_SEC: '0',
  CP_BACKUP_INTERVAL_SEC: '0',
} as unknown as NodeJS.ProcessEnv);
const base = createStore(openDb(':memory:'));
const store: Store = { ...base, createTenant: (s, e, o) => base.createTenant(s, e, { ...o, handoffSecret: SECRET }) };
const provisioner: Provisioner = {
  async provisionTenant(_c, t: Tenant) { await sleep(300); return { url: `http://${t.ns}.${DOMAIN}` }; },
  async deleteTenant() {},
  async suspendTenant() {},
  async resumeTenant() {},
};
const adminOps: AdminOps = {
  async backupTenant() { return { name: 'n/a', bytes: 0 }; },
  listBackups: () => [],
  async podSnapshot() { return { ...EMPTY_SNAPSHOT }; },
  // production does this through `kubectl exec … curl 127.0.0.1` inside the pod; same request, minus the exec
  async pushRoster(_c, t, token) {
    if (t.ns !== SHARED_NS) throw new Error('only the shared tenant is real in this harness');
    const r = await fetch(`http://127.0.0.1:${hostPort}/__api/auth/roster`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ t: token }) });
    if (!r.ok) throw new Error(`roster push ${r.status}: ${await r.text()}`);
  },
};
const log: string[] = [];
const app = createApp(cfg, store, provisioner, (m) => log.push(m), adminOps);

// 4. the edge
type WsData = { target: string; headers: Record<string, string>; up?: WebSocket; queue: (string | Buffer)[] };
const stripCp = (c: string | null) => (c || '').split(';').map((s) => s.trim()).filter((s) => s && !s.startsWith('arigami_cp_sid=')).join('; ');
Bun.serve<WsData>({
  port: edgePort,
  hostname: '127.0.0.1',
  idleTimeout: 60,
  async fetch(req, server) {
    const host = (req.headers.get('host') || '').split(':')[0].toLowerCase();
    const u = new URL(req.url);
    if (host === `cp.${DOMAIN}`) return app.handle(new Request(`${cfg.publicUrl}${u.pathname}${u.search}`, req));
    // forward_auth
    const v = await app.handle(new Request(`${cfg.publicUrl}/auth/verify`, {
      headers: { host, 'x-forwarded-host': host, 'x-forwarded-uri': u.pathname + u.search, cookie: req.headers.get('cookie') || '' },
    }));
    if (v.status !== 200) return v;
    if (host !== SHARED_HOST) return new Response('personal tenants are not running in this harness\n', { status: 502 });
    const headers = new Headers(req.headers);
    headers.set('cookie', stripCp(req.headers.get('cookie')));
    if ((req.headers.get('upgrade') || '').toLowerCase() === 'websocket') {
      const h: Record<string, string> = { cookie: headers.get('cookie') || '' };
      if (req.headers.get('origin')) h.origin = req.headers.get('origin')!;
      return server.upgrade(req, { data: { target: `ws://127.0.0.1:${hostPort}${u.pathname}${u.search}`, headers: h, queue: [] } })
        ? undefined
        : new Response('upgrade failed', { status: 400 });
    }
    const r = await fetch(`http://127.0.0.1:${hostPort}${u.pathname}${u.search}`, {
      method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : await req.arrayBuffer(), redirect: 'manual',
    });
    const out = new Headers(r.headers);
    out.delete('content-encoding');
    out.delete('content-length');
    return new Response(r.body, { status: r.status, headers: out });
  },
  websocket: {
    open(ws) {
      const up = new WebSocket(ws.data.target, { headers: ws.data.headers } as any);
      ws.data.up = up;
      up.onopen = () => { for (const m of ws.data.queue.splice(0)) up.send(m); };
      up.onmessage = (e) => { try { ws.send(e.data as any); } catch {} };
      up.onclose = () => { try { ws.close(); } catch {} };
      up.onerror = () => { try { ws.close(); } catch {} };
    },
    message(ws, m) {
      if (ws.data.up?.readyState === 1) ws.data.up.send(m as any);
      else ws.data.queue.push(m as any);
    },
    close(ws) { try { ws.data.up?.close(); } catch {} },
  },
});

// 5. headless Chrome over CDP
const chromeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-e2e-chrome-'));
tmpDirs.push(chromeDir);
children.push(spawn('google-chrome-stable', [
  '--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${chromeDir}`,
  `--host-resolver-rules=MAP *.${DOMAIN}:80 127.0.0.1:${edgePort}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-extensions', '--disable-dev-shm-usage',
  '--renderer-process-limit=2', '--window-size=1280,860', 'about:blank',
], { stdio: 'ignore' }));
await waitFor(`http://127.0.0.1:${cdpPort}/json/version`);
const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json() as any;
const cdp = new WebSocket(webSocketDebuggerUrl);
await new Promise((r) => (cdp.onopen = r));
let seq = 0;
const pending = new Map<number, (v: any) => void>();
const listeners: ((m: any) => void)[] = [];
cdp.onmessage = (e) => {
  const m = JSON.parse(String(e.data));
  if (m.id && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); } else for (const l of listeners) l(m);
};
function send(method: string, params: any = {}, sessionId?: string): Promise<any> {
  const id = ++seq;
  cdp.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  return new Promise((res, rej) => pending.set(id, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result))));
}

/** One person = one isolated browser context (own cookie jar). */
async function person() {
  const { browserContextId } = await send('Target.createBrowserContext', { disposeOnDetach: true });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank', browserContextId });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const s = (m: string, p: any = {}) => send(m, p, sessionId);
  await s('Page.enable');
  await s('Runtime.enable');
  await s('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
  const loaded = () => new Promise<void>((res) => {
    const l = (m: any) => { if (m.sessionId === sessionId && m.method === 'Page.loadEventFired') { listeners.splice(listeners.indexOf(l), 1); res(); } };
    listeners.push(l);
    setTimeout(res, 15_000);
  });
  const go = async (url: string, settle = 600) => { const w = loaded(); await s('Page.navigate', { url }); await w; await sleep(settle); };
  const evalJs = async (expr: string) => (await s('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.value;
  const click = async (selectorJs: string, settle = 800) => {
    const w = loaded();
    const ok = await evalJs(`(() => { const el = ${selectorJs}; if (!el) return false; el.click(); return true; })()`);
    if (!ok) throw new Error(`nothing to click: ${selectorJs}`);
    await Promise.race([w, sleep(2500)]);
    await sleep(settle);
  };
  // The mock IdP's "login screen" is the query string (&email= on /authorize) and it answers at once, so the
  // browser's authorize request is rewritten on the way out (Fetch domain) to say who this person is.
  let who = '';
  await s('Fetch.enable', { patterns: [{ urlPattern: `http://127.0.0.1:${idpPort}/authorize*`, requestStage: 'Request' }] });
  listeners.push((m: any) => {
    if (m.sessionId !== sessionId || m.method !== 'Fetch.requestPaused') return;
    s('Fetch.continueRequest', { requestId: m.params.requestId, url: `${m.params.request.url}&email=${encodeURIComponent(who)}` }).catch(() => {});
  });
  const signIn = async (email: string, rd: string) => {
    who = email;
    await go(`http://cp.${DOMAIN}/auth/login?rd=${encodeURIComponent(rd)}`, 1000);
  };
  return { s, go, evalJs, click, signIn, shot: async (file: string) => {
    const { data } = await s('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, file), Buffer.from(data, 'base64'));
  } };
}

const shots: { file: string; caption: string; url: string }[] = [];
const notes: string[] = [];
const record = async (p: Awaited<ReturnType<typeof person>>, file: string, caption: string) => {
  await p.shot(file);
  shots.push({ file, caption, url: String(await p.evalJs('location.href')) });
};
const bodyText = (p: Awaited<ReturnType<typeof person>>) => p.evalJs('document.body.innerText').then(String);

try {
  // The mock IdP authorizes immediately; the FIRST org user becomes org-admin.
  const admin = await person();
  await admin.signIn('boss@example.com', '/admin');

  // (1) create the shared workspace from the admin page
  await admin.evalJs(`(() => { const f = document.querySelector('form[action="/admin/shared"]'); f.name.value = 'team'; f.policy.value = 'explicit'; f.default_role.value = 'member'; f.org_host.checked = true; })()`);
  await admin.click(`document.querySelector('form[action="/admin/shared"] button')`);
  await sleep(700);
  await admin.go(`http://cp.${DOMAIN}/admin`);
  if (store.findShared('team')?.state !== 'running') notes.push('shared workspace did not reach running');
  await admin.evalJs(`document.querySelector('h2') && [...document.querySelectorAll('h2')].find(h => h.textContent.includes('Shared'))?.scrollIntoView()`);
  await record(admin, '01-admin-created.png', 'Org-admin page after creating the shared workspace "team" (explicit member list, org host). It has no members yet: creating it did not make the admin a member.');

  // (2) three members
  for (const [email, role] of [['alice@example.com', 'admin'], ['bob@example.com', 'member'], ['vera@example.com', 'viewer']]) {
    await admin.evalJs(`(() => { const f = document.querySelector('form[action="/admin/shared/team/members"]'); f.email.value = '${email}'; f.role.value = '${role}'; })()`);
    await admin.click(`document.querySelector('form[action="/admin/shared/team/members"] button')`);
  }
  await admin.evalJs(`[...document.querySelectorAll('h2')].find(h => h.textContent.includes('Shared'))?.scrollIntoView()`);
  await record(admin, '02-members-added.png', 'Three members added from the admin page: alice (admin), bob (member), vera (viewer). Each change pushes the member list into the workspace; no "not yet applied" warning means the push landed.');

  // (3) bob signs in and sees the picker
  const bob = await person();
  await bob.signIn('bob@example.com', '/workspaces');
  await record(bob, '03-member-picker.png', 'bob signs in through the org IdP and opens /workspaces: his own workspace, plus "team" with his role (member).');

  // (4) bob opens it and lands inside the cockpit as himself
  await bob.click(`[...document.querySelectorAll('a')].find(a => a.getAttribute('href') === '/workspaces/team/open')`, 2500);
  await record(bob, '04a-member-in-cockpit.png', 'Open: the control plane checks membership and hands bob into the workspace host. He lands in the cockpit with no pairing code.');
  await bob.go(`http://${SHARED_HOST}/__host/#/settings/host`, 2500);
  const bobSettings = await bodyText(bob);
  if (!bobSettings.includes('bob@example.com')) notes.push('settings page did not show bob@example.com');
  await bob.evalJs(`(() => { const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) if (n.textContent.includes('bob@example.com')) { n.parentElement.scrollIntoView({ block: 'center' }); n.parentElement.style.outline = '2px solid #e5484d'; return; } })()`);
  await sleep(400);
  await record(bob, '04b-member-identity.png', 'The same session, Settings, Host: "You" shows bob@example.com with role user (member). He is signed in as himself, not as a shared identity.');

  // (5) the viewer tries to act
  const vera = await person();
  await vera.signIn('vera@example.com', '/workspaces/team/open');
  await sleep(2000);
  // Starting a session is the first step of every turn; the composer on the home screen does exactly this POST.
  const refused = await vera.evalJs(`fetch('/__api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'hello' }) }).then(async r => r.status + ' ' + await r.text())`);
  await vera.click(`[...document.querySelectorAll('button')].find(b => b.textContent.trim().endsWith('New session'))`, 1500);
  const turnUi = await vera.evalJs(`(async () => {
    const ta = [...document.querySelectorAll('textarea')].find(t => t.offsetParent); if (!ta) return 'no composer';
    ta.focus(); return 'ok';
  })()`);
  if (turnUi === 'ok') {
    await vera.s('Input.insertText', { text: 'Summarise the open pull requests' });
    await sleep(300);
    await vera.s('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await vera.s('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await sleep(2000);
  } else notes.push(`viewer: ${turnUi}`);
  await vera.evalJs(`(() => { const d = document.createElement('div'); d.id = '__shot_note'; d.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:99999;background:#1a1a1a;color:#fff;font:13px/1.4 monospace;padding:8px 12px;border-radius:6px;max-width:760px'; d.textContent = 'POST /__api/sessions as vera (viewer) -> ' + ${JSON.stringify(String(refused))}; document.body.appendChild(d); })()`);
  await record(vera, '05-viewer-refused.png', 'vera (viewer) is in the cockpit and types a prompt. The host refuses to start the turn: 403 "viewers can look but not act in this workspace". The black strip at the bottom is a harness overlay showing the raw response of the same request.');
  if (!String(refused).startsWith('403')) notes.push(`viewer turn was not refused: ${refused}`);

  // (6) admin removes bob; bob's next request is denied
  await admin.go(`http://cp.${DOMAIN}/admin`);
  await admin.click(`[...document.querySelectorAll('form[action="/admin/shared/team/members/remove"]')].find(f => f.email.value === 'bob@example.com').querySelector('button')`);
  await admin.evalJs(`[...document.querySelectorAll('h2')].find(h => h.textContent.includes('Shared'))?.scrollIntoView()`);
  await record(admin, '06a-member-removed.png', 'The admin removes bob. The edge stops letting him in right away, and the new member list is pushed into the workspace, which drops his sessions, tokens and open sockets.');
  await bob.go(`http://${SHARED_HOST}/__host/`, 1200);
  const bobAfter = await bodyText(bob);
  await record(bob, '06b-removed-member-denied.png', `bob reloads the workspace: the gate answers 403 ("${bobAfter.trim().slice(0, 80)}").`);
  if (!/not open to bob/.test(bobAfter)) notes.push(`removed member got: ${bobAfter.slice(0, 120)}`);
  const inPod = await fetch(`http://127.0.0.1:${hostPort}/__api/auth/me`, { headers: { cookie: (await bob.s('Network.getCookies', { urls: [`http://${SHARED_HOST}/`] }).catch(() => ({ cookies: [] }))).cookies?.map((c: any) => `${c.name}=${c.value}`).join('; ') || '' } });
  if (inPod.status !== 401) notes.push(`removed member's tenant cookie still answers ${inPod.status} directly at the pod`);

  // (7) a non-member asks for the workspace host
  const eve = await person();
  await eve.signIn('eve@example.com', '/workspaces');
  await eve.go(`http://${SHARED_HOST}/__host/`, 1000);
  await record(eve, '07-non-member-denied.png', 'eve is a signed-in org user but not a member. Requesting the workspace host directly gets 403 from the gate.');
  await eve.go(`http://cp.${DOMAIN}/workspaces`);
  if ((await bodyText(eve)).includes('team')) notes.push('non-member picker lists team');
  await record(eve, '07b-non-member-picker.png', 'eve\'s workspace picker: her own workspace only. "team" is not listed for a non-member.');
} catch (e) {
  notes.push(`harness error: ${(e as Error).message}`);
  console.error(e);
} finally {
  fs.writeFileSync(path.join(OUT, 'shots.json'), JSON.stringify({ shots, notes, log }, null, 2));
  console.log(JSON.stringify({ out: OUT, shots: shots.length, notes }, null, 2));
  try { cdp.close(); } catch {}
  cleanup();
  process.exit(0);
}
