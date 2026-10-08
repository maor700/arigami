// Profile rollout (src/profile-rollout.ts) over fake ops — no k8s, no git, no
// timers: the convergence decision, the canary pass (order, stop on the first
// failure, halt held across ticks, backoff, release), and how it sits inside
// the reconcile tick next to image upgrades and backups.
import { describe, test, expect } from 'bun:test';
import { loadConfig } from '../src/config.js';
import { openDb, createStore, type Tenant } from '../src/db.js';
import { reconcileTick, type ReconcileOps } from '../src/reconcile.js';
import { createApp, type Provisioner } from '../src/server.js';
import {
  decideProfile, parseLsRemote, backoffMs, gitAuthEnv, redact, resolveDesired, profilePass, rolloutOrder, haltingTenant,
  rolloutEnabled, DESIRED_META_KEY, type ProfileOps, type DesiredProfile, type TenantProfileStatus,
} from '../src/profile-rollout.js';

const C1 = '1'.repeat(40);
const C2 = '2'.repeat(40);
const C3 = '3'.repeat(40);

const tenant = (over: Partial<Tenant> = {}): Tenant => ({
  subject: 's1', email: 'a@example.com', ns: 'u-abc', release: 'u-abc',
  desired_digest: 'd', running_digest: 'd', ring: 'stable', state: 'running', created_at: '', last_seen_at: '',
  handoff_secret: 'test-handoff-secret-16+',
  profile_commit: '', profile_ref: '', profile_checked_at: 0, profile_failed_commit: '', profile_failures: 0, profile_next_at: 0, profile_error: '',
  ...over,
});

function setup(env: Record<string, string> = {}) {
  const cfg = loadConfig({
    CP_IMAGE_TAG: 'd', CP_RECONCILE_SEC: '0', CP_BACKUP_INTERVAL_SEC: '0',
    CP_ARIGAMI_BUNDLE: 'https://git.example.com/org/profile.git', CP_ARIGAMI_BUNDLE_REF: 'main',
    CP_PROFILE_RETRY_BASE_SEC: '60', CP_PROFILE_RETRY_MAX_SEC: '600', CP_PROFILE_RECHECK_SEC: '0',
    ...env,
  } as unknown as NodeJS.ProcessEnv);
  const store = createStore(openDb(':memory:'));
  return { cfg, store };
}

function mk(store: ReturnType<typeof createStore>, subject: string, opts: { ring?: string; applied?: string } = {}): Tenant {
  store.createUser(subject, `${subject}@example.com`, 'user');
  const t = store.createTenant(subject, `${subject}@example.com`, { desiredDigest: 'd', ring: opts.ring });
  store.setRunningDigest(subject, 'd');
  store.setTenantState(subject, 'running');
  if (opts.applied) store.setProfileApplied(subject, opts.applied, 'main', 0);
  return store.findTenantBySubject(subject)!;
}

/** A fake fleet: each tenant has a "current" commit; apply() succeeds unless the commit is in `bad`. */
function fleet(init: Record<string, string> = {}, opts: { bad?: Set<string>; busy?: Set<string>; unreachable?: Set<string> } = {}) {
  const current = new Map(Object.entries(init));
  const calls: string[] = [];
  const ops: ProfileOps = {
    async status(t): Promise<TenantProfileStatus> {
      calls.push(`status:${t.subject}`);
      if (opts.unreachable?.has(t.subject)) throw new Error('kubectl exec failed');
      return { configured: true, commit: current.get(t.subject) || '', ref: 'main', errors: 0, busySessions: opts.busy?.has(t.subject) ? 1 : 0 };
    },
    async apply(t, d) {
      calls.push(`apply:${t.subject}:${d.commit.slice(0, 1)}`);
      if (opts.bad?.has(d.commit)) return { ok: false, error: 'HTTP 422: invalid bundle: profile.json: "name" must match' };
      current.set(t.subject, d.commit);
      return { ok: true, commit: d.commit };
    },
  };
  return { ops, calls, current };
}
const desired = (commit: string): DesiredProfile => ({ source: 'https://git.example.com/org/profile.git', ref: 'main', commit, resolvedAt: 0 });

