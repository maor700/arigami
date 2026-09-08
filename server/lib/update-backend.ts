// Update channel abstraction (dispatch/update-backend): today the *only*
// wired update path is git — fetch/pull/install/build against a live
// checkout, run from host-control.ts. That stops being universal once
// Arigami ships as a Docker image (no self-recreate) or a `bun build
// --compile` desktop binary (no checkout, no remote, signed & read-only on
// macOS) — verified live: the compiled binary reports `commit: null`,
// `branch: null`, and the Settings card shows "No upstream".
//
// This module names the three destinations as an `UpdateChannel` and gives
// each one an `UpdateBackend` with the same shape, so callers (hostStatus(),
// the upgrade endpoint) branch on the abstraction instead of re-deriving
// "are we in a container / a compiled binary" inline. `pickBackend()` is the
// only detection logic — everything else is per-channel.
//
// `git` is a pure wrapper around what host-control.ts already does
// (upgradePlan/dirtyNow/allowUpgrade/the merge-base check) — zero semantic
// change, see test/host-control.test.ts. `docker` makes explicit what was
// already true (a container can't recreate itself — see the F8 comment on
// `inContainer()`). `packaged` is a scaffold only: detection + `available()`
// via the GitHub Releases check `version.ts` already has, everything else
// (`plan`/`run`) deliberately unimplemented — downloading and verifying a
// signed build is a separate piece of work.
//
// Import direction: this file statically imports host-control.js and
// version.js (both leaf-ish, neither imports this file at module scope).
// host-control.ts imports THIS file only with a dynamic `await import()`
// inside function bodies (same pattern it already uses for version.js), so
// there is no real circular *evaluation* — by the time host-control.ts's
// dynamic import fires, both modules are already fully initialized.
import { cfg } from './config.js';
import { resourceRoot, isCompiledBinary } from './resource-root.js';
import { upgradePlan, dirtyNow, inContainer, ALLOW_ERROR, DIRTY_ERROR, NOT_FF_ERROR, type UpgradeStep } from '../host-control.js';
import { getVersion, currentVersion, fetchLatestRelease, compareVersions } from '../version.js';

export type UpdateChannel = 'git' | 'docker' | 'packaged';
export type { UpgradeStep };

export interface UpdateBackend {
  channel: UpdateChannel;
  /** Cheap, side-effect-free "could an upgrade even start" check for the UI. */
  preflight(): Promise<{ ok: boolean; reason?: string; blockers?: string[] }>;
  available(): Promise<{ current: string; latest: string | null; updateAvailable: boolean }>;
  /** The step list `startUpgrade()` runs, or null when this channel can't self-upgrade. */
  plan(): UpgradeStep[] | null;
  run?(emit: (line: string) => void): Promise<{ ok: boolean; to: string | null }>;
  /** What brings the new build into effect once files are in place. */
  finish: 'restart-self' | 'relaunch-app' | 'recreate-container';
}

function gitBackend(root: string): UpdateBackend {
  return {
    channel: 'git',
    async preflight() {
      if (cfg.host?.allowUpgrade === false) return { ok: false, reason: ALLOW_ERROR };
      const dirty = await dirtyNow(root);
      if (dirty.length) return { ok: false, reason: DIRTY_ERROR, blockers: dirty };
      const v = await getVersion({ root });
      if (v.upstream && v.sharedBase === false) return { ok: false, reason: NOT_FF_ERROR };
      return { ok: true };
    },
    async available() {
      const v = await getVersion({ root });
      return { current: v.version, latest: v.available.version, updateAvailable: v.updateAvailable };
    },
    // Exactly upgradePlan(root) — zero semantic change from what
    // startUpgrade()'s own default already computed before this backend existed.
    plan() { return upgradePlan(root); },
    finish: 'restart-self',
  };
}

function dockerBackend(root: string): UpdateBackend {
  return {
    channel: 'docker',
    async preflight() {
      // F8's existing comment on hostStatus(), made explicit instead of implicit:
      // there is no self-recreate from inside a container.
      return { ok: false, reason: 'a container can\'t recreate itself — pull the new image and recreate the container from the host (docker compose pull && up -d, or your orchestrator\'s rolling update)' };
    },
    async available() {
      const v = await getVersion({ root });
      return { current: v.version, latest: v.available.version, updateAvailable: v.updateAvailable };
    },
    plan() { return null; },
    finish: 'recreate-container',
  };
}

function packagedBackend(root: string): UpdateBackend {
  return {
    channel: 'packaged',
    async preflight() {
      return { ok: false, reason: 'packaged updates are not implemented yet' };
    },
    async available() {
      const current = currentVersion(root);
      const release = await fetchLatestRelease(root);
      const latest = release?.tag ? release.tag.replace(/^v/, '') : null;
      return { current, latest, updateAvailable: compareVersions(latest, current) === 1 };
    },
    plan() { return null; },
    async run() {
      throw Object.assign(new Error('packaged update channel not implemented yet'), { status: 501 });
    },
    finish: 'relaunch-app',
  };
}

/**
 * The one piece of detection logic: compiled binary → packaged, container →
 * docker, else git. `deps` lets tests pick a branch deterministically
 * instead of mocking `resource-root.js`/`host-control.js` globally — real
 * callers (hostStatus(), the upgrade endpoint) never pass it, so detection
 * stays exactly `isCompiledBinary()`/`inContainer()` in production.
 */
export function pickBackend(
  root: string = resourceRoot(),
  deps: { isCompiledBinary?: () => boolean; inContainer?: () => boolean } = {},
): UpdateBackend {
  const compiled = deps.isCompiledBinary ?? isCompiledBinary;
  const container = deps.inContainer ?? inContainer;
  if (compiled()) return packagedBackend(root);
  if (container()) return dockerBackend(root);
  return gitBackend(root);
}
