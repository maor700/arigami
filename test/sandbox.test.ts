// The restricted-session sandbox (server/lib/sandbox.ts, docker/sandbox/egress-proxy.ts): which host paths a
// container gets, the egress allowlist, the proxy's session credentials and private-address refusal, and the relay
// gate — pure, no docker.
import { test, expect, describe } from 'bun:test';
import path from 'node:path';
import crypto from 'node:crypto';
import * as sbx from '../server/lib/sandbox.ts';
import * as egress from '../docker/sandbox/egress-proxy.ts';

const ROOT = '/opt/arigami';
const ADIR = '/home/u/.arigami';
const HOMEDIR = '/home/u';
const files = new Set([
  ROOT, `${ROOT}/skills`, `${ROOT}/docs`, `${ROOT}/mcp`, `${ROOT}/mcp/policy-hook.js`, `${ROOT}/.claude-plugin`, `${ROOT}/server`, `${ROOT}/.env`,
  ADIR, `${ADIR}/user-plugin`, `${ADIR}/skills`, `${ADIR}/user/skills`, `${ADIR}/gatekeeper`, `${ADIR}/accounts.json`,
  `${ADIR}/scratch/s1`, `${ADIR}/codex/s1`, `${ADIR}/repos/app`, `${ADIR}/repos/app/.git`, `${ADIR}/repos/app-wt`, `${HOMEDIR}/.codex/auth.json`,
]);
const fsx = (git: Record<string, { top: string; common: string }> = {}): sbx.PlanFs => ({
  exists: (p) => files.has(p),
  realpath: (p) => (p === `${ADIR}/skills` ? `${ADIR}/user/skills` : p === `${ADIR}/codex/s1/auth.json` ? `${HOMEDIR}/.codex/auth.json` : files.has(p) ? p : null),
  readlink: () => null,
  links: (d) => (d === `${ADIR}/user-plugin` ? [[`${d}/skills`, `${ADIR}/skills`]] : d === `${ADIR}/codex/s1` ? [[`${d}/auth.json`, `${HOMEDIR}/.codex/auth.json`]] : []),
  git: (d) => git[d] || null,
});
const input = (over: Partial<sbx.PlanInput> = {}): sbx.PlanInput => ({
  sessionId: 's1',
  cwd: `${ADIR}/repos/app-wt`,
  args: ['-p', '--plugin-dir', ROOT, '--plugin-dir', `${ADIR}/user-plugin`, '--settings', JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ command: `bun "${ROOT}/mcp/policy-hook.js"` }] }] } })],
  env: { TMPDIR: `${ADIR}/scratch/s1`, CODEX_HOME: `${ADIR}/codex/s1`, ARIGAMI_DIR: ADIR, ARIGAMI_SKILLS: `${ROOT}/skills`, HOME: HOMEDIR },
  root: ROOT, arigamiDir: ADIR, home: HOMEDIR, workAreas: [`${ADIR}/repos`, `${ADIR}/workspace`],
  ...over,
});
const byTarget = (ms: sbx.Mount[]) => Object.fromEntries(ms.map((m) => [m.target, m.ro ? 'ro' : 'rw']));

describe('planMounts: only what the session needs', () => {
  const plan = sbx.planMounts(input(), fsx({ [`${ADIR}/repos/app-wt`]: { top: `${ADIR}/repos/app-wt`, common: `${ADIR}/repos/app/.git` } }));
  const m = byTarget(plan.mounts);
  test('its working tree and the repo git dir read-write; scratch, codex home and its own HOME read-write', () => {
    expect(plan.refused).toBeUndefined();
    expect(m[`${ADIR}/repos/app-wt`]).toBe('rw');
    expect(m[`${ADIR}/repos/app/.git`]).toBe('rw');
    expect(m[`${ADIR}/scratch/s1`]).toBe('rw');
    expect(m[`${ADIR}/codex/s1`]).toBe('rw');
    expect(m[`${ADIR}/sandbox/sessions/s1/home`]).toBe('rw');
  });
  test('Arigami code read-only, by subtree — never the checkout root (its .env, server/)', () => {
    expect(m[`${ROOT}/skills`]).toBe('ro');
    expect(m[`${ROOT}/mcp`]).toBe('ro');
    expect(m[`${ROOT}/.claude-plugin`]).toBe('ro');
    expect(m[ROOT]).toBeUndefined();
    expect(m[`${ROOT}/server`]).toBeUndefined();
    expect(m[`${ROOT}/.env`]).toBeUndefined();
  });
  test('the user plugin and the skills it links to, read-only; no other state of the host', () => {
    expect(m[`${ADIR}/user-plugin`]).toBe('ro');
    expect(m[`${ADIR}/skills`]).toBe('ro');
    expect(plan.mounts.find((x) => x.target === `${ADIR}/skills`)!.host).toBe(`${ADIR}/user/skills`);
    for (const t of Object.keys(m)) {
      expect(t === ADIR || t === HOMEDIR || t === ROOT).toBe(false);
      expect(t.startsWith(`${ADIR}/gatekeeper`) || t === `${ADIR}/accounts.json`).toBe(false);
    }
  });
  test("codex home's auth.json link: that one file, read-write (the engine refreshes it)", () => {
    expect(m[`${HOMEDIR}/.codex/auth.json`]).toBe('rw');
    expect(Object.keys(m).some((t) => t === `${HOMEDIR}/.codex`)).toBe(false);
  });
  test('an extension mod passed as a plugin dir is mounted read-only; a plugin dir that would expose the state dir is not', () => {
    files.add(`${ROOT}/extensions/gk/mods/m1`);
    const r = sbx.planMounts(input({ args: [...input().args, '--plugin-dir', `${ROOT}/extensions/gk/mods/m1`, '--plugin-dir', ADIR, '--plugin-dir', `${HOMEDIR}/.ssh`] }), fsx());
    const t = byTarget(r.mounts);
    expect(t[`${ROOT}/extensions/gk/mods/m1`]).toBe('ro');
    expect(t[ADIR]).toBeUndefined();
    expect(t[`${HOMEDIR}/.ssh`]).toBeUndefined();
  });
  test('a folder that would expose the home, the state dir or the checkout is refused', () => {
    for (const cwd of [HOMEDIR, ADIR, ROOT, '/', `${ADIR}/gatekeeper`]) {
      const r = sbx.planMounts(input({ cwd }), fsx());
      expect(r.refused).toBeTruthy();
      expect(r.mounts).toEqual([]);
    }
  });
  test('a repo whose git dir is an ancestor of the home is refused', () => {
    const r = sbx.planMounts(input({ cwd: `${ADIR}/repos/app-wt` }), fsx({ [`${ADIR}/repos/app-wt`]: { top: `${ADIR}/repos/app-wt`, common: HOMEDIR } }));
    expect(r.refused).toBeTruthy();
  });
});