describe('decideProfile (the convergence decision)', () => {
  const ctx = { haltedBy: null, now: 1_000_000, recheckSec: 0 };
  test('a running tenant on another commit converges; one already on it is left alone', () => {
    expect(decideProfile(tenant({ profile_commit: C1 }), { commit: C2 }, ctx)).toEqual({ action: 'converge', reason: 'new' });
    expect(decideProfile(tenant({ profile_commit: '' }), { commit: C2 }, ctx)).toEqual({ action: 'converge', reason: 'new' });
    expect(decideProfile(tenant({ profile_commit: C2 }), { commit: C2 }, ctx)).toEqual({ action: 'skip', reason: 'converged' });
  });
  test('only running tenants that can verify an operator call are touched', () => {
    for (const state of ['provisioning', 'dormant', 'archived', 'deleted'] as const)
      expect(decideProfile(tenant({ state }), { commit: C2 }, ctx)).toEqual({ action: 'skip', reason: 'not-running' });
    expect(decideProfile(tenant({ handoff_secret: '' }), { commit: C2 }, ctx)).toEqual({ action: 'skip', reason: 'no-secret' });
  });
  test('a failed tenant waits out its backoff, then is the one retried', () => {
    const failed = tenant({ profile_failed_commit: C2, profile_failures: 2, profile_next_at: ctx.now + 1 });
    expect(decideProfile(failed, { commit: C2 }, { ...ctx, haltedBy: failed.ns })).toEqual({ action: 'skip', reason: 'backoff' });
    expect(decideProfile({ ...failed, profile_next_at: ctx.now }, { commit: C2 }, { ...ctx, haltedBy: failed.ns })).toEqual({ action: 'converge', reason: 'retry' });
  });
  test('a failure of an OLD commit does not hold a tenant back from a new one', () => {
    const t = tenant({ profile_failed_commit: C2, profile_failures: 5, profile_next_at: ctx.now + 1e9 });
    expect(decideProfile(t, { commit: C3 }, ctx)).toEqual({ action: 'converge', reason: 'new' });
  });
  test('while another tenant holds the rollout, everyone else waits', () => {
    expect(decideProfile(tenant({ ns: 'u-b' }), { commit: C2 }, { ...ctx, haltedBy: 'u-a' })).toEqual({ action: 'skip', reason: 'halted' });
  });
  test('a converged tenant is re-read after the recheck interval (drift)', () => {
    const t = tenant({ profile_commit: C2, profile_checked_at: ctx.now - 3_600_000 });
    expect(decideProfile(t, { commit: C2 }, { ...ctx, recheckSec: 3600 })).toEqual({ action: 'converge', reason: 'recheck' });
    expect(decideProfile(t, { commit: C2 }, { ...ctx, recheckSec: 7200 })).toEqual({ action: 'skip', reason: 'converged' });
  });
});

