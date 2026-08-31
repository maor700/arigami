// ZIP: uploading an archive attachment used to leave the model with one opaque
// path — it had to Read (or Bash-unzip) the blob itself before it could see
// what was inside. This extracts .zip / .tar / .tar.gz / .tgz server-side into
// a sibling `<file>.d/` dir and returns a manifest the caller can turn into a
// short tree for the model, without trusting the archive any further than a
// hardened extractor should: no path traversal, no symlinks, no zip bombs.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

// ---- bomb-guard constants (exported so tests exercise the real limits) --------
export const MAX_TOTAL_UNCOMPRESSED = 200 * 1024 * 1024; // 200MB combined, whole archive
export const MAX_ENTRIES = 2000; // stop walking after this many entries
export const MAX_ENTRY_UNCOMPRESSED = 100 * 1024 * 1024; // single-entry cap (< total, still worth naming separately)
export const MAX_COMPRESSION_RATIO = 100; // uncompressed/compressed beyond this looks like a bomb

/** Magic-byte sniff — never trust the extension alone. */
export function detectArchiveKind(buf) {
  if (!buf || buf.length < 4) return null;
  if (buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07)) return 'zip';
  if (buf[0] === 0x1f && buf[1] === 0x8b) return 'targz';
  // tar has no magic at offset 0 — the ustar magic ("ustar") sits at byte 257.
  // A plain (pre-POSIX) tar has no magic at all, so also accept a header whose
  // checksum field is internally consistent, but keep it to the common case.
  if (buf.length > 262) {
    const magic = buf.slice(257, 263).toString('latin1');
    if (magic === 'ustar\0' || magic === 'ustar ') return 'tar';
  }
  return null;
}

function rejectReason(code, detail) {
  return { code, detail };
}

/** Normalizes a `/`- or `\`-separated archive entry name and rejects anything unsafe. */
function safeRelPath(rawName) {
  if (!rawName) return null;
  if (rawName.includes('\0')) return null;
  let name = rawName.replace(/\\/g, '/');
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) return null; // absolute (posix or windows drive)
  const norm = path.posix.normalize(name);
  if (norm === '..' || norm.startsWith('../') || norm.startsWith('/')) return null;
  return norm;
}

class Manifest {
  constructor(kind) {
    this.kind = kind;
    this.entries = []; // { name, size, dir }
    this.rejected = []; // { name, reason }
    this.totalSize = 0;
    this.entryCount = 0;
    this.truncated = false; // hit MAX_ENTRIES or MAX_TOTAL_UNCOMPRESSED mid-walk
  }
  reject(name, reason) {
    if (this.rejected.length < 200) this.rejected.push({ name, reason: reason.code, detail: reason.detail });
  }
  accept(name, size, isDir) {
    this.entryCount += 1;
    this.totalSize += size;
    if (this.entries.length < 5000) this.entries.push({ name, size, dir: isDir });
  }
}

function writeEntryFile(destDir, relPath, data) {
  const full = path.join(destDir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, data);
}

// ---- ZIP --------------------------------------------------------------------
// Central-directory driven: the EOCD record is authoritative for entry count
// and offsets, so a crafted local header can't smuggle in extra files the
// directory doesn't know about.
const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;
const S_IFLNK = 0xa000;

