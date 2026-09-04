import fs from 'node:fs';
import path from 'node:path';
// Side-effecting: defines process.env.HOME on Windows. Must precede the HOME
// read below — and, since nearly everything imports config, it also covers the
// entrypoints (tests, the MCP server) that don't go through server/index.ts.
import { HOME } from './platform.js';
import { ARIGAMI_DIR, DEFAULT_ARIGAMI_DIR, IS_DEFAULT_INSTANCE, PORT_SHIFT } from './instance.js';
export const tilde = (p: string | undefined): string => {
  return p && p.startsWith('~')
    ? path.join(HOME, p.slice(1))
    : p || '';
};

// Instance root (T5): everything lives under here. A non-default ARIGAMI_DIR
// also shifts every default port range (+1000) so a second instance started
// with no config at all doesn't fight the first one for ports.
const CONFIG_DIR = ARIGAMI_DIR;
const DEFAULT_DIR_TOKEN = IS_DEFAULT_INSTANCE ? '~/.arigami' : ARIGAMI_DIR;
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

const range = (a: number, b: number): number[] =>
  Array.from({ length: b - a + 1 }, (_, i) => a + i);

// Dispatcher (master/worker orchestration) caps. Global across the whole session
// tree, counted by role+kind, so depth doesn't matter — the whole tree is bounded.
// See docs/DISPATCHER.md §4.5.
export interface DispatcherConfig {
  maxMutating: number; // global concurrent mutating workers
  maxReadOnly: number; // global concurrent read-only workers
  maxChildren: number; // global concurrent FULL children (project-folder sessions)
  portRange: [number, number]; // pool for needsServer workers (Phase 2)
  stallTimeoutSec: number; // watchdog stall threshold (Phase 2)
}

// Global (not per-session) screen-share: one shared desktop, bridged from
// /__vnc to a VNC server running on this host. `vncHost` should stay
// loopback — the bridge is the only intended path to it, gated the same way
// the rest of the host is (VPN reaching this server).
export interface ScreenConfig {
  enabled: boolean;
  vncHost: string;
  vncPort: number;
  // Optional VNC-auth password, handed to noVNC (client-side RFB auth) via
  // GET /__api/screen/credentials. Empty/undefined = server has no auth.
  vncPassword?: string;
  // Screenshots (T3): X display for the scrot/import fallback when the RFB
  // capture fails (e.g. ":99"); empty = no fallback. Watch-mode auto-snapshot
  // cadence, and retention for ~/.arigami/uploads/screens (age OR total size,
  // whichever trips first).
  display?: string;
  // Watch-mode auto-snapshots (T9): off by default. When on, the loop polls
  // every snapshotIntervalMs but only records a frame that changed by more
  // than snapshotChangeThreshold (fraction of sampled pixels) since the last
  // recorded one, and never more often than snapshotMinIntervalMs.
  autoSnapshots: boolean;
  snapshotIntervalMs: number;
  snapshotMinIntervalMs: number;
  snapshotChangeThreshold: number;
  screenshotRetentionDays: number;
  screenshotMaxMb: number;
  // Per-session desktops (T8): pool of VNC ports handed to `server/lib/desktops.ts`
  // when it lazily spawns an `Xvfb`+`x11vnc` pair for a session. The X display
  // number is derived from the port's offset into this range (port 5901 → :100,
  // 5902 → :101, …), so the two never need separate bookkeeping.
  portRange: [number, number];
  // X display number for the FIRST port of portRange (5901 → :100 by default;
  // a non-default instance defaults to :200 so it never races the default
  // instance for /tmp/.X<n>-lock). See server/lib/desktops.ts.
  displayBase: number;
  // Keep a session's `<ARIGAMI_DIR>/chrome-sessions/<id>` profile copy (and skip
  // the delete-time login sync) instead of removing it — for debugging a
  // session's browser state after the fact.
  keepProfiles: boolean;
}

// The brain session's heartbeat (spec M4.3): off by default. When on, a
// backing CronTrigger (server/brain.ts) wakes the singleton brain session
// every `heartbeatEvery` to self-check whether anything needs the owner's
// attention — see server/brain.ts for the trigger it drives.
export interface BrainConfig {
  heartbeatEnabled: boolean;
  heartbeatEvery: string; // interval value, e.g. "30m" (cron-schedule.ts parseIntervalMs format)
}

