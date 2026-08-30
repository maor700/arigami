// F8: host-side client for the WhatsApp MCP server (jlucaso1/whatsapp-mcp-ts).
//
// Sessions used to see WhatsApp tools only when the user had registered that
// MCP server in ~/.claude.json themselves — on a fresh install there was no
// tool at all, so the agent answered "I have no access to WhatsApp" instead of
// asking to connect it (SPEC-JIT acceptance #4). Now host-mcp exposes one
// `whatsapp` tool that funnels here: not connected → the needs_setup shape
// (the agent calls request_setup → QR card); connected → the call is proxied
// to the real MCP server over stdio (spawned lazily, kept alive).
import fs from 'node:fs';
import path from 'node:path';
import { WA_MCP_DIR, WA_DATA_DIR, getBridgeStatus } from './whatsapp-bridge.js';
import { needsSetup, type NeedsSetup } from './capabilities.js';

export const WA_TOOLS = ['list_chats', 'list_messages', 'search_contacts', 'search_messages', 'get_chat', 'get_message_context', 'get_recent_messages', 'send_message'] as const;
export type WaTool = (typeof WA_TOOLS)[number];

const MCP_MAIN = path.join(WA_MCP_DIR, 'src', 'main.ts');

let client: any = null;
let connecting: Promise<any> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
const IDLE_MS = 10 * 60_000;

/** Is the MCP checkout there at all (Docker image / install.sh put it in WA_MCP_DIR)? */
export function whatsappMcpInstalled(): boolean {
  return fs.existsSync(MCP_MAIN);
}

async function connect(): Promise<any> {
  if (client) return client;
  if (connecting) return connecting;
  connecting = (async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    const transport = new StdioClientTransport({
      command: 'npx',
      args: ['tsx', MCP_MAIN],
      env: { ...(process.env as Record<string, string>), WHATSAPP_MCP_DATA_DIR: WA_DATA_DIR, NODE_PATH: path.join(WA_MCP_DIR, 'node_modules') },
      cwd: WA_MCP_DIR,
      stderr: 'ignore',
    });
    const c = new Client({ name: 'arigami-host', version: '0.1.0' });
    await c.connect(transport);
    transport.onclose = () => { if (client === c) client = null; };
    client = c;
    return c;
  })().finally(() => { connecting = null; });
  return connecting;
}

function touchIdle(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { closeProxy().catch(() => {}); }, IDLE_MS);
  if (idleTimer.unref) idleTimer.unref();
}

export async function closeProxy(): Promise<void> {
  const c = client;
  client = null;
  if (c) { try { await c.close(); } catch { /* already gone */ } }
}

/**
 * One WhatsApp tool call on behalf of a session. Never throws for "not
 * connected" — that is the needs_setup shape the agent knows how to handle.
 */
export async function callWhatsapp(tool: string, args: Record<string, unknown> = {}, why = 'use your WhatsApp'):
  Promise<NeedsSetup | { ok: true; result: unknown } | { ok: false; error: string }> {
  if (!(WA_TOOLS as readonly string[]).includes(tool)) return { ok: false, error: `unknown whatsapp tool "${tool}" — one of ${WA_TOOLS.join(', ')}` };
  if (getBridgeStatus().status !== 'connected') return needsSetup('whatsapp', why);
  if (!whatsappMcpInstalled()) return { ok: false, error: `WhatsApp MCP server not installed at ${WA_MCP_DIR} (ARIGAMI_WA_MCP_DIR)` };
  try {
    const c = await connect();
    touchIdle();
    const r = await c.callTool({ name: tool, arguments: args });
    if (r?.isError) return { ok: false, error: String(r.content?.map((x: any) => x.text || '').join('\n') || 'tool error') };
    return { ok: true, result: r?.content ?? r };
  } catch (e) {
    client = null; // a dead transport is retried on the next call
    return { ok: false, error: (e as Error).message };
  }
}
