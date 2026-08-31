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
});
