// The agent-engine seam: pickEngine(session) returns the EngineDriver for its process — same pattern as screen-driver.ts's pickDriver().
// Only 'claude' exists today, registered by claude.js via registerEngine(); a future 'codex' driver is untouched here — see /tmp/codex-research/CODEX-ENGINE.md.
// This file has zero imports from claude.js on purpose (registry pattern, not a direct import) so claude.js -> engine-driver.ts stays one-way, never a cycle.

import type { Session } from '../state.js';

export type EngineId = 'claude' | 'codex';

/** [bin, args, env, cwd] for spawn() — pure data, buildSpawn never itself spawns. */
export interface BuiltSpawn {
  bin: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
}

/** claude assigns its own session id before spawn; codex only announces one on its first event. */
export type EngineSessionIdPolicy =
  | { mode: 'assigned'; assign: () => string }
  | { mode: 'observed'; from: (rawEvent: unknown) => string | null };

/** How a live tool call gets approved, if at all. */
export type EnginePermissions =
  | { kind: 'mcp-tool'; tool: string } // claude: mcp__arigami__permission_prompt
  | { kind: 'rpc-request' } // app-server-style approval RPC — unimplemented
  | { kind: 'none' };

export interface EngineDriver {
  readonly id: EngineId;
  /** Runs before spawn (codex would write CODEX_HOME/config.toml here); claude's is a no-op. Called synchronously today — see registerEngine() note in claude.js. */
  prepare(session: Session, opts: { resume: boolean }): void;
  /** sessionId is already resolved by the caller; this only arranges it into argv. */
  buildSpawn(session: Session, opts: { resume: boolean; sessionId: string | null }): BuiltSpawn;
  /** One raw stdout event -> zero or more appendChat() calls plus engine-local bookkeeping; not a pure normalize() since claude's bookkeeping needs claude-shaped fields directly (see note below). */
  handleEvent(sessionId: string, rawEvent: unknown): void;
  /** Writes one already-composed turn (see composeTurnText in claude.js) to the process in the engine's wire format. */
  writeMessage(proc: unknown, msg: { text: string; attachments?: unknown[] }): void;
  sessionId: EngineSessionIdPolicy;
  permissions: EnginePermissions;
  /** Extra argv so this session's process sees the shared MCP server dict (claude: --mcp-config inline JSON). */
  injectMcp(session: Session): string[];
  /** --model/--effort or the engine's equivalent. */
  modelArgs(opts: { model?: string | null; effort?: string | null }): string[];
}

// Codex-shape notes for a future implementer (not applicable to claude, no interface change needed):
// Codex reports {server, tool} as separate fields, not a flat name — handleEvent has to compose mcp__<server>__<tool> itself.
// Codex's item.started/item.completed are two events sharing one item.id — handleEvent must correlate across calls, not assume 1 event = 1 tool call.

const registry = new Map<EngineId, EngineDriver>();

/** Each engine implementation calls this once at module load (claude.js does it at the bottom of the file). */
export function registerEngine(driver: EngineDriver): void {
  registry.set(driver.id, driver);
}

/** Defaults to 'claude'; throws (does not silently fall back) for a named-but-unregistered engine like 'codex' today. */
export function pickEngine(session?: Pick<Session, 'engine'> | null): EngineDriver {
  const id: EngineId = (session?.engine as EngineId) || 'claude';
  const driver = registry.get(id);
  if (!driver) throw new Error(`engine not implemented: ${id}`);
  return driver;
}