describe('helpers', () => {
  test('parseLsRemote: peeled annotated tag > tag > branch; HEAD by default; exact names only', () => {
    const out = [`${C1}\tHEAD`, `${C1}\trefs/heads/main`, `${C2}\trefs/tags/v2`, `${C3}\trefs/tags/v2^{}`, `${C2}\trefs/heads/feature/v2`].join('\n');
    expect(parseLsRemote(out, '')).toBe(C1);
    expect(parseLsRemote(out, 'main')).toBe(C1);
    expect(parseLsRemote(out, 'v2')).toBe(C3);
    expect(parseLsRemote(out, 'refs/heads/feature/v2')).toBe(C2);
    expect(parseLsRemote(out, 'nope')).toBe(null);
  });
  test('backoff doubles per failure and is capped', () => {
    const cfg = { profileRetryBaseSec: 60, profileRetryMaxSec: 600 };
    expect([1, 2, 3, 4, 5, 9].map((n) => backoffMs(n, cfg) / 1000)).toEqual([60, 120, 240, 480, 600, 600]);
  });
  test('the git token travels as a header for https only, never in a URL or a message', () => {
    const env = gitAuthEnv('https://git.example.com/org/profile.git', 'tok123');
    expect(env.GIT_CONFIG_KEY_0).toBe('http.https://git.example.com/.extraheader');
    expect(JSON.stringify(env)).not.toContain('tok123');
    expect(gitAuthEnv('git@git.example.com:org/profile.git', 'tok123')).toEqual({});
    expect(gitAuthEnv('http://git.example.com/org/profile.git', 'tok123')).toEqual({});
    expect(redact('fatal: unable to access https://x:tok123@git.example.com/org/profile.git')).not.toContain('tok123');
    expect(redact('AUTHORIZATION: basic dG9rMTIz')).not.toContain('dG9rMTIz');
  });
  test('resolveDesired: a full sha needs no network; a ref is resolved through ls-remote with the token header', async () => {
    const { cfg } = setup({ CP_ARIGAMI_BUNDLE_REF: C2, CP_ARIGAMI_GIT_TOKEN: 'tok123' });
    expect((await resolveDesired(cfg, async () => { throw new Error('no network expected'); })).commit).toBe(C2);
    const { cfg: cfg2 } = setup({ CP_ARIGAMI_BUNDLE_REF: 'v2', CP_ARIGAMI_GIT_TOKEN: 'tok123' });
    let seen: { args: string[]; env: Record<string, string> } | null = null;
    const d = await resolveDesired(cfg2, async (args, env) => { seen = { args, env }; return { code: 0, stdout: `${C3}\trefs/tags/v2\n`, stderr: '' }; });
    expect(d).toMatchObject({ ref: 'v2', commit: C3 });
    expect(seen!.args.join(' ')).not.toContain('tok123');
    expect(seen!.env.GIT_CONFIG_VALUE_0).toContain('basic');
    await expect(resolveDesired(cfg2, async () => ({ code: 0, stdout: `${C1}\trefs/heads/main\n`, stderr: '' }))).rejects.toThrow(/not found/);
    const { cfg: bad } = setup({ CP_ARIGAMI_BUNDLE_REF: '--upload-pack=evil' });
    await expect(resolveDesired(bad, async () => ({ code: 0, stdout: '', stderr: '' }))).rejects.toThrow(/not a valid git ref/);
  });
  test('rollout is on only for a git bundle, and can be turned off', () => {
    expect(rolloutEnabled(setup().cfg)).toBe(true);
    expect(rolloutEnabled(setup({ CP_PROFILE_ROLLOUT: '0' }).cfg)).toBe(false);
    expect(rolloutEnabled(setup({ CP_ARIGAMI_BUNDLE: '' }).cfg)).toBe(false);
    expect(rolloutEnabled(setup({ CP_ARIGAMI_BUNDLE: 'shipped-name' }).cfg)).toBe(false);
  });
  test('canary ring first, otherwise oldest first', () => {
    const ts = [tenant({ ns: 'a' }), tenant({ ns: 'b', ring: 'canary' }), tenant({ ns: 'c' }), tenant({ ns: 'd', ring: 'canary' })];
    expect(rolloutOrder(ts).map((t) => t.ns)).toEqual(['b', 'd', 'a', 'c']);
  });
});

