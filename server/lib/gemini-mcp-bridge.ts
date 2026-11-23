// Gemini MCP bridge: agy acp packs MCP tool schemas smallest-first into an internal
// eager budget (~44–58 KB total across all servers) and silently drops every tool
// above it without exposing call_mcp_tool (measured on agy 1.5.15).
//
// For Gemini sessions with the MCP gateway enabled, Arigami sends only `/__mcp/s/arigami`
// (plus any non-gateway stdio/external servers) to `agy acp`. On `/__mcp/s/arigami`,
// Gemini gets a compact set of core everyday host tools directly (~24 KB, well under
// the cap) plus two small bridge tools — `mcp_tools` and `mcp_call` — that inspect
// and invoke every overflow host tool and every other gateway MCP server (extensions,
// Composio, host-held remote grants) through the same policy, mods, and outbound gates.
import type { ToolName } from './gemini-cli.js';

export const GEMINI_BRIDGE_TOOLS_NAME = 'mcp_tools';
export const GEMINI_BRIDGE_CALL_NAME = 'mcp_call';

/** Core everyday arigami tools kept directly declared for Gemini (~24 KB total with the 2 bridge tools). */
export const GEMINI_DIRECT_ARIGAMI_TOOLS = new Set<string>([
  'set_title',
  'set_color',
  'set_status',
  'set_metadata',
  'set_progress',
  'allocate_port',
  'open_tab',
  'update_tab',
  'close_tab',
  'activate_tab',
  'request_action',
  'request_review',
  'publish_artifact',
  'memory_search',
  'memory_get',
  'memory_write',
  'browser_open',
  'browser_navigate',
  'browser_snapshot',
  'browser_click',
  'browser_type',
  'browser_scroll',
  'browser_close',
  'request_screen',
  'sign_in',
  'capture_screen',
]);

export const GEMINI_BRIDGE_TOOL_DEFS = [
  {
    name: GEMINI_BRIDGE_TOOLS_NAME,
    description:
      'List or inspect schemas of connected MCP tools (including overflow arigami tools and external MCP servers). Call before mcp_call to inspect exact parameter schemas.',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'MCP server name (omit to list all servers and tool names)' },
        query: { type: 'string', description: 'Case-insensitive substring filter on tool name or description' },
        names: { type: 'array', items: { type: 'string' }, description: 'Exact tool names to return full parameter schemas for' },
        limit: { type: 'number', description: 'Max tools to return (default 25, max 50)' },
      },
      additionalProperties: false,
    },
  },
  {
    name: GEMINI_BRIDGE_CALL_NAME,
    description:
      'Invoke any connected MCP tool by server and tool name (including overflow arigami tools and external MCP servers). Inspect parameters with mcp_tools first.',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'MCP server name' },
        tool: { type: 'string', description: 'Tool name on that server' },
        arguments: { type: 'object', description: 'JSON object of arguments for the tool', additionalProperties: true },
      },
      required: ['server', 'tool'],
      additionalProperties: false,
    },
  },
];

/** On for Gemini when the MCP gateway is on, unless ARIGAMI_GEMINI_MCP_BRIDGE=0 disables it. */
export function isGeminiGatewayBridged(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ARIGAMI_MCP_GATEWAY !== '0' && env.ARIGAMI_GEMINI_MCP_BRIDGE !== '0';
}

export interface BridgeServerPartition {
  /** Servers handed directly to `agy acp` (arigami + any non-gateway servers). */
  direct: Record<string, any>;
  /** Gateway server names bridged through `/__mcp/s/arigami` (including `arigami`). */
  bridged: string[];
}

/** Pure: split a session's MCP server map into direct ACP servers vs gateway-bridged servers. */
export function partitionGeminiServers(servers: Record<string, any>, gatewayPrefix = '/__mcp/s/'): BridgeServerPartition {
  const direct: Record<string, any> = {};
  const bridged: string[] = [];
  for (const [name, sv] of Object.entries(servers || {})) {
    const url = typeof sv?.url === 'string' ? sv.url : '';
    const isGw = url.includes(gatewayPrefix);
    if (isGw) {
      bridged.push(name);
      if (name === 'arigami') direct[name] = sv;
    } else {
      direct[name] = sv;
    }
  }
  return { direct, bridged };
}

export interface UnwrappedBridgeCall {
  tool: ToolName;
  args: Record<string, unknown>;
}

const VALID_SERVER_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;

/**
 * Pure: unwrap an `mcp_arigami_mcp_call` invocation into the real target MCP tool and arguments,
 * so policy checks, mods, ask-mode permission cards, and chat transcript cards see the real tool.
 */