function findEOCD(buf) {
  const maxCommentLen = 65535;
  const minPos = Math.max(0, buf.length - 22 - maxCommentLen);
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

function extractZip(buf, destDir, manifest) {
  const eocd = findEOCD(buf);
  if (eocd < 0) throw new Error('not a valid zip (no end-of-central-directory record)');
  let cdOffset = buf.readUInt32LE(eocd + 16);
  let cdEntries = buf.readUInt16LE(eocd + 10);
  // ZIP64 EOCD locator, if present, overrides the 32-bit fields above.
  if (cdOffset === 0xffffffff || cdEntries === 0xffff) {
    const locSig = 0x07064b50;
    const locOff = eocd - 20;
    if (locOff >= 0 && buf.readUInt32LE(locOff) === locSig) {
      const z64Off = Number(buf.readBigUInt64LE(locOff + 8));
      if (buf.readUInt32LE(z64Off) === 0x06064b50) {
        cdEntries = Number(buf.readBigUInt64LE(z64Off + 32));
        cdOffset = Number(buf.readBigUInt64LE(z64Off + 48));
      }
    }
  }
  let p = cdOffset;
  for (let i = 0; i < cdEntries; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN_SIG) break;
    if (manifest.entryCount + manifest.rejected.length >= MAX_ENTRIES) { manifest.truncated = true; break; }
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    let compSize = buf.readUInt32LE(p + 20);
    let uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const externalAttrs = buf.readUInt32LE(p + 38);
    let localOffset = buf.readUInt32LE(p + 42);
    const nameBuf = buf.slice(p + 46, p + 46 + nameLen);
    const rawName = (flags & 0x800) ? nameBuf.toString('utf8') : nameBuf.toString('latin1');
    const extra = buf.slice(p + 46 + nameLen, p + 46 + nameLen + extraLen);
    // ZIP64 extra field (0x0001) overrides 0xffffffff-marked sizes/offset.
    if (uncompSize === 0xffffffff || compSize === 0xffffffff || localOffset === 0xffffffff) {
      let ep = 0;
      while (ep + 4 <= extra.length) {
        const id = extra.readUInt16LE(ep);
        const len = extra.readUInt16LE(ep + 2);
        if (id === 0x0001) {
          let fp = ep + 4;
          if (uncompSize === 0xffffffff && fp + 8 <= extra.length) { uncompSize = Number(extra.readBigUInt64LE(fp)); fp += 8; }
          if (compSize === 0xffffffff && fp + 8 <= extra.length) { compSize = Number(extra.readBigUInt64LE(fp)); fp += 8; }
          if (localOffset === 0xffffffff && fp + 8 <= extra.length) { localOffset = Number(extra.readBigUInt64LE(fp)); fp += 8; }
        }
        ep += 4 + len;
      }
    }
    p += 46 + nameLen + extraLen + commentLen;

    const isDir = rawName.endsWith('/');
    const unixMode = externalAttrs >>> 16;
    const isSymlink = unixMode !== 0 && (unixMode & 0xf000) === S_IFLNK;
    const safe = safeRelPath(rawName);
    if (!safe) { manifest.reject(rawName || '(empty)', rejectReason('traversal', 'path escapes the archive root')); continue; }
    if (isSymlink) { manifest.reject(rawName, rejectReason('symlink', 'symlinks are not extracted')); continue; }
    if (isDir) {
      fs.mkdirSync(path.join(destDir, safe), { recursive: true });
      manifest.accept(safe, 0, true);
      continue;
    }
    if ((flags & 0x1) !== 0) { manifest.reject(rawName, rejectReason('encrypted', 'password-protected entries are skipped')); continue; }
    if (uncompSize > MAX_ENTRY_UNCOMPRESSED) { manifest.reject(rawName, rejectReason('entry-too-large', `${uncompSize} bytes exceeds the per-entry cap`)); continue; }
    if (compSize > 0 && uncompSize / compSize > MAX_COMPRESSION_RATIO) { manifest.reject(rawName, rejectReason('bomb-ratio', `compression ratio ${Math.round(uncompSize / compSize)}:1 exceeds the cap`)); continue; }
    if (manifest.totalSize + uncompSize > MAX_TOTAL_UNCOMPRESSED) { manifest.truncated = true; manifest.reject(rawName, rejectReason('total-cap', 'would exceed the total uncompressed-size cap')); continue; }
    if (method !== 0 && method !== 8) { manifest.reject(rawName, rejectReason('unsupported-method', `compression method ${method} is not supported`)); continue; }

    // Now read the local header to find where the actual file data starts —
    // sizes/method are still taken from the CENTRAL directory, never local.
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== LOC_SIG) { manifest.reject(rawName, rejectReason('corrupt', 'local header mismatch')); continue; }
    const locNameLen = buf.readUInt16LE(localOffset + 26);
    const locExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + locNameLen + locExtraLen;
    if (dataStart + compSize > buf.length) { manifest.reject(rawName, rejectReason('corrupt', 'entry data runs past end of file')); continue; }
    const compData = buf.slice(dataStart, dataStart + compSize);
    let data;
    try {
      data = method === 0 ? compData : zlib.inflateRawSync(compData, { maxOutputLength: MAX_ENTRY_UNCOMPRESSED });
    } catch (e) {
      manifest.reject(rawName, rejectReason('bomb-ratio', `decompression exceeded the per-entry cap (${e.code || e.message})`));
      continue;
    }
    if (data.length !== uncompSize) { manifest.reject(rawName, rejectReason('corrupt', 'decompressed size does not match the central directory')); continue; }
    writeEntryFile(destDir, safe, data);
    manifest.accept(safe, data.length, false);
  }
  return manifest;
}

