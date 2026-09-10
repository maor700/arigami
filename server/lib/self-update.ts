// Notice that a new Arigami release exists — without anyone opening Settings.
//
// The pieces to act on an update were already here: version.ts knows what is
// running and what upstream has (`getVersion({refresh:true})` = `git fetch
// --tags` + the GitHub Releases check), update-backend.ts knows which channel
// this install can update through, and host-control.ts can run the upgrade.
// What was missing was the *asking*. `/__api/version` only computed anything
// when a human loaded the page, so an install nobody visits — a child host, a
// box on someone else's desk — could sit a dozen releases behind and never
// say a word. This is the timer that asks on its own and speaks up.
//
// Policy, deliberately asymmetric:
//   - Checking is on by default. It is one `git fetch` every few hours.
//   - Applying is OFF by default (`cfg.host.autoUpgrade`). An upgrade restarts
//     the host and drops what the sessions were doing; nobody's box gets
//     restarted because a bot decided to. Turning it on is an explicit choice,
//     and even then the upgrade is queued `when:'idle'` so it waits for the
//     running sessions to finish rather than killing them.
//
// A found update is announced once per version (host event on the bus + a push
// notification), not once per tick — otherwise every browser tab would buzz
// every few hours until someone clicked.
//
// Everything that touches the world (clock, version probe, backend, upgrade
// runner, bus, push, disk) is injectable, so test/self-update.test.ts drives
// the whole policy without a git remote, a network or a real upgrade.
import fs from 'node:fs';
import path from 'node:path';
import type { VersionInfo } from '../version.js';

export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000; // four times a day
export const TICK_MS = 30 * 60 * 1000; // scheduler cadence; a check only happens when the window lapsed
export const BOOT_DELAY_MS = 120 * 1000; // let the host finish booting before the first fetch

export interface SelfUpdateSeen {
  /** The `available` version we last announced — the key that makes it once-per-version. */
  version: string | null;
  tag: string | null;
  at: number;
}

export interface SelfUpdateStatus {
  enabled: boolean;
  auto: boolean;
  channel: string | null;
  current: string | null;
  available: string | null;
  availableTag: string | null;
  updateAvailable: boolean;
  lastCheck: number | null;
  lastError: string | null;
  announced: SelfUpdateSeen | null;
  applying: boolean;
  lastApply: { at: number; ok: boolean; to: string | null; error: string | null } | null;
}

export interface SelfUpdateDeps {
  store?: string | null;
  now: () => number;
  checkEveryMs: number;
  /** cfg.host.updateCheck !== false */
  enabled: () => boolean;
  /** cfg.host.autoUpgrade === true */
  auto: () => boolean;
  /** version.ts getVersion({refresh:true}) */
  version: () => Promise<VersionInfo>;
  /** update-backend.ts pickBackend() — channel + "could an upgrade even start". */
  backend: () => Promise<{ channel: string; preflight: () => Promise<{ ok: boolean; reason?: string | null }> }>;
  /** host-control.ts startUpgrade(when) — only ever called when auto is on. */
  upgrade: (when: 'idle') => Promise<unknown>;
  emit: (event: Record<string, unknown>) => void;
  notify: (title: string, body: string) => void;
  log: (line: string) => void;
}

/** A version string worth announcing over what is running: strictly newer, both parseable. */
export function isNewer(available: string | null | undefined, current: string | null | undefined): boolean {
  const parse = (s: string | null | undefined) => {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(s || '').trim().replace(/^v/, ''));
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const a = parse(available), c = parse(current);
  if (!a || !c) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== c[i]) return a[i] > c[i];
  return false;
}

/**
 * Should this tick announce? Only when there is an update AND we have not
 * already announced this exact version. `announced` is persisted, so a restart
 * does not re-announce what the human was already told about.
 */
export function shouldAnnounce(v: { updateAvailable: boolean; available: string | null; tag: string | null }, seen: SelfUpdateSeen | null): boolean {
  if (!v.updateAvailable) return false;
  if (!seen) return true;
  // Keyed on the version when there is one, else the tag — a commits-ahead-only
  // update (no version change) still announces once, then stays quiet.
  const key = v.available || v.tag || '';
  const seenKey = seen.version || seen.tag || '';
  return key !== seenKey;
}

