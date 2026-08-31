// ZIP: the hardened extractor is the security boundary for any archive a
// human drags into the composer — it must never write outside its dest dir,
// never follow a symlink, and never let a small file balloon into gigabytes.
// Fixtures are built with python3's zipfile/tarfile (present on the box) so
// the "malicious" cases are byte-for-byte what a real tool produces, not a
// hand-rolled approximation of one.
import { test, expect, describe, beforeAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const {
  extractArchive,
  detectArchiveKind,
  formatTree,
  MAX_ENTRIES,
  MAX_ENTRY_UNCOMPRESSED,
  MAX_TOTAL_UNCOMPRESSED,
  MAX_COMPRESSION_RATIO,
} = await import(path.join(ROOT, 'server/archive.js'));

let tmp;
const dest = () => fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-archive-dest-'));

function py(script) {
  const r = Bun.spawnSync(['python3', '-c', script], { cwd: tmp });
  if (r.exitCode !== 0) throw new Error(`python3 fixture build failed: ${r.stderr.toString()}`);
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-archive-fixtures-'));

  py(`
import zipfile, stat
with zipfile.ZipFile('plain.zip', 'w', zipfile.ZIP_DEFLATED) as zf:
    zf.writestr('readme.txt', 'hello world')
    zf.writestr('src/index.js', 'console.log(1)')
    zf.writestr('src/lib/', '')  # explicit dir entry
    zf.writestr('src/lib/util.js', 'export const x = 1;')
`);

  py(`
import zipfile
with zipfile.ZipFile('traversal.zip', 'w', zipfile.ZIP_DEFLATED) as zf:
    zf.writestr('ok.txt', 'fine')
    zi = zipfile.ZipInfo('../../etc/evil.txt')
    zf.writestr(zi, 'nope')
    zi2 = zipfile.ZipInfo('/absolute.txt')
    zf.writestr(zi2, 'nope2')
`);

  py(`
import zipfile, stat
with zipfile.ZipFile('symlink.zip', 'w', zipfile.ZIP_DEFLATED) as zf:
    zf.writestr('ok.txt', 'fine')
    zi = zipfile.ZipInfo('evil-link')
    zi.external_attr = (stat.S_IFLNK | 0o777) << 16
    zf.writestr(zi, '/etc/passwd')
`);

  py(`
import zipfile
with zipfile.ZipFile('bomb.zip', 'w', zipfile.ZIP_DEFLATED) as zf:
    zf.writestr('bomb.bin', b'\\0' * (5 * 1024 * 1024))
`);

  py(`
import zipfile
with zipfile.ZipFile('manyentries.zip', 'w', zipfile.ZIP_DEFLATED) as zf:
    for i in range(${MAX_ENTRIES} + 5):
        zf.writestr(f'f{i}.txt', 'x')
`);

  py(`
import tarfile, io, os
with tarfile.open('plain.tar', 'w') as tf:
    data = b'hello tar'
    ti = tarfile.TarInfo('readme.txt')
    ti.size = len(data)
    tf.addfile(ti, io.BytesIO(data))
    d = tarfile.TarInfo('dir')
    d.type = tarfile.DIRTYPE
    tf.addfile(d)
with tarfile.open('plain.tar.gz', 'w:gz') as tf:
    data = b'hello targz'
    ti = tarfile.TarInfo('readme.txt')
    ti.size = len(data)
    tf.addfile(ti, io.BytesIO(data))

with tarfile.open('traversal-symlink.tar', 'w') as tf:
    ti = tarfile.TarInfo('../escape.txt')
    ti.size = 4
    tf.addfile(ti, io.BytesIO(b'nope'))
    link = tarfile.TarInfo('evil-link')
    link.type = tarfile.SYMTYPE
    link.linkname = '/etc/passwd'
    tf.addfile(link)
`);

  fs.writeFileSync(path.join(tmp, 'corrupt.zip'), Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('not actually a zip, no central directory here'.repeat(5))]));
  fs.writeFileSync(path.join(tmp, 'corrupt.tar.gz'), Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xff, 0xff, 0xff, 0xff]));

  // ---- ZIP3 fixtures: OS-agnostic separators, legacy encodings, honesty ----

  // A Windows-produced zip: every separator is '\', dirs have no trailing '/'
  // at all. This is exactly the shape of the real archive that only
  // extracted 57 of 1335 entries before this fix.
  py(`
import zipfile
with zipfile.ZipFile('winsep.zip', 'w', zipfile.ZIP_DEFLATED) as zf:
    zf.writestr('proj\\\\', '')
    zf.writestr('proj\\\\invoices\\\\', '')
    zf.writestr('proj\\\\invoices\\\\a.txt', 'hello a')
    zf.writestr('proj\\\\readme.txt', 'hello readme')
    zf.writestr('proj\\\\src\\\\main.py', 'print(1)')
`);

  // Mixed separators within a single archive (some tools produce this when
  // repacking a Windows zip on a Unix box, or vice versa).
  py(`
import zipfile
with zipfile.ZipFile('mixedsep.zip', 'w', zipfile.ZIP_DEFLATED) as zf:
    zf.writestr('mix\\\\dir/', '')
    zf.writestr('mix\\\\dir/leaf.txt', 'leaf')
    zf.writestr('a\\\\b/c\\\\d.txt', 'nested mixed')
`);

  // A Windows drive-prefixed absolute path, and a bare POSIX absolute path
  // that must still be rejected (not silently rebased into destDir).
  py(`
import zipfile
with zipfile.ZipFile('driveprefix.zip', 'w', zipfile.ZIP_DEFLATED) as zf:
    zi = zipfile.ZipInfo('C:\\\\Users\\\\x\\\\file.txt')
    zf.writestr(zi, 'drive-prefixed')
    zi2 = zipfile.ZipInfo('/etc/shadow')
    zf.writestr(zi2, 'nope')
`);

  // Same Hebrew filename two ways: once with the UTF-8 flag set (the normal
  // case), once without it — encoded as CP862 (DOS/Windows Hebrew OEM
  // codepage), which is what a legacy Windows Hebrew-locale zip tool
  // actually writes when it skips the UTF-8 flag.
  py(`
import zipfile
with zipfile.ZipFile('utf8hebrew.zip', 'w', zipfile.ZIP_DEFLATED) as zf:
    zf.writestr('מסמך.txt', 'utf8 flagged hebrew name')
`);
  py(`
import zipfile
with zipfile.ZipFile('cp862hebrew.zip', 'w', zipfile.ZIP_DEFLATED) as zf:
    zf.writestr('XXXX.txt', 'cp862 legacy hebrew name')
data = open('cp862hebrew.zip', 'rb').read()
placeholder = 'XXXX.txt'.encode('ascii')
hebrew = 'מסמך.txt'.encode('cp862')
assert len(placeholder) == len(hebrew)
assert data.count(placeholder) == 2  # local header + central directory
data = data.replace(placeholder, hebrew)
open('cp862hebrew.zip', 'wb').write(data)
`);

  // macOS Finder zips store Unicode in decomposed NFD form; the same name
  // typed elsewhere is NFC. Both must extract to the identical relative path.
  py(`
import zipfile, unicodedata
with zipfile.ZipFile('nfd.zip', 'w', zipfile.ZIP_DEFLATED) as zf:
    nfd_name = unicodedata.normalize('NFD', 'café.txt')
    zf.writestr(nfd_name, 'decomposed name from macOS')
`);

  // A directory entry and a same-named file entry collide on disk — the
  // extractor must reject the losing entry (write-error) and keep going,
  // not abort everything that comes after it.
  py(`
import zipfile
with zipfile.ZipFile('selfconflict.zip', 'w', zipfile.ZIP_DEFLATED) as zf:
    zf.writestr('ok1.txt', 'fine1')
    zf.writestr('x/', '')
    zf.writestr('x', 'conflicts with the directory above')
    zf.writestr('ok2.txt', 'fine2')
`);

  // A central directory that promises more entries (via EOCD) than are
  // actually present — the walk must stop honestly instead of silently
  // reporting a 2-of-3 archive as a complete one.
  py(`
import zipfile, struct
with zipfile.ZipFile('base3.zip', 'w', zipfile.ZIP_DEFLATED) as zf:
    zf.writestr('a.txt', '1')
    zf.writestr('b.txt', '2')
    zf.writestr('c.txt', '3')
data = open('base3.zip', 'rb').read()
eocd = data.rfind(b'PK\\x05\\x06')
cd_offset = struct.unpack('<I', data[eocd + 16:eocd + 20])[0]
cd_bytes = data[cd_offset:eocd]
positions = []
pos = 0
while True:
    idx = cd_bytes.find(b'PK\\x01\\x02', pos)
    if idx == -1:
        break
    positions.append(idx)
    pos = idx + 4
assert len(positions) == 3
truncated_cd = cd_bytes[:positions[2]]  # drop the 3rd central-directory record
new_data = data[:cd_offset] + truncated_cd
new_eocd = struct.pack('<IHHHHIIH', 0x06054b50, 0, 0, 3, 3, len(truncated_cd), cd_offset, 0)
open('corruptcd.zip', 'wb').write(new_data + new_eocd)
`);

  // A 1200-entry backslash-separated zip — a smaller stand-in for the real
  // 1335-entry archive that only 57 entries survived from before this fix.
  py(`
import zipfile
with zipfile.ZipFile('manybackslash.zip', 'w', zipfile.ZIP_DEFLATED) as zf:
    for i in range(1200):
        zf.writestr(f'proj\\\\group{i % 20}\\\\file{i}.txt', f'content {i}')
`);

  // tar.gz with an explicit directory entry (tar.gz coverage previously only
  // had a bare file).
  py(`
import tarfile, io
with tarfile.open('withdir.tar.gz', 'w:gz') as tf:
    d = tarfile.TarInfo('assets')
    d.type = tarfile.DIRTYPE
    tf.addfile(d)
    data = b'leaf content'
    ti = tarfile.TarInfo('assets/leaf.txt')
    ti.size = len(data)
    tf.addfile(ti, io.BytesIO(data))
`);
});

