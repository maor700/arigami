// The consent runner (server/lib/consent-runner.ts) with a real headless Chrome
// against a fake vendor. The vendor's consent page, its login page and the
// redirect back are real pages; the redirect is caught inside the browser.
//
//   - signed in at the vendor: ticks the trust box, approves, catches the code
//   - a login form (no Google way in): stops for a person
//   - a consent page that does not name this host: stops, does not approve
//   - a hop to a domain outside the vendor's: stops
import { test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.ARIGAMI_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), 'consent-runner-'));
const HAVE_CHROME = (() => {
  try {
    return !!require('../server/lib/chrome.ts').chromeBin();
  } catch {
    return false;
  }
})();
const { runConsent } = await import('../server/lib/consent-runner.ts');

let vendor: ReturnType<typeof Bun.serve>;
let vbase = '';
const REDIRECT = 'https://arigami.test.example/__api/mcp-oauth/callback';
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'consent-profile-'));

const page = (body: string) => new Response(`<!doctype html><meta charset="utf-8"><body style="font:15px system-ui">${body}</body>`, { headers: { 'content-type': 'text/html' } });

beforeAll(() => {
  vendor = Bun.serve({
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      const back = `${u.searchParams.get('redirect_uri')}?code=the-code&state=${u.searchParams.get('state')}`;
      if (u.pathname === '/consent')
        return page(`<h2>Fake is requesting access</h2><p>Redirect URIs: ${u.searchParams.get('redirect_uri')}</p>
          <label><input type="checkbox" id="trust"> I recognize and trust this URL</label>
          <button id="ok">Approve</button> <button>Cancel</button>
          <script>
            document.getElementById('ok').addEventListener('click', () => {
              if (document.getElementById('trust').checked) location.href = ${JSON.stringify(back)};
              else document.body.insertAdjacentHTML('beforeend', '<p>tick the box first</p>');
            });
          </script>`);
      if (u.pathname === '/consent-noname') return page(`<h2>Some app is requesting access</h2><button id="ok">Approve</button><script>document.getElementById('ok').onclick = () => { location.href = ${JSON.stringify(back)}; };</script>`);
      if (u.pathname === '/login') return page(`<h2>Log in</h2><input type="email"><input type="password"><button>Sign in</button>`);
      if (u.pathname === '/away') return new Response(null, { status: 302, headers: { location: 'https://example.org/somewhere' } });
      return new Response('no', { status: 404 });
    },
  });
  vbase = `http://127.0.0.1:${vendor.port}`;
});
afterAll(() => vendor?.stop(true));

const url = (p: string) => `${vbase}${p}?redirect_uri=${encodeURIComponent(REDIRECT)}&state=st-1`;
const base = { name: 'fake', redirect: REDIRECT, domains: ['127.0.0.1'], profileDir: profile, timeoutMs: 40_000 };

test.skipIf(!HAVE_CHROME)('signed in at the vendor: ticks the trust box, approves, catches the code', async () => {
  const got: any[] = [];
  const r = await runConsent({ ...base, authorizeUrl: url('/consent'), hints: { approve: '^approve$', check: 'trust this url' }, onCode: async (state, code) => (got.push({ state, code }), { ok: true }) });
  expect(r.status).toBe('approved');
  expect(got).toEqual([{ state: 'st-1', code: 'the-code' }]);
  expect(r.evidence.length).toBeGreaterThan(0);
  expect(fs.existsSync(r.evidence[0])).toBe(true);
}, 60_000);

test.skipIf(!HAVE_CHROME)('a login form with no Google way in stops for a person', async () => {
  const r = await runConsent({ ...base, authorizeUrl: url('/login'), onCode: async () => ({ ok: true }) });
  expect(r.status).toBe('needs-person');
  expect(r.reason).toContain('asks you to sign in');
}, 60_000);

test.skipIf(!HAVE_CHROME)('a consent page that does not name this host is not approved', async () => {
  let called = false;
  const r = await runConsent({ ...base, authorizeUrl: url('/consent-noname'), onCode: async () => ((called = true), { ok: true }) });
  expect(r.status).toBe('needs-person');
  expect(r.reason).toContain('does not name');
  expect(called).toBe(false);
}, 60_000);

test.skipIf(!HAVE_CHROME)('a hop outside the vendor’s domains stops', async () => {
  const r = await runConsent({ ...base, authorizeUrl: url('/away'), onCode: async () => ({ ok: true }) });
  expect(r.status).toBe('needs-person');
  expect(r.reason).toContain('example.org');
}, 60_000);
