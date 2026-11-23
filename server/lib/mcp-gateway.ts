// The MCP gateway: every session's MCP servers served by the host over HTTP,
// instead of a stdio process per server per session.
//
//   /__mcp/s/arigami        the host tools — built in-process per request from
//                           mcp/host-mcp.js's createArigamiServer(), bound to the
//                           calling session
//   /__mcp/s/ext-<name>     an extension's tools — ONE process per extension,
//                           shared by every session; the caller rides along in
//                           each call's _meta (mcp/ext-mcp.js SHARED mode)
//   /__mcp/s/composio-mcp   Composio, in-process, with the host's key and the
//                           session owner's connected accounts (composio-mcp.ts)
//   /__mcp/s/<grant>        a vendor's remote MCP server (Linear, Notion…) through
//                           the host's own grant (mcp-grants.ts) — one login for
//                           every engine and account
//
// Names stay what they were (mcp__arigami__*, mcp__ext-<name>__*), so agent
// allowlists and skills do not change.
//
// Why: on a busy host each session ran three MCP processes of ~45 MB — about
// 150 MB a session for servers that hold no state of their own. It is also
// the one place a tool call passes through for every engine, which later
// stages build on (one login per service, shared across engines).
//
// Who is calling is the bearer token: a session's own token, which the host
// already issues (auth.tokenForSession) and every engine already carries in
// ARIGAMI_TOKEN. Nothing else may call these endpoints.
//
// Stateless on purpose (no MCP session ids): a host restart would otherwise
// leave every engine holding an id the new process never issued.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { cfg, getSession } from '../state.js';
import { auth } from '../auth.js';
import * as extensions from '../extensions.js';
import { policyFor, isRestrictive, serverTouched, toolAllowed, checkToolCall } from '../agent-policy.js';
import {
  GEMINI_BRIDGE_TOOLS_NAME,
  GEMINI_BRIDGE_CALL_NAME,
  GEMINI_DIRECT_ARIGAMI_TOOLS,
  GEMINI_BRIDGE_TOOL_DEFS,
  isGeminiGatewayBridged,
  filterBridgeTools,
  type McpToolDef,
  type ServerToolsEntry,
} from './gemini-mcp-bridge.js';

export const GATEWAY_PREFIX = '/__mcp/s/';
export const COMPOSIO_SERVER = 'composio-mcp';
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;

// How a sender's call becomes a card. api.ts owns cards and registers this at
// load; the gateway only needs it for in-process servers (Composio).
type FileOutbound = import('./composio-mcp.js').FileOutbound;
let fileOutbound: FileOutbound | null = null;
export function setOutboundFiler(f: FileOutbound): void {
  fileOutbound = f;
}

/** On unless ARIGAMI_MCP_GATEWAY=0 — the switch back to stdio servers. */
export function gatewayEnabled(): boolean {
  return process.env.ARIGAMI_MCP_GATEWAY !== '0';
}

export function gatewayUrl(name: string, base = cfg.hostBase || 'http://127.0.0.1:3099'): string {
  return `${base.replace(/\/+$/, '')}${GATEWAY_PREFIX}${name}`;
}

/**
 * Claude's --mcp-config entry. The token is NOT in the config: Claude expands
 * ${ARIGAMI_TOKEN} from the session's own env (measured), so it never lands in
 * argv where any local user could read it.
 */
export function claudeEntry(name: string): Record<string, unknown> {
  return { type: 'http', url: gatewayUrl(name), headers: { Authorization: 'Bearer ${ARIGAMI_TOKEN}' } };
}

/** Codex's [mcp_servers] entry: bearer_token_env_var reads the same env var. */
export function codexEntry(name: string): Record<string, unknown> {
  return { url: gatewayUrl(name), bearerEnv: 'ARIGAMI_TOKEN' };
}

const ownerOf = (s: any): string => {
  const slug = typeof s?.metadata?.agent === 'string' && s.metadata.agent ? s.metadata.agent : null;
  return slug ? `agent:${slug}` : 'global';
};

// ---- shared extension processes ------------------------------------------------

type McpClient = import('@modelcontextprotocol/sdk/client/index.js').Client;
const extClients = new Map<string, Promise<McpClient>>();

/**
 * The one process for this extension server (keyed by its spec, so a changed
 * setting or a reloaded extension gets a fresh one and the old one is closed).
 */
