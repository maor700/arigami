#!/usr/bin/env bun
// RESUME benchmark — how long a phone waits, and how many bytes it pulls, when
// the cockpit comes back from the background.
//
//   bun scripts/bench-resume.ts --root <repo checkout> --label after [--runs 2]
//        [--state ~/.arigami/state.json] [--out result.json] [--record frames-dir]
//
// What it does, all on loopback and in throwaway dirs (nothing touches the live host):
//   1. copies a real state.json (+ the chat logs of three sessions) into a tmp
//      ARIGAMI_DIR — home paths rewritten so the bench host can't reach a real
//      worktree, listeners stopped so nothing polls GitHub — and boots
//      `bun server/index.ts` from --root against it (auth off, fake engines);
//   2. puts a SHAPING PROXY in front of it: Slow-4G-like (562ms RTT, 1.44Mbit/s
//      down, 675kbit/s up, one shared link per direction) — it also counts the
//      real bytes on the wire (after any compression) per direction;
//   3. drives headless Chrome over CDP with a phone profile (390×844 @3x, touch,
//      4× CPU throttle): cold load → open three chats → "background" the page
//      (visibility hidden + lifecycle frozen; the proxy turns the WebSocket into a
//      GHOST — open on the phone, dead on the wire — and drops idle HTTP sockets,
//      which is what a phone that slept actually has) → while hidden the host
//      renames the open session and three others and appends a chat card to the
//      open chat → "foreground" → time until the open chat shows the new card AND
//      the new title, and the bytes/requests the resume cost.
// Two hide lengths per run: SHORT (8s: the ghost survives server-side, the
// client's wake probe decides) and LONG (65s: the host's heartbeat has already
// dropped the ghost).
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const arg = (k: string, d?: string) => {
  const i = args.indexOf(`--${k}`);
  return i > -1 ? args[i + 1] : d;
};
const ROOT = path.resolve(arg('root', process.cwd())!);
const LABEL = arg('label', path.basename(ROOT))!;
const RUNS = Number(arg('runs', '2'));
const SRC_STATE = arg('state', path.join(os.homedir(), '.arigami', 'state.json'))!;
const OUT = arg('out');
const RECORD = arg('record'); // a dir: screenshots every 200ms through ONE extra long-hide resume
const SHORT_HIDE_MS = Number(arg('short', '8000'));
const LONG_HIDE_MS = Number(arg('long', '65000'));
const SCRATCH = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bench-resume-'));
const CHROME = process.env.CHROME_BIN || '/usr/bin/google-chrome';

// Chrome DevTools' "Slow 4G" preset (M120+): 150ms × 3.75 RTT, 1.6Mbit/s × 0.9 down, 750kbit/s × 0.9 up.
const NET = { rttMs: 562.5, downBps: (1.6e6 * 0.9) / 8, upBps: (750e3 * 0.9) / 8 };
const CPU_RATE = 4;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const freePort = () =>
  new Promise<number>((res) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => res(p));
    });
  });

// ---------------------------------------------------------------- bench state
function prepareDir() {
  const dir = path.join(SCRATCH, 'host');
  fs.mkdirSync(path.join(dir, 'chat'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'workspace'), { recursive: true });
  const home = os.homedir();
  const raw = fs.readFileSync(SRC_STATE, 'utf8').split(home).join('/nonexistent-bench-home');
  const st = JSON.parse(raw);
  for (const l of st.listeners || []) l.status = 'stopped';
  const sessions: any[] = Array.isArray(st.sessions) ? st.sessions : Object.values(st.sessions);
  const srcChat = path.join(path.dirname(SRC_STATE), 'chat');
  const size = (id: string) => {
    try { return fs.statSync(path.join(srcChat, `${id}.jsonl`)).size; } catch { return 0; }
  };
  const picks = sessions
    .filter((s) => !s.archived && size(s.id) > 100e3 && size(s.id) < 2.5e6)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .slice(0, 3);
  if (picks.length < 3) throw new Error('need three sessions with a 100KB–2.5MB chat log');
  for (const s of picks) fs.copyFileSync(path.join(srcChat, `${s.id}.jsonl`), path.join(dir, 'chat', `${s.id}.jsonl`));
  const others = sessions.filter((s) => !s.archived && !picks.includes(s)).slice(0, 3);
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(st));
  return { dir, open: picks[0].id, loaded: picks.slice(1).map((s) => s.id), others: others.map((s) => s.id), count: sessions.length };
}

