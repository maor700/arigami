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

export interface Config {
  port: number;
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
  // Model every NEW session starts on (a `claude --model` value: 'opus',
  // 'sonnet', 'haiku', 'opus[1m]', or a full id). null/'' = don't pass --model,
  // letting the Claude Code CLI pick its own default. Per-session dropdown wins.
  defaultModel: string | null;
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
  prodUrl: '',
  storybookCompareUrl: '',
  upstreamCookies: {},
  defaultCwd: '~/Desktop/repos',
  reposDir: '~/Desktop/repos',
  ticketsDir: '~/.arigami-tickets',
  stateFile: `${DEFAULT_DIR_TOKEN}/state.json`,
  chatDir: `${DEFAULT_DIR_TOKEN}/chat`,
  linearWorkspace: '',
  groqApiKey: '',
  composioApiKey: '',
  sttModel: 'whisper-large-v3-turbo',
  voiceRouterProvider: 'groq',
  voiceRouterModel: 'llama-3.3-70b-versatile',
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
  defaultModel: null,
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
  return o;
}

const merged = deepMerge(
  deepMerge(DEFAULTS, loadFile()),
  envOverrides()
) as unknown as Config;

const ticketsDir = tilde(merged.ticketsDir);

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
  hostBase: `http://localhost:${merged.port || DEFAULTS.port}`,
};

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
