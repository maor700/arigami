import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Side-effecting: defines process.env.HOME on Windows. Must precede the HOME
// read below — and, since nearly everything imports config, it also covers the
// entrypoints (tests, the MCP server) that don't go through server/index.ts.
import { HOME } from './platform.js';
export const tilde = (p: string | undefined): string => {
  return p && p.startsWith('~')
    ? path.join(HOME, p.slice(1))
    : p || '';
};

const CONFIG_DIR = tilde(process.env.ARIGAMI_DIR || '~/.arigami');
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
  launcherPrompt: string;
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
  port: 3099,
  prodUrl: '',
  storybookCompareUrl: '',
  upstreamCookies: {},
  defaultCwd: '~/Desktop/repos',
  reposDir: '~/Desktop/repos',
  ticketsDir: '~/.arigami-tickets',
  stateFile: '~/.arigami/state.json',
  chatDir: '~/.arigami/chat',
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
  devServerPorts: range(3020, 3030),
  dispatcher: {
    maxMutating: 3,
    maxReadOnly: 6,
    maxChildren: 4,
    portRange: [3200, 3299],
    stallTimeoutSec: 600,
  },
  screen: {
    enabled: true,
    vncHost: '127.0.0.1',
    vncPort: 5900,
  },
  launcherPrompt: '',
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
      enabled: E.ARIGAMI_SCREEN_ENABLED != null ? E.ARIGAMI_SCREEN_ENABLED !== '0' : DEFAULTS.screen.enabled,
      vncHost: E.ARIGAMI_VNC_HOST || DEFAULTS.screen.vncHost,
      vncPort: E.ARIGAMI_VNC_PORT ? Number(E.ARIGAMI_VNC_PORT) : DEFAULTS.screen.vncPort,
    };
  }
  return o;
}

const merged = deepMerge(
  deepMerge(DEFAULTS, loadFile()),
  envOverrides()
) as unknown as Config;

const ticketsDir = tilde(merged.ticketsDir);
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..'
);
const SKILL_DIR = path.join(REPO_ROOT, 'skills', 'create-from-ticket');
const defaultLauncherPrompt =
  `Read ${SKILL_DIR}/SKILL.md in full and follow it exactly, ` +
  `with $ARGUMENTS={ticket} and $SKILL_DIR=${SKILL_DIR}.`;

export const cfg: Config = {
  ...merged,
  configDir: CONFIG_DIR,
  configFile: CONFIG_FILE,
  defaultCwd: tilde(merged.defaultCwd),
  reposDir: tilde(merged.reposDir),
  ticketsDir,
  imgDir: path.join(ticketsDir, 'img'),
  stateFile: tilde(merged.stateFile),
  chatDir: tilde(merged.chatDir),
  stateDir: CONFIG_DIR,
  logsDir: path.join(CONFIG_DIR, 'logs'),
  runDir: path.join(CONFIG_DIR, 'run'),
  pidFile: path.join(CONFIG_DIR, 'run', 'host.pid'),
  hostBase: `http://localhost:${merged.port || 3099}`,
  launcherPrompt: merged.launcherPrompt || defaultLauncherPrompt,
};

export function ensureConfigFile(): void {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    if (!fs.existsSync(CONFIG_FILE)) {
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULTS, null, 2) + '\n');
    }
  } catch {}
}
