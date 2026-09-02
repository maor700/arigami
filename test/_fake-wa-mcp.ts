// Stand-in for whatsapp-mcp's src/main.ts (BUGS1/B20 + WA1 tests): an MCP stdio
// server with two of the real tool names that writes the same
// bridge-status.json whatsapp.ts writes — but never touches WhatsApp.
//   FAKE_WA_MODE=crash      → a line on stderr, then exit(1) at once (a conflict, a broken dep)
//   FAKE_WA_MODE=logged-out → the real thing's footprint for a 401: the pino
//                             "Connection closed. Reason: loggedOut" lines in
//                             <data>/wa-logs.txt (nothing useful on stderr), exit(1)
//   no <checkout>/auth_info/creds.json → unpaired: status 'qr' with a qrUrl, then
//                             "scanned" once <data>/fake-scanned exists → creds.json
//                             written + status 'connected' (like a real scan)
//   FAKE_WA_SPAWN_LOG=<file> → appends one line per start (spawn counting)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const dataDir = process.env.WHATSAPP_MCP_DATA_DIR || '.';
const authDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'auth_info'); // upstream hardcodes <checkout>/auth_info
if (process.env.FAKE_WA_SPAWN_LOG) fs.appendFileSync(process.env.FAKE_WA_SPAWN_LOG, `${process.pid} ${Date.now()}\n`);
// The real process also logs next to its data — B17 wants that in the data dir, never the cwd.
fs.mkdirSync(dataDir, { recursive: true });
const pino = (level: number, msg: string) => fs.appendFileSync(path.join(dataDir, 'wa-logs.txt'), JSON.stringify({ level, time: new Date().toISOString(), pid: process.pid, hostname: 'fake', msg }) + '\n');
pino(30, `fake start cwd=${process.cwd()}`);

if (process.env.FAKE_WA_MODE === 'crash') {
  console.error('fake main.ts: crashing on purpose (FAKE_WA_MODE=crash)');
  process.exit(1);
}
if (process.env.FAKE_WA_MODE === 'logged-out') {
  pino(30, 'connection errored');
  pino(40, 'Connection closed. Reason: loggedOut');
  pino(50, 'Connection closed: Logged Out. Please delete auth_info and restart.');
  process.exit(1);
}

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
const paired = fs.existsSync(path.join(authDir, 'creds.json'));
if (paired) {
  write({ status: 'connected', user: 'Fake User', qrUrl: null });
} else {
  pino(30, 'QR Code Received.');
  write({ status: 'qr', qrUrl: `https://quickchart.io/qr?text=fake-qr-${process.pid}&size=220` });
  const scanned = path.join(dataDir, 'fake-scanned');
  const poll = setInterval(() => {
    if (!fs.existsSync(scanned)) return;
    clearInterval(poll);
    fs.mkdirSync(authDir, { recursive: true });
    fs.writeFileSync(path.join(authDir, 'creds.json'), JSON.stringify({ me: { id: 'fake@s.whatsapp.net' } }));
    pino(30, 'Connection opened. WA user: Fake User');
    write({ status: 'connected', user: 'Fake User', qrUrl: null });
  }, 100);
}
const bye = () => { try { write({ status: 'disconnected' }); } catch {} process.exit(0); };
process.on('SIGTERM', bye);
process.on('SIGINT', bye);
