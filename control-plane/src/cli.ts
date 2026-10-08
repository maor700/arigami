// K8S-3 operator CLI — the paths that should NOT be one accidental click on a
// web form (restore overwrites a tenant's state) plus scriptable versions of
// what the admin page/reconcile loop do. Reads the same env contract as the
// service (src/config.ts) — run it next to the service with the same env:
//
//   bun src/cli.ts tenants
//   bun src/cli.ts set-digest  <ns|subject|email> <tag-or-sha256:digest>
//   bun src/cli.ts upgrade     <ns|subject|email>            # one tenant, right now (still refuses while busy)
//   bun src/cli.ts backup      <ns|subject|email>
//   bun src/cli.ts backups     <ns|subject|email>
//   bun src/cli.ts restore     <ns|subject|email> <archive.tgz> [--force]
//   bun src/cli.ts set-ring    <ns|subject|email> canary|stable   # canary tenants get a new profile first
//   bun src/cli.ts profile                                        # desired profile commit + every tenant's applied one
//   bun src/cli.ts profile-retry <ns|subject|email>               # drop a failed tenant's backoff (retried next tick)
//   bun src/cli.ts shared …                                   # shared org workspaces, see src/shared-cli.ts
//
// `restore` takes ANY tenant's archive — restoring tenant A's backup into
// tenant B is the migration path (proved live, docs/CONTROL-PLANE.md K8S-3).
import { loadConfig } from './config.js';
import { openDb, createStore, type Tenant } from './db.js';
import * as provisioner from './provisioner.js';
import { upgradeTenant, UpgradeBlockedError } from './upgrade.js';
import { realOps } from './reconcile.js';
import { backupTenant, listBackups, restoreTenant } from './backup.js';
import { DESIRED_META_KEY, haltingTenant, rolloutEnabled, type DesiredRecord } from './profile-rollout.js';
import { runSharedCli } from './shared-cli.js';

const cfg = loadConfig();
const store = createStore(openDb(cfg.dbPath));
const [cmd, ref, arg3] = process.argv.slice(2);
const force = process.argv.includes('--force');
const out = (o: unknown) => process.stdout.write(JSON.stringify(o, null, 2) + '\n');

function findTenant(r: string): Tenant {
  const t = store.listTenants().find((t) => t.ns === r || t.subject === r || t.email === r?.toLowerCase());
  if (!t) throw new Error(`no tenant matching "${r}" (try: bun src/cli.ts tenants)`);
  return t;
}

try {
  if (cmd === 'shared') {
    process.exitCode = await runSharedCli(
      process.argv.slice(3),
      { cfg, store, provisioner, pushRoster: provisioner.pushRoster, log: (m) => process.stderr.write(m + '\n') },
      out,
      (s) => process.stderr.write(s),
    );
  } else if (cmd === 'tenants') {
    out(store.listTenants().map(({ subject, email, ns, state, running_digest, desired_digest, last_seen_at }) => ({ subject, email, ns, state, running_digest, desired_digest, last_seen_at })));
  } else if (cmd === 'set-digest') {
    const t = findTenant(ref);
    if (!arg3) throw new Error('usage: set-digest <tenant> <tag-or-digest>');
    store.setDesiredDigest(t.subject, arg3);
    out({ ok: true, ns: t.ns, desired_digest: arg3, note: `applies on the next reconcile tick (${cfg.reconcileSec}s) when the tenant is idle` });
  } else if (cmd === 'upgrade') {
    const t = findTenant(ref);
    if (!t.desired_digest || t.desired_digest === t.running_digest) throw new Error(`${t.ns}: desired_digest (${t.desired_digest || 'unset'}) already matches — set-digest first`);
    try {
      const r = await upgradeTenant(realOps(cfg).upgradeDeps, t, t.desired_digest);
      store.setRunningDigest(t.subject, t.desired_digest);
      out({ ok: true, ns: t.ns, ...r });
    } catch (e) {
      if (e instanceof UpgradeBlockedError) { out({ ok: false, blocked: true, busySessions: e.busySessions }); process.exitCode = 3; }
      else throw e;
    }
  } else if (cmd === 'backup') {
    const t = findTenant(ref);
    out({ ok: true, ns: t.ns, ...(await backupTenant(cfg, t)) });
  } else if (cmd === 'backups') {
    out(listBackups(cfg, findTenant(ref).ns));
  } else if (cmd === 'restore') {
    const t = findTenant(ref);
    if (!arg3) throw new Error('usage: restore <tenant> <archive.tgz> [--force]');
    await restoreTenant(cfg, t, arg3, { force });
    out({ ok: true, ns: t.ns, restoredFrom: arg3 });
  } else if (cmd === 'set-ring') {
    const t = findTenant(ref);
    if (arg3 !== 'canary' && arg3 !== 'stable') throw new Error('usage: set-ring <tenant> canary|stable');
    store.setRing(t.subject, arg3);
    out({ ok: true, ns: t.ns, ring: arg3 });
  } else if (cmd === 'profile') {
    const desired = store.getMeta<DesiredRecord>(DESIRED_META_KEY);
    const tenants = store.listTenants();
    out({
      enabled: rolloutEnabled(cfg),
      source: cfg.arigamiBundle,
      desired,
      haltedBy: desired?.commit ? haltingTenant(tenants, desired.commit)?.ns ?? null : null,
      tenants: tenants.map((t) => ({
        ns: t.ns, state: t.state, ring: t.ring, applied: t.profile_commit, ref: t.profile_ref,
        ...(t.profile_failures ? { failedCommit: t.profile_failed_commit, failures: t.profile_failures, nextAt: new Date(t.profile_next_at).toISOString(), error: t.profile_error } : {}),
      })),
    });
  } else if (cmd === 'profile-retry') {
    const t = findTenant(ref);
    store.clearProfileBackoff(t.subject);
    out({ ok: true, ns: t.ns, note: `retried on the next reconcile tick (${cfg.reconcileSec}s) when the tenant is idle` });
  } else {
    process.stderr.write('usage: bun src/cli.ts tenants | shared … | set-digest <t> <digest> | upgrade <t> | backup <t> | backups <t> | restore <t> <file.tgz> [--force] | set-ring <t> canary|stable | profile | profile-retry <t>\n');
    process.exitCode = 2;
  }
} catch (e) {
  process.stderr.write(`error: ${(e as Error).message}\n`);
  if ((e as provisioner.ProvisionError).stderr) process.stderr.write(`${(e as provisioner.ProvisionError).stderr}\n`);
  process.exitCode = 1;
}