async function extClient(name: string, spec: { command: string; args: string[]; cwd: string; env: Record<string, string> }): Promise<McpClient> {
  const key = name + ':' + createHash('sha1').update(JSON.stringify(spec)).digest('hex').slice(0, 12);
  const have = extClients.get(key);
  if (have) return have;
  for (const [k, p] of extClients) {
    if (k.startsWith(name + ':')) {
      extClients.delete(k);
      p.then((c) => c.close()).catch(() => {});
    }
  }
  const made = (async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    // The host's own env minus any session identity; the caller comes per call.
    const { ARIGAMI_SESSION_ID: _s, ARIGAMI_TOKEN: _t, ...base } = process.env as Record<string, string>;
    const transport = new StdioClientTransport({ command: spec.command, args: spec.args, cwd: spec.cwd, env: { ...base, ...spec.env, EXT_SHARED: '1' } });
    const client = new Client({ name: 'arigami-gateway', version: '0.1.0' }, (await import('./mcp-validator.js')).mcpClientOptions());
    transport.onclose = () => extClients.delete(key); // it died — the next call starts a new one
    await client.connect(transport);
    return client;
  })();
  extClients.set(key, made);
  made.catch(() => extClients.delete(key));
  return made;
}

/** Close every shared extension process (host shutdown, tests). */
export async function closeShared(): Promise<void> {
  const all = [...extClients.values()];
  extClients.clear();
  await Promise.all(all.map((p) => p.then((c) => c.close()).catch(() => {})));
}

async function extProxy(name: string, session: any, token: string) {
  const specs = extensions.extServersFor(ownerOf(session)) as Record<string, { command: string; args: string[]; cwd: string; env: Record<string, string> }>;
  const spec = specs[name];
  if (!spec) return null;
  const client = await extClient(name, spec);
  const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
  const { ListToolsRequestSchema, CallToolRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');
  const server = new Server({ name, version: '0.1.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: ((await client.listTools()) as any).tools || [] }));
  server.setRequestHandler(CallToolRequestSchema, async (req: any) =>
    (await client.callTool({
      name: req.params.name,
      arguments: req.params.arguments || {},
      _meta: { 'arigami/session': session.id, 'arigami/token': token },
    } as any)) as any
  );
  return server;
}

/** A host-held remote grant, for a session whose owner may use it. */
async function remoteProxy(name: string, session: any) {
  const grants = await import('./mcp-grants.js');
  const g = grants.getGrant(name);
  if (!g || (g.owner !== 'global' && g.owner !== ownerOf(session))) return null;
  const { isOutbound } = await import('./outbound.js');
  const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
  const { ListToolsRequestSchema, CallToolRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');
  const server = new Server({ name, version: '0.1.0' }, { capabilities: { tools: {} } });
  const fail = (e: unknown) => ({ content: [{ type: 'text', text: `${name}: ${(e as Error).message}` }], isError: true });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: (((await (await grants.clientFor(name)).listTools()) as any).tools || []) }));
  server.setRequestHandler(CallToolRequestSchema, async (req: any) => {
    const tool = String(req.params?.name || '');
    const args = req.params?.arguments && typeof req.params.arguments === 'object' ? req.params.arguments : {};
    if (isOutbound(tool)) {
      if (!fileOutbound) return fail(new Error('outbound cards are not wired'));
      const r = await fileOutbound(session.id, { via: 'mcp', server: name, tool, args });
      return { content: [{ type: 'text', text: JSON.stringify(r) }] };
    }
    try {
      return (await grants.callTool(name, tool, args)) as any;
    } catch (e) {
      return fail(e);
    }
  });
  return server;
}

async function arigamiServer(session: any, token: string) {
  const { createArigamiServer } = (await import('../../mcp/host-mcp.js')) as any;
  const md = session.metadata || {};
  return createArigamiServer({
    ARIGAMI_URL: cfg.hostBase,
    ARIGAMI_PUBLIC_PATH: '/__host/',
    ARIGAMI_TOKEN: token,
    ARIGAMI_SESSION_ID: session.id,
    ...(typeof md.agent === 'string' && md.agent ? { ARIGAMI_AGENT: md.agent } : {}),
    ...(session.engine === 'codex' || session.engine === 'gemini' ? { ARIGAMI_ENGINE: session.engine } : {}),
  });
}

const deny = (res: ServerResponse, status: number, error: string) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error }));
};

/** Build the underlying MCP Server instance for one gateway server name, without Gemini bridge wrapping. */
async function buildRawServer(name: string, session: any, token: string): Promise<any> {
  if (name === 'arigami') return arigamiServer(session, token);
  if (name === COMPOSIO_SERVER) {
    if (!fileOutbound) throw new Error('outbound cards are not wired');
    const { createComposioServer } = await import('./composio-mcp.js');
    return createComposioServer(session, ownerOf(session), fileOutbound);
  }
  if (name.startsWith('ext-')) return extProxy(name, session, token);
  return remoteProxy(name, session);
}

