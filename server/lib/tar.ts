// A streaming, dependency-free ustar/GNU-tar reader+writer, so backup.ts can
// stop shelling out to the system `tar` — which only exists in a GNU-flavored
// build on Linux. macOS ships BSD tar (libarchive) and Windows' tar.exe is
// bsdtar too; neither understands GNU's `--wildcards-match-slash` flags that
// backup.ts's exclude-glob semantics depend on.
//
// Everything here streams in both directions: CREATE reads each file with
// fs.createReadStream and yields it chunk-by-chunk into a gzip Transform;
// EXTRACT decompresses incrementally and writes each entry with bounded
// in-memory chunks, never materializing a whole file (let alone a whole
// multi-GB archive) in memory. See server/archive.js for a similar
// (non-streaming, in-memory) tar/zip reader — that one exists for small
// uploaded attachments with intentional zip-bomb caps; this one is for a
// trusted, potentially huge backup, so it has no such caps.
//
// Format: entries are written GNU-longname style (typeflag 'L'/'K' + the
// special "././@LongLink" name, exactly what GNU tar itself emits for a path
// or link target over 100 bytes) so a name of any length round-trips through
// real `tar`. The base header is plain POSIX ustar (magic "ustar\0", version
// "00") — GNU tar reads that natively. Numeric fields fall back to GNU
// base-256 encoding past ustar's ~8 GB octal-field ceiling.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { once } from 'node:events';

const BLOCK = 512;

// ---- exclude-glob matching ----------------------------------------------------
// Mirrors GNU tar's `--exclude=PATTERN` semantics as backup.ts's tarArgs() uses
// them: `*`/`?` either cross `/` or not (the --wildcards-match-slash toggle),
// and a pattern matches if it matches the WHOLE candidate name, OR a leading
// portion of it ending exactly at a `/` (GNU tar's FNM_LEADING_DIR) — which is
// what makes `--exclude=./run` prune the entire run/ subtree from one pattern.
// No `[...]` bracket-expression support: none of EXCLUDES/EXCLUDE_GLOBS/
// ROOT_EXCLUDE_GLOBS use one.

function escapeRegexChar(c: string): string {
  return /[.*+?^${}()|[\]\\]/.test(c) ? `\\${c}` : c;
}

export function globToRegex(pattern: string, slashCross: boolean): RegExp {
  let body = '';
  for (const c of pattern) {
    if (c === '*') body += slashCross ? '.*' : '[^/]*';
    else if (c === '?') body += slashCross ? '.' : '[^/]';
    else body += escapeRegexChar(c);
  }
  return new RegExp(`^(?:${body})(?:/|$)`);
}

export interface ExcludeSpec {
  pattern: string;
  /** whether `*`/`?` in this pattern may match `/` (GNU tar's --wildcards-match-slash) */
  slashCross: boolean;
}

export type ExcludeMatcher = (candidate: string) => boolean;

export function makeExcludeMatcher(specs: ExcludeSpec[]): ExcludeMatcher {
  const regexes = specs.map((s) => globToRegex(s.pattern, s.slashCross));
  return (candidate: string) => regexes.some((re) => re.test(candidate));
}

// ---- header (de)serialization --------------------------------------------------

function writeStr(buf: Buffer, offset: number, len: number, value: string): void {
  const b = Buffer.from(value, 'utf8');
  b.copy(buf, offset, 0, Math.min(b.length, len));
}

/** ustar numeric field: zero-padded octal + NUL, falling back to GNU base-256 past the octal field's capacity. */
function writeNumeric(buf: Buffer, offset: number, len: number, value: number | bigint): void {
  const v = BigInt(Math.trunc(Number(value)));
  const maxOctal = (1n << BigInt((len - 1) * 3)) - 1n;
  if (v >= 0n && v <= maxOctal) {
    writeStr(buf, offset, len, `${v.toString(8).padStart(len - 1, '0')}\0`);
    return;
  }
  let rem = v;
  for (let i = offset + len - 1; i >= offset + 1; i--) {
    buf[i] = Number(rem & 0xffn);
    rem >>= 8n;
  }
  buf[offset] = 0x80;
}

function readNumeric(buf: Buffer, offset: number, len: number): number {
  if (buf[offset] & 0x80) {
    let v = 0n;
    for (let i = 1; i < len; i++) v = (v << 8n) | BigInt(buf[offset + i]);
    return Number(v);
  }
  const s = buf.toString('latin1', offset, offset + len).replace(/\0.*$/, '').trim();
  return s ? parseInt(s, 8) || 0 : 0;
}