async function startHost(dir: string, port: number): Promise<ChildProcess> {
  const fake = path.join(ROOT, 'test', '_fake-claude.js');
  const host = spawn('bun', ['server/index.ts'], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH,
      HOME: dir,
      TMPDIR: SCRATCH,
      ARIGAMI_DIR: dir,
      ARIGAMI_STATE_FILE: path.join(dir, 'state.json'),
      ARIGAMI_PORT: String(port),
      ARIGAMI_BIND: '127.0.0.1',
      ARIGAMI_AUTH: 'off',
      ARIGAMI_SCREEN_ENABLED: '0',
      ARIGAMI_CLAUDE_BIN: fake,
      ARIGAMI_CODEX_BIN: fake,
      ARIGAMI_TELEMETRY: '0',
      ARIGAMI_ENGINE_AUTOPICK: '0',
      ARIGAMI_OWNER_CHROME: '0',
      ARIGAMI_WA_DATA_DIR: path.join(dir, 'wa'),
      ARIGAMI_DEFAULT_CWD: path.join(dir, 'workspace'),
    },
    stdio: ['ignore', fs.openSync(path.join(SCRATCH, 'host.log'), 'a'), fs.openSync(path.join(SCRATCH, 'host.log'), 'a')],
  });
  for (let i = 0; i < 150; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/__api/sessions`);
      if (r.ok) return host;
    } catch {}
    await sleep(200);
  }
  throw new Error(`bench host did not come up — see ${SCRATCH}/host.log`);
}

// ---------------------------------------------------------------- shaping proxy
type Conn = { client: net.Socket; up: net.Socket; ws: boolean; ghost: boolean; sniffed: boolean };
class Link {
  free = 0;
  private q: { at: number; fn: () => void }[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(private bps: number, private oneWayMs: number) {}
  // FIFO serialisation at the link rate, then the propagation delay. ONE pump
  // drains the queue in order — a timer per chunk can fire same-millisecond
  // chunks out of order and corrupt the stream (seen as ERR_INVALID_CHUNKED_ENCODING).
  send(fn: () => void, bytes: number) {
    const now = Date.now();
    const start = Math.max(now, this.free);
    this.free = start + (bytes / this.bps) * 1000;
    this.q.push({ at: this.free + this.oneWayMs, fn });
    if (!this.timer) this.pump();
  }
  private pump() {
    this.timer = null;
    const now = Date.now();
    while (this.q.length && this.q[0].at <= now) this.q.shift()!.fn();
    if (this.q.length) this.timer = setTimeout(() => this.pump(), Math.max(0, this.q[0].at - Date.now()));
  }
}
function startProxy(listenPort: number, hostPort: number) {
  const down = new Link(NET.downBps, NET.rttMs / 2);
  const up = new Link(NET.upBps, NET.rttMs / 2);
  const conns = new Set<Conn>();
  const stats = { down: 0, up: 0, conns: 0, wsConns: 0, lastAt: Date.now() };
  const server = net.createServer((client) => {
    const upstream = net.connect(hostPort, '127.0.0.1');
    const c: Conn = { client, up: upstream, ws: false, ghost: false, sniffed: false };
    conns.add(c);
    stats.conns++;
    // the TCP handshake costs one RTT before the first byte can go out
    let ready = false;
    const held: Buffer[] = [];
    setTimeout(() => { ready = true; for (const b of held.splice(0)) fwdUp(b); }, NET.rttMs);
    const fwdUp = (b: Buffer) => {
      if (c.ghost) return;
      stats.up += b.length; stats.lastAt = Date.now();
      up.send(() => { if (!upstream.destroyed) upstream.write(b); }, b.length);
    };
    client.on('data', (b: Buffer) => {
      if (!c.sniffed) {
        c.sniffed = true;
        if (/\r\nupgrade:\s*websocket/i.test(b.toString('latin1', 0, Math.min(b.length, 4096)))) { c.ws = true; stats.wsConns++; }
      }
      if (!ready) held.push(b); else fwdUp(b);
    });
    upstream.on('data', (b: Buffer) => {
      if (c.ghost) return;
      stats.down += b.length; stats.lastAt = Date.now();
      down.send(() => { if (!client.destroyed) client.write(b); }, b.length);
    });
    const endBoth = () => {
      conns.delete(c);
      if (c.ghost) { upstream.destroy(); return; } // a ghost never tells the phone
      down.send(() => client.destroy(), 0);
      upstream.destroy();
    };
    upstream.on('close', endBoth);
    upstream.on('error', () => {});
    client.on('close', () => { conns.delete(c); upstream.destroy(); });
    client.on('error', () => {});
  });
  server.listen(listenPort, '127.0.0.1');
  return {
    stats,
    reset() { stats.down = stats.up = stats.conns = stats.wsConns = 0; stats.lastAt = Date.now(); },
    // The phone went to sleep: the WebSocket stays "open" on the phone and goes
    // silent on the wire; every other socket is gone.
    sleep() {
      for (const c of conns) {
        if (c.ws) c.ghost = true;
        else { c.client.destroy(); c.up.destroy(); conns.delete(c); }
      }
    },
    close() { server.close(); for (const c of conns) { c.client.destroy(); c.up.destroy(); } },
  };
}

// ---------------------------------------------------------------- CDP
class Cdp {
  ws!: WebSocket;
  id = 0;
  pending = new Map<number, (v: any) => void>();
  handlers: ((m: any) => void)[] = [];
  async open(url: string) {
    this.ws = new WebSocket(url);
    await new Promise((r, j) => { this.ws.onopen = r; this.ws.onerror = j; });
    this.ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)!(m); this.pending.delete(m.id); }
      else for (const h of this.handlers) h(m);
    };
  }
  send(method: string, params: any = {}): Promise<any> {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((r) => this.pending.set(id, (m) => r(m.error ? { error: m.error } : m.result)));
  }
  async eval<T = any>(expr: string): Promise<T> {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return r?.result?.value;
  }
}

async function startChrome() {
  const port = await freePort();
  const prof = path.join(SCRATCH, `chrome-${port}`);
  const proc = spawn(CHROME, [
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--no-sandbox',
    `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, '--window-size=390,844',
    // the bench drives visibility itself; keep Chrome from throttling the "hidden" page on its own
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', 'about:blank',
  ], { stdio: 'ignore' });
  let target: any;
  for (let i = 0; i < 100 && !target; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t: any) => t.type === 'page'); } catch {}
    if (!target) await sleep(100);
  }
  const cdp = new Cdp();
  await cdp.open(target.webSocketDebuggerUrl);
  return { proc, cdp };
}

