// ZIP: uploading an archive attachment used to leave the model with one opaque
// path — it had to Read (or Bash-unzip) the blob itself before it could see
// what was inside. This extracts .zip / .tar / .tar.gz / .tgz server-side into
// a sibling `<file>.d/` dir and returns a manifest the caller can turn into a
// short tree for the model, without trusting the archive any further than a
// hardened extractor should: no path traversal, no symlinks, no zip bombs.
//
// ZIP3: the extractor above was written and tested against Unix-style zips
// only. A Windows-produced zip (Explorer's built-in zip, most enterprise
// tools) is exclusively backslash-separated and never contains a single '/'
// — that broke directory detection (a dir entry "a\b\" doesn't end in '/')
// and let path names carry a literal trailing backslash into the filesystem,
// which then collided with a later entry that legitimately needed the same
// name as a directory (`EISDIR`). Everything below path normalization,
// encoding, and per-entry fault isolation exists to make extraction OS-
// agnostic and to make a partial extraction impossible to mistake for a
// complete one.
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

// ---- entry-name normalization ------------------------------------------------
// One rule set for every archive kind: accept '\' and '/' as separators,
// strip a Windows drive prefix, strip a leading '/' or './', collapse
// repeated separators, and normalize Unicode to NFC (macOS zips store
// decomposed NFD, so a Hebrew name from a Mac and the same name typed
// elsewhere must land on the same path instead of two look-alike files).
//
// Trade-off: treating '\' as a separator means the rare *legitimate* Unix
// filename that contains a literal backslash gets split into an extra path
// segment instead of staying one file — e.g. "a\b.txt" lands at "a/b.txt".
// That matches what mainstream unzip/7-Zip/Explorer already do with the same
// ambiguity, and the alternative (backslash as an ordinary character) is what
// caused this bug: every Windows-authored zip is 100% backslash-separated,
// so treating '\' literally silently breaks the overwhelming common case to
// protect a nearly nonexistent one. We chose to break the rare case, not the
// common one.
const WIN_DRIVE_RE = /^[A-Za-z]:/;

/**
 * Normalizes a raw archive entry name. Returns `{ path, dirMarker }` where
 * `path` never carries a trailing separator (directory-ness is a separate
 * boolean, so callers never re-derive it from string shape and never risk
 * emitting a doubled trailing slash), or `null` if the name is unsafe
 * (traversal, absolute, empty after stripping).
 */
function normalizeEntryName(rawName) {
  if (!rawName) return null;
  if (rawName.includes('\0')) return null;
  let name = rawName.replace(/\\/g, '/');
  const hadDrivePrefix = WIN_DRIVE_RE.test(name);
  if (hadDrivePrefix) {
    name = name.replace(WIN_DRIVE_RE, ''); // "C:foo" / "C:\foo" (backslash already converted above)
  } else if (name.startsWith('/')) {
    // A genuine POSIX-style absolute path with no drive letter in sight —
    // reject outright rather than rebasing it into destDir, same as before.
    return null;
  }
  name = name.replace(/^(\.\/)+/, ''); // tar's "./foo" convention — just noise, strip it
  if (hadDrivePrefix) name = name.replace(/^\/+/, ''); // "C:\foo" → "/foo" (post-strip) → "foo"
  if (name.startsWith('/')) return null; // still absolute after stripping — reject
  name = name.replace(/\/{2,}/g, '/'); // collapse "a//b" → "a/b"
  name = name.normalize('NFC');
  if (!name) return null;
  const dirMarker = name.endsWith('/');
  const trimmed = dirMarker ? name.slice(0, -1) : name;
  if (!trimmed) return null;
  const norm = path.posix.normalize(trimmed);
  if (norm === '.' || norm === '..' || norm.startsWith('../') || norm.startsWith('/')) return null;
  return { path: norm, dirMarker };
}