export function createSelfUpdater(deps: Partial<SelfUpdateDeps> & Pick<SelfUpdateDeps, 'version' | 'backend' | 'upgrade'>) {
  const d: SelfUpdateDeps = {
    store: null,
    now: () => Date.now(),
    checkEveryMs: CHECK_EVERY_MS,
    enabled: () => true,
    auto: () => false,
    emit: () => {},
    notify: () => {},
    log: () => {},
    ...deps,
  } as SelfUpdateDeps;

  const st: SelfUpdateStatus = {
    enabled: true, auto: false, channel: null, current: null, available: null, availableTag: null,
    updateAvailable: false, lastCheck: null, lastError: null, announced: null, applying: false, lastApply: null,
  };

  // Only `announced` and `lastApply` survive a restart; everything else is
  // re-derived on the next tick and would only go stale on disk.
  if (d.store && fs.existsSync(d.store)) {
    try {
      const j = JSON.parse(fs.readFileSync(d.store, 'utf8'));
      if (j && typeof j === 'object') { st.announced = j.announced ?? null; st.lastApply = j.lastApply ?? null; }
    } catch {}
  }
  function persist() {
    if (!d.store) return;
    try {
      fs.mkdirSync(path.dirname(d.store), { recursive: true });
      fs.writeFileSync(d.store, JSON.stringify({ announced: st.announced, lastApply: st.lastApply }, null, 2));
    } catch {}
  }

  function status(): SelfUpdateStatus {
    return { ...st, enabled: d.enabled(), auto: d.auto() };
  }

  /** Ask version.ts what is out there. Cheap enough to call directly from the API too. */
  async function check(): Promise<SelfUpdateStatus> {
    let v: VersionInfo;
    try {
      v = await d.version();
    } catch (e) {
      st.lastError = (e as Error)?.message || 'version check failed';
      st.lastCheck = d.now();
      d.log(`check failed: ${st.lastError}`);
      return status();
    }
    st.lastError = null;
    st.lastCheck = d.now();
    st.current = v.version ?? null;
    st.available = v.available?.version ?? null;
    st.availableTag = v.available?.tag ?? v.available?.release?.tag ?? null;
    // Trust version.ts's own verdict (it also counts commits ahead), but a
    // version number that went BACKWARDS is not an update — that is a checkout
    // sitting on a branch, not a release to chase.
    st.updateAvailable = !!v.updateAvailable && (!st.available || !st.current || isNewer(st.available, st.current) || v.ahead === null || (v.ahead ?? 0) > 0);
    try { st.channel = (await d.backend()).channel; } catch { st.channel = null; }
    return status();
  }

  /** One beat: check when the window lapsed, announce a new version once, auto-apply only if asked to. */
  async function tick(): Promise<SelfUpdateStatus> {
    if (!d.enabled()) return status();
    if (st.lastCheck && d.now() - st.lastCheck < d.checkEveryMs) return status();

    await check();
    if (!st.updateAvailable) return status();

    if (shouldAnnounce({ updateAvailable: st.updateAvailable, available: st.available, tag: st.availableTag }, st.announced)) {
      st.announced = { version: st.available, tag: st.availableTag, at: d.now() };
      persist();
      const label = st.available || st.availableTag || 'a newer build';
      d.log(`update available: ${st.current || '?'} → ${label} (channel ${st.channel || '?'})`);
      d.emit({ kind: 'self-update-available', current: st.current, available: st.available, tag: st.availableTag, channel: st.channel, auto: d.auto() });
      d.notify('Arigami update available', `${st.current || '?'} → ${label}`);
    }

    if (!d.auto() || st.applying) return status();

    // Auto-apply. Ask the channel first: a Docker or packaged install cannot
    // upgrade itself in place, and there is no point starting a job that
    // host-control would refuse (a dirty checkout, allowUpgrade=false).
    let pf: { ok: boolean; reason?: string | null };
    try { pf = await (await d.backend()).preflight(); } catch (e) { pf = { ok: false, reason: (e as Error)?.message }; }
    if (!pf.ok) {
      d.log(`auto-upgrade skipped: ${pf.reason || 'the channel cannot upgrade in place'}`);
      return status();
    }
    // Do not retry the same failed version every half hour.
    if (st.lastApply && !st.lastApply.ok && st.lastApply.to === (st.available || st.availableTag) && d.now() - st.lastApply.at < d.checkEveryMs) return status();

    st.applying = true;
    const to = st.available || st.availableTag;
    try {
      // `idle` and not `now`: wait for the busy sessions to finish rather than
      // pulling the floor out from under them.
      await d.upgrade('idle');
      st.lastApply = { at: d.now(), ok: true, to, error: null };
      d.log(`auto-upgrade queued (when idle) → ${to || '?'}`);
      d.emit({ kind: 'self-update-started', to, channel: st.channel });
    } catch (e) {
      const error = (e as Error)?.message || 'upgrade failed to start';
      st.lastApply = { at: d.now(), ok: false, to, error };
      d.log(`auto-upgrade failed to start: ${error}`);
      d.emit({ kind: 'self-update-failed', to, error });
    } finally {
      st.applying = false;
      persist();
    }
    return status();
  }

  let timer: ReturnType<typeof setInterval> | null = null;
  let bootTimer: ReturnType<typeof setTimeout> | null = null;
  function start({ bootDelayMs = BOOT_DELAY_MS, tickMs = TICK_MS } = {}) {
    if (timer) return;
    const beat = () => { tick().catch((e) => d.log(`tick failed: ${(e as Error)?.message}`)); };
    bootTimer = setTimeout(beat, bootDelayMs);
    timer = setInterval(beat, tickMs);
    (bootTimer as any).unref?.();
    (timer as any).unref?.();
  }
  function stop() {
    if (timer) clearInterval(timer);
    if (bootTimer) clearTimeout(bootTimer);
    timer = bootTimer = null;
  }

  return { status, check, tick, start, stop, _state: st };
}