const VISIBILITY_SHIM = `(() => {
  // the bench host never ran onboarding — keep the first-run wizard from taking the screen
  try { sessionStorage.setItem('arigami.wizardDismissed', '1'); } catch {}
  let hidden = false;
  Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get: () => hidden });
  Object.defineProperty(Document.prototype, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
  window.__benchHide = (h) => {
    hidden = h;
    document.dispatchEvent(new Event('visibilitychange'));
    if (!h) window.dispatchEvent(new Event('focus'));
  };
})();`;

// page errors, printed if a cold load never becomes interactive
const pageErrors: string[] = [];
async function phone(cdp: Cdp) {
  cdp.handlers.push((m) => {
    if (m.method === 'Runtime.exceptionThrown') pageErrors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') pageErrors.push(m.params.args?.map((a: any) => a.value ?? a.description).join(' '));
    if (m.method === 'Network.loadingFailed') pageErrors.push(`load failed: ${m.params.errorText} ${m.params.blockedReason || ''}`);
  });
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: false });
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await cdp.send('Emulation.setUserAgentOverride', {
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_RATE });
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: VISIBILITY_SHIM });
}

// requests the page made (http + ws handshakes), by URL path
function requestLog(cdp: Cdp) {
  const log: string[] = [];
  cdp.handlers.push((m) => {
    if (m.method === 'Network.requestWillBeSent') {
      const u = new URL(m.params.request.url);
      if (u.protocol.startsWith('http')) log.push(`${m.params.request.method} ${u.pathname}${u.search}`);
    }
    if (m.method === 'Network.webSocketCreated') log.push(`WS ${new URL(m.params.url).pathname}`);
  });
  return log;
}