const slugOf = (s: any): string | null => (typeof s?.metadata?.agent === 'string' && s.metadata.agent ? s.metadata.agent : null);

/** Gateway server names this Gemini session may access (same source + A3 filter as geminiMcpServers). */
async function geminiSessionGatewayServers(session: any): Promise<string[]> {
  const { mcpServersFor } = await import('../claude.js');
  const servers: Record<string, any> = mcpServersFor(session, { claudeGrants: false });
  const policy = policyFor(slugOf(session));
  const out: string[] = [];
  for (const [name, sv] of Object.entries(servers || {})) {
    const url = typeof sv?.url === 'string' ? sv.url : '';
    if (!url.includes(GATEWAY_PREFIX)) continue;
    if (isRestrictive(policy) && policy.tools !== null && !serverTouched(policy, name)) continue;
    out.push(name);
  }
  return out;
}

/** Run `fn` against an in-process MCP Server over an InMemoryTransport pair, closing both sides on exit. */
async function withInMemoryClient<T>(server: any, fn: (client: McpClient) => Promise<T>): Promise<T> {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'arigami-bridge', version: '0.1.0' }, (await import('./mcp-validator.js')).mcpClientOptions());
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

const BRIDGE_CALL_TIMEOUT_MS = 30 * 60 * 1000;

async function listServerTools(name: string, session: any, token: string, timeoutMs = 5000): Promise<McpToolDef[]> {
  const server = await buildRawServer(name, session, token);
  if (!server) return [];
  const res = await withInMemoryClient(server, (c) => c.listTools(undefined, { timeout: timeoutMs }));
  return (Array.isArray(res?.tools) ? res.tools : []).map((t: any) => ({
    name: String(t.name || ''),
    description: typeof t.description === 'string' ? t.description : '',
    inputSchema: t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : { type: 'object', properties: {} },
  }));
}

async function listSessionGatewayTools(
  session: any,
  token: string,
  opts: { onlyServer?: string; timeoutMs?: number } = {}
): Promise<ServerToolsEntry[]> {
  const allowedServers = await geminiSessionGatewayServers(session);
  const targets = opts.onlyServer ? allowedServers.filter((s) => s === opts.onlyServer) : allowedServers;
  const policy = policyFor(slugOf(session));
  const timeoutMs = opts.timeoutMs ?? 5000;
  return Promise.all(
    targets.map(async (server): Promise<ServerToolsEntry> => {
      try {
        const raw = await listServerTools(server, session, token, timeoutMs);
        const tools = raw.filter((t) => toolAllowed(policy, server === 'arigami' ? t.name : `mcp__${server}__${t.name}`));
        return { server, tools };
      } catch (e) {
        return { server, tools: [], error: (e as Error).message };
      }
    })
  );
}

/**
 * Gemini-specific `/__mcp/s/arigami` wrapper: exposes core everyday arigami tools directly (~24 KB)
 * plus `mcp_tools` and `mcp_call` to discover and invoke overflow arigami tools and all other
 * gateway MCP servers without overflowing `agy acp`'s internal eager schema budget.
 */