// Published artifacts (A1, server/artifacts.ts): snapshot copies of static
// files/folders the agent publishes under $ARIGAMI_DIR/uploads/artifacts.
export interface ArtifactsConfig {
  maxMb: number;          // per-publish size cap (all files of one version)
  retentionDays: number;  // GC: versions older than this are removed
}

// K2 share links (server/share-token.ts): signed `?t=` tokens that open ONE
// artifact without a cookie. Expiry defaults to `defaultDays`, callers may ask
// for up to `maxDays` (§7.13: 7 / 90).
export interface ShareConfig {
  defaultDays: number;
  maxDays: number;
}

// Host lifecycle from the cockpit (B4-lite): restart/upgrade endpoints in
// server/host-control.ts. `allowUpgrade=false` turns POST /__api/host/upgrade
// into a 403 (restart stays available). drainTimeoutMs = how long an in-flight
// claude turn may hold up a "restart now"; idleTimeoutMin = how long "restart
// when idle" waits for sessions to go quiet before restarting anyway.
// UPD1: the `claude` CLI updater (server/lib/claude-update.js). claudeAutoUpdate
// = apply `claude update` by itself once the daily check finds a newer release
// ("update now" in the cockpit works either way); claudeUpdateMinFreeMb = never
// apply while MemAvailable is below this (deferred, retried every 15 min).
export interface HostConfig {
  allowUpgrade: boolean;
  drainTimeoutMs: number;
  idleTimeoutMin: number;
  claudeAutoUpdate: boolean;
  claudeUpdateMinFreeMb: number;
}

// C1 — host auth. `mode:'off'` is ONLY legal when `bind` is loopback (the
// server refuses to boot otherwise — see validateAuthBind); it exists so the
// current single-machine install can keep working behind `tailscale serve`
// while migrating (docs/AUTH.md). 'pairing' = one-time code → admin cookie;
// 'oidc' = pairing PLUS a "Sign in with <provider>" button (openid-client).
export interface OidcConfig {
  issuer: string; // e.g. https://accounts.google.com — discovery is derived
  clientId: string;
  clientSecret?: string; // prefer secrets.ts ARIGAMI_OIDC_CLIENT_SECRET
  allowedEmails: string[];
  allowedDomains: string[];
  autoCreate: boolean; // create a 'user' on first allowed login (first ever = admin)
}
export interface AuthConfig {
  mode: 'pairing' | 'oidc' | 'off';
  cookieDays: number;
  oidc?: OidcConfig;
}

// D3 — opt-in telemetry (server/telemetry.ts). OFF by default. `enabled`
// ships the K5 funnel milestones (names + timestamps) plus version/os/arch/
// docker to `endpoint`; env ARIGAMI_TELEMETRY=1|0 overrides the file and
// DO_NOT_TRACK=1 forces it off regardless. `updateCheck` gates the daily
// "is upstream ahead" fetch in server/version.ts (never sends anything).
export interface TelemetryConfig {
  enabled: boolean;
  updateCheck: boolean;
  endpoint: string;
}

// RES1 — the session supervisor (server/supervisor-loop.ts). One wall-clock tick
// classifies every session and walks the recovery ladder. `stallMin` is "no
// progress with something still owed"; `reportGraceMin` is how long a child may
// sit terminal before the host synthesizes its report to the master;
// `notifyEveryMin` is the re-notify cadence for a block only a human can clear.
export interface SupervisorConfig {
  enabled: boolean;
  tickSec: number;
  stallMin: number;
  reportGraceMin: number;
  notifyEveryMin: number;
  maxRespawns: number;
  /** How long to stay on a weaker rung when the CLI never said when the quota resets. */
  modelBackoffMin: number;
  /**
   * LADDER1 — a ladder replay may occupy at most this share of the TARGET
   * rung's context window (default 0.7); a bigger conversation is compacted
   * (digest + last `ladderTailTurns` turns verbatim) instead of `--resume`d raw.
   */
  ladderHeadroom?: number;
  ladderTailTurns?: number;
}

