// Adapt the pinned upstream bridge to the host status protocol. No credentials
// or QR payloads go to third-party sites. Refuse unknown sources instead of
// silently producing an installation that cannot report its state.
import fs from 'node:fs';
import path from 'node:path';
const dir = process.argv[2];
function edit(file, before, after) {
  const p = path.join(dir, 'src', file);
  const text = fs.readFileSync(p, 'utf8');
  if (text.includes(after)) return;
  if (!text.includes(before)) throw new Error(`Unsupported WhatsApp source: ${file}`);
  fs.writeFileSync(p, text.replace(before, after));
}
edit('database.ts', 'const DATA_DIR = path.join(import.meta.dirname, "..", "data");', 'const DATA_DIR = process.env.WHATSAPP_MCP_DATA_DIR || path.join(import.meta.dirname, "..", "data");');
edit('whatsapp.ts', 'import open from "open";', 'import { bridgeStatus, qrStatus } from "./arigami-status.ts";');
const p = path.join(dir, 'src', 'whatsapp.ts');
let text = fs.readFileSync(p, 'utf8');
if (!text.includes('await qrStatus(qr)')) {
  const start = text.indexOf('      if (qr) {');
  const end = text.indexOf('\n      if (connection === "close")', start);
  if (start < 0 || end < 0) throw new Error('Unsupported QR handler');
  text = text.slice(0, start) + '      if (qr) await qrStatus(qr);\n' + text.slice(end);
  fs.writeFileSync(p, text);
}
edit('whatsapp.ts', '  initializeDatabase();', '  initializeDatabase();\n  bridgeStatus("starting");');
edit('whatsapp.ts', '          startWhatsAppConnection(logger);', '          bridgeStatus("disconnected");\n          process.exit(1); // host reconnects with a fresh MCP socket');
edit('whatsapp.ts', '          process.exit(1);\n        }', '          bridgeStatus("disconnected", { reason: "logged-out" });\n          process.exit(1);\n        }');
edit('whatsapp.ts', '      } else if (connection === "open") {', '      } else if (connection === "open") {\n        bridgeStatus("connected", { user: sock.user?.name || sock.user?.id || null });');
fs.copyFileSync(new URL('./whatsapp-status.ts', import.meta.url), path.join(dir, 'src', 'arigami-status.ts'));
edit('whatsapp.ts', 'import { bridgeStatus, qrStatus } from "./arigami-status.ts";', 'import { bridgeStatus, qrStatus } from "./arigami-status.ts";\nimport { rememberMedia } from "./arigami-media.ts";');
edit('whatsapp.ts', '  let content: string | null = null;', '  let content: string | null = rememberMedia(msg);');
edit('mcp.ts', 'import { z } from "zod";', 'import { z } from "zod";\nimport { registerMediaTool } from "./arigami-media.ts";');
edit('mcp.ts', '  server.tool(\n    "search_contacts",', '  registerMediaTool(server, sock, waLogger);\n\n  server.tool(\n    "search_contacts",');
fs.copyFileSync(new URL('./whatsapp-media.ts', import.meta.url), path.join(dir, 'src', 'arigami-media.ts'));