async function createGeminiBridgeArigamiServer(session: any, token: string) {
  const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
  const { ListToolsRequestSchema, CallToolRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');
  const server = new Server(
    { name: 'arigami', version: '0.1.0' },
    { capabilities: { tools: {} }, instructions: "Arigami's tools and MCP bridge. Use mcp_tools + mcp_call for additional arigami and external MCP tools." }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const raw = await listServerTools('arigami', session, token, 5000);
    const direct = raw.filter((t) => GEMINI_DIRECT_ARIGAMI_TOOLS.has(t.name));
    return { tools: [...direct, ...GEMINI_BRIDGE_TOOL_DEFS] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req: any) => {
    const toolName = String(req.params?.name || '');
    const args = req.params?.arguments && typeof req.params.arguments === 'object' ? req.params.arguments : {};

    if (toolName === GEMINI_BRIDGE_TOOLS_NAME) {
      const onlyServer = typeof args.server === 'string' && args.server.trim() ? args.server.trim() : undefined;
      const entries = await listSessionGatewayTools(session, token, { onlyServer, timeoutMs: 10_000 });
      const payload = filterBridgeTools(entries, {
        server: onlyServer,
        query: typeof args.query === 'string' ? args.query : undefined,
        names: Array.isArray(args.names) ? args.names : undefined,
        limit: typeof args.limit === 'number' ? args.limit : undefined,
      });
      return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
    }

    if (toolName === GEMINI_BRIDGE_CALL_NAME) {
      const targetServer = typeof args.server === 'string' ? args.server.trim() : '';
      const targetTool = typeof args.tool === 'string' ? args.tool.trim() : '';
      const targetArgs = args.arguments && typeof args.arguments === 'object' && !Array.isArray(args.arguments) ? args.arguments : {};
      if (!targetServer || !NAME_RE.test(targetServer)) {
        return { content: [{ type: 'text', text: `error: invalid MCP server name "${targetServer}"` }], isError: true };
      }
      if (!targetTool) {
        return { content: [{ type: 'text', text: 'error: missing tool name' }], isError: true };
      }
      if (targetServer === 'arigami' && (targetTool === GEMINI_BRIDGE_CALL_NAME || targetTool === GEMINI_BRIDGE_TOOLS_NAME)) {
        return { content: [{ type: 'text', text: `error: call "${targetTool}" directly instead of nesting through mcp_call` }], isError: true };
      }
      const allowedServers = await geminiSessionGatewayServers(session);
      if (!allowedServers.includes(targetServer)) {
        return { content: [{ type: 'text', text: `error: MCP server "${targetServer}" is not available in this session` }], isError: true };
      }
      const canonical = targetServer === 'arigami' ? targetTool : `mcp__${targetServer}__${targetTool}`;
      const verdict = checkToolCall(policyFor(slugOf(session)), canonical, targetArgs, session.id);
      if (!verdict.allow) {
        return { content: [{ type: 'text', text: `[arigami policy] ${(verdict as any).reason || `${canonical} is not allowed for this agent`}` }], isError: true };
      }
      const { noteMcpResult } = await import('../claude.js');
      try {
        const target = await buildRawServer(targetServer, session, token);
        if (!target) return { content: [{ type: 'text', text: `error: MCP server "${targetServer}" could not be started` }], isError: true };
        const result = (await withInMemoryClient(target, (c) => c.callTool({ name: targetTool, arguments: targetArgs }, undefined, { timeout: BRIDGE_CALL_TIMEOUT_MS }))) as any;
        const summary = Array.isArray(result?.content) ? result.content.map((c: any) => (c?.type === 'text' ? String(c.text || '') : '')).join('\n') : '';
        if (targetServer !== 'arigami') noteMcpResult(session.id, targetServer, { content: summary, is_error: !!result?.isError });
        return { content: Array.isArray(result?.content) ? result.content : [{ type: 'text', text: JSON.stringify(result ?? { ok: true }) }], ...(result?.isError ? { isError: true } : {}) };
      } catch (e) {
        const msg = `${targetServer}.${targetTool}: ${(e as Error).message}`;
        if (targetServer !== 'arigami') noteMcpResult(session.id, targetServer, { content: msg, is_error: true });
        return { content: [{ type: 'text', text: `error: ${msg}` }], isError: true };
      }
    }

    // Direct arigami tool call
    try {
      const raw = await arigamiServer(session, token);
      const result = (await withInMemoryClient(raw, (c) => c.callTool({ name: toolName, arguments: args }, undefined, { timeout: BRIDGE_CALL_TIMEOUT_MS }))) as any;
      return { content: Array.isArray(result?.content) ? result.content : [{ type: 'text', text: JSON.stringify(result ?? { ok: true }) }], ...(result?.isError ? { isError: true } : {}) };
    } catch (e) {
      return { content: [{ type: 'text', text: `error: ${(e as Error).message}` }], isError: true };
    }
  });

  return server;
}

/** Serve one gateway request. `principal` is the host's auth result for it. */
export async function handle(req: IncomingMessage, res: ServerResponse, name: string, principal: any): Promise<void> {
  if (!NAME_RE.test(name)) return deny(res, 404, `no such MCP server: ${name}`);
  // The session is the bearer token's, in every auth mode: with auth off every
  // principal is 'off', and that cannot say which session is calling.
  const sessionId = principal?.kind === 'session' ? principal.sessionId : auth.sessionFromBearer(req);
  if (!sessionId) return deny(res, 403, 'the MCP gateway serves sessions only — call it with a session token');
  const session = getSession(sessionId);
  if (!session) return deny(res, 404, 'no such session');
  const token = auth.tokenForSession(session.id);
  let server: any;
  try {
    if (name === 'arigami' && session.engine === 'gemini' && isGeminiGatewayBridged()) {
      server = await createGeminiBridgeArigamiServer(session, token);
    } else {
      server = await buildRawServer(name, session, token);
    }
  } catch (e) {
    return deny(res, 502, `could not start ${name}: ${(e as Error).message}`);
  }
  if (!server) return deny(res, 404, `this session has no MCP server ${name}`);
  const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });
  await server.connect(transport);
  await transport.handleRequest(req as any, res);
}
