// ARIGAMI_SSO_URL: the control-plane entry each tenant sends a session-less browser to (server/sso-redirect.ts).
import { describe, test, expect } from 'bun:test';
import { loadConfig } from '../src/config.js';
import { buildHelmArgs, ssoUrl } from '../src/provisioner.js';
import type { Tenant } from '../src/db.js';

const cfg = loadConfig({ CP_ORG_DOMAIN: 'lab.example.com', CP_PUBLIC_URL: 'https://lab.example.com/' } as unknown as NodeJS.ProcessEnv);
const tenant = (over: Partial<Tenant> = {}): Tenant => ({
  subject: 's1', email: 'a@example.com', ns: 'u-abc', release: 'u-abc',
  desired_digest: 'd1', running_digest: 'd1', ring: 'stable', state: 'running', created_at: '', last_seen_at: '', handoff_secret: 'x'.repeat(20),
  profile_commit: '', profile_ref: '', profile_checked_at: 0, profile_failed_commit: '', profile_failures: 0, profile_next_at: 0, profile_error: '',
  ...over,
});
const flag = (args: string[]) => {
  const i = args.findIndex((a) => a.startsWith('env.ARIGAMI_SSO_URL='));
  return i < 0 ? null : { set: args[i - 1], value: args[i].slice('env.ARIGAMI_SSO_URL='.length) };
};

describe('ARIGAMI_SSO_URL', () => {
  test('personal tenant: /workspace on the control plane', () => {
    expect(ssoUrl(cfg, tenant())).toBe('https://lab.example.com/workspace');
    expect(flag(buildHelmArgs(cfg, tenant()))).toEqual({ set: '--set-string', value: 'https://lab.example.com/workspace' });
  });
  test('shared workspace: /workspaces/<name>/open, name encoded', () => {
    const t = tenant({ kind: 'shared', name: 'eng team' });
    expect(flag(buildHelmArgs(cfg, t))?.value).toBe('https://lab.example.com/workspaces/eng%20team/open');
  });
  test('re-provision (every upgrade uses the same argv builder) carries it', () => {
    expect(flag(buildHelmArgs(cfg, tenant({ state: 'dormant', running_digest: 'old' })))).not.toBeNull();
  });
});