// LEARN1: autonomous memory learning (server/memory-learning.ts). `auto` = the
// host triages the pending queue itself once `minBatch` proposals pile up OR
// `maxAgeHours` passed since the last run (whichever first) and applies the
// result through the same approve/write gate; `manual` = the run is computed
// and stored pre-checked, the human clicks once. `minFreeMb` = never spawn the
// one-shot LLM while MemAvailable is below this (deferred to the next tick).
export interface MemoryLearningConfig {
  mode: 'auto' | 'manual';
  minBatch: number;
  maxAgeHours: number;
  minFreeMb: number;
}
export interface MemoryConfig {
  learning: MemoryLearningConfig;
}

export interface Config {
  port: number;
  // Listen address. Default 127.0.0.1 (fail-closed): reach the host from other
  // devices through `tailscale serve` / Caddy (C2), which forward to loopback.
  // `0.0.0.0` (env ARIGAMI_BIND) is honoured only with auth enabled.
  bind: string;
  // Absolute origin the host is reachable at from a browser, e.g.
  // https://host.example.ts.net (env ARIGAMI_PUBLIC_URL). Used for OAuth/OIDC
  // redirects and outgoing share links; cookies get `Secure` when it's https.
  publicUrl: string;
  // C2: believe X-Forwarded-Proto/-Host from a reverse proxy (Caddy,
  // `tailscale serve`) — only ever for LOOPBACK peers, see
  // server/lib/proxy-headers.ts. Default: true when `bind` is loopback (the
  // proxy is the only thing that can reach the socket), false otherwise
  // (a remote client could forge the header). Env ARIGAMI_TRUST_PROXY=0|1.
  trustProxy?: boolean;
  auth: AuthConfig;
  prodUrl: string;
  storybookCompareUrl: string;
  upstreamCookies: Record<string, string>;
  defaultCwd: string;
  reposDir: string;
  ticketsDir: string;
  stateFile: string;
  chatDir: string;
  linearWorkspace: string;
  groqApiKey: string;
  composioApiKey: string;
  sttModel: string;
  voiceRouterProvider: string;
  voiceRouterModel: string;
  anthropicRouterModel: string;
  voiceLang: string;
  palette: string[];
  devServerPorts: number[];
  dispatcher: DispatcherConfig;
  screen: ScreenConfig;
  brain: BrainConfig;
  artifacts: ArtifactsConfig;
  share: ShareConfig;
  host: HostConfig;
  telemetry: TelemetryConfig;
  memory: MemoryConfig;
  // Model every NEW session starts on (a `claude --model` value: 'opus',
  // 'sonnet', 'haiku', 'opus[1m]', or a full id). null/'' = don't pass --model,
  // letting the Claude Code CLI pick its own default. Per-session dropdown wins.
  defaultModel: string | null;
  // RES1 — the host-wide model ladder. When every pooled account has hit its
  // limit, the supervisor drops one rung of this chain instead of stopping, and
  // climbs back once the top rung's quota resets. An agent or a session may
  // override it (session.claude.modelChain). See server/supervisor.ts.
  modelChain: string[];
  // CTX1 — manual escape hatch for a model id server/lib/ctx-window.ts doesn't
  // recognize (new release, custom proxy id…): tokens per model id/alias,
  // lower-cased. Checked before the built-in table; env
  // CLAUDE_CODE_MAX_CONTEXT_TOKENS (global, matches the `claude` CLI's own var)
  // is the fallback when a model has no entry here.
  ctxWindowOverrides: Record<string, number>;
  // RES1 — supervisor loop knobs. `enabled:false` turns the whole 30s tick off
  // (the health model and /__api/health keep working, nothing is auto-recovered).
  supervisor: SupervisorConfig;
  configDir?: string;
  configFile?: string;
  imgDir?: string;
  stateDir?: string;
  logsDir?: string;
  runDir?: string;
  pidFile?: string;
  hostBase?: string;
}

