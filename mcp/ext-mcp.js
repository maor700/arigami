#!/usr/bin/env bun
// Generic MCP wrapper for an extension's `kind:'module'` tools.
//
//   bun mcp/ext-mcp.js /abs/path/to/extension/tools/module.ts
//
// The module exports plain functions with a schema; this file turns them into
// an MCP stdio server so the author never has to learn the protocol:
//
//   export const tools = [
//     { name, description, inputSchema, async run(args, ctx) { … } }
//   ];
//   // or: export default defineTools([...])
//
// ctx = { extDir, settings, secrets, fetch, host: { api(method, path, body) } }.
// `host.api` talks to the host's REST over ARIGAMI_URL with ARIGAMI_TOKEN — the
// same internal bearer every session tool uses; it is never printed.
//
// Structural copy of mcp/host-mcp.js (ListTools/CallTool over stdio). A tool
// that throws becomes `isError:true` with the message — the server itself never
// dies, because a crashed MCP server would silently remove every tool of the
// extension from a live session.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const modulePath = process.argv[2];
if (!modulePath) {
  console.error('usage: bun mcp/ext-mcp.js <abs path to the tools module>');
  process.exit(2);
}

const EXT_DIR = process.env.EXT_DIR || path.dirname(path.dirname(modulePath));
const EXT_NAME = process.env.EXT_NAME || path.basename(EXT_DIR);
// INTERNAL only — never echoed into a tool result (test/no-localhost-urls).
const HOST = process.env.ARIGAMI_URL || 'http://127.0.0.1:3099';
const TOKEN = process.env.ARIGAMI_TOKEN || '';

let settings = {};
try { settings = JSON.parse(process.env.EXT_SETTINGS || '{}'); } catch { settings = {}; }

// Secrets reach a tool module as env (the loader puts extensions.json
// secrets[<ext>] there). They are NOT enumerated into ctx — read the ones you
// declared by name, e.g. process.env.MY_API_KEY.
const ctx = {
  extDir: EXT_DIR,
  extName: EXT_NAME,
  settings,
  secrets: new Proxy({}, { get: (_t, k) => (typeof k === 'string' ? process.env[k] : undefined) }),
  fetch: globalThis.fetch,
  host: {
    async api(method, apiPath, body) {
      const res = await fetch(HOST + apiPath, {
        method,
        headers: { 'content-type': 'application/json', ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      let json;
      try { json = JSON.parse(text); } catch { json = { raw: text }; }
      if (!res.ok) throw new Error(json.error || `${res.status} ${text.slice(0, 300)}`);
      return json;
    },
  },
};

function pickTools(mod) {
  const t = mod?.tools ?? mod?.default ?? null;
  if (Array.isArray(t)) return t;
  if (t && Array.isArray(t.tools)) return t.tools;
  return [];
}

let TOOLS = [];
let loadError = null;
try {
  const mod = await import(pathToFileURL(modulePath).href);
  TOOLS = pickTools(mod).filter((t) => t && typeof t.name === 'string' && typeof t.run === 'function');
  if (!TOOLS.length) loadError = `${modulePath} exports no tools (expected \`export const tools = [{name, description, inputSchema, run}]\`)`;
} catch (e) {
  loadError = `failed to import ${modulePath}: ${e?.message || e}`;
}
if (loadError) console.error(`[ext-mcp:${EXT_NAME}] ${loadError}`);

const server = new Server({ name: `ext-${EXT_NAME}`, version: '0.1.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map((t) => ({
    name: t.name,
    description: t.description || `${t.name} (${EXT_NAME} extension)`,
    inputSchema: t.inputSchema || { type: 'object', properties: {} },
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = TOOLS.find((t) => t.name === req.params.name);
  if (!tool)
    return { content: [{ type: 'text', text: loadError || `unknown tool: ${req.params.name}` }], isError: true };
  try {
    const result = await tool.run(req.params.arguments || {}, ctx);
    return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result ?? { ok: true }) }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `error: ${e?.message || e}` }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
