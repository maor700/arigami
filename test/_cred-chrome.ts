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
  // VAULT2: a payment-verification form — named fields, no sign-in
  '/card': `<form onsubmit="event.preventDefault()"><label for="cn">Card number</label><input id="cn" name="cardNumber" autocomplete="cc-number">
    <label for="exp">Expiry</label><input id="exp" name="exp"><input id="cvv" type="password" placeholder="CVV"><input id="other" name="other">
    <label for="notes">Notes</label><textarea id="notes" name="notes"></textarea><button type="submit">Verify</button></form>`,
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
  // a cold Chrome in a full test run lists the tab before the page has its inputs: wait for the form itself
  for (let i = 0; i < 100 && !(await ev("!!document.querySelector('#p')").catch(() => false)); i++) await sleep(100);

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

  // ---- VAULT2: one named field into the field the agent means -------------------------------------------------------
  await go(`${base}/card`);
  const f1 = await cr.requestField(sid, { site: '127.0.0.1', field: 'card_number', target: 'card number', entry: 'Dana', reason: 'verify' });
  out.cardReq = f1.status === 'pending' ? { kind: f1.request.kind, fields: f1.request.fields, entry: f1.request.entry, host: f1.request.host } : f1;
  if (f1.status !== 'pending') throw new Error('no field request: ' + JSON.stringify(f1));
  // the body names more than the card asked for: only the card's one field lands, in the marked element only
  out.cardFill = await cr.fill(sid, f1.request.requestId, { card_number: '4111 1111 1111 1111', cvv: '999', exp: '12/30' });
  out.cardSeen = await ev("({cn: document.querySelector('#cn').value, cvv: document.querySelector('#cvv').value, exp: document.querySelector('#exp').value, other: document.querySelector('#other').value, marks: document.querySelectorAll('[data-arigami-fill]').length})");
  out.cardReuse = await cr.fill(sid, f1.request.requestId, { card_number: 'x' }).then(() => 'filled', (e) => e.message);
  // a multi-line value into a textarea, by its label
  const fN = await cr.requestField(sid, { field: 'remarks', target: 'notes' });
  if (fN.status !== 'pending') throw new Error('no textarea request: ' + JSON.stringify(fN));
  out.notesFill = await cr.fill(sid, fN.request.requestId, { remarks: 'line one\nline two SECRET-NOTE' });
  out.notesSeen = await ev("document.querySelector('#notes').value");
  // what browser_snapshot reads (body.innerText) after the fills: the page's text, never a field's value — input or textarea
  const snap = String(await ev('document.body.innerText'));
  out.snapshotLeak = snap.includes('4111') || snap.includes('SECRET-NOTE');
  // and what a screenshot shows of a filled plain field from now on: dots (the value is still there for the page to submit)
  out.masked = await ev("[getComputedStyle(document.querySelector('#cn')).webkitTextSecurity, getComputedStyle(document.querySelector('#notes')).webkitTextSecurity, getComputedStyle(document.querySelector('#other')).webkitTextSecurity]");
  // the pixels: two different values of the same length in the masked fields render the SAME screenshot (no caret —
  // nothing has the focus), while the same change in an unmasked field renders a different one
  await ev('document.activeElement && document.activeElement.blur()');
  const shotA = await cdp.pageScreenshot(sid);
  const fA = await cr.requestField(sid, { field: 'card_number', target: 'card number' });
  const fB = await cr.requestField(sid, { field: 'remarks', target: 'notes' });
  // (a second request on the same session replaces the first card: fill the textarea, then the card number)
  if (fB.status !== 'pending') throw new Error('no second textarea request');
  await cr.fill(sid, fB.request.requestId, { remarks: 'line two\nline one SECRET-NOTE' });
  const fA2 = await cr.requestField(sid, { field: 'card_number', target: 'card number' });
  if (fA2.status !== 'pending') throw new Error('no second card request');
  await cr.fill(sid, fA2.request.requestId, { card_number: '4222 3333 4444 5555' });
  await ev('document.activeElement && document.activeElement.blur()');
  await sleep(150);
  const shotB = await cdp.pageScreenshot(sid);
  out.maskedPixelsSame = shotA.equals(shotB);
  out.maskedValues = await ev("[document.querySelector('#cn').value, document.querySelector('#notes').value]");
  await ev("document.querySelector('#other').value = 'aaaa'");
  await sleep(150);
  const shotC = await cdp.pageScreenshot(sid);
  await ev("document.querySelector('#other').value = 'bbbb'");
  await sleep(150);
  const shotD = await cdp.pageScreenshot(sid);
  out.plainPixelsSame = shotC.equals(shotD);
  void fA;
  // no target: the focused field (a password-type CVV the agent may not type into itself)
  await ev("document.querySelector('#cvv').focus()");
  const f2 = await cr.requestField(sid, { field: 'cvv' });
  if (f2.status !== 'pending') throw new Error('no focus request: ' + JSON.stringify(f2));
  out.focusFill = await cr.fill(sid, f2.request.requestId, { cvv: '321' });
  out.focusSeen = await ev("document.querySelector('#cvv').value");
  // nothing focused and no target, a target that matches nothing, the wrong site: told, no card
  await ev('document.activeElement.blur()');
  out.noFocus = await cr.requestField(sid, { field: 'cvv' });
  out.noMatch = await cr.requestField(sid, { field: 'iban', target: 'iban' });
  out.fieldWrongSite = (await cr.requestField(sid, { site: 'example.com', field: 'cvv', target: 'cvv' })).status;
  // the page moves to another origin between the card and the fill: nothing is typed
  const f3 = await cr.requestField(sid, { field: 'exp', target: 'expiry' });
  if (f3.status !== 'pending') throw new Error('no move request: ' + JSON.stringify(f3));
  await go(`${other}/card`);
  out.fieldMoved = await cr.fill(sid, f3.request.requestId, { exp: '01/31' }).then(() => 'filled', (e) => e.message);
  out.fieldMovedValue = await ev("document.querySelector('#exp').value");

  await go(`${base}/none`);
  out.none = await cr.request(sid, {});
  // the page script can't read what the host typed except through the field itself; the inspect result has no values
  out.inspectKeys = Object.keys(await cr.inspect(sid));
} finally {
  chrome.kill('SIGKILL');
  server.stop(true);
}
(globalThis as any).emit(out);
