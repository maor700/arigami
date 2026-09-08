// Desktop packaging (bun build --compile): the four mcp/*.js helper scripts
// (host-mcp.js, policy-hook.js, ext-mcp.js — blocking-call.js is a library
// imported by host-mcp.js, never spawned on its own) are normally run as
// `bun <path>`. A compiled binary has no `bun` on PATH to spawn, so instead
// we re-exec the binary itself with a `--mcp <kind>` subcommand;
// server/index.ts recognizes that argv at the very top and routes to the
// script instead of booting the server. Outside a compiled binary this is a
// no-op wrapper — it must build the exact same {command, args} the call
// sites built by hand before this helper existed.
import path from 'node:path';
import { resourceRoot, isCompiledBinary } from './resource-root.js';

export type McpKind = 'host' | 'policy' | 'ext';

const MCP_FILES: Record<McpKind, string> = {
  host: 'host-mcp.js',
  policy: 'policy-hook.js',
  ext: 'ext-mcp.js',
};

export function bunExec(kind: McpKind, extraArgs: string[] = []): { command: string; args: string[] } {
  if (isCompiledBinary()) return { command: process.execPath, args: ['--mcp', kind, ...extraArgs] };
  return { command: 'bun', args: [path.join(resourceRoot(), 'mcp', MCP_FILES[kind]), ...extraArgs] };
}

/**
 * Shell-quoted single-string form, for embedding in a hook `command` field
 * (Claude Code's --settings PreToolUse hook takes a shell string, not argv).
 * When not compiled this reduces to exactly `bun "<path>"`, byte-identical
 * to the hand-written string it replaces.
 */
export function bunExecShell(kind: McpKind, extraArgs: string[] = []): string {
  const { command, args } = bunExec(kind, extraArgs);
  return [command, ...args.map((a) => `"${a}"`)].join(' ');
}