// ---- legacy (non-UTF-8) name decoding -----------------------------------------
// The zip general-purpose flag bit 11 marks a UTF-8 name; when it's unset the
// spec leaves the codepage to the tool that wrote the archive. The obvious
// "CP437 fallback" is the wrong one for the failure this exists to fix: CP437
// is the US-English DOS OEM codepage and has no Hebrew code points at all, so
// decoding with it can never recover a Hebrew filename — it would just trade
// one kind of mojibake for another. We use CP862 (MS-DOS/Windows Hebrew OEM
// codepage) instead, which is what Hebrew-locale Windows zip tools actually
// write when they skip the UTF-8 flag. ASCII (0x00–0x7F) is identical either
// way, so this is a strict improvement, not a regression for Latin names.
const CP862_HIGH =
  '\u05d0\u05d1\u05d2\u05d3\u05d4\u05d5\u05d6\u05d7\u05d8\u05d9\u05da\u05db\u05dc\u05dd\u05de\u05df' +
  '\u05e0\u05e1\u05e2\u05e3\u05e4\u05e5\u05e6\u05e7\u05e8\u05e9\u05ea\u00a2\u00a3\u00a5\u20a7\u0192' +
  '\u00e1\u00ed\u00f3\u00fa\u00f1\u00d1\u00aa\u00ba\u00bf\u2310\u00ac\u00bd\u00bc\u00a1\u00ab\u00bb' +
  '\u2591\u2592\u2593\u2502\u2524\u2561\u2562\u2556\u2555\u2563\u2551\u2557\u255d\u255c\u255b\u2510' +
  '\u2514\u2534\u252c\u251c\u2500\u253c\u255e\u255f\u255a\u2554\u2569\u2566\u2560\u2550\u256c\u2567' +
  '\u2568\u2564\u2565\u2559\u2558\u2552\u2553\u256b\u256a\u2518\u250c\u2588\u2584\u258c\u2590\u2580' +
  '\u03b1\u00df\u0393\u03c0\u03a3\u03c3\u00b5\u03c4\u03a6\u0398\u03a9\u03b4\u221e\u03c6\u03b5\u2229' +
  '\u2261\u00b1\u2265\u2264\u2320\u2321\u00f7\u2248\u00b0\u2219\u00b7\u221a\u207f\u00b2\u25a0\u00a0';

function decodeLegacyName(buf) {
  let out = '';
  for (const b of buf) out += b < 0x80 ? String.fromCharCode(b) : CP862_HIGH[b - 0x80];
  return out;
}

