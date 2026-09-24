// The consent runner: the host walks a vendor's OAuth consent by itself, in a
// browser where the owner is already signed in — so connecting (and, above
// all, reconnecting) a service needs nobody, unless the vendor really wants a
// person (a password, 2FA, a choice the host cannot make).
//
// It is a fixed routine of the host, not an agent improvising: the same steps
// every time, in this order, and it STOPS at the first page it does not know.
//
//   where    the shared browser (the login vault, chrome-base) for the host's own
//            grants; an agent's own profile for that agent's grants. Never a
//            copy: Google does not accept a copied session (login-sites.ts), so
//            the runner goes to where the sign-in actually lives.
//   how      real mouse clicks (a click from page script is not a user gesture:
//            Notion's "Continue with Google" popup is blocked without one — measured)
//   approves only on the vendor's own domain, and only when the consent page
//            names this host's callback (Linear and Notion both print it; Notion
//            shows the host name rather than the client name, so the address
//            is the check, not the name)
//   the end  the vendor's redirect to the callback is caught inside the browser
//            (CDP Fetch) and the code is exchanged right here — no dependence
//            on the host reaching its own public URL
//   stops    on a password or email field, a second Google account to choose
//            from, a domain outside the vendor's, or any page it cannot place
//
// Per-vendor differences are data (mcp-catalog.ts `consent`): which button
// approves, which box must be ticked first. A vendor without them gets the
// generic buttons (Approve / Allow / Authorize); anything else goes to a person.
import fs from 'node:fs';
import path from 'node:path';
import { ARIGAMI_DIR } from './instance.js';

export interface ConsentHints {
  /** regex source, case-insensitive: the button that approves */
  approve?: string;
  /** regex source: a checkbox label that must be ticked before approving */
  check?: string;
}

export interface RunInput {
  name: string;
  authorizeUrl: string;
  redirect: string;
  /** the vendor's domains (mcp-catalog.ts `domains`) */
  domains: string[];
  hints?: ConsentHints;
  /** browser profile dir; default the login vault */
  profileDir?: string;
  /** Google account to use when a chooser lists several */
  identityEmail?: string | null;
  /** exchange the caught code (mcp-grants.ts finishLogin) */
  onCode: (state: string, code: string) => Promise<{ ok: boolean; error?: string }>;
  timeoutMs?: number;
}

export interface RunResult {
  status: 'approved' | 'needs-person' | 'failed';
  reason: string;
  /** where it stopped (host + path), for the card */
  at?: string;
  workspace?: string | null;
  evidence: string[];
}

const DEFAULT_APPROVE = '^(approve|allow|allow access|authorize|authorise|accept|grant access)$';
const GOOGLE_BUTTON = /^(google|continue with google|sign in with google|log in with google)$/i;

const hostMatches = (host: string, domain: string) => host === domain || host.endsWith('.' + domain);

