// The MCP gateway: every session's MCP servers served by the host over HTTP,
// instead of a stdio process per server per session.
//
//   /__mcp/s/arigami        the host tools — built in-process per request from
//                           mcp/host-mcp.js's createArigamiServer(), bound to the
//                           calling session
//   /__mcp/s/ext-<name>     an extension's tools — ONE process per extension,
//                           shared by every session; the caller rides along in
//                           each call's _meta (mcp/ext-mcp.js SHARED mode)
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

export const GATEWAY_PREFIX = '/__mcp/s/';
const NAME_RE = /^(arigami|ext-[a-z0-9][a-z0-9-]*)$/;

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
    const client = new Client({ name: 'arigami-gateway', version: '0.1.0' }, { capabilities: {} });
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

async function arigamiServer(session: any, token: string) {
  const { createArigamiServer } = (await import('../../mcp/host-mcp.js')) as any;
  const md = session.metadata || {};
  return createArigamiServer({
    ARIGAMI_URL: cfg.hostBase,
    ARIGAMI_PUBLIC_PATH: '/__host/',
    ARIGAMI_TOKEN: token,
    ARIGAMI_SESSION_ID: session.id,
    ...(typeof md.agent === 'string' && md.agent ? { ARIGAMI_AGENT: md.agent } : {}),
    ...(session.engine === 'codex' ? { ARIGAMI_ENGINE: 'codex' } : {}),
  });
}

const deny = (res: ServerResponse, status: number, error: string) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error }));
};

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
    server = name === 'arigami' ? await arigamiServer(session, token) : await extProxy(name, session, token);
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
