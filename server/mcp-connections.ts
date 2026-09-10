// M1 — who owns which native remote-MCP grant, and is that grant still live.
//
// Two questions, two sources:
//
//   OWNERSHIP (ours)   `$ARIGAMI_DIR/mcp-connections.json` for the host's own
//                      connections, `$ARIGAMI_DIR/agents/<slug>/connections.json`
//                      for an agent's (PRD-ARIGAMI-AGENTS §A2 / RESEARCH §4.3).
//                      Names, URLs and timestamps — NEVER a token.
//
//   LIVENESS (Claude Code's)  `$CLAUDE_CONFIG_DIR/.credentials.json` → `mcpOAuth`
//                      keyed `<serverName>|<url-hash>`, and `.claude.json` →
//                      `mcpServers` for the header/bearer servers. Both are read
//                      for presence only; the host never copies a token out of
//                      them, and they are machine-local (excluded from export).
//
// Reading the files instead of shelling out to `claude mcp get` keeps the
// capability check offline, per-owner and instant — `bin/host doctor` and the
// Connections hub both call it on every refresh.
import fs from 'node:fs';
import path from 'node:path';
import { HOME } from './lib/platform.js';
import { ARIGAMI_DIR } from './lib/instance.js';
import { grantName, mcpSpec, type McpAuth } from './mcp-catalog.js';

export interface McpConnection {
  /** capability id — `mcp:<slug>` */
  cap: string;
  slug: string;
  /** the OAuth grant / MCP server name (`linear` or `linear--<agent>`) */
  name: string;
  url: string;
  auth: McpAuth;
  at: string;
  /** which Google identity drove the consent, when one was connected. Never a secret. */
  byIdentity?: string | null;
  /** `readonly` variant of the vendor's server was used */
  readonly?: boolean;
}

const AGENT_OWNER_RE = /^agent:([a-z0-9][a-z0-9-]{0,39})$/;
export const GLOBAL = 'global';
const slugOfOwner = (owner: string): string | null => AGENT_OWNER_RE.exec(String(owner || ''))?.[1] ?? null;

/** Where an owner's connection record lives. */
export function connectionsFile(owner: string = GLOBAL): string {
  const slug = slugOfOwner(owner);
  return slug ? path.join(ARIGAMI_DIR, 'agents', slug, 'connections.json') : path.join(ARIGAMI_DIR, 'mcp-connections.json');
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

const valid = (c: unknown): c is McpConnection =>
  !!c && typeof c === 'object' && typeof (c as any).cap === 'string' && typeof (c as any).name === 'string' && typeof (c as any).url === 'string';

export function readConnections(owner: string = GLOBAL): McpConnection[] {
  const list = readJson<unknown[]>(connectionsFile(owner), []);
  return Array.isArray(list) ? list.filter(valid) : [];
}

function writeConnections(owner: string, list: McpConnection[]): void {
  const file = connectionsFile(owner);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(list, null, 2) + '\n', { mode: 0o600 });
}

/** Idempotent: one record per capability per owner, newest wins. */
export function recordConnection(owner: string, conn: Omit<McpConnection, 'at'> & { at?: string }): McpConnection {
  const entry: McpConnection = { at: new Date().toISOString(), ...conn };
  writeConnections(owner, [...readConnections(owner).filter((c) => c.cap !== entry.cap), entry]);
  return entry;
}

export function removeConnection(owner: string, cap: string): boolean {
  const before = readConnections(owner);
  const after = before.filter((c) => c.cap !== cap);
  if (after.length === before.length) return false;
  writeConnections(owner, after);
  return true;
}

export const findConnection = (owner: string, cap: string): McpConnection | null => readConnections(owner).find((c) => c.cap === cap) ?? null;

/** Every owner that has a connections file, with its records (Settings → "Belongs to"). */
export function allConnections(): Array<{ owner: string; connections: McpConnection[] }> {
  const out = [{ owner: GLOBAL, connections: readConnections(GLOBAL) }];
  let slugs: string[] = [];
  try {
    slugs = fs.readdirSync(path.join(ARIGAMI_DIR, 'agents')).sort();
  } catch {
    /* no agents yet */
  }
  for (const slug of slugs) {
    const conns = readConnections(`agent:${slug}`);
    if (conns.length) out.push({ owner: `agent:${slug}`, connections: conns });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Claude Code's own state (read-only, presence only)
// ---------------------------------------------------------------------------

export const claudeConfigDir = (): string => process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');

export interface McpState {
  /** grant name → true when a usable (non-empty) access token is stored */
  grants: Map<string, boolean>;
  /** server names present in .claude.json (any scope) — how a bearer server registers */
  configured: Set<string>;
}

export function readMcpState(dir: string = claudeConfigDir()): McpState {
  const grants = new Map<string, boolean>();
  const creds = readJson<any>(path.join(dir, '.credentials.json'), null);
  for (const [key, v] of Object.entries((creds?.mcpOAuth || {}) as Record<string, any>)) {
    // Key is `<serverName>|<16-hex hash of the URL>` (verified in the M1 spike);
    // `serverName` is carried inside too, so prefer it and fall back to the key.
    const name = typeof v?.serverName === 'string' && v.serverName ? v.serverName : key.split('|')[0];
    const live = !!v?.accessToken;
    if (!grants.get(name)) grants.set(name, live);
  }
  const configured = new Set<string>();
  const cfg = readJson<any>(path.join(dir, '.claude.json'), null);
  for (const n of Object.keys(cfg?.mcpServers || {})) configured.add(n);
  for (const proj of Object.values((cfg?.projects || {}) as Record<string, any>)) {
    for (const n of Object.keys(proj?.mcpServers || {})) configured.add(n);
  }
  return { grants, configured };
}

/** Is this grant usable right now? OAuth → a stored token; bearer → the server is configured. */
export function grantLive(name: string, auth: McpAuth, state: McpState = readMcpState()): boolean {
  return auth === 'bearer' ? state.configured.has(name) : state.grants.get(name) === true;
}

/**
 * Resolve `mcp:<slug>` for an owner: the owner's own connection first, then the
 * host's shared one (A2's agent-first-then-global rule).
 */
export function resolveMcp(cap: string, owner: string = GLOBAL, state: McpState = readMcpState()): { conn: McpConnection; from: string } | null {
  const slug = cap.startsWith('mcp:') ? cap.slice(4) : cap;
  const spec = mcpSpec(slug);
  if (!spec) return null;
  for (const o of owner === GLOBAL ? [GLOBAL] : [owner, GLOBAL]) {
    const conn = findConnection(o, `mcp:${slug}`);
    if (conn && grantLive(conn.name, conn.auth || spec.auth, state)) return { conn, from: o };
  }
  return null;
}

/** The `--mcp-config` servers to inject for a session acting as `owner` (agent-owned grants only). */
export function injectedServersFor(owner: string, state: McpState = readMcpState()): Record<string, { type: 'http'; url: string }> {
  const out: Record<string, { type: 'http'; url: string }> = {};
  if (!slugOfOwner(owner)) return out; // the host's own grants are user-scoped — every session already sees them
  for (const c of readConnections(owner)) {
    const spec = mcpSpec(c.slug);
    if (!spec || (c.auth || spec.auth) === 'bearer') continue; // bearer grants carry a header we deliberately do not store
    if (!grantLive(c.name, c.auth || spec.auth, state)) continue;
    out[c.name] = { type: 'http', url: c.url };
  }
  return out;
}

export { grantName };
