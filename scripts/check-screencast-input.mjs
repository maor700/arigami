// LIVE check: does the screencast input relay actually move the remote page?
// Real Chrome, real CDP, a real WebSocket pair into bridgeToScreencast.
//
// This is the harness behind docs/WINDOWS-REMOTE.md §2's "proven live" claims.
// It is kept in the repo (rather than thrown away) because the first person
// with a real Windows machine should run it there — every assertion in it is
// platform-independent, so a pass on Windows closes most of §4's first block.
//
//   D=$(mktemp -d)
//   WRP_ROOT=$PWD ARIGAMI_DIR=$D ARIGAMI_PORT= ARIGAMI_WA_AUTOSTART=0 \
//     ARIGAMI_WA_DATA_DIR=$D/wa bun scripts/check-screencast-input.mjs
//
// Exits 0 on success, 1 with a [live] FAIL line otherwise.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { WebSocketServer, WebSocket } from 'ws';

const ARIGAMI_DIR = process.env.ARIGAMI_DIR;
const ROOT = process.env.WRP_ROOT;
// Chrome is found the way the host itself finds it (server/lib/platform.ts),
// not hardcoded to a Linux path — otherwise "run this on the Windows box"
// would be a claim this file cannot honour.
const { findChromeBin } = await import(ROOT + '/server/lib/platform.ts');
const CHROME = findChromeBin();
if (!CHROME) { console.error('[live] FAIL: no Chrome/Chromium found on this machine'); process.exit(1); }
const SID = 'wrp-live';
const profile = path.join(ARIGAMI_DIR, 'chrome-sessions', SID);
fs.mkdirSync(profile, { recursive: true });

const log = (...a) => console.log('[live]', ...a);
const fail = (m) => { console.error('[live] FAIL:', m); process.exit(1); };

// A page whose title changes on click and records typed text — the only way
// to prove input ARRIVED rather than just that we sent bytes.
const PAGE = `data:text/html,<html><body style="margin:0">
<button id="b" style="position:absolute;left:100px;top:100px;width:200px;height:80px">hit me</button>
<input id="i" style="position:absolute;left:100px;top:300px;width:300px;height:40px">
<script>
document.title='untouched';
b.onclick=()=>{document.title='CLICKED';};
i.oninput=()=>{document.title='TYPED:'+i.value;};
</script></body></html>`;

const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  '--window-size=1280,800', PAGE,
], { stdio: ['ignore', 'ignore', 'ignore'] });

process.on('exit', () => { try { chrome.kill('SIGKILL'); } catch {} });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitPort() {
  for (let i = 0; i < 100; i++) {
    try {
      const n = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim());
      if (n > 0) return n;
    } catch {}
    await sleep(200);
  }
  fail('Chrome never wrote DevToolsActivePort');
}
const port = await waitPort();
log('chrome CDP port', port);

// Give the page a moment to settle, then find it.
await sleep(800);
const { bridgeToScreencast, inputToCdp } = await import(ROOT+'/server/screencast.ts');
const { frontPage, cdpCall } = await import(ROOT+'/server/lib/chrome-cdp.ts');
const page = await frontPage(SID);
log('front page:', page.url.slice(0, 40) + '…');

const title = async () => (await cdpCall(page.webSocketDebuggerUrl, 'Runtime.evaluate', { expression: 'document.title', returnByValue: true })).result.value;
if ((await title()) !== 'untouched') fail('page did not initialise');

// A genuine WebSocket pair: the bridge gets a real server-side socket, we
// hold the client end exactly like the cockpit would.
const wss = new WebSocketServer({ port: 0 });
const addr = wss.address().port;
const serverSock = new Promise((res) => wss.once('connection', res));
const client = new WebSocket(`ws://127.0.0.1:${addr}/`);
await new Promise((r) => client.once('open', r));
bridgeToScreencast(await serverSock, SID);

let frames = 0, firstFrame = null;
client.on('message', (raw) => {
  const m = JSON.parse(String(raw));
  if (m.type === 'frame') { frames++; firstFrame ||= m; }
  if (m.type === 'error') fail('bridge error: ' + m.message);
});
await sleep(2500);
if (frames === 0) fail('no screencast frames arrived');
log(`frames received: ${frames}, first ${firstFrame.width}x${firstFrame.height}`);

// ---- the actual point: does a click reach the page? ----
const send = (o) => client.send(JSON.stringify(o));
send({ type: 'mouse', action: 'move', x: 200, y: 140, buttons: 0 });
send({ type: 'mouse', action: 'down', x: 200, y: 140, button: 'left', buttons: 1, clickCount: 1 });
send({ type: 'mouse', action: 'up', x: 200, y: 140, button: 'left', buttons: 0, clickCount: 1 });
await sleep(600);
const afterClick = await title();
log('title after click:', afterClick);
if (afterClick !== 'CLICKED') fail(`click did not reach the page (title=${afterClick})`);

// ---- and does the keyboard? ----
send({ type: 'mouse', action: 'down', x: 250, y: 320, button: 'left', buttons: 1, clickCount: 1 });
send({ type: 'mouse', action: 'up', x: 250, y: 320, button: 'left', buttons: 0, clickCount: 1 });
await sleep(300);
for (const k of ['h', 'i']) {
  send({ type: 'key', action: 'down', key: k, code: 'Key' + k.toUpperCase(), keyCode: k.toUpperCase().charCodeAt(0) });
  send({ type: 'key', action: 'up', key: k, code: 'Key' + k.toUpperCase(), keyCode: k.toUpperCase().charCodeAt(0) });
}
await sleep(500);
const afterKeys = await title();
log('title after typing:', afterKeys);
if (afterKeys !== 'TYPED:hi') fail(`keyboard did not reach the page (title=${afterKeys})`);

// ---- paste (insertText), the one-time-code path ----
send({ type: 'text', text: '-42' });
await sleep(500);
const afterPaste = await title();
log('title after paste:', afterPaste);
if (afterPaste !== 'TYPED:hi-42') fail(`insertText did not reach the page (title=${afterPaste})`);

// ---- and a hostile message must NOT become a CDP call ----
send({ type: 'evil', method: 'Runtime.evaluate', params: { expression: "document.title='PWNED'" } });
send({ method: 'Browser.close' });
await sleep(500);
if ((await title()) !== 'TYPED:hi-42') fail('an unrecognized client message reached CDP');
log('unrecognized client messages ignored ✓');

client.close();
wss.close();
chrome.kill('SIGKILL');
log('ALL LIVE CHECKS PASSED');
process.exit(0);
