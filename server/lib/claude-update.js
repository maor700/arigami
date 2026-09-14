// UPD1 — keep the `claude` CLI Arigami spawns up to date, and say so.
//
// The CLI is a NATIVE install (~/.local/bin/claude → ~/.local/share/claude/
// versions/<ver>); `claude update` swaps that symlink in place. On Linux a
// running session keeps its old binary inode, so updating under live sessions
// is safe — only NEW spawns pick up the new build. That is also exactly when
// the model picker goes stale (the list ships with the CLI), so a successful
// update force-refetches server/models.js.
//
// "Is there an update?" — `claude update` (2.1.258) has no --check/--dry-run;
// it always installs. The CLI's own updater for native installs does
// GET https://downloads.claude.ai/claude-code-releases/<channel> and gets the
// version back as plain text ("2.1.258"). We ask the same URL (channel
// `latest`, what `claude update` tracks) and compare against `claude --version`
// of the binary lib/claude-bin.js resolves right now. No npm registry involved:
// the native channel and npm are published separately and never `npm i -g` a
// second copy next to the native one (that shadowed Fable 5.1 for a day).
//
// Policy: auto-apply is ON by default (cfg.host.claudeAutoUpdate=false turns
// it off; "update now" from the cockpit works either way). Never apply while
// the box is short on RAM — `claude update` peaks ~190MB RSS plus the download —
// defer and retry on the next tick instead of failing loudly.
//
// Everything that touches the world (version probe, HTTP, the runner, meminfo,
// clock, bus, push, models) is injectable so test/claude-update.test.ts drives
// it with stubs and never runs the real `claude update`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

export const LATEST_URL = 'https://downloads.claude.ai/claude-code-releases/latest';
export const CHECK_EVERY_MS = 24 * 60 * 60 * 1000; // once a day is plenty
export const TICK_MS = 15 * 60 * 1000; // scheduler cadence: daily check + retry of a deferred apply
export const BOOT_DELAY_MS = 90 * 1000; // let the host settle before the first probe
export const APPLY_TIMEOUT_MS = 5 * 60 * 1000; // download of a ~200MB binary on a slow link
export const DEFAULT_MIN_FREE_MB = 700; // ~190MB for the updater, ~400MB headroom the box must keep
export const LOG_TAIL = 40;

// ---- version compare ----------------------------------------------------------

/** "2.1.258 (Claude Code)" / "v2.1.258" / " 2.1.258\n" → "2.1.258"; null when there is no version in it. */
export function parseVersion(s) {
  const m = /(\d+)\.(\d+)\.(\d+)(?:[-.]([0-9A-Za-z.-]+))?/.exec(String(s || ''));
  return m ? m[0] : null;
}

/** semver-ish: -1 / 0 / 1 (a<b / a==b / a>b). A pre-release ("2.1.0-beta") sorts below its release. Unparseable → 0. */
export function compareVersions(a, b) {
  const pa = parseVersion(a), pb = parseVersion(b);
  if (!pa || !pb) return 0;
  const split = (v) => { const [core, pre] = v.split(/-(.*)/s); return { nums: core.split('.').map(Number), pre: pre || null }; };
  const A = split(pa), B = split(pb);
  for (let i = 0; i < 3; i++) if (A.nums[i] !== B.nums[i]) return A.nums[i] < B.nums[i] ? -1 : 1;
  if (A.pre === B.pre) return 0;
  if (!A.pre) return 1; // release > pre-release
  if (!B.pre) return -1;
  return A.pre < B.pre ? -1 : 1;
}

export const isNewer = (latest, installed) => compareVersions(latest, installed) > 0;

// ---- world -------------------------------------------------------------------------

/** MemAvailable from /proc/meminfo (what `free -m` calls "available"); os.freemem() elsewhere. */
export function memAvailableMb() {
  try {
    const m = /MemAvailable:\s+(\d+)\s*kB/.exec(fs.readFileSync('/proc/meminfo', 'utf8'));
    if (m) return Math.round(Number(m[1]) / 1024);
  } catch {}
  return Math.round(os.freemem() / 1024 / 1024);
}