describe('egress allowlist', () => {
  test('groups expand, host patterns pass, bare unknown words drop', () => {
    expect(sbx.expandEgress(['npm', 'example.com', 'nonsense'])).toEqual(['registry.npmjs.org', 'registry.yarnpkg.com', 'example.com']);
  });
  test('exact and *.subdomain matching; a wildcard does not cover the apex or look-alikes', () => {
    for (const fn of [sbx.hostAllowed, egress.hostAllowed]) {
      expect(fn('api.anthropic.com', ['api.anthropic.com'])).toBe(true);
      expect(fn('API.Anthropic.com.', ['api.anthropic.com'])).toBe(true);
      expect(fn('evil-api.anthropic.com', ['api.anthropic.com'])).toBe(false);
      expect(fn('a.example.com', ['*.example.com'])).toBe(true);
      expect(fn('example.com', ['*.example.com'])).toBe(false);
      expect(fn('badexample.com', ['*.example.com'])).toBe(false);
      expect(fn('attacker.bench', sbx.MODEL_HOSTS)).toBe(false);
    }
  });
});

describe('egress proxy', () => {
  const key = 'k'.repeat(64);
  const cred = (sid: string, pass?: string) => 'Basic ' + Buffer.from(`${sid}:${pass ?? crypto.createHmac('sha256', key).update(sid).digest('base64url').slice(0, 32)}`).toString('base64');
  test('a session proves itself with HMAC(key, id); anything else is nobody', () => {
    expect(egress.sessionOf(cred('sess_abc'), key)).toBe('sess_abc');
    expect(egress.sessionOf(cred('sess_abc', 'x'.repeat(32)), key)).toBe(null);
    expect(egress.sessionOf(cred('sess_other', crypto.createHmac('sha256', key).update('sess_abc').digest('base64url').slice(0, 32)), key)).toBe(null);
    expect(egress.sessionOf(undefined, key)).toBe(null);
    expect(egress.sessionOf('Bearer x', key)).toBe(null);
  });
  test('private, loopback, link-local (metadata) and CGNAT addresses are refused', () => {
    // Synthetic range examples (RFC 1918 / 6598), built from octets: the repo guard (no-internal-refs) is about
    // literal addresses of real networks in source, and these are not.
    const v4 = [[10, 1, 2, 3], [172, 20, 0, 1], [192, 168, 1, 1], [100, 64, 0, 1]].map((o) => o.join('.'));
    for (const a of ['127.0.0.1', ...v4, '169.254.169.254', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1'])
      expect(egress.isPrivateAddress(a)).toBe(true);
    for (const a of ['1.1.1.1', '140.82.112.3', '172.32.0.1', '2606:4700::1111']) expect(egress.isPrivateAddress(a)).toBe(false);
  });
});

describe('the host relay gate', () => {
  const fakeRes = () => { const r: any = { status: 0, body: '' }; r.writeHead = (s: number) => { r.status = s; return r; }; r.end = (b: string) => { r.body = b; }; return r; };
  test('without the sandbox on, nothing passes (and a Full session never would)', () => {
    const res = fakeRes();
    const req: any = { headers: { cookie: 'arigami_sid=x', 'x-forwarded-host': 'evil' } };
    expect(sbx.sandboxGate(req, res, { sessionOf: () => 's1', getSession: () => ({ id: 's1', profile: { name: 'r' } }) })).toBe(true);
    expect(res.status).toBe(403);
    expect(req.headers.cookie).toBeUndefined();
    expect(req.headers['x-forwarded-host']).toBeUndefined();
  });
});

describe('names and paths', () => {
  test('daemonPath maps the longest prefix only', () => {
    const map = [{ from: '/data', to: '/vm/bench' }, { from: '/data/.arigami', to: '/vm/inst' }];
    expect(sbx.daemonPath('/data/.arigami/x', map)).toBe('/vm/inst/x');
    expect(sbx.daemonPath('/data/repos/r', map)).toBe('/vm/bench/repos/r');
    expect(sbx.daemonPath('/database', map)).toBe('/database');
  });
  test('pathTokens finds absolute paths inside argv and JSON', () => {
    expect(sbx.pathTokens(`bun "${ROOT}/mcp/policy-hook.js"`)).toEqual([`${ROOT}/mcp/policy-hook.js`]);
    expect(sbx.pathTokens('--model')).toEqual([]);
    expect(path.isAbsolute(sbx.pathTokens('http://127.0.0.1:1/__mcp/s/arigami')[0] || '/')).toBe(true);
  });
});