export const DEFAULTS: Config = {
  port: 3099 + PORT_SHIFT,
  bind: '127.0.0.1',
  publicUrl: '',
  auth: {
    mode: 'pairing',
    cookieDays: 30,
  },
  prodUrl: '',
  storybookCompareUrl: '',
  upstreamCookies: {},
  // S1: a fresh install's first session opens in an empty workspace the host
  // creates on first start (no repo needed) — see server/index.ts.
  defaultCwd: `${DEFAULT_DIR_TOKEN}/workspace`,
  reposDir: '~/Desktop/repos',
  ticketsDir: '~/.arigami-tickets',
  stateFile: `${DEFAULT_DIR_TOKEN}/state.json`,
  chatDir: `${DEFAULT_DIR_TOKEN}/chat`,
  linearWorkspace: '',
  groqApiKey: '',
  composioApiKey: '',
  sttModel: 'whisper-large-v3-turbo',
  voiceRouterProvider: 'groq',
  voiceRouterModel: 'openai/gpt-oss-120b',
  anthropicRouterModel: 'claude-haiku-4-5-20251001',
  voiceLang: 'he',
  palette: [
    '#E0594F',
    '#1F9C82',
    '#6A4FC4',
    '#2C6BD6',
    '#CE8324',
    '#3C9A4E',
    '#C2459E',
    '#5B62D6',
  ],
  devServerPorts: range(3020 + PORT_SHIFT, 3030 + PORT_SHIFT),
  dispatcher: {
    maxMutating: 3,
    maxReadOnly: 6,
    maxChildren: 4,
    portRange: [3200 + PORT_SHIFT, 3299 + PORT_SHIFT],
    stallTimeoutSec: 600,
  },
  screen: {
    enabled: true,
    vncHost: '127.0.0.1',
    vncPort: 5900,
    autoSnapshots: false,
    snapshotIntervalMs: 10_000,
    snapshotMinIntervalMs: 30_000,
    snapshotChangeThreshold: 0.03,
    screenshotRetentionDays: 7,
    screenshotMaxMb: 200,
    portRange: [5901 + PORT_SHIFT, 5950 + PORT_SHIFT],
    displayBase: IS_DEFAULT_INSTANCE ? 100 : 200,
    keepProfiles: false,
  },
  brain: {
    heartbeatEnabled: false,
    heartbeatEvery: '30m',
  },
  artifacts: {
    maxMb: 50,
    retentionDays: 30,
  },
  share: {
    defaultDays: 7,
    maxDays: 90,
  },
  host: {
    allowUpgrade: true,
    claudeAutoUpdate: true,
    claudeUpdateMinFreeMb: 700,
    drainTimeoutMs: 20_000,
    idleTimeoutMin: 30,
  },
  telemetry: {
    enabled: false,
    updateCheck: false,
    endpoint: 'https://telemetry.arigami.dev/v1/events',
  },
  memory: {
    learning: { mode: 'auto', minBatch: 40, maxAgeHours: 48, minFreeMb: 600 },
  },
  defaultModel: null,
  modelChain: ['fable', 'sonnet', 'haiku'],
  ctxWindowOverrides: {},
  supervisor: {
    enabled: true,
    tickSec: 30,
    stallMin: 10,
    reportGraceMin: 2,
    notifyEveryMin: 60,
    maxRespawns: 2,
    modelBackoffMin: 60,
  },
};

function deepMerge(
  base: unknown,
  over: unknown
): Record<string, unknown> {
  if (!over || typeof over !== 'object') {
    return (typeof base === 'object' && base !== null && !Array.isArray(base))
      ? (base as Record<string, unknown>)
      : {};
  }
  if (Array.isArray(base) || Array.isArray(over)) {
    return typeof base === 'object' && base !== null && !Array.isArray(base)
      ? (base as Record<string, unknown>)
      : {};
  }
  const baseObj = base as Record<string, unknown>;
  const overObj = over as Record<string, unknown>;
  const out: Record<string, unknown> = { ...baseObj };
  for (const k of Object.keys(overObj)) {
    const overVal = overObj[k];
    const baseVal = baseObj[k];
    if (
      overVal &&
      typeof overVal === 'object' &&
      !Array.isArray(overVal) &&
      baseVal &&
      typeof baseVal === 'object' &&
      !Array.isArray(baseVal)
    ) {
      out[k] = deepMerge(baseVal, overVal);
    } else if (overVal !== undefined) {
      out[k] = overVal;
    }
  }
  return out;
}