// ---- TAR / TAR.GZ ------------------------------------------------------------
function octal(buf) {
  const s = buf.toString('latin1').replace(/\0.*$/, '').trim();
  return s ? parseInt(s, 8) || 0 : 0;
}

function extractTar(buf, destDir, manifest) {
  let offset = 0;
  let longName = null;
  while (offset + 512 <= buf.length) {
    const block = buf.slice(offset, offset + 512);
    if (block.every((b) => b === 0)) break; // end-of-archive marker
    const nameField = block.slice(0, 100).toString('latin1').replace(/\0.*$/, '');
    const size = octal(block.slice(124, 136));
    const typeflag = String.fromCharCode(block[156] || 0);
    const prefix = block.slice(345, 500).toString('latin1').replace(/\0.*$/, '');
    const dataStart = offset + 512;
    const paddedSize = Math.ceil(size / 512) * 512;
    offset = dataStart + paddedSize;

    if (typeflag === 'L') { // GNU long-name: next block(s) hold the real name
      longName = size <= 4096 ? buf.slice(dataStart, dataStart + size).toString('latin1').replace(/\0.*$/, '') : null;
      continue;
    }
    const rawName = longName || (prefix ? `${prefix}/${nameField}` : nameField);
    longName = null;
    if (!rawName) continue;

    if (manifest.entryCount + manifest.rejected.length >= MAX_ENTRIES) { manifest.truncated = true; break; }
    const safe = safeRelPath(rawName);
    if (!safe) { manifest.reject(rawName, rejectReason('traversal', 'path escapes the archive root')); continue; }
    if (typeflag === '5') { fs.mkdirSync(path.join(destDir, safe), { recursive: true }); manifest.accept(safe, 0, true); continue; }
    if (typeflag === '2' || typeflag === '1') { manifest.reject(rawName, rejectReason('symlink', 'links are not extracted')); continue; }
    if (typeflag !== '0' && typeflag !== '\0' && typeflag !== '') { manifest.reject(rawName, rejectReason('unsupported-type', `tar type '${typeflag}' is not a regular file`)); continue; }
    if (size > MAX_ENTRY_UNCOMPRESSED) { manifest.reject(rawName, rejectReason('entry-too-large', `${size} bytes exceeds the per-entry cap`)); continue; }
    if (manifest.totalSize + size > MAX_TOTAL_UNCOMPRESSED) { manifest.truncated = true; manifest.reject(rawName, rejectReason('total-cap', 'would exceed the total uncompressed-size cap')); continue; }
    if (dataStart + size > buf.length) { manifest.reject(rawName, rejectReason('corrupt', 'entry data runs past end of file')); continue; }
    writeEntryFile(destDir, safe, buf.slice(dataStart, dataStart + size));
    manifest.accept(safe, size, false);
  }
  return manifest;
}

/**
 * Extracts a zip/tar/tar.gz buffer into destDir (created if needed). Returns a
 * manifest describing what was written and what was skipped, never throwing on
 * a hostile entry — only on a structurally unreadable archive (caller decides
 * whether to keep the raw file when that happens).
 */
export function extractArchive(buf, destDir, kind = detectArchiveKind(buf)) {
  if (!kind) throw new Error('not a recognized archive');
  fs.mkdirSync(destDir, { recursive: true });
  const manifest = new Manifest(kind);
  if (kind === 'zip') return extractZip(buf, destDir, manifest);
  if (kind === 'tar') return extractTar(buf, destDir, manifest);
  if (kind === 'targz') {
    let tarBuf;
    try {
      tarBuf = zlib.gunzipSync(buf, { maxOutputLength: MAX_TOTAL_UNCOMPRESSED });
    } catch (e) {
      throw new Error(`gzip decompression failed or exceeded the ${MAX_TOTAL_UNCOMPRESSED}-byte cap (${e.code || e.message})`);
    }
    return extractTar(tarBuf, destDir, manifest);
  }
  throw new Error(`unknown archive kind: ${kind}`);
}

/** A short tree for the model: first `limit` entries (dirs and files, in archive order), then "+N more". */
export function formatTree(manifest, limit = 40) {
  const lines = [];
  const shown = manifest.entries.slice(0, limit);
  for (const e of shown) lines.push(e.dir ? `${e.name}/` : e.name);
  const more = manifest.entryCount - shown.length;
  if (more > 0) lines.push(`+${more} more`);
  return lines;
}
