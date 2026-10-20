import fs from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';
const data = process.env.WHATSAPP_MCP_DATA_DIR || path.join(import.meta.dirname, '..', 'data');
export function bridgeStatus(status: string, extra: Record<string, unknown> = {}) {
  fs.mkdirSync(data, { recursive: true });
  const file = path.join(data, 'bridge-status.json');
  fs.writeFileSync(`${file}.tmp`, JSON.stringify({ status, pid: process.pid, ts: Date.now(), qrUrl: null, user: null, ...extra }), { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}
export async function qrStatus(qr: string) {
  bridgeStatus('qr', { qrUrl: await QRCode.toDataURL(qr) });
}
