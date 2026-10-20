import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dir, '..');
test('native repair preserves pairing/data, retries failed dependencies, and is offline-idempotent', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-install-'));
  const wa = path.join(tmp, 'wa');
  const bin = path.join(tmp, 'bin');
  fs.mkdirSync(bin);
  for (const folder of ['src', 'auth_info', 'data']) fs.mkdirSync(path.join(wa, folder), { recursive: true });
  fs.writeFileSync(path.join(wa, 'src/main.ts'), '// fixture');
  fs.writeFileSync(path.join(wa, 'src/database.ts'), 'const DATA_DIR = path.join(import.meta.dirname, "..", "data");');
  fs.writeFileSync(path.join(wa, 'src/whatsapp.ts'), `import open from "open";
  initializeDatabase();
  let content: string | null = null;
      if (qr) {
        await open(qr);
      }
      if (connection === "close") {
          startWhatsAppConnection(logger);
          process.exit(1);
        }
      } else if (connection === "open") {
`);
  fs.writeFileSync(path.join(wa, 'src/mcp.ts'), 'import { z } from "zod";\n  server.tool(\n    "search_contacts",');
  fs.writeFileSync(path.join(wa, 'auth_info/creds.json'), '{"sentinel":"pairing"}');
  fs.writeFileSync(path.join(wa, 'data/whatsapp.db'), 'message-data');
  function executable(name: string, body: string) {
    fs.writeFileSync(path.join(bin, name), '#!/bin/sh\n'+body, { mode: 0o755 });
  }
  // Only package management is mocked; run the real adapter against source.
  executable('node', `case "$1" in *prepare-whatsapp.mjs) exec "${process.execPath}" "$@";; *) exit 0;; esac\n`);
  executable('npm', `echo called >> "$ARIGAMI_WA_MCP_DIR/npm-calls"
[ ! -f "$ARIGAMI_WA_MCP_DIR/fail" ] || exit 1
mkdir -p node_modules/.bin node_modules/qrcode
printf '#!/bin/sh\\n' > node_modules/.bin/tsx
chmod +x node_modules/.bin/tsx
touch node_modules/qrcode/package.json
`);
  const run = () => spawnSync('bash', [path.join(root, 'scripts/install-whatsapp.sh')], {
    env: { ...process.env, PATH: bin+':'+process.env.PATH, ARIGAMI_WA_MCP_DIR: wa }, encoding: 'utf8',
  });
  fs.writeFileSync(path.join(wa, 'fail'), '');
  expect(run().status).not.toBe(0);
  expect(fs.existsSync(path.join(wa, '.arigami-bridge-v2'))).toBe(false);
  fs.unlinkSync(path.join(wa, 'fail'));
  expect(run().status).toBe(0);
  const calls = fs.readFileSync(path.join(wa, 'npm-calls'), 'utf8');
  expect(run().status).toBe(0);
  expect(fs.readFileSync(path.join(wa, 'npm-calls'), 'utf8')).toBe(calls);
  expect(fs.readFileSync(path.join(wa, 'auth_info/creds.json'), 'utf8')).toBe('{"sentinel":"pairing"}');
  expect(fs.readFileSync(path.join(wa, 'data/whatsapp.db'), 'utf8')).toBe('message-data');
  const source = fs.readFileSync(path.join(wa, 'src/whatsapp.ts'), 'utf8');
  expect(source).toContain('await qrStatus(qr)');
  expect(source).not.toContain('await open(');
  expect(fs.readFileSync(path.join(wa, 'src/database.ts'), 'utf8')).toContain('WHATSAPP_MCP_DATA_DIR');
});