function computeChecksum(buf: Buffer): number {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : buf[i];
  return sum;
}

interface HeaderFields {
  name: string; // pre-truncated to <=100 bytes by the caller (long names go through a GNU longname entry)
  mode: number;
  size: number;
  mtime: number;
  typeflag: string;
  linkname?: string; // pre-truncated to <=100 bytes
}

function buildHeader(f: HeaderFields): Buffer {
  const buf = Buffer.alloc(BLOCK, 0);
  writeStr(buf, 0, 100, f.name);
  writeNumeric(buf, 100, 8, f.mode & 0o7777);
  writeNumeric(buf, 108, 8, 0); // uid
  writeNumeric(buf, 116, 8, 0); // gid
  writeNumeric(buf, 124, 12, f.size);
  writeNumeric(buf, 136, 12, f.mtime);
  buf.fill(0x20, 148, 156); // chksum placeholder while computing
  buf[156] = f.typeflag.charCodeAt(0);
  writeStr(buf, 157, 100, f.linkname || '');
  writeStr(buf, 257, 8, 'ustar\0' + '00');
  writeNumeric(buf, 329, 8, 0); // devmajor
  writeNumeric(buf, 337, 8, 0); // devminor
  writeStr(buf, 148, 8, `${computeChecksum(buf).toString(8).padStart(6, '0')}\0 `);
  return buf;
}

interface ParsedHeader {
  name: string;
  size: number;
  mode: number;
  mtime: number;
  typeflag: string;
  linkname: string;
}

function isZeroBlock(buf: Buffer): boolean {
  for (let i = 0; i < buf.length; i++) if (buf[i] !== 0) return false;
  return true;
}

function parseHeader(buf: Buffer): ParsedHeader {
  const nameField = buf.toString('utf8', 0, 100).replace(/\0.*$/, '');
  const mode = readNumeric(buf, 100, 8);
  const size = readNumeric(buf, 124, 12);
  const mtime = readNumeric(buf, 136, 12);
  let typeflag = String.fromCharCode(buf[156] || 0);
  if (typeflag === '\0' || typeflag === '') typeflag = '0';
  const linkname = buf.toString('utf8', 157, 257).replace(/\0.*$/, '');
  // GNU and POSIX ustar magics both put a "ustar"-prefixed 6 bytes at 257; the
  // POSIX prefix field (splitting long names) sits at 345 either way.
  const magic = buf.toString('latin1', 257, 263);
  const prefix = magic === 'ustar\0' || magic === 'ustar ' ? buf.toString('utf8', 345, 500).replace(/\0.*$/, '') : '';
  const name = prefix ? `${prefix}/${nameField}` : nameField;
  return { name, size, mode, mtime, typeflag, linkname };
}

// ---- CREATE ---------------------------------------------------------------------

export interface TarRoot {
  /** the `-C dir` this call's members are relative to */
  dir: string;
  /** member names, or '.' for the whole dir (only '.' gets a './'-prefixed archive name — matches GNU tar) */
  members: string[];
}

interface WalkEntry {
  abs: string;
  name: string; // archive-relative name, tar convention (see TarRoot)
  st: fs.Stats;
}

async function* walkDir(absDir: string, prefix: string, exclude?: ExcludeMatcher): AsyncGenerator<WalkEntry> {
  let names: string[];
  try {
    names = (await fsp.readdir(absDir)).sort();
  } catch {
    return; // vanished mid-walk — skip, mirrors tar's --ignore-failed-read
  }
  for (const n of names) {
    const abs = path.join(absDir, n);
    const tarName = prefix === './' ? `./${n}` : `${prefix}/${n}`;
    if (exclude?.(tarName)) continue;
    let st: fs.Stats;
    try {
      st = await fsp.lstat(abs);
    } catch {
      continue;
    }
    yield { abs, name: tarName, st };
    if (st.isDirectory() && !st.isSymbolicLink()) yield* walkDir(abs, tarName, exclude);
  }
}

