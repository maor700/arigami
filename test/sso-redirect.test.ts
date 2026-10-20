// Direct visit to a tenant with no session of its own: redirect to the control plane's SSO entry instead of the
// pairing screen — but only for unauthenticated HTML navigations, never for API/ws/assets/handoff, never in a loop.
import { test, expect, describe } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAuth, COOKIE } from '../server/auth.ts';
import { ssoRedirectTarget, SSO_TRY_COOKIE } from '../server/sso-redirect.ts';
import { tmpDir } from './_tmp.js';

const SSO = 'https://lab.example.com/workspace';
const ENV = { ARIGAMI_SSO_URL: SSO } as unknown as NodeJS.ProcessEnv;
const HTML = { accept: 'text/html,application/xhtml+xml' };
const req = (url: string, headers: Record<string, string> = HTML, method = 'GET') => ({ method, url, headers }) as any;

describe('ssoRedirectTarget', () => {
  test('no env var: never (pairing screen unchanged)', () => {
    expect(ssoRedirectTarget(req('/__host/'), {} as any)).toBeNull();
    expect(ssoRedirectTarget(req('/'), { ARIGAMI_SSO_URL: 'javascript:alert(1)' } as any)).toBeNull();
  });
  test('HTML navigations to the page documents redirect', () => {
    for (const u of ['/', '/__host', '/__host/', '/__host/index.html', '/some/pinned/page']) expect(ssoRedirectTarget(req(u), ENV)).toBe(SSO);
    expect(ssoRedirectTarget(req('/__host/', { ...HTML, 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }), ENV)).toBe(SSO);
  });
  test('not for non-HTML, non-GET, sub-resources, API, ws, webhooks, assets, handoff, health', () => {
    expect(ssoRedirectTarget(req('/__host/', { accept: 'application/json' }), ENV)).toBeNull();
    expect(ssoRedirectTarget(req('/__host/', {}), ENV)).toBeNull();
    expect(ssoRedirectTarget(req('/__host/', HTML, 'POST'), ENV)).toBeNull();
    expect(ssoRedirectTarget(req('/__host/', { ...HTML, 'sec-fetch-mode': 'cors' }), ENV)).toBeNull();
    expect(ssoRedirectTarget(req('/__host/', { ...HTML, 'sec-fetch-dest': 'iframe' }), ENV)).toBeNull();
    for (const u of ['/__api/auth/handoff?t=x', '/__api/sessions', '/__api/webhooks/github', '/__mcp/x', '/__health', '/__host/assets/app.js', '/__host/favicon.svg', '/__ws', '/__artifacts/a/1'])
      expect(ssoRedirectTarget(req(u), ENV)).toBe(u === '/__ws' ? SSO : null);
  });
  test('?pair=1 escape and the loop-guard cookie', () => {
    expect(ssoRedirectTarget(req('/__host/?pair=1'), ENV)).toBeNull();
    expect(ssoRedirectTarget(req('/__host/', { ...HTML, cookie: `a=b; ${SSO_TRY_COOKIE}=1` }), ENV)).toBeNull();
  });
});

describe('through auth.gate', () => {
  const mk = () => createAuth({ dir: tmpDir('arigami-sso-'), auth: { mode: 'pairing', cookieDays: 30 }, log() {} });
  const run = (a: any, url: string, headers: Record<string, string> = HTML) => {
    const out: any = { status: 0, headers: {} };
    const res: any = { writeHead: (s: number, h: any) => ((out.status = s), (out.headers = h || {})), end() {} };
    const answered = a.gate({ method: 'GET', url, headers, socket: {} }, res);
    return { answered, ...out };
  };
  test('env set: anonymous page -> 302 to SSO once; then the pairing screen; with a session: no redirect', () => {
    const prev = process.env.ARIGAMI_SSO_URL;
    process.env.ARIGAMI_SSO_URL = SSO;
    try {
      const a = mk();
      const r = run(a, '/__host/');
      expect([r.answered, r.status, r.headers.location]).toEqual([true, 302, SSO]);
      expect(r.headers['set-cookie']).toContain(SSO_TRY_COOKIE);
      expect(run(a, '/__host/', { ...HTML, cookie: `${SSO_TRY_COOKIE}=1` }).answered).toBe(false); // loop guard
      expect(run(a, '/__host/?pair=1').answered).toBe(false);
      expect(run(a, '/__api/auth/handoff?t=x').answered).toBe(false);
      expect(run(a, '/__api/sessions').status).toBe(401);
      expect(run(a, '/some/page').headers.location).toBe(SSO); // protected page: SSO, not /__host/
      const u = a.createUser('x@example.com', 'admin');
      const s = a.createWebSession(u.id, 'ua');
      expect(run(a, '/__host/', { ...HTML, cookie: `${COOKIE}=${s.token}` }).answered).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.ARIGAMI_SSO_URL;
      else process.env.ARIGAMI_SSO_URL = prev;
    }
  });
  test('env unset: unchanged', () => {
    const a = mk();
    expect(run(a, '/__host/').answered).toBe(false);
    expect(run(a, '/some/page').headers.location).toBe('/__host/');
  });
});
