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
    <label for="notes">Notes</label><textarea id="notes" name="notes"></textarea>
    <input id="num" type="number" aria-label="Amount"><input id="dob" type="date" aria-label="Birth date"><input id="q" type="search" placeholder="Search"><button type="submit">Verify</button></form>`,
  // VAULT3: a payment form with the real target's public shape — a card number input, a CVV, and the expiry as two selects
  '/pay': `<form id="pay" onsubmit="event.preventDefault();window.paid={n:document.querySelector('#txtNumber').value,m:document.querySelector('#cmbExpiryMonth').value,y:document.querySelector('#cmbExpiryYear').value};document.title='paid'">
    <label for="txtNumber">Card number</label><input id="txtNumber" name="txtNumber">
    <label for="txtCVV">CVV</label><input id="txtCVV" name="txtCVV" type="password">
    <label for="cmbExpiryMonth">Expiry month</label><select id="cmbExpiryMonth" name="cmbExpiryMonth"><option value="">--</option>${Array.from({ length: 12 }, (_, i) => `<option value="${i + 1}">${String(i + 1).padStart(2, '0')}</option>`).join('')}</select>
    <label for="cmbExpiryYear">Expiry year</label><select id="cmbExpiryYear" name="cmbExpiryYear"><option value="">--</option>${Array.from({ length: 6 }, (_, i) => `<option value="${26 + i}">${2026 + i}</option>`).join('')}</select>
    <label for="cmbBogus">Bogus</label><select id="cmbBogus" name="cmbBogus"><option value="a">A</option><option value="b">B</option></select>
    <label for="cmbPlain">Plain</label><select id="cmbPlain" name="cmbPlain"><option value="x">X</option><option value="y">Y</option></select>
    <label for="txtExpiry">Expiry (text)</label><input id="txtExpiry" name="txtExpiry">
    <label for="cmbRetry">Retry</label><select id="cmbRetry" name="cmbRetry"><option value="">--</option><option value="26">2026</option><option value="27">2027</option></select>
    <label for="cmbDis">Disabled</label><select id="cmbDis" name="cmbDis"><option value="">--</option><option value="26" disabled>2026</option><optgroup label="old" disabled><option value="28">2028</option></optgroup><option value="27">2027</option></select>
    <label for="cmbY03">Years with 2003</label><select id="cmbY03" name="cmbY03"><option value="">--</option><option value="2003">2003</option><option value="2027">2027</option></select>
    <label for="cmbAmb">Ambiguous</label><select id="cmbAmb" name="cmbAmb"><option value="">--</option><option value="3">March</option><option value="03">03</option></select>
    <button id="paySubmit" type="submit">Pay</button></form>`,
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
  // what the vault knows for this origin (names and types only): remarks is plain multi-line text, the others are not
  cr.writeCatalog({ entries: [{ id: 't1', title: 'Test', origin: base, fields: [{ name: 'remarks', type: 'multiline' }, { name: 'card_number', type: 'number' }, { name: 'cvv', type: 'secret' }] }] });
  const f1 = await cr.requestField(sid, { site: '127.0.0.1', field: 'card_number', target: 'card number', entry: 'Dana', reason: 'verify' });
  out.cardReq = f1.status === 'pending' ? { kind: f1.request.kind, fields: f1.request.fields, entry: f1.request.entry, host: f1.request.host, pref: f1.request.pref, page: f1.request.page } : f1;
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
  // the input types Chrome does not dot (number, date): the value is made invisible instead, and still submitted
  const fNum = await cr.requestField(sid, { field: 'amount', target: 'amount' });
  if (fNum.status !== 'pending') throw new Error('no number request: ' + JSON.stringify(fNum));
  out.numFill = await cr.fill(sid, fNum.request.requestId, { amount: '1234' });
  const fDob = await cr.requestField(sid, { field: 'dob', target: 'birth date' });
  if (fDob.status !== 'pending') throw new Error('no date request: ' + JSON.stringify(fDob));
  out.dobFill = await cr.fill(sid, fDob.request.requestId, { dob: '2020-01-02' });
  out.numDobSeen = await ev("[document.querySelector('#num').value, document.querySelector('#dob').value]");
  out.numDobInvisible = await ev("[getComputedStyle(document.querySelector('#num')).color, getComputedStyle(document.querySelector('#dob')).color, getComputedStyle(document.querySelector('#num')).webkitTextFillColor]");
  // the pixels: two different values of the same length in the masked fields (text, textarea, number, date) render the
  // SAME screenshot (no caret — nothing has the focus), while the same change in an unmasked field renders a different one
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
  const fNum2 = await cr.requestField(sid, { field: 'amount', target: 'amount' });
  if (fNum2.status !== 'pending') throw new Error('no second number request');
  await cr.fill(sid, fNum2.request.requestId, { amount: '5678' });
  const fDob2 = await cr.requestField(sid, { field: 'dob', target: 'birth date' });
  if (fDob2.status !== 'pending') throw new Error('no second date request');
  await cr.fill(sid, fDob2.request.requestId, { dob: '2021-03-04' });
  await ev('document.activeElement && document.activeElement.blur()');
  await sleep(150);
  const shotB = await cdp.pageScreenshot(sid);
  out.maskedPixelsSame = shotA.equals(shotB);
  if (!out.maskedPixelsSame) {
    // for a human to look at: the two frames, under the run's own temp root
    const dbg = process.env.TMPDIR || '/tmp';
    fs.writeFileSync(path.join(dbg, 'cred-chrome-shotA.png'), shotA);
    fs.writeFileSync(path.join(dbg, 'cred-chrome-shotB.png'), shotB);
    out.maskedPixelsDump = dbg;
  }
  out.maskedValues = await ev("[document.querySelector('#cn').value, document.querySelector('#notes').value, document.querySelector('#num').value, document.querySelector('#dob').value]");
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
  out.fieldWwwSite = (await cr.requestField(sid, { site: 'www.127.0.0.1', field: 'cvv', target: 'cvv' })).status; // www. aside, the same host
  // a secret (by its saved type — or unknown to the catalog) never goes into a search box or a free-text area
  out.cvvIntoTextarea = await cr.requestField(sid, { field: 'cvv', target: 'notes' });
  out.cvvIntoSearch = await cr.requestField(sid, { field: 'cvv', target: 'search' });
  out.unknownIntoTextarea = await cr.requestField(sid, { field: 'iban', target: 'notes' });
  out.searchValue = await ev("document.querySelector('#q').value");
  // browser_click({text}) is no oracle on a filled field: a value never matches, a label or a button still does
  const ba = await import('../server/lib/browser-actions.ts');
  out.oracle = {
    value: await ev(ba.findClickableJs('4111')),
    valueDigit: await ev(ba.findClickableJs('4')),
    note: await ev(ba.findClickableJs('SECRET-NOTE')),
    number: await ev(ba.findClickableJs('1234')),
    label: (await ev(ba.findClickableJs('Card number'))) !== null, // the label of a FILLED field: skipped (F-1)
    labelFree: (await ev(ba.findClickableJs('Expiry'))) !== null, // the label of a field not filled: still a target
    button: (await ev(ba.findClickableJs('Verify'))) !== null,
    placeholder: (await ev(ba.findClickableJs('Search'))) !== null,
  };
  // the page moves to another origin between the card and the fill: nothing is typed
  const f3 = await cr.requestField(sid, { field: 'exp', target: 'expiry' });
  if (f3.status !== 'pending') throw new Error('no move request: ' + JSON.stringify(f3));
  await go(`${other}/card`);
  out.fieldMoved = await cr.fill(sid, f3.request.requestId, { exp: '01/31' }).then(() => 'filled', (e) => e.message);
  out.fieldMovedValue = await ev("document.querySelector('#exp').value");

  // ---- VAULT3: an expiry's month / year into two selects -------------------------------------------------------------
  await go(`${base}/pay`);
  cr.writeCatalog({ entries: [{ id: 't2', title: 'Test', origin: base, fields: [{ name: 'card_number', type: 'number' }, { name: 'cvv', type: 'secret' }, { name: 'expiry', type: 'secret' }] }] });
  const ba2 = await import('../server/lib/browser-actions.ts');
  const fM = await cr.requestField(sid, { site: '127.0.0.1', field: 'expiry', part: 'month', target: 'cmbExpiryMonth' });
  out.monthReq = fM.status === 'pending' ? { part: fM.request.part, page: fM.request.page, fields: fM.request.fields } : fM;
  if (fM.status !== 'pending') throw new Error('no month request: ' + JSON.stringify(fM));
  // the worker sends the PART only ("03"); the host picks the option that is the same number
  out.monthFill = await cr.fill(sid, fM.request.requestId, { expiry: '03' });
  const fY = await cr.requestField(sid, { site: '127.0.0.1', field: 'expiry', part: 'year', target: 'expiry year' });
  if (fY.status !== 'pending') throw new Error('no year request: ' + JSON.stringify(fY));
  out.yearFill = await cr.fill(sid, fY.request.requestId, { expiry: '2027' }); // options are "26".."31" — matched by the last two digits
  out.selected = await ev("[document.querySelector('#cmbExpiryMonth').value, document.querySelector('#cmbExpiryYear').value]");
  // no option for the saved part: nothing is chosen, and the error names the select and the count, never the value
  const fBog = await cr.requestField(sid, { field: 'expiry', part: 'year', target: 'bogus' });
  if (fBog.status !== 'pending') throw new Error('no bogus request: ' + JSON.stringify(fBog));
  out.bogus = await cr.fill(sid, fBog.request.requestId, { expiry: '2027' }).then(() => 'filled', (e) => ({ message: e.message, status: e.status }));
  out.bogusValue = await ev("document.querySelector('#cmbBogus').value");
  // F-5: a miss leaves the request open and the field marked — the next try on the same card lands
  const fR = await cr.requestField(sid, { field: 'expiry', part: 'year', target: 'retry' });
  if (fR.status !== 'pending') throw new Error('no retry request: ' + JSON.stringify(fR));
  out.retryMiss = await cr.fill(sid, fR.request.requestId, { expiry: '2031' }).then(() => 'filled', (e) => e.status);
  out.retryMarked = await ev("document.querySelector('#cmbRetry').getAttribute('data-arigami-fill') !== null");
  out.retryHit = await cr.fill(sid, fR.request.requestId, { expiry: '2027' }).then((r) => r.filled, (e) => e.message);
  out.retryValue = await ev("document.querySelector('#cmbRetry').value");
  // F-4: a disabled option, or one inside a disabled optgroup, is never chosen (it would not be submitted)
  const fD = await cr.requestField(sid, { field: 'expiry', part: 'year', target: 'disabled' });
  if (fD.status !== 'pending') throw new Error('no disabled request: ' + JSON.stringify(fD));
  out.disabledOpt = await cr.fill(sid, fD.request.requestId, { expiry: '2026' }).then(() => 'filled', (e) => ({ message: e.message, status: e.status }));
  out.disabledGroup = await cr.fill(sid, fD.request.requestId, { expiry: '2028' }).then(() => 'filled', (e) => e.status);
  out.disabledOk = await cr.fill(sid, fD.request.requestId, { expiry: '2027' }).then((r) => r.filled, (e) => e.message);
  out.disabledValue = await ev("document.querySelector('#cmbDis').value");
  // F-3: the 2↔4-digit rule is a YEAR rule — a month "03" never picks "2003"; two candidates are no choice
  const fY03 = await cr.requestField(sid, { field: 'expiry', part: 'month', target: 'years with 2003' });
  if (fY03.status !== 'pending') throw new Error('no y03 request: ' + JSON.stringify(fY03));
  out.monthNot2003 = await cr.fill(sid, fY03.request.requestId, { expiry: '03' }).then(() => 'filled', (e) => ({ message: e.message, status: e.status }));
  out.monthNot2003Value = await ev("document.querySelector('#cmbY03').value");
  const fAmb = await cr.requestField(sid, { field: 'expiry', part: 'month', target: 'ambiguous' });
  if (fAmb.status !== 'pending') throw new Error('no ambiguous request: ' + JSON.stringify(fAmb));
  out.ambiguous = await cr.fill(sid, fAmb.request.requestId, { expiry: '03' }).then(() => 'filled', (e) => ({ message: e.message, status: e.status }));
  out.ambiguousValue = await ev("document.querySelector('#cmbAmb').value");
  out.reasonLine = fAmb.request.reason;
  // F-2: an older cockpit that ignores `part` sends the WHOLE expiry — the host splits it in this route's memory into
  // the part that was asked for (never a whole expiry in a month field); garbage is refused before the page is touched,
  // the field stays empty and the message carries no value
  const fS = await cr.requestField(sid, { field: 'expiry', part: 'month', target: 'txtExpiry' });
  if (fS.status !== 'pending') throw new Error('no txtExpiry request: ' + JSON.stringify(fS));
  out.staleShape = await cr.fill(sid, fS.request.requestId, { expiry: 'next year' }).then(() => 'filled', (e) => ({ message: e.message, status: e.status }));
  out.staleShapeValue = await ev("document.querySelector('#txtExpiry').value");
  out.staleShapeOk = await cr.fill(sid, fS.request.requestId, { expiry: '03/27' }).then((r) => r.filled, (e) => e.message);
  out.staleShapeOkValue = await ev("document.querySelector('#txtExpiry').value");
  const fS2 = await cr.requestField(sid, { field: 'expiry', part: 'year', target: 'cmbExpiryYear' });
  if (fS2.status !== 'pending') throw new Error('no year-shape request: ' + JSON.stringify(fS2));
  out.staleShapeSelect = await cr.fill(sid, fS2.request.requestId, { expiry: '27' }).then(() => 'filled', (e) => ({ message: e.message, status: e.status }));
  out.staleShapeSelectValue = await ev("document.querySelector('#cmbExpiryYear').value");
  out.staleWholeSelect = await cr.fill(sid, fS2.request.requestId, { expiry: '12/2028' }).then((r) => r.filled, (e) => e.message);
  out.staleWholeSelectValue = await ev("document.querySelector('#cmbExpiryYear').value");
  // put the year back to what the inert checks below expect
  const fS3 = await cr.requestField(sid, { field: 'expiry', part: 'year', target: 'cmbExpiryYear' });
  if (fS3.status !== 'pending') throw new Error('no year-restore request: ' + JSON.stringify(fS3));
  await cr.fill(sid, fS3.request.requestId, { expiry: '2027' });
  // hidden and off-limits: transparent text, no pointer events, not in the Tab order, marked; both selects
  out.selectHidden = await ev("['#cmbExpiryMonth','#cmbExpiryYear'].map((s) => { const el = document.querySelector(s); const cs = getComputedStyle(el); return [cs.color, cs.pointerEvents, el.getAttribute('tabindex'), el.getAttribute('data-arigami-filled'), el.inert, el.hasAttribute('inert')]; })");
  // F-1: the select is INERT — its <label>, a programmatic focus and real keys (what desktop_keyboard sends) can neither
  // focus, change nor open it; the value is still what the owner approved, the pixels unchanged, the form still submits it
  const labelCentre = await ev("(() => { const r = document.querySelector('label[for=\"cmbExpiryMonth\"]').getBoundingClientRect(); return [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)]; })()");
  const page = (await cdp.listTabs(sid)).find((t) => t.type === 'page' && t.webSocketDebuggerUrl)!;
  const key = async (k: string, code: string, vk: number) => {
    for (const type of ['keyDown', 'keyUp']) await cdp.cdpCall(page.webSocketDebuggerUrl!, 'Input.dispatchKeyEvent', { type, key: k, code, windowsVirtualKeyCode: vk });
  };
  await ev('document.activeElement && document.activeElement.blur()');
  await sleep(100);
  const inertBefore = await cdp.pageScreenshot(sid);
  out.inertLabelByText = await ev(ba2.findClickableJs('Expiry month'));
  out.inertLabelGuard = await ev(ba2.clickGuardJs(labelCentre[0], labelCentre[1]));
  await cdp.pageClick(sid, labelCentre[0], labelCentre[1]); // a real click on the label
  await sleep(100);
  out.inertAfterLabelClick = await ev("document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : null");
  await key('ArrowDown', 'ArrowDown', 40);
  await key(' ', 'Space', 32);
  await key('F4', 'F4', 115);
  await ev("document.querySelector('#cmbExpiryMonth').focus()"); // programmatic focus
  out.inertAfterFocus = await ev("document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : null");
  await key('ArrowDown', 'ArrowDown', 40);
  await key(' ', 'Space', 32);
  await ev("document.querySelector('label[for=\"cmbExpiryMonth\"]').click()"); // a scripted label click
  await key('ArrowUp', 'ArrowUp', 38);
  await sleep(150);
  out.inertValueAfter = await ev("[document.querySelector('#cmbExpiryMonth').value, document.querySelector('#cmbExpiryYear').value]");
  out.inertFocusAfter = await ev("document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : null");
  await ev('document.activeElement && document.activeElement.blur()');
  await sleep(100);
  out.inertPixelsSame = inertBefore.equals(await cdp.pageScreenshot(sid));
  out.inertFormData = await ev("(() => { const fd = new FormData(document.querySelector('#pay')); return [fd.get('cmbExpiryMonth'), fd.get('cmbExpiryYear')]; })()");
  // no oracle: the selects' option texts match nothing by click-text, the click guard refuses their spot, typing into a focused one is refused
  const centre = (s: string) => ev(`(() => { const r = document.querySelector('${s}').getBoundingClientRect(); return [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)]; })()`);
  const [mx, my] = await centre('#cmbExpiryMonth');
  const [bx, by] = await centre('#paySubmit');
  // the gate: an inert select cannot take the focus at all; a filled INPUT can, and typing into it is refused (reason 'filled')
  const fN2 = await cr.requestField(sid, { site: '127.0.0.1', field: 'card_number', target: 'txtNumber' });
  if (fN2.status !== 'pending') throw new Error('no txtNumber request: ' + JSON.stringify(fN2));
  await cr.fill(sid, fN2.request.requestId, { card_number: '4111111111111111' });
  await ev("document.querySelector('#txtNumber').focus()");
  out.selectOracle = {
    // option texts that exist only in the FILLED selects ('03' / '2027' also sit in the unfilled test selects, which stay clickable)
    byText11: await ev(ba2.findClickableJs('11')),
    byText2029: await ev(ba2.findClickableJs('2029')),
    guardOnSelect: await ev(ba2.clickGuardJs(mx, my)),
    guardOnButton: await ev(ba2.clickGuardJs(bx, by)),
    gate: (await ba2.humanGate(sid)).reason || null,
    payButton: (await ev(ba2.findClickableJs('Pay'))) !== null,
  };
  await ev('document.activeElement && document.activeElement.blur()');
  // the pixels: a different month / year in the hidden selects renders the same screenshot; a plain select does not
  await sleep(150);
  const payA = await cdp.pageScreenshot(sid);
  const fM2 = await cr.requestField(sid, { field: 'expiry', part: 'month', target: 'cmbExpiryMonth' });
  if (fM2.status !== 'pending') throw new Error('no second month request');
  await cr.fill(sid, fM2.request.requestId, { expiry: '11' });
  const fY2 = await cr.requestField(sid, { field: 'expiry', part: 'year', target: 'cmbExpiryYear' });
  if (fY2.status !== 'pending') throw new Error('no second year request');
  await cr.fill(sid, fY2.request.requestId, { expiry: '2029' });
  await ev('document.activeElement && document.activeElement.blur()');
  await sleep(150);
  const payB = await cdp.pageScreenshot(sid);
  out.selectPixelsSame = payA.equals(payB);
  await ev("document.querySelector('#cmbPlain').value = 'y'");
  await sleep(150);
  const payC = await cdp.pageScreenshot(sid);
  out.plainSelectPixelsSame = payB.equals(payC);
  // the page submits what was chosen
  await ev("document.querySelector('#paySubmit').click()");
  await sleep(200);
  out.paid = await ev('window.paid');

  await go(`${base}/none`);
  out.none = await cr.request(sid, {});
  // the page script can't read what the host typed except through the field itself; the inspect result has no values
  out.inspectKeys = Object.keys(await cr.inspect(sid));
} finally {
  chrome.kill('SIGKILL');
  server.stop(true);
}
(globalThis as any).emit(out);