async function* walkMember(baseDir: string, member: string, exclude?: ExcludeMatcher): AsyncGenerator<WalkEntry> {
  const isDot = member === '.';
  const abs = path.join(baseDir, member);
  const rootName = isDot ? './' : member;
  let st: fs.Stats;
  try {
    st = await fsp.lstat(abs);
  } catch {
    return; // missing top-level member — mirrors --ignore-failed-read
  }
  if (!isDot && exclude?.(rootName)) return;
  yield { abs, name: rootName, st };
  if (st.isDirectory() && !st.isSymbolicLink()) yield* walkDir(abs, rootName, exclude);
}

async function* longNameBlocks(typeflag: 'L' | 'K', value: string): AsyncGenerator<Buffer> {
  const data = Buffer.from(`${value}\0`, 'utf8');
  yield buildHeader({ name: '././@LongLink', mode: 0, size: data.length, mtime: 0, typeflag });
  yield data;
  const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
  if (pad) yield Buffer.alloc(pad);
}

async function* entryBlocks(entry: WalkEntry): AsyncGenerator<Buffer> {
  const { abs, st } = entry;
  const mode = st.mode & 0o7777;
  const mtime = Math.floor(st.mtimeMs / 1000);

  if (st.isSymbolicLink()) {
    const target = await fsp.readlink(abs);
    if (Buffer.byteLength(target, 'utf8') > 100) yield* longNameBlocks('K', target);
    let name = entry.name;
    if (Buffer.byteLength(name, 'utf8') > 100) { yield* longNameBlocks('L', name); name = name.slice(0, 100); }
    yield buildHeader({ name, mode, size: 0, mtime, typeflag: '2', linkname: target.length <= 100 ? target : '' });
    return;
  }

  if (st.isDirectory()) {
    let name = entry.name.endsWith('/') ? entry.name : `${entry.name}/`;
    if (Buffer.byteLength(name, 'utf8') > 100) { yield* longNameBlocks('L', name); name = name.slice(0, 100); }
    yield buildHeader({ name, mode, size: 0, mtime, typeflag: '5' });
    return;
  }

  if (!st.isFile()) return; // fifo/socket/device — not relevant under $ARIGAMI_DIR

  let name = entry.name;
  if (Buffer.byteLength(name, 'utf8') > 100) { yield* longNameBlocks('L', name); name = name.slice(0, 100); }
  yield buildHeader({ name, mode, size: st.size, mtime, typeflag: '0' });
  let written = 0;
  // Cap reads at the size recorded in the header (taken from the lstat above)
  // so a file that GROWS while we read it can't desync the archive; one that
  // SHRINKS gets zero-padded out to that size below — best-effort, same spirit
  // as tar's own "file changed as we read it" (exit code 1) tolerance.
  try {
    for await (const chunk of fs.createReadStream(abs, { end: st.size > 0 ? st.size - 1 : -1 })) {
      written += (chunk as Buffer).length;
      yield chunk as Buffer;
    }
  } catch {
    /* vanished mid-read — the size still committed to the header gets padded below */
  }
  if (written < st.size) yield Buffer.alloc(st.size - written);
  const pad = (BLOCK - (st.size % BLOCK)) % BLOCK;
  if (pad) yield Buffer.alloc(pad);
}

async function* tarBlocks(roots: TarRoot[], exclude?: ExcludeMatcher): AsyncGenerator<Buffer> {
  for (const root of roots) {
    for (const member of root.members) {
      for await (const entry of walkMember(root.dir, member, exclude)) {
        yield* entryBlocks(entry);
      }
    }
  }
  yield Buffer.alloc(BLOCK * 2); // end-of-archive marker
}

export interface CreateResult {
  stream: Readable;
  /** resolves 0 on a clean finish, 2 on a stream error (never rejects) */
  done: Promise<number>;
  kill: () => void;
}

export function createTarGzStream(roots: TarRoot[], opts: { exclude?: ExcludeMatcher } = {}): CreateResult {
  const raw = Readable.from(tarBlocks(roots, opts.exclude));
  const gz = zlib.createGzip();
  const done = pipeline(raw, gz).then(
    () => 0,
    () => 2
  );
  return {
    stream: gz,
    done,
    kill: () => {
      try { raw.destroy(); } catch {}
      try { gz.destroy(); } catch {}
    },
  };
}

// ---- streaming reader (shared by list / single-file-extract / full-extract) ----

