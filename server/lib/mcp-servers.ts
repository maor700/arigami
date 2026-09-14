// Host-managed external stdio MCP servers (composio-mcp): $ARIGAMI_DIR/mcp-servers.json, read by both engines.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ARIGAMI_DIR } from './instance.js';

export type StdioServer = { command: string; args?: string[]; env?: Record<string, string> };

/** Server names the host manages; seeded once from ~/.claude.json, where they used to live. */
export const MANAGED_SERVERS = ['composio-mcp'];

export const mcpServersFile = (): string => path.join(ARIGAMI_DIR, 'mcp-servers.json');

/** Path of Claude Code's user config (`$CLAUDE_CONFIG_DIR/.claude.json` or `~/.claude.json`). */
export function claudeJsonPath(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR;
  return dir ? path.join(dir, '.claude.json') : path.join(os.homedir(), '.claude.json');
}

const readJson = (file: string): any => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

const isStdio = (sv: any): sv is StdioServer => !!sv && typeof sv === 'object' && typeof sv.command === 'string' && !sv.url;

function writeAtomic(file: string, data: unknown): void {
  let mode = 0o600;
  try {
    mode = fs.statSync(file).mode & 0o777;
  } catch {}
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.arigami-${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode });
  fs.renameSync(tmp, file);
}

/** The managed servers; the first read seeds the file from ~/.claude.json. */
export function hostMcpServers(): Record<string, StdioServer> {
  const file = mcpServersFile();
  const own = readJson(file);
  if (own && typeof own === 'object') {
    const out: Record<string, StdioServer> = {};
    for (const [name, sv] of Object.entries(own.mcpServers || {})) if (isStdio(sv)) out[name] = sv;
    return out;
  }
  const seeded: Record<string, StdioServer> = {};
  const claude = readJson(claudeJsonPath());
  for (const name of MANAGED_SERVERS) if (isStdio(claude?.mcpServers?.[name])) seeded[name] = claude.mcpServers[name];
  if (Object.keys(seeded).length) {
    try {
      writeAtomic(file, { version: 1, mcpServers: seeded });
    } catch {
      /* read-only dir — still serve the seed */
    }
  }
  return seeded;
}

/** Set one env var on a managed server in both mcp-servers.json and ~/.claude.json; false when the server isn't configured. */
export function setHostMcpEnv(name: string, key: string, value: string): boolean {
  const servers = hostMcpServers();
  const sv = servers[name];
  if (!sv) return false;
  sv.env = { ...(sv.env || {}), [key]: value };
  writeAtomic(mcpServersFile(), { version: 1, mcpServers: servers });
  const cj = claudeJsonPath();
  const claude = readJson(cj);
  if (claude && typeof claude === 'object') {
    claude.mcpServers = { ...(claude.mcpServers || {}), [name]: sv };
    try {
      writeAtomic(cj, claude);
    } catch {
      /* claude reads the old key until the next write */
    }
  }
  return true;
}

/** Composio connect flow: the new key reaches composio-mcp for both engines. */
export const syncComposioKey = (key: string): boolean => {
  try {
    return setHostMcpEnv('composio-mcp', 'COMPOSIO_API_KEY', key);
  } catch {
    return false;
  }
};