const load = (name) => fs.readFileSync(path.join(tmp, name));

describe('detectArchiveKind', () => {
  test('sniffs by magic bytes, not extension', () => {
    expect(detectArchiveKind(load('plain.zip'))).toBe('zip');
    expect(detectArchiveKind(load('plain.tar.gz'))).toBe('targz');
    expect(detectArchiveKind(load('plain.tar'))).toBe('tar');
    expect(detectArchiveKind(Buffer.from('just some text'))).toBeNull();
    // renaming a zip to .txt still detects as zip — extension is never trusted
    const zipBytesNamedTxt = load('plain.zip');
    expect(detectArchiveKind(zipBytesNamedTxt)).toBe('zip');
  });
});

describe('zip extraction', () => {
  test('happy path: files + explicit dir entry land on disk with correct content', () => {
    const d = dest();
    const m = extractArchive(load('plain.zip'), d);
    expect(m.kind).toBe('zip');
    expect(m.rejected).toEqual([]);
    expect(fs.readFileSync(path.join(d, 'readme.txt'), 'utf8')).toBe('hello world');
    expect(fs.readFileSync(path.join(d, 'src/index.js'), 'utf8')).toBe('console.log(1)');
    expect(fs.readFileSync(path.join(d, 'src/lib/util.js'), 'utf8')).toBe('export const x = 1;');
    expect(fs.statSync(path.join(d, 'src/lib')).isDirectory()).toBe(true);
  });

  test('path traversal entries are rejected and never written outside destDir', () => {
    const d = dest();
    const m = extractArchive(load('traversal.zip'), d);
    expect(fs.readFileSync(path.join(d, 'ok.txt'), 'utf8')).toBe('fine');
    const names = m.rejected.map((r) => r.name);
    expect(names).toContain('../../etc/evil.txt');
    expect(names).toContain('/absolute.txt');
    expect(m.rejected.every((r) => r.reason === 'traversal')).toBe(true);
    expect(fs.existsSync(path.join(path.dirname(d), 'etc/evil.txt'))).toBe(false);
    expect(fs.existsSync('/absolute.txt')).toBe(false);
  });

  test('symlink entries are rejected, not followed or materialized', () => {
    const d = dest();
    const m = extractArchive(load('symlink.zip'), d);
    expect(fs.readFileSync(path.join(d, 'ok.txt'), 'utf8')).toBe('fine');
    expect(m.rejected).toEqual([{ name: 'evil-link', reason: 'symlink', detail: 'symlinks are not extracted' }]);
    expect(fs.existsSync(path.join(d, 'evil-link'))).toBe(false);
  });

  test('a high compression-ratio entry is rejected as a suspected bomb', () => {
    const d = dest();
    const m = extractArchive(load('bomb.zip'), d);
    expect(m.entries).toEqual([]);
    expect(m.rejected[0].reason).toBe('bomb-ratio');
    expect(fs.existsSync(path.join(d, 'bomb.bin'))).toBe(false);
  });

  test('entry count beyond MAX_ENTRIES stops the walk and marks truncated', () => {
    const d = dest();
    const m = extractArchive(load('manyentries.zip'), d);
    expect(m.entryCount + m.rejected.length).toBeLessThanOrEqual(MAX_ENTRIES);
    expect(m.truncated).toBe(true);
  });

  test('a structurally corrupt zip throws rather than silently extracting garbage', () => {
    const d = dest();
    expect(() => extractArchive(load('corrupt.zip'), d)).toThrow();
  });

  test('MAX_ENTRY_UNCOMPRESSED and MAX_TOTAL_UNCOMPRESSED are sane relative to each other', () => {
    expect(MAX_ENTRY_UNCOMPRESSED).toBeLessThanOrEqual(MAX_TOTAL_UNCOMPRESSED);
    expect(MAX_COMPRESSION_RATIO).toBeGreaterThan(1);
  });
});