class ByteReader {
  private it: AsyncIterator<Buffer>;
  private buf: Buffer = Buffer.alloc(0);
  private ended = false;
  constructor(source: AsyncIterable<Buffer>) {
    this.it = source[Symbol.asyncIterator]();
  }
  private async fill(): Promise<boolean> {
    if (this.ended) return false;
    const { value, done } = await this.it.next();
    if (done) { this.ended = true; return false; }
    this.buf = this.buf.length ? Buffer.concat([this.buf, value]) : value;
    return true;
  }
  /** Up to maxN bytes; blocks for at most one underlying chunk once it has any buffered. Empty only at true EOF. */
  async readSome(maxN: number): Promise<Buffer> {
    if (this.buf.length === 0 && !(await this.fill())) return Buffer.alloc(0);
    const take = Math.min(maxN, this.buf.length);
    const out = this.buf.subarray(0, take);
    this.buf = this.buf.subarray(take);
    return out;
  }
  /** Exactly n bytes; only used for small fixed-size reads (512-byte headers). */
  async readExact(n: number): Promise<Buffer> {
    while (this.buf.length < n) if (!(await this.fill())) break;
    if (this.buf.length < n) throw new Error('unexpected end of archive');
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }
}

class TarStreamReader {
  private reader: ByteReader;
  private remaining = 0;
  private size = 0;
  constructor(source: AsyncIterable<Buffer>) {
    this.reader = new ByteReader(source);
  }

  /** Advance past any unread content + padding of the CURRENT entry, so next() can read the next header. */
  async finishEntry(): Promise<void> {
    while (this.remaining > 0) await this.readChunk();
    const pad = (BLOCK - (this.size % BLOCK)) % BLOCK;
    if (pad) await this.reader.readExact(pad);
  }

  /** Up to maxN bytes of the current entry's content. Empty once content is exhausted. */
  async readChunk(maxN = 1024 * 1024): Promise<Buffer> {
    if (this.remaining <= 0) return Buffer.alloc(0);
    const chunk = await this.reader.readSome(Math.min(maxN, this.remaining));
    if (chunk.length === 0) throw new Error('unexpected end of archive (truncated entry)');
    this.remaining -= chunk.length;
    return chunk;
  }

  private async readAllContent(size: number): Promise<Buffer> {
    const parts: Buffer[] = [];
    let remaining = size;
    while (remaining > 0) {
      const chunk = await this.reader.readSome(remaining);
      if (chunk.length === 0) throw new Error('unexpected end of archive');
      parts.push(chunk);
      remaining -= chunk.length;
    }
    const pad = (BLOCK - (size % BLOCK)) % BLOCK;
    if (pad) await this.reader.readExact(pad);
    return Buffer.concat(parts);
  }

  /** Next real entry (GNU longname/longlink pseudo-entries are resolved transparently). null at end-of-archive. */
  async next(): Promise<ParsedHeader | null> {
    let longName: string | null = null;
    let longLink: string | null = null;
    for (;;) {
      const block = await this.reader.readExact(BLOCK);
      if (isZeroBlock(block)) return null;
      const h = parseHeader(block);
      if (h.typeflag === 'L') { longName = (await this.readAllContent(h.size)).toString('utf8').replace(/\0.*$/, ''); continue; }
      if (h.typeflag === 'K') { longLink = (await this.readAllContent(h.size)).toString('utf8').replace(/\0.*$/, ''); continue; }
      if (longName) h.name = longName;
      if (longLink) h.linkname = longLink;
      this.size = h.size;
      this.remaining = h.size;
      return h;
    }
  }
}

function gunzipSource(file: string): AsyncIterable<Buffer> {
  const rs = fs.createReadStream(file);
  const gz = zlib.createGunzip();
  rs.on('error', (e) => gz.destroy(e));
  rs.pipe(gz);
  return gz;
}

// ---- LIST -------------------------------------------------------------------

export async function listTarGz(file: string): Promise<string[]> {
  const tr = new TarStreamReader(gunzipSource(file));
  const names: string[] = [];
  for (;;) {
    const h = await tr.next();
    if (!h) break;
    names.push(h.name);
    await tr.finishEntry();
  }
  return names;
}

// ---- single-file extract to a Buffer (the manifest read) --------------------

