// Stand-in for whatsapp-mcp's src/main.ts (BUGS1/B20 tests): an MCP stdio
// server with two of the real tool names that writes the same
// bridge-status.json whatsapp.ts writes — but never touches WhatsApp.
//   FAKE_WA_MODE=crash → exit(1) at once (a logged-out pairing / a conflict)
//   FAKE_WA_SPAWN_LOG=<file> → appends one line per start (spawn counting)
import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const dataDir = process.env.WHATSAPP_MCP_DATA_DIR || '.';
if (process.env.FAKE_WA_SPAWN_LOG) fs.appendFileSync(process.env.FAKE_WA_SPAWN_LOG, `${process.pid} ${Date.now()}\n`);
// The real process also logs next to its data — B17 wants that in the data dir, never the cwd.
fs.mkdirSync(dataDir, { recursive: true });
fs.appendFileSync(path.join(dataDir, 'wa-logs.txt'), `fake start pid=${process.pid} cwd=${process.cwd()}\n`);

if (process.env.FAKE_WA_MODE === 'crash') process.exit(1);

const write = (s: Record<string, unknown>) => fs.writeFileSync(path.join(dataDir, 'bridge-status.json'), JSON.stringify({ ...s, pid: process.pid, ts: Date.now() }));
write({ status: 'starting' });

const server = new McpServer({ name: 'fake-whatsapp', version: '0.0.0' });
server.tool('list_chats', { limit: z.number().optional() }, async ({ limit }) => ({
  content: [{ type: 'text', text: JSON.stringify([{ jid: '1@s.whatsapp.net', name: 'fake chat', limit: limit ?? null, pid: process.pid }]) }],
}));
server.tool('send_message', { recipient: z.string(), message: z.string() }, async ({ recipient }) => ({
  isError: recipient === 'bad', content: [{ type: 'text', text: recipient === 'bad' ? 'Failed to send message' : 'sent' }],
}));

await server.connect(new StdioServerTransport());
write({ status: 'connected', user: 'Fake User', qrUrl: null });
const bye = () => { try { write({ status: 'disconnected' }); } catch {} process.exit(0); };
process.on('SIGTERM', bye);
process.on('SIGINT', bye);
