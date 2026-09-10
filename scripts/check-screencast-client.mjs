// LIVE check of the CLIENT transport in a REAL browser:
// web/src/lib/screencastClient.js against a real /__screencast bridge backed
// by a real Chrome page. Proves frames decode and paint onto the canvas, and
// that a real DOM click maps through canvasToPage and lands on the remote page.
//
// The companion to scripts/check-screencast-input.mjs (which checks the server
// half). Same reason for keeping it: run it on the first real Windows machine.
//
//   D=$(mktemp -d)
//   WRP_ROOT=$PWD ARIGAMI_DIR=$D ARIGAMI_PORT= ARIGAMI_WA_AUTOSTART=0 \
//     ARIGAMI_WA_DATA_DIR=$D/wa WRP_SHOT=/tmp/viewer.png \
//     bun scripts/check-screencast-client.mjs
//
// WRP_SHOT (optional) writes a screenshot of the viewer as evidence.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';

const ROOT = process.env.WRP_ROOT;
// Chrome is found the way the host itself finds it (server/lib/platform.ts),
// not hardcoded to a Linux path — otherwise "run this on the Windows box"
// would be a claim this file cannot honour.
const { findChromeBin } = await import(ROOT + '/server/lib/platform.ts');
const CHROME = findChromeBin();
if (!CHROME) { console.error('[live] FAIL: no Chrome/Chromium found on this machine'); process.exit(1); }
const ARIGAMI_DIR = process.env.ARIGAMI_DIR;
const SID = 'wrp-client';
const profile = path.join(ARIGAMI_DIR, 'chrome-sessions', SID);
fs.mkdirSync(profile, { recursive: true });
const log = (...a) => console.log('[client-live]', ...a);
const fail = (m) => { console.error('[client-live] FAIL:', m); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function launch(name, dir, extra) {
  fs.mkdirSync(dir, { recursive: true });
  return spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${dir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', ...extra,
  ], { stdio: 'ignore' });
}
async function devtoolsPort(dir, name) {
  for (let i = 0; i < 100; i++) {
    try {
      const n = Number(fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim());
      if (n > 0) return n;
    } catch {}
    await sleep(200);
  }
  fail(`${name} never wrote DevToolsActivePort`);
}

// ---- 1. the REMOTE machine's Chrome (what the agent drives) ----
const TARGET = 'data:text/html,' + encodeURIComponent(`<html><body style="margin:0;background:#ffcc00">
<button id="b" style="position:absolute;left:100px;top:100px;width:300px;height:120px;font-size:40px">HIT</button>
<script>document.title='untouched';b.onclick=()=>{document.title='CLICKED';document.body.style.background='#0066ff';};</script>
</body></html>`);
const remote = launch('remote', profile, ['--window-size=1280,800', TARGET]);
await devtoolsPort(profile, 'remote Chrome');
await sleep(1000);

const { bridgeToScreencast } = await import(ROOT + '/server/screencast.ts');
const { frontPage, cdpCall } = await import(ROOT + '/server/lib/chrome-cdp.ts');
const page = await frontPage(SID);
const title = async () => (await cdpCall(page.webSocketDebuggerUrl, 'Runtime.evaluate', { expression: 'document.title', returnByValue: true })).result.value;
if ((await title()) !== 'untouched') fail('remote page did not initialise');