function loadFile(): Partial<Config> {
  let raw: any;
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
  // `JSON.parse("null")` (or an array, or a truncated write that yields a
  // non-object) succeeds but `raw[k]` below would throw at module top level and
  // brick every import of config.js. Treat anything but a plain object as empty.
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Partial<Config> = {};
  for (const k of Object.keys(DEFAULTS)) {
    if (raw[k] !== undefined) {
      (out as any)[k] = raw[k];
    }
  }
  if ((out as any).chatDir === '~/.arigami-chat') delete (out as any).chatDir;
  return out;
}

function envOverrides(): Partial<Config> {
  const E = process.env;
  const o: Partial<Config> = {};
  const port = E.ARIGAMI_PORT || E.POC_PORT;
  if (port && Number(port)) o.port = Number(port);
  if (E.ARIGAMI_BIND) o.bind = E.ARIGAMI_BIND;
  if (E.ARIGAMI_PUBLIC_URL) o.publicUrl = E.ARIGAMI_PUBLIC_URL.replace(/\/+$/, '');
  if (E.ARIGAMI_TRUST_PROXY != null && E.ARIGAMI_TRUST_PROXY !== '') o.trustProxy = /^(1|true|yes)$/i.test(E.ARIGAMI_TRUST_PROXY);
  if (E.ARIGAMI_AUTH && ['off', 'pairing', 'oidc'].includes(E.ARIGAMI_AUTH))
    o.auth = { ...DEFAULTS.auth, mode: E.ARIGAMI_AUTH as AuthConfig['mode'] };
  if (E.ARIGAMI_PROD_URL || E.POC_PROD_URL)
    o.prodUrl = E.ARIGAMI_PROD_URL || E.POC_PROD_URL;
  if (E.ARIGAMI_REPOS_DIR || E.POC_REPOS_DIR)
    o.reposDir = E.ARIGAMI_REPOS_DIR || E.POC_REPOS_DIR;
  if (E.ARIGAMI_DEFAULT_CWD) o.defaultCwd = E.ARIGAMI_DEFAULT_CWD;
  if (E.ARIGAMI_LINEAR_WORKSPACE || E.POC_LINEAR_WORKSPACE)
    o.linearWorkspace =
      E.ARIGAMI_LINEAR_WORKSPACE || E.POC_LINEAR_WORKSPACE;
  if (E.GROQ_API_KEY) o.groqApiKey = E.GROQ_API_KEY;
  if (E.COMPOSIO_API_KEY) o.composioApiKey = E.COMPOSIO_API_KEY;
  if (E.ARIGAMI_VOICE_LANG) o.voiceLang = E.ARIGAMI_VOICE_LANG;
  if ((E.ARIGAMI_TELEMETRY != null && E.ARIGAMI_TELEMETRY !== '') || E.ARIGAMI_TELEMETRY_URL) {
    o.telemetry = {
      ...DEFAULTS.telemetry,
      ...(E.ARIGAMI_TELEMETRY != null && E.ARIGAMI_TELEMETRY !== '' ? { enabled: /^(1|true|yes|on)$/i.test(E.ARIGAMI_TELEMETRY) } : {}),
      ...(E.ARIGAMI_TELEMETRY_URL ? { endpoint: E.ARIGAMI_TELEMETRY_URL } : {}),
    };
  }
  if (E.ARIGAMI_SCREEN_ENABLED != null || E.ARIGAMI_VNC_HOST || E.ARIGAMI_VNC_PORT) {
    o.screen = {
      ...DEFAULTS.screen,
      enabled: E.ARIGAMI_SCREEN_ENABLED != null ? E.ARIGAMI_SCREEN_ENABLED !== '0' : DEFAULTS.screen.enabled,
      vncHost: E.ARIGAMI_VNC_HOST || DEFAULTS.screen.vncHost,
      vncPort: E.ARIGAMI_VNC_PORT ? Number(E.ARIGAMI_VNC_PORT) : DEFAULTS.screen.vncPort,
    };
  }
  if (E.ARIGAMI_VNC_PASSWORD) {
    o.screen = { ...(o.screen || DEFAULTS.screen), vncPassword: E.ARIGAMI_VNC_PASSWORD };
  }
  // Screenshot knobs (T3). Each one alone is enough to materialize o.screen —
  // deepMerge fills the rest from the file/defaults.
  const num = (v: string | undefined) => (v && Number(v) > 0 ? Number(v) : undefined);
  const shot: Partial<ScreenConfig> = {};
  if (E.ARIGAMI_SCREEN_DISPLAY || E.DISPLAY) shot.display = E.ARIGAMI_SCREEN_DISPLAY || E.DISPLAY;
  if (E.ARIGAMI_AUTO_SNAPSHOTS != null) shot.autoSnapshots = E.ARIGAMI_AUTO_SNAPSHOTS !== '0' && E.ARIGAMI_AUTO_SNAPSHOTS !== 'false';
  if (num(E.ARIGAMI_SNAPSHOT_INTERVAL_MS)) shot.snapshotIntervalMs = num(E.ARIGAMI_SNAPSHOT_INTERVAL_MS)!;
  if (num(E.ARIGAMI_SNAPSHOT_MIN_INTERVAL_MS)) shot.snapshotMinIntervalMs = num(E.ARIGAMI_SNAPSHOT_MIN_INTERVAL_MS)!;
  if (num(E.ARIGAMI_SNAPSHOT_CHANGE_THRESHOLD)) shot.snapshotChangeThreshold = num(E.ARIGAMI_SNAPSHOT_CHANGE_THRESHOLD)!;
  if (num(E.ARIGAMI_SCREENSHOT_RETENTION_DAYS)) shot.screenshotRetentionDays = num(E.ARIGAMI_SCREENSHOT_RETENTION_DAYS)!;
  if (num(E.ARIGAMI_SCREENSHOT_MAX_MB)) shot.screenshotMaxMb = num(E.ARIGAMI_SCREENSHOT_MAX_MB)!;
  if (Object.keys(shot).length) o.screen = { ...(o.screen || DEFAULTS.screen), ...shot };
  // RES1 — supervisor + model ladder. Every knob is env-overridable so an
  // isolated-host test can run the 30s loop at 1s with a 3s stall threshold.
  if (E.ARIGAMI_MODEL_CHAIN != null && E.ARIGAMI_MODEL_CHAIN !== '')
    o.modelChain = E.ARIGAMI_MODEL_CHAIN.split(',').map((m) => m.trim()).filter(Boolean);
  const sup: Partial<SupervisorConfig> = {};
  if (E.ARIGAMI_SUPERVISOR != null && E.ARIGAMI_SUPERVISOR !== '')
    sup.enabled = /^(1|true|yes|on)$/i.test(E.ARIGAMI_SUPERVISOR);
  if (num(E.ARIGAMI_SUPERVISOR_TICK_SEC)) sup.tickSec = num(E.ARIGAMI_SUPERVISOR_TICK_SEC)!;
  if (num(E.ARIGAMI_SUPERVISOR_STALL_MIN)) sup.stallMin = num(E.ARIGAMI_SUPERVISOR_STALL_MIN)!;
  if (num(E.ARIGAMI_SUPERVISOR_REPORT_GRACE_MIN)) sup.reportGraceMin = num(E.ARIGAMI_SUPERVISOR_REPORT_GRACE_MIN)!;
  if (num(E.ARIGAMI_SUPERVISOR_NOTIFY_MIN)) sup.notifyEveryMin = num(E.ARIGAMI_SUPERVISOR_NOTIFY_MIN)!;
  if (num(E.ARIGAMI_MODEL_BACKOFF_MIN)) sup.modelBackoffMin = num(E.ARIGAMI_MODEL_BACKOFF_MIN)!;
  if (num(E.ARIGAMI_LADDER_HEADROOM)) sup.ladderHeadroom = num(E.ARIGAMI_LADDER_HEADROOM)!;
  if (E.ARIGAMI_LADDER_TAIL_TURNS != null && E.ARIGAMI_LADDER_TAIL_TURNS !== '' && Number.isFinite(Number(E.ARIGAMI_LADDER_TAIL_TURNS)))
    sup.ladderTailTurns = Number(E.ARIGAMI_LADDER_TAIL_TURNS);
  if (Object.keys(sup).length) o.supervisor = { ...DEFAULTS.supervisor, ...sup };
  return o;
}