async function fetchLatestFromRelease(url = LATEST_URL, timeoutMs = 15_000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': 'arigami-host' } });
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  const v = parseVersion(await r.text());
  if (!v) throw new Error(`${url} returned no version`);
  return v;
}

// `claude --version` on whatever lib/claude-bin.js resolves NOW (force: skip the
// one-minute memo — after an update the answer just changed).
async function probeInstalled(force = false) {
  const { cliVersion } = await import('../models.js');
  const v = await cliVersion(force);
  return v ? parseVersion(v) : null;
}

// Real runner: `claude update` under the host, output captured, killed on timeout.
function runClaudeUpdate({ timeoutMs = APPLY_TIMEOUT_MS } = {}) {
  return new Promise(async (resolve) => {
    const { claudeBin } = await import('./claude-bin.js');
    const bin = claudeBin({ force: true });
    execFile(bin, ['update'], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, CI: '1' } }, (err, stdout, stderr) => {
      const output = `${stdout || ''}${stderr ? `\n${stderr}` : ''}`.trim();
      resolve({ code: err ? (err.code === undefined || typeof err.code === 'string' ? 1 : err.code) : 0, timedOut: !!err?.killed, output, error: err ? err.message : null });
    });
  });
}

// ---- the updater ----------------------------------------------------------------------

/**
 * @param {object} deps
 *  installed(force)   → Promise<string|null>   `claude --version`
 *  fetchLatest()      → Promise<string>        the release pointer
 *  run()              → Promise<{code, output, timedOut?, error?}>  `claude update`
 *  memAvailableMb()   → number
 *  minFreeMb          → number
 *  auto()             → boolean                cfg.host.claudeAutoUpdate
 *  onUpdated({from,to}) → Promise<void>        models cache refetch
 *  emit(event)        → void                   bus `host` event
 *  notify(title, body)→ void                   push
 *  now()              → number
 *  store              → path|null              persisted status (checkedAt/latest/lastUpdate)
 *  log(line)          → void                   append to logs/claude-update.log
 *  name               → 'claude'|'codex'       event kind prefix + notification title
 */