describe('profilePass (the canary rollout)', () => {
  test('converges every tenant in order, canary first; a tenant already on the commit is confirmed, not re-applied', async () => {
    const { cfg, store } = setup();
    mk(store, 'a'); mk(store, 'b'); mk(store, 'c', { ring: 'canary' });
    const { ops, calls } = fleet({ a: C1, b: C2, c: C1 });
    const { summary } = await profilePass(cfg, store, ops, desired(C2), { log: () => {}, now: 1000 });
    expect(calls.filter((c) => c.startsWith('apply:'))).toEqual(['apply:c:2', 'apply:a:2']);
    expect(summary.confirmed).toEqual([store.findTenantBySubject('b')!.ns]);
    for (const s of ['a', 'b', 'c']) expect(store.findTenantBySubject(s)!.profile_commit).toBe(C2);
    // second pass: nothing to do, nothing called
    const again = fleet({ a: C2, b: C2, c: C2 });
    await profilePass(cfg, store, again.ops, desired(C2), { log: () => {}, now: 2000 });
    expect(again.calls).toEqual([]);
  });

  test('a bad profile stops at the first failure: later tenants untouched, failure + backoff recorded', async () => {
    const { cfg, store } = setup();
    mk(store, 'canary', { ring: 'canary', applied: C1 }); mk(store, 'a', { applied: C1 }); mk(store, 'b', { applied: C1 });
    const { ops, calls, current } = fleet({ canary: C1, a: C1, b: C1 }, { bad: new Set([C2]) });
    const { summary } = await profilePass(cfg, store, ops, desired(C2), { log: () => {}, now: 1000 });
    expect(calls).toEqual(['status:canary', 'apply:canary:2']);
    const cn = store.findTenantBySubject('canary')!;
    expect(summary.failed).toEqual([cn.ns]);
    expect(summary.halted).toBe(cn.ns);
    expect(cn).toMatchObject({ profile_commit: C1, profile_failed_commit: C2, profile_failures: 1, profile_next_at: 1000 + 60_000 });
    expect(cn.profile_error).toMatch(/invalid bundle/);
    expect(current.get('a')).toBe(C1);
    expect(current.get('b')).toBe(C1);
    expect(haltingTenant(store.listTenants(), C2)?.ns).toBe(cn.ns);

    // inside the backoff window: nobody is touched at all
    const quiet = await profilePass(cfg, store, ops, desired(C2), { log: () => {}, now: 30_000 });
    expect(calls.length).toBe(2);
    expect(quiet.summary.halted).toBe(cn.ns);

    // after it: ONLY the failed tenant is retried; its 2nd failure doubles the wait
    await profilePass(cfg, store, ops, desired(C2), { log: () => {}, now: 61_000 });
    expect(calls.slice(2)).toEqual(['status:canary', 'apply:canary:2']);
    expect(store.findTenantBySubject('canary')!).toMatchObject({ profile_failures: 2, profile_next_at: 61_000 + 120_000 });
  });

  test('publishing a fixed commit releases the halt and the rollout resumes, canary first', async () => {
    const { cfg, store } = setup();
    mk(store, 'canary', { ring: 'canary', applied: C1 }); mk(store, 'a', { applied: C1 });
    const { ops, calls } = fleet({ canary: C1, a: C1 }, { bad: new Set([C2]) });
    await profilePass(cfg, store, ops, desired(C2), { log: () => {}, now: 1000 });
    const { summary } = await profilePass(cfg, store, ops, desired(C3), { log: () => {}, now: 2000 });
    expect(summary.halted).toBe(null);
    expect(calls.filter((c) => c.startsWith('apply:'))).toEqual(['apply:canary:2', 'apply:canary:3', 'apply:a:3']);
    expect(store.findTenantBySubject('canary')!).toMatchObject({ profile_commit: C3, profile_failures: 0, profile_error: '' });
  });

  test('a successful retry releases the halt in the same pass', async () => {
    const { cfg, store } = setup();
    mk(store, 'canary', { ring: 'canary', applied: C1 }); mk(store, 'a', { applied: C1 });
    const bad = new Set([C2]);
    const { ops, calls } = fleet({ canary: C1, a: C1 }, { bad });
    await profilePass(cfg, store, ops, desired(C2), { log: () => {}, now: 1000 });
    bad.clear(); // the cause was transient (e.g. the git host was down)
    const { summary } = await profilePass(cfg, store, ops, desired(C2), { log: () => {}, now: 100_000 });
    expect(summary.applied.length).toBe(2);
    expect(summary.halted).toBe(null);
    expect(calls.filter((c) => c.startsWith('apply:'))).toEqual(['apply:canary:2', 'apply:canary:2', 'apply:a:2']);
  });

  test('busy or unreachable tenants are skipped (not failed) and the rollout continues past them', async () => {
    const { cfg, store } = setup();
    mk(store, 'busy', { ring: 'canary' }); mk(store, 'gone'); mk(store, 'ok');
    const { ops, calls } = fleet({}, { busy: new Set(['busy']), unreachable: new Set(['gone']) });
    const { summary } = await profilePass(cfg, store, ops, desired(C2), { log: () => {}, now: 1000 });
    expect(calls.filter((c) => c.startsWith('apply:'))).toEqual(['apply:ok:2']);
    expect(summary.busy).toEqual([store.findTenantBySubject('busy')!.ns]);
    expect(summary.unreachable).toEqual([store.findTenantBySubject('gone')!.ns]);
    expect(summary.failed).toEqual([]);
    expect(store.findTenantBySubject('busy')!.profile_failures).toBe(0);
  });

  test('a tenant that turns busy between status and apply (409) is deferred, not failed', async () => {
    const { cfg, store } = setup();
    mk(store, 'a');
    const ops: ProfileOps = {
      status: async () => ({ configured: true, commit: C1, ref: 'main', errors: 0, busySessions: 0 }),
      apply: async () => ({ ok: false, busy: true, error: '1 session(s) have a turn in flight' }),
    };
    const { summary } = await profilePass(cfg, store, ops, desired(C2), { log: () => {}, now: 1000 });
    expect(summary.busy.length).toBe(1);
    expect(store.findTenantBySubject('a')!.profile_failures).toBe(0);
  });

  test('a tenant whose provenance carries apply errors is not counted as converged', async () => {
    const { cfg, store } = setup();
    mk(store, 'a');
    const calls: string[] = [];
    const ops: ProfileOps = {
      status: async () => ({ configured: true, commit: C2, ref: 'main', errors: 1, busySessions: 0 }),
      apply: async (_t, d) => { calls.push('apply'); return { ok: true, commit: d.commit }; },
    };
    await profilePass(cfg, store, ops, desired(C2), { log: () => {}, now: 1000 });
    expect(calls).toEqual(['apply']);
  });

  test('CP_PROFILE_BATCH limits applies per tick (a slower canary)', async () => {
    const { cfg, store } = setup({ CP_PROFILE_BATCH: '1' });
    mk(store, 'a'); mk(store, 'b');
    const { ops, calls } = fleet();
    await profilePass(cfg, store, ops, desired(C2), { log: () => {}, now: 1000 });
    expect(calls.filter((c) => c.startsWith('apply:'))).toEqual(['apply:a:2']);
    await profilePass(cfg, store, ops, desired(C2), { log: () => {}, now: 2000 });
    expect(calls.filter((c) => c.startsWith('apply:'))).toEqual(['apply:a:2', 'apply:b:2']);
  });
});