const merged = deepMerge(
  deepMerge(DEFAULTS, loadFile()),
  envOverrides()
) as unknown as Config;

const ticketsDir = tilde(merged.ticketsDir);

export const isLoopbackBind = (bind: string): boolean =>
  bind === '127.0.0.1' || bind === 'localhost' || bind === '::1' || /^127\./.test(bind);

// C2: trustProxy defaults to "bind is loopback" (see Config.trustProxy).
export const resolveTrustProxy = (c: Pick<Config, 'bind' | 'trustProxy'>): boolean =>
  typeof c.trustProxy === 'boolean' ? c.trustProxy : isLoopbackBind(c.bind || DEFAULTS.bind);

// Fail-closed sanity (SPEC §7.9): an unauthenticated host may only listen on
// loopback. Returns an error string (the caller exits 2) or null when fine.
export function validateAuthBind(c: Pick<Config, 'bind' | 'auth'>): string | null {
  if (c.auth?.mode === 'off' && !isLoopbackBind(c.bind))
    return `auth.mode is 'off' but bind is '${c.bind}' — an unauthenticated host may only listen on loopback. ` +
      `Either drop ARIGAMI_BIND/bind (default 127.0.0.1) or enable auth (auth.mode 'pairing').`;
  if (c.auth?.mode === 'oidc' && !(c.auth.oidc?.issuer && c.auth.oidc?.clientId))
    return `auth.mode is 'oidc' but auth.oidc.issuer/clientId are missing.`;
  return null;
}