export function unwrapBridgeCall(meta: ToolName, rawArgs: unknown): UnwrappedBridgeCall | null {
  if (meta.server !== 'arigami' || meta.tool !== GEMINI_BRIDGE_CALL_NAME) return null;
  if (!rawArgs || typeof rawArgs !== 'object') return null;
  const obj = rawArgs as Record<string, unknown>;
  const server = typeof obj.server === 'string' ? obj.server.trim() : '';
  const tool = typeof obj.tool === 'string' ? obj.tool.trim() : '';
  if (!server || !VALID_SERVER_RE.test(server) || !tool) return null;
  const rawInner = obj.arguments;
  const args = rawInner && typeof rawInner === 'object' && !Array.isArray(rawInner) ? (rawInner as Record<string, unknown>) : {};
  return {
    tool: { name: `mcp__${server}__${tool}`, server, tool },
    args,
  };
}

export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface ServerToolsEntry {
  server: string;
  tools: McpToolDef[];
  error?: string;
}

const FULL_SCHEMA_THRESHOLD = 12;
const truncate = (s: string, max: number): string => (s.length <= max ? s : s.slice(0, max - 1) + '…');

/** Pure: filter and format gateway tools for `mcp_tools`. */
export function filterBridgeTools(
  entries: ServerToolsEntry[],
  opts: { server?: string; query?: string; names?: string[]; limit?: number } = {},
  directArigami: ReadonlySet<string> = GEMINI_DIRECT_ARIGAMI_TOOLS
): Record<string, unknown> {
  const serverFilter = typeof opts.server === 'string' ? opts.server.trim() : '';
  const query = typeof opts.query === 'string' ? opts.query.trim().toLowerCase() : '';
  const names = Array.isArray(opts.names) ? opts.names.map((n) => String(n || '').trim()).filter(Boolean) : [];
  const nameSet = names.length ? new Set(names) : null;
  const limit = Math.max(1, Math.min(50, Number(opts.limit) || 25));

  const selected = serverFilter ? entries.filter((e) => e.server === serverFilter) : entries;
  if (serverFilter && !selected.length) {
    return { error: `unknown or unavailable MCP server: ${serverFilter}`, availableServers: entries.map((e) => e.server) };
  }

  // Overview mode (no server, no query, no names): compact server -> tool names list.
  if (!serverFilter && !query && !nameSet) {
    return {
      servers: selected.map((e) => {
        const list = e.server === 'arigami' ? e.tools.filter((t) => !directArigami.has(t.name)) : e.tools;
        return {
          server: e.server,
          count: list.length,
          ...(e.error ? { error: e.error } : { tools: list.map((t) => t.name) }),
        };
      }),
      hint: 'Pass server + names (or query) to inspect full parameter schemas before calling mcp_call.',
    };
  }

  const matches: Array<{ server: string; tool: McpToolDef }> = [];
  for (const e of selected) {
    for (const t of e.tools) {
      if (e.server === 'arigami' && !query && !nameSet && directArigami.has(t.name)) continue;
      if (nameSet && !nameSet.has(t.name)) continue;
      if (query) {
        const hay = `${e.server} ${t.name} ${t.description || ''}`.toLowerCase();
        if (!hay.includes(query)) continue;
      }
      matches.push({ server: e.server, tool: t });
    }
  }

  const total = matches.length;
  const sliced = matches.slice(0, limit);
  const full = !!nameSet || sliced.length <= FULL_SCHEMA_THRESHOLD;
  return {
    total,
    returned: sliced.length,
    ...(selected.some((e) => e.error) ? { errors: selected.filter((e) => e.error).map((e) => ({ server: e.server, error: e.error })) } : {}),
    tools: sliced.map(({ server, tool }) =>
      full
        ? { server, name: tool.name, description: tool.description || '', inputSchema: tool.inputSchema || { type: 'object', properties: {} } }
        : { server, name: tool.name, description: truncate(String(tool.description || ''), 140) }
    ),
    ...(!full ? { hint: 'Pass names: [...] or a narrower query to get full parameter schemas.' } : {}),
  };
}

/** Pure: compact system-prompt note naming bridged MCP servers (synchronous, zero startup latency or schema budget). */
export function formatBridgeCatalog(servers: string[]): string {
  const list = servers.filter(Boolean);
  if (!list.length) return '';
  const labels = list.map((s) => (s === 'arigami' ? 'arigami (additional tools)' : s));
  return (
    '\n\nAdditional MCP tools (beyond the directly declared arigami tools) are invoked via ' +
    'mcp_arigami_mcp_call({ server, tool, arguments }); call mcp_arigami_mcp_tools({ server, names: [...] }) or ' +
    'mcp_arigami_mcp_tools({ server, query }) first to inspect exact parameters. ' +
    'Whenever a skill or instruction names mcp__<server>__<tool> (or an arigami tool not directly declared), ' +
    'call it through mcp_arigami_mcp_call({ server: "<server>", tool: "<tool>", arguments: {...} }).\n' +
    `Bridged MCP servers available in this session: ${labels.join(', ')}.`
  );
}