describe('OS-agnostic separators, encoding, and honest partial reporting', () => {
  test('a Windows zip (every entry backslash-separated, no forward slashes) extracts completely', () => {
    const d = dest();
    const m = extractArchive(load('winsep.zip'), d);
    expect(m.rejected).toEqual([]);
    expect(m.entryCount).toBe(m.entriesTotal);
    expect(fs.statSync(path.join(d, 'proj')).isDirectory()).toBe(true);
    expect(fs.statSync(path.join(d, 'proj/invoices')).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(d, 'proj/invoices/a.txt'), 'utf8')).toBe('hello a');
    expect(fs.readFileSync(path.join(d, 'proj/readme.txt'), 'utf8')).toBe('hello readme');
    expect(fs.readFileSync(path.join(d, 'proj/src/main.py'), 'utf8')).toBe('print(1)');
    // no entry name (or its rendered tree line) carries a literal backslash
    for (const e of m.entries) expect(e.name.includes('\\')).toBe(false);
  });

  test('a 1200-entry backslash zip extracts every entry (regression for the 57-of-1335 bug)', () => {
    const d = dest();
    const m = extractArchive(load('manybackslash.zip'), d);
    expect(m.rejected).toEqual([]);
    expect(m.truncated).toBe(false);
    expect(m.entriesTotal).toBe(1200);
    expect(m.entryCount).toBe(1200);
    expect(fs.readFileSync(path.join(d, 'proj/group5/file5.txt'), 'utf8')).toBe('content 5');
    expect(fs.readFileSync(path.join(d, 'proj/group19/file1199.txt'), 'utf8')).toBe('content 1199');
  });

  test('mixed \\ and / separators in the same archive normalize consistently', () => {
    const d = dest();
    const m = extractArchive(load('mixedsep.zip'), d);
    expect(m.rejected).toEqual([]);
    expect(fs.statSync(path.join(d, 'mix/dir')).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(d, 'mix/dir/leaf.txt'), 'utf8')).toBe('leaf');
    expect(fs.readFileSync(path.join(d, 'a/b/c/d.txt'), 'utf8')).toBe('nested mixed');
  });

  test('a Windows drive-prefixed path is rebased into destDir; a bare absolute path is still rejected', () => {
    const d = dest();
    const m = extractArchive(load('driveprefix.zip'), d);
    expect(fs.readFileSync(path.join(d, 'Users/x/file.txt'), 'utf8')).toBe('drive-prefixed');
    expect(m.rejected).toEqual([{ name: '/etc/shadow', reason: 'traversal', detail: 'path escapes the archive root' }]);
    expect(fs.existsSync(path.join(d, 'etc'))).toBe(false); // never rebased under destDir either
  });

  test('Hebrew filename with the UTF-8 flag set decodes correctly', () => {
    const d = dest();
    const m = extractArchive(load('utf8hebrew.zip'), d);
    expect(m.rejected).toEqual([]);
    expect(fs.readFileSync(path.join(d, 'מסמך.txt'), 'utf8')).toBe('utf8 flagged hebrew name');
  });

  test('Hebrew filename without the UTF-8 flag decodes via the CP862 fallback', () => {
    const d = dest();
    const m = extractArchive(load('cp862hebrew.zip'), d);
    expect(m.rejected).toEqual([]);
    expect(fs.readFileSync(path.join(d, 'מסמך.txt'), 'utf8')).toBe('cp862 legacy hebrew name');
  });

  test('an NFD (macOS-decomposed) name normalizes to the same NFC path as everywhere else', () => {
    const d = dest();
    const m = extractArchive(load('nfd.zip'), d);
    expect(m.rejected).toEqual([]);
    const nfcName = 'café.txt'.normalize('NFC');
    expect(fs.readFileSync(path.join(d, nfcName), 'utf8')).toBe('decomposed name from macOS');
    // the on-disk directory listing itself is NFC, not NFD
    expect(fs.readdirSync(d)).toEqual([nfcName]);
  });

  test('a file entry that collides with a directory another entry created is rejected, not fatal', () => {
    const d = dest();
    const m = extractArchive(load('selfconflict.zip'), d);
    expect(fs.readFileSync(path.join(d, 'ok1.txt'), 'utf8')).toBe('fine1');
    expect(fs.readFileSync(path.join(d, 'ok2.txt'), 'utf8')).toBe('fine2');
    expect(fs.statSync(path.join(d, 'x')).isDirectory()).toBe(true);
    expect(m.rejected.some((r) => r.name === 'x' && r.reason === 'write-error')).toBe(true);
    // the conflict is visible as a gap between what the archive claimed and what extracted
    expect(m.entryCount).toBeLessThan(m.entriesTotal);
  });

  test('a central directory that overclaims its entry count is reported as a partial extraction, not a success', () => {
    const d = dest();
    const m = extractArchive(load('corruptcd.zip'), d);
    expect(fs.readFileSync(path.join(d, 'a.txt'), 'utf8')).toBe('1');
    expect(fs.readFileSync(path.join(d, 'b.txt'), 'utf8')).toBe('2');
    expect(fs.existsSync(path.join(d, 'c.txt'))).toBe(false);
    expect(m.entriesTotal).toBe(3);
    expect(m.entryCount).toBe(2);
    expect(m.entryCount).not.toBe(m.entriesTotal); // this is the honesty check the chip relies on
    expect(m.rejected.some((r) => r.reason === 'corrupt')).toBe(true);
  });

  test('rejectedTotal is never truncated by the 200-entry display cap on `rejected`', () => {
    // manyentries.zip has MAX_ENTRIES + 5 files, all accepted (no rejects) —
    // reuse the traversal case shape instead: rejectedTotal must track every
    // reject() call, not just the ones kept for display.
    const d = dest();
    const m = extractArchive(load('traversal.zip'), d);
    expect(m.rejectedTotal).toBe(m.rejected.length); // small here, but same counter that stays honest past 200
  });
});