async function waitFor(cdp: Cdp, expr: string, timeoutMs: number, everyMs = 50): Promise<number | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await cdp.eval<boolean>(expr)) return Date.now() - t0;
    await sleep(everyMs);
  }
  return null;
}

// traffic quiet for `quietMs` (cap `maxMs`) — the end of a measurement window
async function settle(proxy: ReturnType<typeof startProxy>, quietMs = 2500, maxMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs && Date.now() - proxy.stats.lastAt < quietMs) await sleep(100);
}

const api = (port: number) => async (method: string, p: string, body?: unknown) => {
  const r = await fetch(`http://127.0.0.1:${port}/__api${p}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return r.json().catch(() => null);
};

// ---------------------------------------------------------------- one run
async function run(n: number, ctx: Awaited<ReturnType<typeof boot>>, record?: string) {
  const { cdp, proxy, bench, call, base } = ctx;
  const log = requestLog(cdp);
  const chatShown = (id: string) =>
    `(()=>{const s=location.hash.includes(${JSON.stringify(id)});return s && document.querySelectorAll('[data-event-id]').length>3})()`;

  // ---- cold load
  proxy.reset();
  log.length = 0;
  const c0 = Date.now();
  await cdp.send('Page.navigate', { url: `${base}/#/session/${bench.open}` });
  const coldMs = await waitFor(cdp, chatShown(bench.open), Number(arg('coldmax', '90000')), 100);
  const coldRequests = log.length;
  if (coldMs == null) console.error('[cold] page errors:', pageErrors.slice(-8).map((e) => String(e).slice(0, 400)));
  if (coldMs == null)
    console.error('[cold] not interactive:', JSON.stringify(await cdp.eval(`({hash: location.hash, rows: document.querySelectorAll('[data-event-id]').length, pill: document.querySelector('[data-conn-state]')?.textContent, text: document.body.textContent.slice(0, 300)})`)));
  await settle(proxy);
  console.error(`[${LABEL}] run ${n} cold: interactive ${coldMs}ms, ${(proxy.stats.down / 1024).toFixed(1)}KB down`);
  const cold = { ms: coldMs, down: proxy.stats.down, up: proxy.stats.up, requests: log.slice(), wallMs: Date.now() - c0 };

  // open the two other chats so the resume has "other loaded chats" to deal with
  for (const id of [...bench.loaded, bench.open]) {
    await cdp.eval(`location.hash = '#/session/${id}'`);
    const ms = await waitFor(cdp, chatShown(id), 60000, 100);
    console.error(`[${LABEL}] run ${n} opened ${id}: ${ms}ms`);
  }
  await settle(proxy, 1500);

  const out: any = { cold: { ...cold, requestsUntilInteractive: coldRequests } };
  for (const [kind, hideMs] of [['short', SHORT_HIDE_MS], ['long', LONG_HIDE_MS]] as const) {
    if (record && kind === 'short') continue;
    // ---- background
    await cdp.eval('window.__benchHide(true)');
    const frz = await cdp.send('Page.setWebLifecycleState', { state: 'frozen' });
    proxy.sleep();
    const stamp = `${kind}-${n}-${Date.now() % 100000}`;
    await call('PATCH', `/sessions/${bench.open}`, { title: `Bench ${stamp}` });
    for (const id of bench.others) await call('PATCH', `/sessions/${id}`, { title: `Bench other ${stamp}` });
    const card = await call('POST', `/sessions/${bench.open}/ui`, { ui: `root = Stack([TextContent("resumed ${stamp}")])`, title: `bench ${stamp}` });
    await call('POST', `/sessions/${bench.loaded[0]}/ui`, { ui: `root = Stack([TextContent("side ${stamp}")])`, title: `side ${stamp}` });
    await sleep(hideMs);

    // ---- foreground
    proxy.reset();
    log.length = 0;
    let frames = 0;
    let shooting = !!record;
    const shoot = async () => {
      const t0 = Date.now();
      while (shooting) {
        const shot = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 70 });
        if (shot?.data) fs.writeFileSync(path.join(record!, `f${String(frames++).padStart(4, '0')}-${Date.now() - t0}.jpg`), Buffer.from(shot.data, 'base64'));
        await sleep(150);
      }
    };
    if (!frz?.error) await cdp.send('Page.setWebLifecycleState', { state: 'active' });
    const t0 = Date.now();
    const shooter = record ? shoot() : null;
    await cdp.eval('window.__benchHide(false)');
    const freshExpr = `(()=>{const m=document.body.textContent;return m.includes(${JSON.stringify(`Bench ${stamp}`)}) && !!document.querySelector('[data-event-id=${JSON.stringify(card?.event_id || 'none')}]')})()`;
    const pillExpr = `!!document.querySelector('[data-conn-state]')`;
    let pillSeen = false;
    let freshMs: number | null = null;
    while (Date.now() - t0 < 60000) {
      const [fresh, pill] = await cdp.eval<[boolean, boolean]>(`[${freshExpr}, ${pillExpr}]`);
      if (pill) pillSeen = true;
      if (fresh) { freshMs = Date.now() - t0; break; }
      await sleep(50);
    }
    const reqUntilFresh = log.slice();
    await settle(proxy);
    if (record) { await sleep(1500); shooting = false; await shooter; }
    out[kind] = { hideMs, freshMs, down: proxy.stats.down, up: proxy.stats.up, conns: proxy.stats.conns, pillSeen, requestsUntilFresh: reqUntilFresh, requests: log.slice(), frozen: !frz?.error };
    console.error(`[${LABEL}] run ${n} ${kind}: fresh ${freshMs}ms, ${(proxy.stats.down / 1024).toFixed(1)}KB down, ${log.length} requests`);
  }
  return out;
}