// The loopback address internal callers (MCP, one-shots, bin/host) should dial.
// Never 'localhost': with bind=127.0.0.1 a resolver that prefers ::1 would miss.
const loopbackHost = (bind: string): string =>
  bind === '::' || bind === '::1' ? '[::1]' : '127.0.0.1';

// A non-default instance must never read/write the default instance's state —
// a config.json copied over from ~/.arigami still says `~/.arigami/state.json`.
// Remap those into our own dir, loudly.
function ownPath(key: 'stateFile' | 'chatDir', fallback: string): string {
  const p = tilde(merged[key]);
  if (IS_DEFAULT_INSTANCE || !p) return p;
  const rel = path.relative(DEFAULT_ARIGAMI_DIR, path.resolve(p));
  if (rel.startsWith('..') || path.isAbsolute(rel)) return p;
  const own = path.join(ARIGAMI_DIR, fallback);
  console.warn(`[config] ${key}=${p} points into the default instance dir; this instance (${ARIGAMI_DIR}) uses ${own} instead`);
  return own;
}

export const cfg: Config = {
  ...merged,
  configDir: CONFIG_DIR,
  configFile: CONFIG_FILE,
  defaultCwd: tilde(merged.defaultCwd),
  reposDir: tilde(merged.reposDir),
  ticketsDir,
  imgDir: path.join(ticketsDir, 'img'),
  stateFile: ownPath('stateFile', 'state.json'),
  chatDir: ownPath('chatDir', 'chat'),
  stateDir: CONFIG_DIR,
  logsDir: path.join(CONFIG_DIR, 'logs'),
  runDir: path.join(CONFIG_DIR, 'run'),
  pidFile: path.join(CONFIG_DIR, 'run', 'host.pid'),
  publicUrl: String(merged.publicUrl || '').replace(/\/+$/, ''),
  trustProxy: resolveTrustProxy(merged),
  hostBase: `http://${loopbackHost(merged.bind || DEFAULTS.bind)}:${merged.port || DEFAULTS.port}`,
};

// `publicUrl('/__artifacts/x/')` → absolute when ARIGAMI_PUBLIC_URL is set,
// else the relative path unchanged (the client prepends its own origin).
export function publicUrl(p: string): string {
  return cfg.publicUrl ? cfg.publicUrl + (p.startsWith('/') ? p : '/' + p) : p;
}