export async function runConsent(input: RunInput): Promise<RunResult> {
  const { withVault, VAULT_DIR } = await import('./login-vault.js');
  const dir = input.profileDir || VAULT_DIR;
  const evidenceDir = path.join(ARIGAMI_DIR, 'consent', input.name.replace(/[^\w.-]/g, '_'));
  fs.mkdirSync(evidenceDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const evidence: string[] = [];
  const redirect = new URL(input.redirect);
  const allowed = [...input.domains, 'accounts.google.com', redirect.hostname];
  const approveRe = new RegExp(input.hints?.approve || DEFAULT_APPROVE, 'i');
  const checkRe = input.hints?.check ? new RegExp(input.hints.check, 'i') : null;
  const deadline = Date.now() + (input.timeoutMs ?? 90_000);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  return withVault(async (cdp: any) => {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const tabs = new Map<string, string>(); // targetId → sessionId
    let caught = null as { state: string; code: string } | null;
    let exchanged = null as { ok: boolean; error?: string } | null;

    const attach = async (tid: string) => {
      if (tabs.has(tid)) return tabs.get(tid)!;
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: tid, flatten: true });
      tabs.set(tid, sessionId);
      await cdp.send('Runtime.enable', {}, sessionId).catch(() => {});
      await cdp.send('Page.enable', {}, sessionId).catch(() => {});
      // The vendor's redirect back to us: caught here, answered here.
      await cdp.send('Fetch.enable', { patterns: [{ urlPattern: `${redirect.origin}${redirect.pathname}*`, requestStage: 'Request' }] }, sessionId).catch(() => {});
      return sessionId;
    };
    const off = cdp.on(async (method: string, params: any, sessionId?: string) => {
      if (method !== 'Fetch.requestPaused') return;
      try {
        const u = new URL(params.request.url);
        const code = u.searchParams.get('code') || '';
        const state = u.searchParams.get('state') || '';
        if (code && state && !caught) {
          caught = { state, code };
          exchanged = await input.onCode(state, code).catch((e) => ({ ok: false, error: (e as Error).message }));
        }
        const body = Buffer.from(`<!doctype html><meta charset="utf-8"><body style="font:15px system-ui;padding:2rem">${exchanged?.ok ? 'Connected.' : 'Not connected.'}</body>`).toString('base64');
        await cdp.send('Fetch.fulfillRequest', { requestId: params.requestId, responseCode: 200, responseHeaders: [{ name: 'content-type', value: 'text/html; charset=utf-8' }], body }, sessionId);
      } catch {
        await cdp.send('Fetch.continueRequest', { requestId: params.requestId }, sessionId).catch(() => {});
      }
    });

    try {
    const main = await attach(targetId);
    const ev = async (s: string, expr: string) => (await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, s)).result?.value;
    const shot = async (s: string, label: string) => {
      try {
        const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, s);
        const f = path.join(evidenceDir, `${stamp}-${evidence.length + 1}-${label}.png`);
        fs.writeFileSync(f, Buffer.from(data, 'base64'));
        evidence.push(f);
      } catch {
        /* a page that closed mid-shot */
      }
    };
    const inspect = (s: string) =>
      ev(
        s,
        `(() => {
          const vis = (e) => { const r = e.getBoundingClientRect(); const st = getComputedStyle(e); return r.width > 0 && r.height > 0 && st.visibility !== 'hidden'; };
          const btns = [...document.querySelectorAll('button, a, [role=button], input[type=submit]')].filter(vis).map((b) => (b.innerText || b.value || '').trim()).filter(Boolean);
          const fields = [...document.querySelectorAll('input[type=password], input[type=email]')].filter(vis).length;
          return { url: location.href, btns, fields, text: document.body ? document.body.innerText : '', rows: [...document.querySelectorAll('[data-identifier],[data-email]')].map((r) => r.getAttribute('data-identifier') || r.getAttribute('data-email') || '') };
        })()`
      ).catch(() => null);
    // A real click: the element's centre, pressed and released by the "mouse".
    const click = async (s: string, finder: string) => {
      const pt = await ev(s, `(() => { const el = (${finder})(); if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
      if (!pt) return false;
      for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, x: pt.x, y: pt.y, button: 'left', clickCount: 1 }, s);
      return true;
    };
    const byText = (re: RegExp) => `() => [...document.querySelectorAll('button, a, [role=button], input[type=submit]')].find((b) => ${re}.test((b.innerText || b.value || '').trim()))`;
    const where = (url: string) => {
      try {
        const u = new URL(url);
        return u.host + u.pathname;
      } catch {
        return url;
      }
    };
    const stop = async (s: string, status: RunResult['status'], reason: string, at?: string, workspace: string | null = null): Promise<RunResult> => {
      await shot(s, status);
      return { status, reason, at, workspace, evidence };
    };

    // A Google page (popup or main tab): the chooser with one account, or the
    // account the owner is known by; anything asking for credentials → a person.
    const google = async (s: string): Promise<'done' | RunResult> => {
      for (let k = 0; k < 4; k++) {
        const g = await inspect(s);
        if (!g) return 'done'; // the popup closed: Google handed back to the vendor
        if (!/accounts\.google\.com$/.test(new URL(g.url).hostname)) return 'done';
        await shot(s, 'google');
        if (g.fields) return stop(s, 'needs-person', 'Google asks you to sign in', where(g.url));
        if (g.rows.length) {
          const pick = g.rows.length === 1 ? g.rows[0] : g.rows.find((r: string) => input.identityEmail && r.toLowerCase() === input.identityEmail.toLowerCase());
          if (!pick) return stop(s, 'needs-person', 'Google asks which account to use', where(g.url));
          await click(s, `() => document.querySelector('[data-identifier="${pick.replace(/"/g, '')}"], [data-email="${pick.replace(/"/g, '')}"]')`);
          await sleep(4000);
          continue;
        }
        if (/sign in to|continue to/i.test(g.text) && g.btns.some((b: string) => /^continue$/i.test(b))) {
          await click(s, byText(/^continue$/i));
          await sleep(4000);
          continue;
        }
        return stop(s, 'needs-person', 'Google shows a page Arigami does not handle', where(g.url));
      }
      return 'done';
    };

    await cdp.send('Page.navigate', { url: input.authorizeUrl }, main);
    await sleep(5000);
    let unknown = 0;
    let workspace: string | null = null;
    while (Date.now() < deadline) {
      if (caught) {
        await sleep(300);
        return exchanged?.ok
          ? { status: 'approved', reason: 'approved on the vendor’s consent page', workspace, evidence }
          : { status: 'failed', reason: exchanged?.error || 'the vendor’s code was refused', workspace, evidence };
      }
      const p = await inspect(main);
      if (!p) {
        await sleep(1000);
        continue;
      }
      const host = new URL(p.url).hostname;
      if (!allowed.some((d) => hostMatches(host, d))) return stop(main, 'needs-person', `the sign-in went to ${host}`, where(p.url));
      if (/accounts\.google\.com$/.test(host)) {
        const r = await google(main);
        if (r !== 'done') return r;
        await sleep(3000);
        continue;
      }
      const approveBtn = p.btns.find((b: string) => approveRe.test(b));
      if (approveBtn) {
        // Approve only a consent that names THIS host's callback.
        if (!p.text.includes(redirect.hostname)) return stop(main, 'needs-person', 'the consent page does not name this Arigami — check it yourself', where(p.url));
        const ws = /select workspace\s*\n+\s*([^\n]+)/i.exec(p.text);
        workspace = ws ? ws[1].trim() : null;
        await shot(main, 'consent');
        if (checkRe) {
          const ticked = await ev(
            main,
            `(() => { const re = ${checkRe}; const box = [...document.querySelectorAll('input[type=checkbox]')].find((c) => re.test((c.closest('label') || c.parentElement || {}).innerText || '')); if (!box) return null; if (!box.checked) { box.scrollIntoView({ block: 'center' }); const r = box.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; } return 'already'; })()`
          );
          if (ticked && ticked !== 'already') for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, x: ticked.x, y: ticked.y, button: 'left', clickCount: 1 }, main);
          await sleep(500);
        }
        await click(main, byText(approveRe));
        await sleep(4000);
        continue;
      }
      const googleBtn = p.btns.find((b: string) => GOOGLE_BUTTON.test(b));
      if (googleBtn && input.domains.some((d) => hostMatches(host, d))) {
        const before = new Set(((await cdp.send('Target.getTargets')).targetInfos || []).map((t: any) => t.targetId));
        await click(main, byText(GOOGLE_BUTTON));
        // Google opens in a popup (Notion) or in this tab (others)
        let pop: any = null;
        for (let i = 0; i < 16 && !pop; i++) {
          await sleep(500);
          pop = ((await cdp.send('Target.getTargets')).targetInfos || []).find((t: any) => t.type === 'page' && !before.has(t.targetId));
        }
        if (pop) {
          const ps = await attach(pop.targetId);
          await sleep(2500);
          const r = await google(ps);
          if (r !== 'done') return r;
        }
        await sleep(4000);
        continue;
      }
      // A login form with no Google way in (Notion shows email AND Google — the
      // Google button was taken above): a person signs in, once, for good.
      if (p.fields) return stop(main, 'needs-person', `${host} asks you to sign in`, where(p.url));
      if (++unknown >= 3) return stop(main, 'needs-person', `${host} shows a page Arigami does not handle`, where(p.url));
      await sleep(2000);
    }
    return stop(main, 'needs-person', 'the vendor took too long', undefined, workspace);
    } finally {
      off();
      for (const tid of tabs.keys()) await cdp.send('Target.closeTarget', { targetId: tid }).catch(() => {});
    }
  }, dir);
}