// ---- singleton wiring (the host) ----------------------------------------------

let singleton: ReturnType<typeof createSelfUpdater> | null = null;

export async function selfUpdater() {
  if (singleton) return singleton;
  const { cfg } = await import('../state.js');
  const bus = await import('../bus.js');
  const logFile = path.join((cfg as any).logsDir || path.join((cfg as any).configDir, 'logs'), 'self-update.log');
  singleton = createSelfUpdater({
    store: path.join((cfg as any).configDir, 'self-update.json'),
    enabled: () => (cfg as any).host?.updateCheck !== false,
    auto: () => (cfg as any).host?.autoUpgrade === true,
    version: async () => (await import('../version.js')).getVersion({ refresh: true }),
    backend: async () => (await import('./update-backend.js')).pickBackend() as any,
    upgrade: async (when) => {
      const hc = await import('../host-control.js');
      const { pickBackend } = await import('./update-backend.js');
      const plan = pickBackend().plan();
      if (!plan) throw new Error('no upgrade plan for this channel');
      return hc.startUpgrade(when, undefined, plan);
    },
    emit: (event) => bus.broadcast({ type: 'host', event } as any),
    notify: (title, body) => {
      import('../push.js')
        .then((push: any) => {
          if (!push.hasSubscriptions()) return;
          return push.sendPush({ title: title.slice(0, 80), body: String(body || '').slice(0, 200), tag: 'self-update', url: '/__host/#/settings/host' });
        })
        .catch(() => {});
    },
    log: (line) => {
      console.log(`[self-update] ${line}`);
      try { fs.mkdirSync(path.dirname(logFile), { recursive: true }); fs.appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`); } catch {}
    },
  });
  return singleton;
}

/** index.ts: arm the periodic "is there a new release?" loop. */
export async function startSelfUpdater() {
  const u = await selfUpdater();
  u.start();
  return u;
}