describe('tar / tar.gz extraction', () => {
  test('plain tar: files and dirs extract', () => {
    const d = dest();
    const m = extractArchive(load('plain.tar'), d);
    expect(m.kind).toBe('tar');
    expect(fs.readFileSync(path.join(d, 'readme.txt'), 'utf8')).toBe('hello tar');
    expect(fs.statSync(path.join(d, 'dir')).isDirectory()).toBe(true);
  });

  test('tar.gz: gunzips then extracts', () => {
    const d = dest();
    const m = extractArchive(load('plain.tar.gz'), d);
    expect(m.kind).toBe('targz');
    expect(fs.readFileSync(path.join(d, 'readme.txt'), 'utf8')).toBe('hello targz');
  });

  test('tar traversal + symlink entries are rejected', () => {
    const d = dest();
    const m = extractArchive(load('traversal-symlink.tar'), d);
    expect(m.entries).toEqual([]);
    const reasons = m.rejected.map((r) => r.reason).sort();
    expect(reasons).toEqual(['symlink', 'traversal']);
    expect(fs.existsSync(path.join(d, 'evil-link'))).toBe(false);
  });

  test('a gzip bomb (tiny compressed, huge declared/actual output) is rejected without OOMing', () => {
    const huge = Buffer.alloc(MAX_TOTAL_UNCOMPRESSED + 1024 * 1024, 0);
    const gz = zlib.gzipSync(huge);
    const d = dest();
    expect(() => extractArchive(gz, d, 'targz')).toThrow();
  });

  test('a corrupt gzip header throws', () => {
    const d = dest();
    expect(() => extractArchive(load('corrupt.tar.gz'), d)).toThrow();
  });

  test('tar.gz with an explicit directory entry extracts the dir and its contents', () => {
    const d = dest();
    const m = extractArchive(load('withdir.tar.gz'), d);
    expect(m.rejected).toEqual([]);
    expect(fs.statSync(path.join(d, 'assets')).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(d, 'assets/leaf.txt'), 'utf8')).toBe('leaf content');
  });
});

