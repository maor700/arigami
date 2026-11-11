// RESUME — gzip/br for the host's own responses. The host is reached straight
// over loopback, through `tailscale serve`, the SW proxy and the desktop shell;
// all of them pass Content-Encoding through untouched, and a caller that does not
// send Accept-Encoding (node's http.get, curl without --compressed, host-internal
// fetches with their own header) keeps getting identity bytes. Every compressed
// (or compressible) response says `Vary: Accept-Encoding` so no cache in between
// hands a gzip body to a client that never asked for one.
import zlib from 'node:zlib';

export type Encoding = 'br' | 'gzip' | null;

/** Below this a compressed body is not worth the CPU and the header bytes. */
export const COMPRESS_MIN = 1400;

/** br > gzip > nothing, honouring q=0 ("not acceptable"). */
export function pickEncoding(accept: string | string[] | undefined): Encoding {
  const raw = Array.isArray(accept) ? accept.join(',') : accept || '';
  const ok: Record<string, boolean> = {};
  for (const part of raw.toLowerCase().split(',')) {
    const [name, ...params] = part.trim().split(';');
    if (!name) continue;
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    ok[name.trim()] = !(q && Number(q.slice(2)) === 0);
  }
  if (ok.br) return 'br';
  if (ok.gzip) return 'gzip';
  if (ok['*']) return 'gzip';
  return null;
}

export function compress(body: string | Buffer, enc: Encoding, level: 'fast' | 'max' = 'fast'): Buffer | null {
  if (!enc) return null;
  const buf = typeof body === 'string' ? Buffer.from(body) : body;
  if (enc === 'br')
    return zlib.brotliCompressSync(buf, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: level === 'max' ? 9 : 4,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length,
      },
    });
  return zlib.gzipSync(buf, { level: level === 'max' ? 9 : 6 });
}

/** MIME types worth compressing (images/fonts/wasm are already packed). */
export function compressibleType(type: string | undefined): boolean {
  return !!type && /^(text\/|application\/(json|javascript|xml|manifest\+json)|image\/svg\+xml)/i.test(type);
}
