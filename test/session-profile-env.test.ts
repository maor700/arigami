// Restricted run mode: the spawn env is an ALLOWLIST (server/session-profile.ts restrictedEnv / spawnEnvFor). A Full
// session's env is passed through untouched — the very same object.
import { test, expect, describe } from 'bun:test';
import * as sp from '../server/session-profile.ts';

const HOST = {
  PATH: '/usr/bin:/bin', HOME: '/home/u', USER: 'u', SHELL: '/bin/bash', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TERM: 'xterm', TMPDIR: '/tmp/s1',
  DISPLAY: ':101', PORT: '4100', CODEX_HOME: '/h/codex/s1',
  ARIGAMI_SESSION_ID: 's1', ARIGAMI_URL: 'http://127.0.0.1:3099', ARIGAMI_TOKEN: 'session-scoped', ARIGAMI_PROFILE: 'restricted', ARIGAMI_SKILLS: '/r/skills',
  CLAUDE_CODE_OAUTH_TOKEN: 'engine-cred',
  // what must never reach a restricted session
  GH_TOKEN: 'gh-secret', GITHUB_TOKEN: 'gh-secret', SLACK_BOT_TOKEN: 'slack-secret', SLACK_SIGNING_SECRET: 'x', LINEAR_API_KEY: 'lin', SENTRY_AUTH_TOKEN: 'sentry',
  AWS_SECRET_ACCESS_KEY: 'aws', COMPOSIO_API_KEY: 'c', NPM_TOKEN: 'n', DATABASE_URL: 'postgres://u:p@db/x', ARIGAMI_ADMIN_SECRET: 'not-allowlisted',
  HTTPS_PROXY: 'http://user:pass@proxy:3128', NO_PROXY: 'localhost', HTTP_PROXY: 'http://proxy:3128',
  UNSET: undefined,
};

describe('restrictedEnv', () => {
  const out = sp.restrictedEnv(HOST);
  test('keeps plumbing, locale, the session identity and the engine credential', () => {
    for (const k of ['PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'DISPLAY', 'PORT', 'CODEX_HOME', 'ARIGAMI_SESSION_ID', 'ARIGAMI_URL', 'ARIGAMI_TOKEN', 'ARIGAMI_PROFILE', 'ARIGAMI_SKILLS', 'CLAUDE_CODE_OAUTH_TOKEN'])
      expect(out[k]).toBe((HOST as any)[k]);
  });
  test('drops every service token and anything not named — including unknown ARIGAMI_* keys', () => {
    for (const k of ['GH_TOKEN', 'GITHUB_TOKEN', 'SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET', 'LINEAR_API_KEY', 'SENTRY_AUTH_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'COMPOSIO_API_KEY', 'NPM_TOKEN', 'DATABASE_URL', 'ARIGAMI_ADMIN_SECRET', 'UNSET'])
      expect(k in out).toBe(false);
  });
  test('proxy settings pass only without credentials in the URL', () => {
    expect(out.HTTP_PROXY).toBe('http://proxy:3128');
    expect(out.NO_PROXY).toBe('localhost');
    expect('HTTPS_PROXY' in out).toBe(false);
  });
  test('never adds a variable', () => {
    for (const k of Object.keys(out)) expect(k in HOST).toBe(true);
    expect(sp.restrictedEnv({})).toEqual({});
  });
});

describe('spawnEnvFor', () => {
  test('a Full session gets the exact same env object back', () => {
    const env = { ...HOST };
    expect(sp.spawnEnvFor({}, env)).toBe(env);
    expect(sp.spawnEnvFor({ profile: null }, env)).toBe(env);
    expect(sp.spawnEnvFor(undefined, env)).toBe(env);
  });
  test('a restricted session gets the allowlist', () => {
    const r = sp.spawnEnvFor({ profile: sp.fromSpec({ tools: ['git'] }) }, { ...HOST }) as Record<string, string>;
    expect(r.GH_TOKEN).toBeUndefined();
    expect(r.ARIGAMI_TOKEN).toBe('session-scoped');
  });
});