export function createUpdater(deps = {}) {
  const d = {
    installed: probeInstalled,
    fetchLatest: fetchLatestFromRelease,
    run: runClaudeUpdate,
    memAvailableMb,
    minFreeMb: DEFAULT_MIN_FREE_MB,
    auto: () => true,
    onUpdated: async () => {},
    emit: () => {},
    notify: () => {},
    now: () => Date.now(),
    store: null,
    log: () => {},
    checkEveryMs: CHECK_EVERY_MS,
    name: 'claude',
    source: LATEST_URL,
    ...deps,
  };
  const title = `${d.name === 'codex' ? 'Codex' : 'Claude'} CLI`;

  const st = {
    installed: null,
    latest: null,
    checkedAt: null,
    checkError: null,
    lastUpdate: null, // { from, to, at, ok, log, error, durationMs }
    deferred: null, // { reason:'memory', availableMb, minFreeMb, since }
    applying: false,
    checking: false,
  };
  (function load() {
    if (!d.store) return;
    try {
      const j = JSON.parse(fs.readFileSync(d.store, 'utf8'));
      if (j && typeof j === 'object') {
        st.latest = j.latest ?? null;
        st.checkedAt = j.checkedAt ?? null;
        st.lastUpdate = j.lastUpdate ?? null;
      }
    } catch {}
  })();
  function persist() {
    if (!d.store) return;
    try {
      fs.mkdirSync(path.dirname(d.store), { recursive: true });
      fs.writeFileSync(d.store, JSON.stringify({ latest: st.latest, checkedAt: st.checkedAt, lastUpdate: st.lastUpdate }, null, 2));
    } catch (e) { console.error('[claude-update] persist failed:', e.message); }
  }

  const updateAvailable = () => !!(st.installed && st.latest && isNewer(st.latest, st.installed));

  function status() {
    return {
      installed: st.installed,
      latest: st.latest,
      updateAvailable: updateAvailable(),
      checkedAt: st.checkedAt,
      checkError: st.checkError,
      checking: st.checking,
      applying: st.applying,
      auto: !!d.auto(),
      deferred: st.deferred,
      minFreeMb: d.minFreeMb,
      availableMb: safeMem(),
      lastUpdate: st.lastUpdate,
      source: d.source,
    };
  }
  function safeMem() { try { return d.memAvailableMb(); } catch { return null; } }

  let checkInflight = null;
  /** Probe installed + latest. `force` skips the daily window (the cockpit's "check" button). Never throws. */
  function check({ force = false } = {}) {
    if (checkInflight) return checkInflight;
    const fresh = st.checkedAt && d.now() - st.checkedAt < d.checkEveryMs;
    if (!force && fresh && st.installed) return Promise.resolve(status());
    st.checking = true;
    checkInflight = (async () => {
      try { st.installed = (await d.installed(force)) || st.installed; } catch (e) { d.log(`version probe failed: ${e.message}`); }
      if (force || !fresh) {
        try {
          st.latest = await d.fetchLatest();
          st.checkedAt = d.now();
          st.checkError = null;
        } catch (e) {
          st.checkError = e.message;
          d.log(`latest check failed: ${e.message}`);
        }
      }
      persist();
      return status();
    })().finally(() => { st.checking = false; checkInflight = null; });
    return checkInflight;
  }

  let applyInflight = null;
  /**
   * Run `claude update` now. Resolves {deferred:true, ...} (no run) when RAM is
   * short, {ok, from, to, log} after a run. Rejects with status 409 when a run
   * is already in flight.
   */
  function apply({ reason = 'manual' } = {}) {
    if (applyInflight) { const e = new Error('an update is already running'); e.status = 409; return Promise.reject(e); }
    const availableMb = safeMem();
    if (availableMb !== null && availableMb < d.minFreeMb) {
      st.deferred = { reason: 'memory', availableMb, minFreeMb: d.minFreeMb, since: st.deferred?.since ?? d.now(), by: reason };
      d.log(`deferred (${reason}): ${availableMb}MB available < ${d.minFreeMb}MB`);
      if (reason === 'manual') d.emit({ kind: `${d.name}-update-deferred`, availableMb, minFreeMb: d.minFreeMb });
      return Promise.resolve({ deferred: true, ...st.deferred });
    }
    st.deferred = null;
    st.applying = true;
    const from = st.installed;
    const startedAt = d.now();
    d.emit({ kind: `${d.name}-update-started`, from, to: st.latest, reason });
    applyInflight = (async () => {
      let r;
      try { r = await d.run(); } catch (e) { r = { code: 1, output: '', error: e.message }; }
      const lines = String(r.output || '').split('\n').map((l) => l.trimEnd()).filter(Boolean);
      for (const l of lines) d.log(`> ${l}`);
      let to = null;
      try { to = (await d.installed(true)) || null; } catch {}
      if (to) st.installed = to;
      const m = /updated from\s+(\S+)\s+to(?:\s+version)?\s+(\S+)/i.exec(r.output || '');
      const ok = r.code === 0 && !r.timedOut && (!!m || (to && (!from || !isNewer(st.latest, to))));
      const error = ok ? null : r.timedOut ? `timed out after ${Math.round((d.now() - startedAt) / 1000)}s` : r.error || (r.code !== 0 ? `exit ${r.code}` : `still ${to || from || '?'} after update`);
      st.lastUpdate = { from: m ? parseVersion(m[1]) || from : from, to: m ? parseVersion(m[2]) || to : to, at: d.now(), ok, error, log: lines.slice(-LOG_TAIL), durationMs: d.now() - startedAt, reason };
      persist();
      if (ok) {
        d.log(`updated ${st.lastUpdate.from || '?'} → ${st.lastUpdate.to || '?'} (${reason})`);
        // New spawns now get the new binary; make the picker learn its models
        // without anyone restarting anything (models.js re-keys on version).
        try { await d.onUpdated({ from: st.lastUpdate.from, to: st.lastUpdate.to }); } catch (e) { d.log(`models refetch failed: ${e.message}`); }
        d.emit({ kind: `${d.name}-update-done`, from: st.lastUpdate.from, to: st.lastUpdate.to, reason });
        d.notify(`${title} updated`, `${st.lastUpdate.from || '?'} → ${st.lastUpdate.to || '?'}`);
      } else {
        d.log(`update failed (${reason}): ${error}`);
        d.emit({ kind: `${d.name}-update-failed`, from, error, reason });
        d.notify(`${title} update failed`, error);
      }
      return { ok, from: st.lastUpdate.from, to: st.lastUpdate.to, error, log: st.lastUpdate.log };
    })().finally(() => { st.applying = false; applyInflight = null; });
    return applyInflight;
  }

  /** One scheduler beat: (re)check when the daily window lapsed, then auto-apply if allowed. */
  async function tick() {
    await check();
    if (!updateAvailable() || !d.auto() || applyInflight) return null;
    // A failed automatic attempt for THIS version is not retried every 15 minutes.
    const lu = st.lastUpdate;
    if (lu && !lu.ok && lu.reason === 'auto' && lu.from === st.installed && d.now() - lu.at < d.checkEveryMs) return null;
    return apply({ reason: 'auto' });
  }

  let timer = null, bootTimer = null;
  function start({ bootDelayMs = BOOT_DELAY_MS, tickMs = TICK_MS } = {}) {
    if (timer) return;
    const beat = () => tick().catch((e) => d.log(`tick failed: ${e.message}`));
    bootTimer = setTimeout(beat, bootDelayMs);
    timer = setInterval(beat, tickMs);
    bootTimer.unref?.(); timer.unref?.();
  }
  function stop() { if (timer) clearInterval(timer); if (bootTimer) clearTimeout(bootTimer); timer = bootTimer = null; }

  return { status, check, apply, tick, start, stop, _state: st };
}