describe('inside reconcileTick', () => {
  function tickOps(profile: { ops: ProfileOps; commit?: string; resolveError?: string }, extra: Partial<ReconcileOps> = {}) {
    const calls: string[] = [];
    const o: ReconcileOps = {
      upgradeDeps: {
        busySessions: async () => 0,
        revision: async () => 1,
        provision: async (t) => { calls.push(`provision:${t.subject}`); return { url: 'http://x' }; },
        verifyHealth: async () => {},
        rollback: async () => {},
      },
      backup: async (t) => { calls.push(`backup:${t.subject}`); },
      newestBackupMs: () => null,
      profile: {
        resolve: async () => {
          if (profile.resolveError) throw new Error(profile.resolveError);
          return desired(profile.commit || C2);
        },
        ops: profile.ops,
      },
      ...extra,
    };
    return { o, calls };
  }

  test('one lifecycle action per tenant per tick: upgraded → no profile; profile applied → no backup', async () => {
    const { cfg, store } = setup({ CP_BACKUP_INTERVAL_SEC: '3600' });
    mk(store, 'up'); mk(store, 'prof'); mk(store, 'idle', { applied: C2 });
    store.setDesiredDigest('up', 'd2');
    const f = fleet({ idle: C2 });
    const { o, calls } = tickOps({ ops: f.ops });
    const sum = await reconcileTick(cfg, store, o, () => {});
    expect(sum.upgraded.length).toBe(1);
    expect(f.calls.filter((c) => c.startsWith('apply:'))).toEqual(['apply:prof:2']);
    expect(calls.filter((c) => c.startsWith('backup:'))).toEqual(['backup:idle']);
    expect(sum.profile?.applied.length).toBe(1);
    expect(store.getMeta<any>(DESIRED_META_KEY)).toMatchObject({ ref: 'main', commit: C2 });
  });

  test('when the ref cannot be resolved nothing is rolled out, and the page says why', async () => {
    const { cfg, store } = setup();
    mk(store, 'a');
    store.setMeta(DESIRED_META_KEY, { ref: 'main', commit: C1, resolvedAt: 5 });
    const f = fleet();
    const { o } = tickOps({ ops: f.ops, resolveError: 'git ls-remote failed: https://x:tok123@git.example.com/ not found' });
    const sum = await reconcileTick(cfg, store, o, () => {});
    expect(sum.profile).toBeUndefined();
    expect(f.calls).toEqual([]);
    const meta = store.getMeta<any>(DESIRED_META_KEY);
    expect(meta.commit).toBe(C1);
    expect(meta.error).toMatch(/ls-remote failed/);
    expect(meta.error).not.toContain('tok123');
  });
});