export async function extractFileFromTarGz(file: string, name: string): Promise<Buffer | null> {
  const target = name.replace(/^\.\//, '');
  const tr = new TarStreamReader(gunzipSource(file));
  for (;;) {
    const h = await tr.next();
    if (!h) return null;
    if (h.name.replace(/^\.\//, '') === target && h.typeflag !== '5') {
      const parts: Buffer[] = [];
      for (;;) {
        const c = await tr.readChunk();
        if (!c.length) break;
        parts.push(c);
      }
      await tr.finishEntry();
      return Buffer.concat(parts);
    }
    await tr.finishEntry();
  }
}

// ---- full extract to a directory ---------------------------------------------
// Hardening (the extractor is our responsibility to get right):
//  - absolute paths, `..` segments, NUL bytes → the archive is rejected outright
//    (an all-or-nothing import already expects a hard failure — see backup.ts's
//    assertSafeEntries, which gates every full-extract caller before this runs).
//  - symlinks: the target is resolved against its own directory and must stay
//    inside destDir, or the entry is skipped (not extracted, not fatal).
//  - hardlinks: same containment check, applied to the archive-internal
//    linkname; if the link's source hasn't been extracted (or was skipped),
//    the entry is skipped rather than failing the whole restore.

function isUnsafeEntryName(raw: string): boolean {
  if (!raw || raw.includes('\0')) return true;
  if (path.posix.isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith('/')) return true;
  const n = raw.replace(/\/+$/, '').replace(/^(\.\/)+/, '');
  return n.split('/').includes('..');
}

function safeRelPath(raw: string): string {
  return raw.replace(/\/+$/, '').replace(/^(\.\/)+/, '');
}

function withinDir(destDir: string, candidate: string): boolean {
  const rel = path.relative(destDir, candidate);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

export interface ExtractOptions {
  exclude?: ExcludeMatcher;
}

export interface ExtractResult {
  entries: number;
}

export async function extractTarGzToDir(file: string, destDir: string, opts: ExtractOptions = {}): Promise<ExtractResult> {
  await fsp.mkdir(destDir, { recursive: true });
  const tr = new TarStreamReader(gunzipSource(file));
  let count = 0;
  for (;;) {
    const h = await tr.next();
    if (!h) break;
    if (isUnsafeEntryName(h.name)) throw new Error(`archive contains an unsafe path: ${h.name}`);
    const safe = safeRelPath(h.name);
    if (!safe) { await tr.finishEntry(); continue; }
    // Matched literally against the name as STORED in the archive — same as
    // real tar at extract time, which does not normalize a missing './'
    // prefix (verified: `tar -x --exclude=./run` leaves a bare "run/x" entry
    // alone). Our own writer always stores dot-prefixed names, so this only
    // matters for a hand-built or foreign archive.
    if (opts.exclude?.(h.name.replace(/\/$/, ''))) { await tr.finishEntry(); continue; }
    const destPath = path.join(destDir, safe);

    if (h.typeflag === '5' || h.name.endsWith('/')) {
      await fsp.mkdir(destPath, { recursive: true });
      await tr.finishEntry();
      count++;
      continue;
    }

    if (h.typeflag === '2') {
      const resolved = path.resolve(path.dirname(destPath), h.linkname);
      if (!h.linkname || path.isAbsolute(h.linkname) || !withinDir(destDir, resolved)) { await tr.finishEntry(); continue; }
      await fsp.mkdir(path.dirname(destPath), { recursive: true });
      await fsp.rm(destPath, { force: true });
      await fsp.symlink(h.linkname, destPath);
      await tr.finishEntry();
      count++;
      continue;
    }

    if (h.typeflag === '1') {
      if (isUnsafeEntryName(h.linkname)) { await tr.finishEntry(); continue; }
      const linkSrc = path.join(destDir, safeRelPath(h.linkname));
      await fsp.mkdir(path.dirname(destPath), { recursive: true });
      try {
        await fsp.rm(destPath, { force: true });
        await fsp.link(linkSrc, destPath);
      } catch {
        /* source not (yet) extracted — skip, non-fatal */
      }
      await tr.finishEntry();
      count++;
      continue;
    }

    if (h.typeflag !== '0') { await tr.finishEntry(); continue; } // fifo/device/etc — skip

    await fsp.mkdir(path.dirname(destPath), { recursive: true });
    const ws = fs.createWriteStream(destPath, { mode: h.mode || 0o644 });
    for (;;) {
      const chunk = await tr.readChunk();
      if (!chunk.length) break;
      if (!ws.write(chunk)) await once(ws, 'drain');
    }
    ws.end();
    await once(ws, 'finish');
    await tr.finishEntry();
    count++;
  }
  return { entries: count };
}
