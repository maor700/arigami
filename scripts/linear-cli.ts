// One-off Linear MCP client for the dispatch smoke test (root master use).
// Reuses the host's file-backed OAuth store (~/.arigami/linear-oauth.json),
// connects to Linear's remote MCP, and calls a tool by name.
//
// Usage:
//   bun scripts/linear-cli.ts tools
//   bun scripts/linear-cli.ts call <toolName> '<json-args>'
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';

const SERVER_URL = 'https://mcp.linear.app/mcp';
const STORE = path.join(process.env.HOME || '.', '.arigami', 'linear-oauth.json');

function load() {
  try { return JSON.parse(fs.readFileSync(STORE, 'utf8')); } catch { return {}; }
}
function save(s: any) {
  fs.writeFileSync(STORE, JSON.stringify(s, null, 2), { mode: 0o600 });
}

const provider: OAuthClientProvider = {
  get redirectUrl() { return 'http://localhost:3099/__api/linear/oauth/callback'; },
  get clientMetadata() {
    return {
      client_name: 'Arigami',
      redirect_uris: [this.redirectUrl as string],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: 'read',
    } as any;
  },
  state() { const s = load(); if (!s.state) { s.state = crypto.randomBytes(16).toString('hex'); save(s); } return s.state; },
  clientInformation() { return load().clientInformation; },
  saveClientInformation(info: any) { const s = load(); s.clientInformation = info; save(s); },
  tokens() { return load().tokens; },
  saveTokens(tokens: any) { const s = load(); s.tokens = tokens; save(s); },
  redirectToAuthorization(url: URL) { console.error('NEEDS_AUTH', url.toString()); process.exit(2); },
  saveCodeVerifier(v: string) { const s = load(); s.codeVerifier = v; save(s); },
  codeVerifier() { const v = load().codeVerifier; if (!v) throw new Error('no verifier'); return v; },
  invalidateCredentials() {},
};

const c = new Client({ name: 'arigami-cli', version: '0.1.0' }, { capabilities: {} });
const t = new StreamableHTTPClientTransport(new URL(SERVER_URL), { authProvider: provider });
await c.connect(t);

const [, , cmd, toolName, argsJson] = process.argv;
if (cmd === 'tools') {
  const tools = await c.listTools();
  console.log(JSON.stringify(tools.tools.map((x: any) => x.name), null, 2));
} else if (cmd === 'schema') {
  const tools = await c.listTools();
  const tool = tools.tools.find((x: any) => x.name === toolName);
  console.log(JSON.stringify(tool?.inputSchema ?? null, null, 2));
} else if (cmd === 'call' || cmd === 'callf') {
  const args = cmd === 'callf'
    ? JSON.parse(fs.readFileSync(argsJson, 'utf8'))
    : (argsJson ? JSON.parse(argsJson) : {});
  const res = await c.callTool({ name: toolName, arguments: args });
  const text = (res?.content || []).filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('\n');
  console.log(res?.structuredContent ? JSON.stringify(res.structuredContent, null, 2) : text);
} else {
  console.error('usage: tools | schema <name> | call <name> <json>');
}
process.exit(0);
