// K8S-3 §3 — per-tenant backup & restore, reusing the host's EXISTING
// export/import (server/backup.ts, B4-full) instead of inventing an archive
// format:
//
//   backup:  kubectl exec  → `bun server/backup.ts export --full` in-pod
//            kubectl cp    → archive lands under CP_BACKUP_DIR/<ns>/ on the
//                            control-plane's own disk (NOT the tenant's PVC —
//                            a backup that lives on the volume it protects
//                            dies with it)
//   restore: kubectl cp    → archive into the target pod
//            kubectl exec  → `bun server/backup.ts import <file> --force`
//                            (the in-pod CLI can't see the live host's busy
//                            state; the control-plane checks tenantBusySessions
//                            FIRST, so --force here only skips a check that
//                            was already made — outside k8s the same guard is
//                            server/backup.ts's own 409)
//            rollout restart → the host comes back up on the restored dir
//
// Why exec-in-pod and not a CronJob/Job: the §5 quota decision is "a tenant
// is exactly one pod" — the namespace has zero request headroom for a backup
// pod, on purpose. A Job would also need the RWO volume (mountable only
// beside the running pod on the same node) and RBAC to reach it. Exec runs
// inside the pod that already has everything. Scheduling lives in
// src/reconcile.ts (CP_BACKUP_INTERVAL_SEC), the "control-plane job" flavour
// of the PRD's CronJob idea.
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './config.js';
import type { Tenant } from './db.js';
import { ProvisionError, execInTenant, tenantBusySessions, tenantPod, fullname, verifyTenantHealth } from './provisioner.js';

const IN_POD_TMP = '/tmp/arigami-cp-transfer.tgz';
const HOST_BACKUP_CLI = 'server/backup.ts'; // relative to the image's WORKDIR /app

export interface BackupEntry {
  file: string; // absolute path on the control-plane machine
  name: string;
  bytes: number;
  mtimeMs: number;
}

export function backupStamp(d = new Date()): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

export function tenantBackupDir(cfg: Config, ns: string): string {
  return path.join(cfg.backupDir, ns);
}

export function listBackups(cfg: Config, ns: string): BackupEntry[] {
  const dir = tenantBackupDir(cfg, ns);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => /^arigami-backup-.*\.tgz$/.test(n))
    .map((name) => {
      const st = fs.statSync(path.join(dir, name));
      return { file: path.join(dir, name), name, bytes: st.size, mtimeMs: st.mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first
}

/** Keep the newest `keep` archives; returns the deleted files. Pure over listBackups' order. */
export function pruneBackups(cfg: Config, ns: string, keep = cfg.backupKeep): string[] {
  const removed: string[] = [];
  for (const b of listBackups(cfg, ns).slice(Math.max(0, keep))) {
    try {
      fs.unlinkSync(b.file);
      removed.push(b.file);
    } catch {}
  }
  return removed;
}

async function run(cmd: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => {
    try { proc.kill(); } catch {}
  }, timeoutMs);
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return { code, stdout, stderr };
}

/**
 * Export the tenant's whole $ARIGAMI_DIR (minus the host-bound EXCLUDES the
 * host's own backup CLI already knows) and pull the archive to the
 * control-plane's disk. The tenant keeps running throughout — export is a
 * streamed tar of a live directory, same as the cockpit's own export button.
 */
export async function backupTenant(cfg: Config, t: Tenant): Promise<BackupEntry> {
  const ex = await execInTenant(cfg, t, ['bun', HOST_BACKUP_CLI, 'export', '--full', IN_POD_TMP], { timeoutMs: 300_000 });
  if (ex.code !== 0) throw new ProvisionError(`in-pod export failed for ${t.ns} (exit ${ex.code})`, ex.stderr || ex.stdout);

  const dir = tenantBackupDir(cfg, t.ns);
  fs.mkdirSync(dir, { recursive: true });
  const name = `arigami-backup-${backupStamp()}.tgz`;
  const local = path.join(dir, name);
  // kubectl cp = tar over exec; retries once on the flaky-stream failures cp is known for
  let cp = await run(['kubectl', 'cp', `${t.ns}/${tenantPod(t.ns)}:${IN_POD_TMP}`, local], 300_000);
  if (cp.code !== 0) cp = await run(['kubectl', 'cp', `${t.ns}/${tenantPod(t.ns)}:${IN_POD_TMP}`, local], 300_000);
  await execInTenant(cfg, t, ['rm', '-f', IN_POD_TMP]);
  if (cp.code !== 0) {
    try { fs.unlinkSync(local); } catch {}
    throw new ProvisionError(`kubectl cp out of ${t.ns} failed (exit ${cp.code})`, cp.stderr);
  }
  const st = fs.statSync(local);
  if (st.size === 0) {
    fs.unlinkSync(local);
    throw new ProvisionError(`backup of ${t.ns} came out empty`, '');
  }
  pruneBackups(cfg, t.ns);
  return { file: local, name, bytes: st.size, mtimeMs: st.mtimeMs };
}

export interface RestoreOptions {
  /** skip the no-turn-in-flight check (an operator restoring over a wedged tenant) */
  force?: boolean;
}

/**
 * Restore an archive (any tenant's — cross-tenant restore is the migration
 * path) into tenant `t`, then restart its pod so the host boots on the
 * restored $ARIGAMI_DIR. The previous state is kept in-pod by the host CLI
 * itself (a timestamped .bak next to the dir — server/backup.ts importFull).
 */
export async function restoreTenant(cfg: Config, t: Tenant, archiveFile: string, opts: RestoreOptions = {}): Promise<void> {
  if (!fs.existsSync(archiveFile)) throw new ProvisionError(`no such archive: ${archiveFile}`, '');
  if (!opts.force) {
    const busy = await tenantBusySessions(cfg, t); // throws when unreadable — fail closed
    if (busy > 0) throw new ProvisionError(`${t.ns} has ${busy} session(s) working — not restoring (pass force to override)`, '');
  }
  const cp = await run(['kubectl', 'cp', archiveFile, `${t.ns}/${tenantPod(t.ns)}:${IN_POD_TMP}`], 300_000);
  if (cp.code !== 0) throw new ProvisionError(`kubectl cp into ${t.ns} failed (exit ${cp.code})`, cp.stderr);
  const im = await execInTenant(cfg, t, ['bun', HOST_BACKUP_CLI, 'import', IN_POD_TMP, '--force'], { timeoutMs: 300_000 });
  await execInTenant(cfg, t, ['rm', '-f', IN_POD_TMP]);
  if (im.code !== 0) throw new ProvisionError(`in-pod import failed for ${t.ns} (exit ${im.code})`, im.stderr || im.stdout);

  const rr = await run(['kubectl', '-n', t.ns, 'rollout', 'restart', `statefulset/${fullname(t.ns)}`], 30_000);
  if (rr.code !== 0) throw new ProvisionError(`rollout restart failed for ${t.ns} (exit ${rr.code})`, rr.stderr);
  const st = await run(['kubectl', '-n', t.ns, 'rollout', 'status', `statefulset/${fullname(t.ns)}`, `--timeout=${cfg.helmTimeoutSec}s`], (cfg.helmTimeoutSec + 30) * 1000);
  if (st.code !== 0) throw new ProvisionError(`restored ${t.ns} did not come back Ready (exit ${st.code})`, st.stderr);
  await verifyTenantHealth(cfg, t);
}
