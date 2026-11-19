#!/usr/bin/env bun
// Serve one extension's `kind:'module'` tools over HTTP, for a host that runs them OUTSIDE its own process — a
// sidecar container next to it (Helm chart `isolation.gatekeeper`, server/lib/ext-remote.ts on the host side).
//
//   EXT_NAME=gatekeeper bun mcp/ext-serve.ts /app/extensions/gatekeeper/tools/module.ts
//
//   POST /shared   sessions, through the host's MCP gateway — the caller rides in each call's _meta (EXT_SHARED mode)
//   POST /host     host calls: an owner's tab (EXT_HOST_CALL mode)
//   GET  /health   200 once both are up (the container's readiness probe)
//
// The tools run exactly as on the host: this file starts mcp/ext-mcp.js twice (once per mode) over stdio and relays
// tools/list and tools/call to it, _meta included. So what the module holds — credentials read from files mounted
// only into this container — never exists in the host's container.
//
// Listens on 127.0.0.1 by default: in a pod that is the pod's own network namespace, i.e. the host container and
// nothing outside the pod. Stateless (no MCP session ids), like the host's gateway.
import http from 'node:http';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const modulePath = process.argv[2];
if (!modulePath) {
  console.error('usage: bun mcp/ext-serve.ts <abs path to the tools module>');
  process.exit(2);
}
const EXT_DIR = process.env.EXT_DIR || path.dirname(path.dirname(path.resolve(modulePath)));
const EXT_NAME = process.env.EXT_NAME || path.basename(EXT_DIR);
const PORT = Number(process.env.EXT_SERVE_PORT || 3199);
const BIND = process.env.EXT_SERVE_BIND || '127.0.0.1';
const EXT_MCP = path.join(import.meta.dir, 'ext-mcp.js');

type Mode = 'shared' | 'host';
const clients = new Map<Mode, Promise<Client>>();

/** The ext-mcp.js child for one mode — started on first use, restarted after it dies. */
function child(mode: Mode): Promise<Client> {
  const have = clients.get(mode);
  if (have) return have;
  const made = (async () => {
    const { EXT_SHARED: _a, EXT_HOST_CALL: _b, ARIGAMI_SESSION_ID: _c, ...base } = process.env as Record<string, string>;
    const env = { ...base, EXT_DIR, EXT_NAME, ...(mode === 'shared' ? { EXT_SHARED: '1' } : { EXT_HOST_CALL: '1' }) };
    const transport = new StdioClientTransport({ command: process.execPath, args: [EXT_MCP, path.resolve(modulePath)], cwd: EXT_DIR, env });
    const client = new Client({ name: `ext-serve-${mode}`, version: '0.1.0' }, { capabilities: {} });
    transport.onclose = () => clients.delete(mode);
    await client.connect(transport);
    return client;
  })();
  clients.set(mode, made);
  made.catch(() => clients.delete(mode));
  return made;
}

function relay(mode: Mode): Server {
  const server = new Server({ name: `ext-${EXT_NAME}`, version: '0.1.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: (((await (await child(mode)).listTools()) as any).tools || []) }));
  server.setRequestHandler(CallToolRequestSchema, async (req: any) => {
    const p = req.params || {};
    // _meta is passed through only on /shared: that is where the host names the calling session. A host call names none.
    return (await (await child(mode)).callTool({ name: p.name, arguments: p.arguments || {}, ...(mode === 'shared' && p._meta ? { _meta: p._meta } : {}) } as any)) as any;
  });
  return server;
}

const send = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const srv = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://x');
  if (url.pathname === '/health') {
    try {
      await Promise.all([child('shared'), child('host')]);
      return send(res, 200, { ok: true, ext: EXT_NAME });
    } catch (e) {
      return send(res, 503, { ok: false, error: (e as Error).message });
    }
  }
  const mode: Mode | null = url.pathname === '/shared' ? 'shared' : url.pathname === '/host' ? 'host' : null;
  if (!mode) return send(res, 404, { error: 'not found' });
  const server = relay(mode);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req as any, res);
  } catch (e) {
    if (!res.headersSent) send(res, 500, { error: (e as Error).message });
  }
});

srv.listen(PORT, BIND, () => console.log(`[ext-serve] ${EXT_NAME} on http://${BIND}:${PORT} (/shared, /host)`));
const stop = () => {
  srv.close();
  for (const p of clients.values()) p.then((c) => c.close()).catch(() => {});
  setTimeout(() => process.exit(0), 500).unref();
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