async function boot() {
  const bench = prepareDir();
  const hostPort = await freePort();
  const proxyPort = await freePort();
  const host = await startHost(bench.dir, hostPort);
  const proxy = startProxy(proxyPort, hostPort);
  const { proc, cdp } = await startChrome();
  await phone(cdp);
  return { bench, host, hostPort, proxy, proc, cdp, call: api(hostPort), base: `http://127.0.0.1:${proxyPort}` };
}

async function rawSizes(port: number) {
  // what one full session list weighs, as served, with and without gzip/br
  const sizes: Record<string, number> = {};
  for (const enc of ['identity', 'gzip', 'br']) {
    const r = await fetch(`http://127.0.0.1:${port}/__api/sessions?archived=true&wire=2`, { headers: { 'accept-encoding': enc }, decompress: false } as any);
    sizes[enc] = (await r.arrayBuffer()).byteLength;
    sizes[`${enc}:encoding`] = (r.headers.get('content-encoding') || 'none') as any;
  }
  return sizes;
}

const ctx = await boot();
const results: any = { label: LABEL, root: ROOT, net: NET, cpu: CPU_RATE, sessions: ctx.bench.count, runs: [] };
results.list = await rawSizes(ctx.hostPort).catch(() => null);
try {
  if (RECORD) {
    fs.mkdirSync(RECORD, { recursive: true });
    results.runs.push(await run(0, ctx, RECORD));
  } else {
    for (let i = 1; i <= RUNS; i++) {
      results.runs.push(await run(i, ctx));
      await ctx.cdp.send('Page.navigate', { url: 'about:blank' });
    }
  }
} finally {
  try { ctx.proc.kill('SIGKILL'); } catch {}
  try { ctx.host.kill('SIGTERM'); } catch {}
  ctx.proxy.close();
}
const json = JSON.stringify(results, null, 2);
if (OUT) fs.writeFileSync(OUT, json);
console.log(json);
process.exit(0);
