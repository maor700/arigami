// Host-shared media metadata survives bridge restarts. Downloads are explicit;
// message bodies are never exposed in the MCP result. Credentials stay in DB.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { proto, normalizeMessageContent, downloadMediaMessage } from '@whiskeysockets/baileys';
import { z } from 'zod';
import { initializeDatabase } from './database.ts';
const data = process.env.WHATSAPP_MCP_DATA_DIR || path.join(import.meta.dirname, '..', 'data');
function db() {
  const db = initializeDatabase();
  db.exec('CREATE TABLE IF NOT EXISTS arigami_media (chat TEXT NOT NULL, id TEXT NOT NULL, message BLOB NOT NULL, PRIMARY KEY(chat,id))');
  return db;
}
export function rememberMedia(msg: any): string | null {
  const body = normalizeMessageContent(msg.message);
  const kind = ['image', 'video', 'audio', 'document', 'sticker'].find(k => body?.[`${k}Message`]);
  if (!kind || !msg.key?.remoteJid || !msg.key?.id) return null;
  db().prepare('INSERT OR REPLACE INTO arigami_media(chat,id,message) VALUES(?,?,?)')
    .run(msg.key.remoteJid, msg.key.id, Buffer.from(proto.WebMessageInfo.encode(msg).finish()));
  return `[${kind}] ${body[`${kind}Message`].caption || ''}`.trim();
}
export function registerMediaTool(server: any, sock: any, logger: any) {
  server.tool('download_media', {
    chat_jid: z.string().min(1), message_id: z.string().min(1),
  }, async ({ chat_jid, message_id }: { chat_jid: string; message_id: string }) => {
    let temporary: string | undefined;
    try {
      if (!sock) throw new Error('WhatsApp is not connected');
      const row = db().prepare('SELECT message FROM arigami_media WHERE chat=? AND id=?').get(chat_jid, message_id) as any;
      if (!row) throw new Error('Media metadata unavailable: only messages received or synced after media support was installed can be downloaded');
      const msg = proto.WebMessageInfo.decode(row.message);
      const body = normalizeMessageContent(msg.message);
      const kind = ['image', 'video', 'audio', 'document', 'sticker'].find(k => body?.[`${k}Message`]);
      const mime = kind ? body[`${kind}Message`]?.mimetype || 'application/octet-stream' : 'application/octet-stream';
      const extensions: Record<string, string> = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'video/mp4': '.mp4', 'audio/ogg': '.ogg', 'application/pdf': '.pdf' };
      const directory = path.join(data, 'media');
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const filename = createHash('sha256').update(JSON.stringify([chat_jid, message_id])).digest('hex') + (extensions[mime] || '.bin');
      const output = path.join(directory, filename);
      temporary = `${output}.${randomUUID()}.part`;
      const stream = await downloadMediaMessage(msg, 'stream', {}, { logger, reuploadRequest: sock.updateMediaMessage });
      let bytes = 0;
      const limit = new Transform({ transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        callback(bytes > 50 * 1024 * 1024 ? new Error('Media exceeds the 50 MiB download limit') : null, chunk);
      } });
      await pipeline(stream, limit, fs.createWriteStream(temporary, { mode: 0o600, flags: 'wx' }));
      fs.renameSync(temporary, output);
      temporary = undefined;
      return { content: [{ type: 'text', text: JSON.stringify({ path: output, mime_type: mime, bytes }) }] };
    } catch (error) {
      if (temporary) fs.rmSync(temporary, { force: true });
      return { isError: true, content: [{ type: 'text', text: (error as Error).message }] };
    }
  });
}
