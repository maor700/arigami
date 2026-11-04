// Incoming voice notes → text (Groq Whisper), stored as "[Audio] <transcript>".
// No key → the row stays "[Audio]". Bounded (size, time), serial, never throws.
import { normalizeMessageContent, downloadMediaMessage } from '@whiskeysockets/baileys';
import { initializeDatabase } from './database.ts';

const MAX_BYTES = 25 * 1024 * 1024; // Groq's upload limit
const TIMEOUT_MS = Math.max(1000, Number(process.env.ARIGAMI_STT_TIMEOUT_MS) || 90_000);
const GROQ = 'https://api.groq.com/openai/v1/audio/transcriptions';

export interface Transcriber {
  (audio: Buffer, mime: string, language: string): Promise<string>;
}

const apiKey = () => process.env.GROQ_API_KEY || '';
const language = () => (/^[a-z]{2,3}$/.test(process.env.ARIGAMI_VOICE_LANG || '') ? (process.env.ARIGAMI_VOICE_LANG as string) : 'he');

/** Whisper via Groq; the caller bounds the time with `signal`. */
export async function groqTranscribe(audio: Buffer, mime: string, lang: string, signal?: AbortSignal): Promise<string> {
  const base = (mime || 'audio/ogg').split(';')[0].trim();
  const ext = base.includes('mp4') || base.includes('m4a') ? 'm4a' : base.includes('mpeg') || base.includes('mp3') ? 'mp3' : base.includes('wav') ? 'wav' : base.includes('webm') ? 'webm' : 'ogg';
  const form = new FormData();
  form.append('file', new Blob([audio], { type: base }), `note.${ext}`);
  form.append('model', process.env.ARIGAMI_STT_MODEL || 'whisper-large-v3-turbo');
  form.append('language', lang);
  form.append('response_format', 'json');
  form.append('temperature', '0');
  const r = await fetch(GROQ, { method: 'POST', headers: { Authorization: `Bearer ${apiKey()}` }, body: form, signal });
  if (!r.ok) throw new Error(`groq stt ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return String(((await r.json()) as any).text || '').trim();
}

async function readCapped(stream: AsyncIterable<Buffer | Uint8Array>, signal: AbortSignal): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stream) {
    if (signal.aborted) throw new Error('timed out');
    bytes += chunk.length;
    if (bytes > MAX_BYTES) throw new Error(`voice note exceeds ${MAX_BYTES} bytes`);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

let queue: Promise<void> = Promise.resolve();
/** Resolves once every queued transcription has settled (tests). */
export const drain = (): Promise<void> => queue;

/** Fire-and-forget: queue the note, update its row when the text arrives. */
export function transcribeAudio(msg: any, sock: any, logger: any, transcriber?: Transcriber): void {
  const body = normalizeMessageContent(msg?.message);
  const audio = body?.audioMessage;
  if (!audio || msg?.key?.fromMe || !msg?.key?.remoteJid || !msg?.key?.id) return;
  if (!transcriber && !apiKey()) return;
  const declared = Number(audio.fileLength?.toNumber?.() ?? audio.fileLength ?? 0);
  if (declared > MAX_BYTES) { logger?.warn?.({ msgId: msg.key.id, bytes: declared }, 'voice note too large to transcribe'); return; }
  const { remoteJid, id } = msg.key;
  queue = queue.then(async () => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    const timeout = new Promise<never>((_, reject) => ctl.signal.addEventListener('abort', () => reject(new Error('timed out'))));
    try {
      const work = (async () => {
        const stream = await downloadMediaMessage(msg, 'stream', {}, { logger, reuploadRequest: sock?.updateMediaMessage });
        const buf = await readCapped(stream as any, ctl.signal);
        const mime = String(audio.mimetype || 'audio/ogg');
        return transcriber ? transcriber(buf, mime, language()) : groqTranscribe(buf, mime, language(), ctl.signal);
      })();
      work.catch(() => {}); // a late failure after the timeout won is not unhandled
      const text = await Promise.race([timeout, work]);
      if (!text) return;
      initializeDatabase().prepare('UPDATE messages SET content = ? WHERE id = ? AND chat_jid = ?').run(`[Audio] ${text}`, id, remoteJid);
      logger?.info?.({ msgId: id, chatId: remoteJid, chars: text.length }, 'voice note transcribed');
    } catch (e) {
      logger?.warn?.({ msgId: id, err: (e as Error).message }, 'voice note not transcribed');
    } finally {
      clearTimeout(timer);
    }
  });
}
