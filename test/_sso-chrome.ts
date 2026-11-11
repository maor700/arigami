// Child half of sso-window.test.js: a headless Chrome standing in for "My browser" (one tab of the owner's own,
// holding something private), a local site with a "Continue with SSO" button, and the host's SSO window (sso.ts).
import fs from 'node:fs';
import { tmpDir } from './_tmp.js';
import { spawn } from 'node:child_process';

const sso = await import('../server/lib/sso.ts');
const cdp = await import('../server/lib/chrome-cdp.ts');
const { findChromeBin } = await import('../server/lib/platform.ts');

const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: (req) => {
  const u = new URL(req.url);
  const page = u.pathname === '/private' ? '<h1>OWNER PRIVATE INBOX</h1>'
    : u.pathname === '/done' ? '<h1>Signed in as owner@example.test</h1>'
    : '<h1>Acme</h1><button onclick="location.href=\'/done\'">Continue with SSO</button><input type="password">';
  return new Response(`<!doctype html><title>t</title>${page}`, { headers: { 'content-type': 'text/html' } });
} });
const site = `http://127.0.0.1:${server.port}`;   // the approved site
const other = `http://localhost:${server.port}`;   // another site in the owner's browser
const dir = tmpDir('sso-mybrowser-');
const chrome = spawn(findChromeBin()!, ['--headless=new', '--no-sandbox', `--user-data-dir=${dir}`, '--remote-debugging-port=0', '--no-first-run', `${other}/private`], { stdio: 'ignore', env: { ...process.env, TMPDIR: '/tmp' } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const out: Record<string, unknown> = {};
const err = async (p: Promise<unknown>) => p.then(() => 'ok', (e) => `${e.status} ${e.message}`);
try {
  let port = 0;
  for (let i = 0; i < 80 && !port; i++) { port = cdp.cdpPort('', dir) || 0; if (!port) await sleep(150); }
  for (let i = 0; i < 40 && !(await cdp.listTabs('', port)).some((t) => t.url.includes('/private')); i++) await sleep(150);
  const ownerTab = (await cdp.listTabs('', port)).find((t) => t.url.includes('/private'))!;

  out.noGrant = await err(sso.look('s1'));
  out.provider = await err(sso.start('s1', 'https://accounts.google.com/', port));
  const st = await sso.start('s1', `${site}/login`, port);
  out.ownTab = st.tabId !== ownerTab.id;
  await sleep(800);
  const l1 = await sso.look('s1');
  out.look = { text: l1.text.includes('Acme'), needsHuman: l1.needsHuman, image: l1.image.length > 1000 };
  out.navOut = await err(sso.navigate('s1', `${other}/private`));
  out.otherSession = await err(sso.look('s2'));
  await sso.click('s1', { text: 'Continue with SSO' });
  await sleep(800);
  out.after = (await sso.look('s1')).text.includes('Signed in as');
  // the tab wanders off (a redirect, a link): nothing is shown, clicks refused
  await cdp.cdpCall((await cdp.listTabs('', port)).find((t) => t.id === st.tabId)!.webSocketDebuggerUrl!, 'Page.navigate', { url: `${other}/private` });
  await sleep(800);
  out.outside = await err(sso.look('s1'));
  out.outsideClick = await err(sso.click('s1', { x: 10, y: 10 }));
  out.finished = await sso.finish('s1');
  await sleep(300);
  const tabs = await cdp.listTabs('', port);
  out.tabClosed = !tabs.some((t) => t.id === st.tabId);
  out.ownerTabKept = tabs.some((t) => t.id === ownerTab.id);
  out.afterFinish = await err(sso.look('s1'));
} finally {
  chrome.kill('SIGKILL');
  server.stop(true);
}
(globalThis as any).emit(out);