// ---- 2. one server: the harness page, the client module, and the bridge ----
const wss = new WebSocketServer({ noServer: true });
wss.on('connection', (ws) => bridgeToScreencast(ws, SID));
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/screencastClient.js')) {
    res.writeHead(200, { 'content-type': 'text/javascript' });
    return res.end(fs.readFileSync(ROOT + '/web/src/lib/screencastClient.js'));
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<!doctype html><html><body style="margin:0">
<div id="host" style="position:absolute;left:20px;top:20px;width:640px;height:400px"></div>
<script type="module">
import { ScreencastConnection } from '/screencastClient.js';
const host = document.getElementById('host');
const conn = new ScreencastConnection(host, 'ws://127.0.0.1:${port}/__screencast');
conn.viewOnly = false;                       // the take-over modal's mode
window.__status = 'new';
conn.addEventListener('connect', () => { window.__status = 'connected'; });
conn.addEventListener('disconnect', () => { window.__status = 'disconnected'; });
conn.addEventListener('screencasterror', (e) => { window.__status = 'error:' + e.detail.message; });
window.__probe = () => {
  const c = host.querySelector('canvas');
  if (!c || !c.width) return null;
  const ctx = c.getContext('2d');
  const mid = ctx.getImageData(Math.floor(c.width/2), Math.floor(c.height/2), 1, 1).data;
  return { status: window.__status, w: c.width, h: c.height, mid: [mid[0], mid[1], mid[2]] };
};
// A REAL DOM click on the canvas, at the element coordinates that must map to
// the remote button (page 250,160 → element 20+125, 20+80 at 0.5 scale).
window.__clickAt = (ex, ey) => {
  const c = host.querySelector('canvas');
  const r = c.getBoundingClientRect();
  const opts = { clientX: r.left + ex, clientY: r.top + ey, button: 0, buttons: 1, bubbles: true, pointerId: 1, detail: 1 };
  c.dispatchEvent(new PointerEvent('pointerdown', opts));
  c.dispatchEvent(new PointerEvent('pointerup', { ...opts, buttons: 0 }));
  return true;
};
</script></body></html>`);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
server.on('upgrade', (req, sock, head) => wss.handleUpgrade(req, sock, head, (ws) => wss.emit('connection', ws, req)));
log('harness+bridge on', port);

// ---- 3. a SECOND Chrome = the human's cockpit browser ----
const viewerDir = path.join(ARIGAMI_DIR, 'viewer-profile');
const viewer = launch('viewer', viewerDir, ['--window-size=900,600', `http://127.0.0.1:${port}/`]);
process.on('exit', () => { for (const p of [remote, viewer]) { try { p.kill('SIGKILL'); } catch {} } });
const vport = await devtoolsPort(viewerDir, 'viewer Chrome');
await sleep(2000);
const tabs = await (await fetch(`http://127.0.0.1:${vport}/json/list`)).json();
const vtab = tabs.find((t) => t.type === 'page' && t.url.startsWith('http://127.0.0.1:'));
if (!vtab) fail('viewer tab not found: ' + JSON.stringify(tabs.map((t) => t.url)));
const vEval = async (expr) => {
  const r = await cdpCall(vtab.webSocketDebuggerUrl, 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, 8000);
  if (r.exceptionDetails) fail('viewer eval threw: ' + (r.exceptionDetails.text || JSON.stringify(r.exceptionDetails)));
  return r.result.value;
};

// ---- 4. did the frames actually PAINT in the viewer? ----
let probe = null;
for (let i = 0; i < 40; i++) {
  probe = await vEval('window.__probe && window.__probe()');
  if (probe && probe.mid && (probe.mid[0] || probe.mid[1] || probe.mid[2])) break;
  await sleep(400);
}
if (!probe) fail('harness never initialised (no canvas)');
log('viewer canvas:', JSON.stringify(probe));
if (probe.status !== 'connected') fail('client never reported connect, status=' + probe.status);
if (!probe.w || !probe.h) fail('canvas never sized from a frame');
// The remote page is #ffcc00 → the painted centre pixel must be that colour,
// which is only possible if a JPEG frame really decoded onto this canvas.
const [r0, g0, b0] = probe.mid;
if (!(r0 > 200 && g0 > 150 && b0 < 90)) fail(`centre pixel ${probe.mid} is not the remote page's yellow — frames did not paint`);
log('frames decoded and painted in a real browser ✓');

// ---- 5. does a REAL click in the viewer reach the remote page? ----
await vEval('window.__clickAt(125 + 20 - 20, 80 + 20 - 20)'); // element-space centre of the remote button
await sleep(800);
const after = await title();
log('remote title after a real DOM click in the viewer:', after);
if (after !== 'CLICKED') fail('the click did not reach the remote page');

// and the change comes BACK as a new frame (the loop closes)
let painted = null;
for (let i = 0; i < 30; i++) {
  painted = await vEval('window.__probe()');
  if (painted && painted.mid[2] > 150 && painted.mid[0] < 100) break;
  await sleep(400);
}
log('viewer centre pixel after the click:', JSON.stringify(painted && painted.mid));
if (!(painted && painted.mid[2] > 150 && painted.mid[0] < 100))
  fail('the remote page changed colour but the viewer never repainted it');
log('round trip closed: click → remote page → new frame → viewer canvas ✓');
// Evidence: a screenshot of the VIEWER, showing the remote page rendered
// inside the client's canvas after the round trip.
if (process.env.WRP_SHOT) {
  const shot = await cdpCall(vtab.webSocketDebuggerUrl, 'Page.captureScreenshot', { format: 'png' }, 10000);
  fs.writeFileSync(process.env.WRP_SHOT, Buffer.from(shot.data, 'base64'));
  log('screenshot written to', process.env.WRP_SHOT);
}
log('ALL CLIENT LIVE CHECKS PASSED');
process.exit(0);