describe('formatTree', () => {
  test('lists entries in archive order, then "+N more" past the limit', () => {
    const d = dest();
    const m = extractArchive(load('plain.zip'), d);
    const lines = formatTree(m, 2);
    expect(lines.length).toBe(3);
    expect(lines[2]).toMatch(/^\+\d+ more$/);
  });

  test('no "+N more" line when everything fits', () => {
    const d = dest();
    const m = extractArchive(load('plain.zip'), d);
    const lines = formatTree(m, 100);
    expect(lines.some((l) => /more$/.test(l))).toBe(false);
  });

  test('directory lines from a backslash-separated archive never carry a doubled trailing slash', () => {
    const d = dest();
    const m = extractArchive(load('winsep.zip'), d);
    const lines = formatTree(m, 100);
    expect(lines.some((l) => l.includes('//'))).toBe(false);
    expect(lines).toContain('proj/');
    expect(lines).toContain('proj/invoices/');
  });
});

describe('re-extraction is idempotent', () => {
  test('extracting the same buffer into the same destDir twice yields the same manifest and no duplicate entries', () => {
    const d = dest();
    const buf = load('winsep.zip');
    const m1 = extractArchive(buf, d);
    const m2 = extractArchive(buf, d);
    expect(m2.entryCount).toBe(m1.entryCount);
    expect(m2.entriesTotal).toBe(m1.entriesTotal);
    expect(m2.rejected).toEqual(m1.rejected);
    expect(m2.entries.map((e) => e.name).sort()).toEqual(m1.entries.map((e) => e.name).sort());
    // no "file (1).txt"-style duplicate artifacts on disk
    expect(fs.readdirSync(path.join(d, 'proj')).sort()).toEqual(['invoices', 'readme.txt', 'src']);
  });
});