class Manifest {
  constructor(kind) {
    this.kind = kind;
    this.entries = []; // { name, size, dir }
    this.rejected = []; // { name, reason } — capped at 200 for display; see rejectedTotal for the real count
    this.rejectedTotal = 0;
    this.totalSize = 0;
    this.entryCount = 0; // successfully extracted (files + dirs) — "extracted" in caller-facing terms
    this.entriesTotal = 0; // entries the archive claims to hold (zip: from its central directory; tar: entries actually visited, a lower bound if truncated)
    this.truncated = false; // hit MAX_ENTRIES or MAX_TOTAL_UNCOMPRESSED mid-walk
  }
  reject(name, reason) {
    this.rejectedTotal += 1;
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
const S_IFDIR = 0x4000;
const DOS_DIR_ATTR = 0x10; // FILE_ATTRIBUTE_DIRECTORY, low byte of external_attr

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
  manifest.entriesTotal = cdEntries;
  let p = cdOffset;
  let i = 0;
  let sawStructuralBreak = false;
  for (; i < cdEntries; i++) {
    if (manifest.entryCount + manifest.rejectedTotal >= MAX_ENTRIES) { manifest.truncated = true; break; }
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN_SIG) { sawStructuralBreak = true; break; }
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
    const rawName = (flags & 0x800) ? nameBuf.toString('utf8') : decodeLegacyName(nameBuf);
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

    const parsed = normalizeEntryName(rawName);
    if (!parsed) { manifest.reject(rawName || '(empty)', rejectReason('traversal', 'path escapes the archive root')); continue; }
    const { path: safe, dirMarker } = parsed;
    const unixMode = externalAttrs >>> 16;
    const isSymlink = unixMode !== 0 && (unixMode & 0xf000) === S_IFLNK;
    const isUnixDir = unixMode !== 0 && (unixMode & 0xf000) === S_IFDIR;
    const isDosDir = (externalAttrs & DOS_DIR_ATTR) !== 0;
    // A directory entry is one that says so explicitly (trailing separator,
    // either archive convention) OR carries directory attributes with no
    // content — some tools omit the trailing separator but still set the bit.
    const isDir = dirMarker || ((isUnixDir || isDosDir) && uncompSize === 0);
    if (isSymlink) { manifest.reject(rawName, rejectReason('symlink', 'symlinks are not extracted')); continue; }
    if (isDir) {
      try {
        fs.mkdirSync(path.join(destDir, safe), { recursive: true });
        manifest.accept(safe, 0, true);
      } catch (e) {
        manifest.reject(rawName, rejectReason('write-error', e.code || e.message));
      }
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
    // A single hostile/malformed entry (e.g. a path that collides with a
    // directory another entry already created) must never abort everything
    // that comes after it — that's exactly how "57 of 1335" happened.
    try {
      writeEntryFile(destDir, safe, data);
      manifest.accept(safe, data.length, false);
    } catch (e) {
      manifest.reject(rawName, rejectReason('write-error', e.code || e.message));
    }
  }
  if (sawStructuralBreak) {
    // The central directory promised `cdEntries` records but the bytes at
    // record `i` don't parse as one — surface that instead of silently
    // reporting whatever we managed to read as the whole archive.
    manifest.reject('(central directory)', rejectReason('corrupt', `central directory record ${i} of ${cdEntries} is malformed or truncated`));
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
    // Tar names are raw bytes with no per-entry encoding flag; modern tar
    // (GNU/BSD, any UTF-8 locale) writes UTF-8 directly, so decode as UTF-8
    // rather than latin1 — otherwise a multi-byte Hebrew name reads back as
    // mojibake, one garbled "character" per byte.
    const nameField = block.slice(0, 100).toString('utf8').replace(/\0.*$/, '');
    const size = octal(block.slice(124, 136));
    const typeflag = String.fromCharCode(block[156] || 0);
    const prefix = block.slice(345, 500).toString('utf8').replace(/\0.*$/, '');
    const dataStart = offset + 512;
    const paddedSize = Math.ceil(size / 512) * 512;
    offset = dataStart + paddedSize;

    if (typeflag === 'L') { // GNU long-name: next block(s) hold the real name
      longName = size <= 4096 ? buf.slice(dataStart, dataStart + size).toString('utf8').replace(/\0.*$/, '') : null;
      continue;
    }
    const rawName = longName || (prefix ? `${prefix}/${nameField}` : nameField);
    longName = null;
    if (!rawName) continue;

    if (manifest.entryCount + manifest.rejectedTotal >= MAX_ENTRIES) { manifest.truncated = true; break; }
    const parsed = normalizeEntryName(rawName);
    if (!parsed) { manifest.reject(rawName, rejectReason('traversal', 'path escapes the archive root')); continue; }
    const { path: safe, dirMarker } = parsed;
    const isDir = typeflag === '5' || (dirMarker && size === 0);
    if (isDir) {
      try {
        fs.mkdirSync(path.join(destDir, safe), { recursive: true });
        manifest.accept(safe, 0, true);
      } catch (e) {
        manifest.reject(rawName, rejectReason('write-error', e.code || e.message));
      }
      continue;
    }
    if (typeflag === '2' || typeflag === '1') { manifest.reject(rawName, rejectReason('symlink', 'links are not extracted')); continue; }
    if (typeflag !== '0' && typeflag !== '\0' && typeflag !== '') { manifest.reject(rawName, rejectReason('unsupported-type', `tar type '${typeflag}' is not a regular file`)); continue; }
    if (size > MAX_ENTRY_UNCOMPRESSED) { manifest.reject(rawName, rejectReason('entry-too-large', `${size} bytes exceeds the per-entry cap`)); continue; }
    if (manifest.totalSize + size > MAX_TOTAL_UNCOMPRESSED) { manifest.truncated = true; manifest.reject(rawName, rejectReason('total-cap', 'would exceed the total uncompressed-size cap')); continue; }
    if (dataStart + size > buf.length) { manifest.reject(rawName, rejectReason('corrupt', 'entry data runs past end of file')); continue; }
    try {
      writeEntryFile(destDir, safe, buf.slice(dataStart, dataStart + size));
      manifest.accept(safe, size, false);
    } catch (e) {
      manifest.reject(rawName, rejectReason('write-error', e.code || e.message));
    }
  }
  // No central directory to consult upfront — the entries actually visited
  // are the best available count, and only a lower bound when `truncated`.
  manifest.entriesTotal = manifest.entryCount + manifest.rejectedTotal;
  return manifest;
}

/**
 * Extracts a zip/tar/tar.gz buffer into destDir (created if needed). Returns a
 * manifest describing what was written and what was skipped, never throwing on
 * a hostile or malformed entry — only on a structurally unreadable archive
 * (caller decides whether to keep the raw file when that happens). Safe to
 * call again with the same buffer and destDir: every write is by exact
 * relative path (mkdir is recursive/idempotent, file writes overwrite in
 * place) and the manifest is computed fresh each call, so re-extracting an
 * already-extracted archive reproduces the same result instead of stacking on
 * top of it.
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
