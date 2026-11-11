// Child half of chrome-idle.test.ts: a real (headless) session Chrome started by openChrome, the idle closer on a fast
// clock, and a DevTools client attached the way an agent's Playwright script attaches. Run with ARIGAMI_DIR set.
import fs from 'node:fs';
console.log = console.error; // the host's log lines must not mix into emit()'s JSON on stdout
import path from 'node:path';

const state = await import('../server/state.ts');
const chrome = await import('../server/lib/chrome.ts');
const cdp = await import('../server/lib/chrome-cdp.ts');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean | Promise<boolean>, ms = 15000) => { const t = Date.now(); while (!(await f())) { if (Date.now() - t > ms) throw new Error('timed out'); await sleep(100); } };
const portFile = (id: string) => path.join(chrome.chromeSessionDir(id), 'DevToolsActivePort');

const id = state.createSession({ title: 'chrome idle', cwd: process.cwd() }).id;
await chrome.openChrome(id, 'about:blank');
await until(() => !!cdp.cdpPort(id) && cdp.listTabs(id).then((t) => t.some((x) => x.type === 'page')));
const port = cdp.cdpPort(id)!;
const idle = await chrome.cdpActivity(port);

// An attached client (what connectOverCDP does) keeps the browser up long past IDLE_MS without any browser_* step.
const page = (await cdp.listTabs(id)).find((t) => t.type === 'page')!;
const ws = new WebSocket(page.webSocketDebuggerUrl!);
await new Promise((r) => { ws.onopen = r; });
const busy = await chrome.cdpActivity(port);
const stop = chrome.startIdleCloser(() => false, cdp.cdpPort, chrome.cdpActivity, 150);
let n = 0;
const traffic = setInterval(() => ws.send(JSON.stringify({ id: ++n, method: 'Runtime.evaluate', params: { expression: '1+1' } })), 200);
await sleep(Number(process.env.ARIGAMI_BROWSER_IDLE_MS) * 4);
const aliveWhileAttached = chrome.isChromeRunning(id);

// Once the client leaves, the next idle window closes it — with its reason logged and no stale port left behind.
clearInterval(traffic);
ws.close();
await until(() => !chrome.isChromeRunning(id));
await until(() => !fs.existsSync(portFile(id)));
stop();

// Reopen names the previous stop; an exit nobody asked for is logged as such.
const second = await chrome.openChrome(id);
await until(() => !!cdp.cdpPort(id));
process.kill(second.pid, 'SIGKILL');
await until(() => !chrome.isChromeRunning(id));
await chrome.openChrome(id);
await until(() => !!cdp.cdpPort(id));
chrome.closeChrome(id, 'session deleted');
await until(() => !fs.existsSync(portFile(id)));

const log = fs.readFileSync(path.join(process.env.ARIGAMI_DIR!, 'logs', 'chrome.log'), 'utf8');
emit({ idle, busy, aliveWhileAttached, log });