// Persist a partial auth config (Settings → Users; `bin/host` CLI). Same
// merge pattern as updateScreenConfig. Note the live `cfg.auth` object is
// PATCHED in place (not replaced) because server/auth.ts holds a reference.
export function updateAuthConfig(patch: Partial<AuthConfig>): AuthConfig {
  ensureConfigFile();
  const file = loadFile() as Partial<Config>;
  const next: AuthConfig = { ...cfg.auth, ...patch };
  const out = { ...file, auth: { ...(file.auth || {}), ...patch } } as any;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(out, null, 2) + '\n');
  Object.assign(cfg.auth, next);
  return cfg.auth;
}

export function ensureConfigFile(): void {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    if (!fs.existsSync(CONFIG_FILE)) {
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULTS, null, 2) + '\n');
    }
  } catch {}
}

// Persist a partial screen-share config (Settings → screen). Merges into the
// on-disk file (so unrelated keys survive) and patches the live `cfg` so the
// change takes effect without a restart. Env overrides still win at next boot.
export function updateScreenConfig(patch: Partial<ScreenConfig>): ScreenConfig {
  ensureConfigFile();
  const file = loadFile() as Partial<Config>;
  const next: ScreenConfig = { ...cfg.screen, ...patch };
  if (!next.vncPassword) delete next.vncPassword;
  const out = { ...file, screen: { ...(file.screen || {}), ...patch } } as any;
  if (!patch.vncPassword && 'vncPassword' in patch) delete out.screen.vncPassword;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(out, null, 2) + '\n');
  cfg.screen = next;
  return next;
}

// Persist a partial brain config (heartbeat on/off + interval). Same merge
// pattern as updateScreenConfig — unrelated keys survive, live `cfg` patches
// immediately so the change takes effect without a restart.
export function updateBrainConfig(patch: Partial<BrainConfig>): BrainConfig {
  ensureConfigFile();
  const file = loadFile() as Partial<Config>;
  const next: BrainConfig = { ...cfg.brain, ...patch };
  const out = { ...file, brain: next } as any;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(out, null, 2) + '\n');
  cfg.brain = next;
  return next;
}

// Persist a partial telemetry config (Settings toggle, wizard step, `bin/host`).
// Same merge pattern as updateBrainConfig. Note: env ARIGAMI_TELEMETRY and
// DO_NOT_TRACK still win at runtime — see server/telemetry.ts effective().
// UPD1: persist a partial host config (the Claude-CLI auto-update toggle).
export function updateHostConfig(patch: Partial<HostConfig>): HostConfig {
  ensureConfigFile();
  const file = loadFile() as Partial<Config>;
  const next: HostConfig = { ...cfg.host, ...patch };
  const out = { ...file, host: { ...(file.host || {}), ...patch } } as any;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(out, null, 2) + '\n');
  cfg.host = next;
  return next;
}

export function updateTelemetryConfig(patch: Partial<TelemetryConfig>): TelemetryConfig {
  ensureConfigFile();
  const file = loadFile() as Partial<Config>;
  const next: TelemetryConfig = { ...cfg.telemetry, ...patch };
  const out = { ...file, telemetry: { ...(file.telemetry || {}), ...patch } } as any;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(out, null, 2) + '\n');
  cfg.telemetry = next;
  return next;
}

// LEARN1: persist a partial memory-learning config (mode / batch / age). Same
// merge pattern as updateHostConfig — unrelated keys survive, live `cfg` patches.
export function updateMemoryLearningConfig(patch: Partial<MemoryLearningConfig>): MemoryLearningConfig {
  ensureConfigFile();
  const file = loadFile() as Partial<Config>;
  const next: MemoryLearningConfig = { ...cfg.memory.learning, ...patch };
  const out = { ...file, memory: { ...(file.memory || {}), learning: { ...((file.memory as any)?.learning || {}), ...patch } } } as any;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(out, null, 2) + '\n');
  cfg.memory = { ...cfg.memory, learning: next };
  return next;
}
