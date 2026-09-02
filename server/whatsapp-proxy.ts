// F8: host-side client for the WhatsApp MCP server (jlucaso1/whatsapp-mcp-ts).
//
// Sessions used to see WhatsApp tools only when the user had registered that
// MCP server in ~/.claude.json themselves — on a fresh install there was no
// tool at all, so the agent answered "I have no access to WhatsApp" instead of
// asking to connect it (SPEC-JIT acceptance #4). Now host-mcp exposes one
// `whatsapp` tool that funnels here: not connected → the needs_setup shape
// (the agent calls request_setup → QR card); connected → the call goes to the
// host's ONE WhatsApp process (whatsapp-bridge.ts owns it; BUGS1/B20 — this
// module no longer spawns a second, competing client of its own).
import { WA_MCP_DIR, getBridgeStatus, callTool, whatsappMcpInstalled } from './whatsapp-bridge.js';
import { needsSetup, type NeedsSetup } from './capabilities.js';

export { whatsappMcpInstalled };

export const WA_TOOLS = ['list_chats', 'list_messages', 'search_contacts', 'search_messages', 'get_chat', 'get_message_context', 'get_recent_messages', 'send_message'] as const;
export type WaTool = (typeof WA_TOOLS)[number];

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
    const r = await callTool(tool, args);
    if (r?.isError) return { ok: false, error: String(r.content?.map((x: any) => x.text || '').join('\n') || 'tool error') };
    return { ok: true, result: r?.content ?? r };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