describe('admin page', () => {
  const noopProvisioner: Provisioner = {
    provisionTenant: async (_c, t) => ({ url: `http://${t.ns}.example.test` }),
    deleteTenant: async () => {}, suspendTenant: async () => {}, resumeTenant: async () => {},
  };
  const adminOps = { backupTenant: async () => ({ name: 'x', bytes: 0 }), listBackups: () => [], podSnapshot: async () => ({}) as any };

  test('shows applied → desired per tenant, the halt, and a retry button that drops the backoff', async () => {
    const { cfg, store } = setup();
    store.createUser('admin-1', 'admin@example.com', 'admin');
    mk(store, 'ok', { applied: C2 }); mk(store, 'behind', { applied: C1 }); mk(store, 'broken', { applied: C1 });
    store.setProfileFailed('broken', C2, 'HTTP 422: invalid bundle', Date.now() + 600_000);
    store.setMeta(DESIRED_META_KEY, { ref: 'main', commit: C2, resolvedAt: Date.now() });
    const app = createApp(cfg, store, noopProvisioner, () => {}, adminOps);
    const cookie = `arigami_cp_sid=${store.createSession('admin-1', 1).token}`;
    const page = await (await app.handle(new Request('http://localhost:8090/admin', { headers: { cookie } }))).text();
    expect(page).toContain('Profile (applied → desired)');
    expect(page).toContain('Rollout halted');
    expect(page).toContain(store.findTenantBySubject('broken')!.ns);
    expect(page).toContain('failed ×1');
    expect(page).toContain('invalid bundle');
    expect(page).toContain('(halted)'); // 'behind' waits for the broken one
    expect(page).toContain('/admin/tenants/broken/profile-retry');

    const r = await app.handle(new Request('http://localhost:8090/admin/tenants/broken/profile-retry', { method: 'POST', headers: { cookie } }));
    expect(r.status).toBe(302);
    expect(store.findTenantBySubject('broken')!).toMatchObject({ profile_next_at: 0, profile_failures: 1 });

    store.createUser('user-1', 'bob@example.com', 'user');
    const asUser = await app.handle(new Request('http://localhost:8090/admin/tenants/broken/profile-retry', { method: 'POST', headers: { cookie: `arigami_cp_sid=${store.createSession('user-1', 1).token}` } }));
    expect(asUser.status).toBe(403);
  });
});
