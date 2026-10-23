// Child half of credentials-fill.test.ts: a real headless Chrome on a session profile, a local sign-in page, and the
// host's own inspect / fill (server/lib/credentials.ts). Run with ARIGAMI_DIR set; reports through emit().
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const cr = await import('../server/lib/credentials.ts');
const { chromeSessionDir } = await import('../server/lib/chrome.ts');
const { findChromeBin } = await import('../server/lib/platform.ts');
const cdp = await import('../server/lib/chrome-cdp.ts');

const PAGES: Record<string, string> = {
  '/login': `<form id="f" onsubmit="event.preventDefault();window.sent={u:document.querySelector('#u').value,p:document.querySelector('#p').value};document.title='sent'">
    <input id="search" placeholder="Search"><input id="u" name="email" type="email"><input id="p" type="password" autocomplete="current-password"><button type="submit">Sign in</button></form>`,
  // username first, the password on the next screen (same origin)
  '/two-step': `<form id="f" onsubmit="event.preventDefault();window.u=document.querySelector('#u').value;document.body.innerHTML='<form onsubmit=&quot;event.preventDefault();window.p=document.querySelector(\\'#p\\').value;document.title=\\'done\\'&quot;><input id=p type=password><button type=submit>Next</button></form>'">
    <input id="u" name="username" autocomplete="username"><button type="submit">Next</button></form>`,
  '/otp': `<input id="code" autocomplete="one-time-code" inputmode="numeric"><button onclick="window.code=document.querySelector('#code').value">Verify</button>`,
  '/none': `<p>hello</p>`,
};
const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: (req) => new Response(`<!doctype html><title>t</title>${PAGES[new URL(req.url).pathname] || ''}`, { headers: { 'content-type': 'text/html' } }) });
const base = `http://127.0.0.1:${server.port}`;
const other = `http://localhost:${server.port}`; // another origin, same server

const sid = 'sess_credtest';
const dir = chromeSessionDir(sid);
fs.mkdirSync(dir, { recursive: true });
const chrome = spawn(findChromeBin()!, ['--headless=new', '--no-sandbox', `--user-data-dir=${dir}`, '--remote-debugging-port=0', '--no-first-run', `${base}/login`], {
  stdio: 'ignore',
  // Chrome puts its singleton socket under TMPDIR; a test run's deep TMPDIR is past the unix-socket path limit
  env: { ...process.env, TMPDIR: '/tmp' },
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const out: Record<string, unknown> = {};
try {
  for (let i = 0; i < 80 && !(await cdp.listTabs(sid)).some((t) => t.url.startsWith(base)); i++) await sleep(150);
  const ev = (expr: string) => cdp.pageEvaluate(sid, expr);
  const go = async (u: string) => { await cdp.pageNavigate(sid, u); await sleep(100); };

  out.login = await cr.inspect(sid).then((r) => ({ origin: r.origin, fields: r.fields }));
  const req = await cr.request(sid, { site: '127.0.0.1', reason: 'test' });
  out.requestStatus = req.status;
  if (req.status !== 'pending') throw new Error('no request: ' + JSON.stringify(req));
  out.wrongSite = (await cr.request(sid, { site: 'example.com' })).status;
  // the cockpit can only name roles; extra keys are ignored
  const r1 = await cr.fill(sid, req.request.requestId, { username: 'me@x.test', password: 's3cret', selector: '#search' } as any, { waitMs: 0 });
  out.fill = r1;
  await sleep(300);
  out.sent = await ev('window.sent');
  out.search = await ev("document.querySelector('#search') ? document.querySelector('#search').value : null");
  out.reuse = await cr.fill(sid, req.request.requestId, { password: 'x' }).then(() => 'filled', (e) => e.message);

  // a navigation to another origin between the card and the fill: nothing is typed
  await go(`${base}/login`);
  const req2 = await cr.request(sid, {});
  if (req2.status !== 'pending') throw new Error('no request 2');
  await go(`${other}/login`);
  out.moved = await cr.fill(sid, req2.request.requestId, { username: 'a', password: 'b' }).then(() => 'filled', (e) => e.message);
  out.movedValue = await ev("document.querySelector('#p').value");

  await go(`${base}/two-step`);
  const req3 = await cr.request(sid, {});
  out.twoStepFields = req3.status === 'pending' ? req3.request.fields : req3;
  if (req3.status === 'pending') out.twoStep = await cr.fill(sid, req3.request.requestId, { username: 'me', password: 'pw2' }, { waitMs: 5000 });
  await sleep(300);
  out.twoStepSeen = await ev('({u: window.u, p: window.p, t: document.title})');

  await go(`${base}/otp`);
  const req4 = await cr.request(sid, {});
  out.otpFields = req4.status === 'pending' ? req4.request.fields : req4;

  await go(`${base}/none`);
  out.none = await cr.request(sid, {});
  // the page script can't read what the host typed except through the field itself; the inspect result has no values
  out.inspectKeys = Object.keys(await cr.inspect(sid));
} finally {
  chrome.kill('SIGKILL');
  server.stop(true);
}
(globalThis as any).emit(out);