// ---- singleton wiring (the host) ---------------------------------------------------------

let singleton = null;

export async function claudeUpdater() {
  if (singleton) return singleton;
  const { cfg } = await import('../state.js');
  const bus = await import('../bus.js');
  const logFile = path.join(cfg.logsDir || path.join(cfg.configDir, 'logs'), 'claude-update.log');
  singleton = createUpdater({
    store: path.join(cfg.configDir, 'claude-update.json'),
    minFreeMb: Number(cfg.host?.claudeUpdateMinFreeMb) > 0 ? Number(cfg.host.claudeUpdateMinFreeMb) : DEFAULT_MIN_FREE_MB,
    auto: () => cfg.host?.claudeAutoUpdate !== false,
    onUpdated: async () => { const { getModels } = await import('../models.js'); await getModels(true); },
    emit: (event) => bus.broadcast({ type: 'host', event }),
    notify: (title, body) => {
      import('../push.js')
        .then((push) => { if (!push.hasSubscriptions()) return; return push.sendPush({ title: title.slice(0, 80), body: String(body || '').slice(0, 200), tag: 'claude-update', url: '/__host/#/settings/host' }); })
        .catch(() => {});
    },
    log: (line) => {
      console.log(`[claude-update] ${line}`);
      try { fs.mkdirSync(path.dirname(logFile), { recursive: true }); fs.appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`); } catch {}
    },
  });
  return singleton;
}

/** index.ts: arm the daily check + auto-apply loop — only when a claude binary resolves. */
export async function startClaudeUpdater({ bin } = {}) {
  const resolved = bin ?? (await import('./claude-bin.js')).claudeBin({ force: true });
  if (!resolved || resolved === 'claude') { console.log('[claude-update] no claude binary — daily check not started'); return null; }
  const u = await claudeUpdater();
  u.start();
  return u;
}
