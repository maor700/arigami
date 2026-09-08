// server/lib/tar.ts — the pure-JS streaming tar reader/writer that stands in
// for the system `tar` on macOS/Windows (dispatch/js-tar). Two things matter
// most here and get tested against the REAL GNU tar on this machine, not just
// each other: (1) an archive our writer produces opens with system tar, and an
// archive system tar produces opens with our reader — both directions, for
// real; (2) EXCLUDES/EXCLUDE_GLOBS/ROOT_EXCLUDE_GLOBS keep exactly the exclude
// semantics backup.ts's tarArgs() gets from GNU tar's --wildcards-match-slash
// toggle — verified by literally comparing our matcher's output against a real
// `tar --exclude=...` run over the same tree.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tar = await import('../server/lib/tar.ts');

const tmp = (p = 'tarjs-') => fs.mkdtempSync(path.join(os.tmpdir(), p));
const sysTarList = (f: string) => spawnSync('tar', ['-tzf', f], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean);

// ---- exclude-glob matching, verified against real GNU tar ---------------------------

// The exact pattern set backup.ts's tarArgs() builds from EXCLUDES/EXCLUDE_GLOBS/
// ROOT_EXCLUDE_GLOBS (server/backup.ts), duplicated here on purpose: a test that
// imported the real constants could pass even if EXCLUDE_GLOBS silently drifted
// from what tarArgs() actually sends to `tar --exclude=`.
const EXCLUDES = ['run', 'chrome-sessions', 'chrome-base', 'logs', 'user-plugin', 'ext-plugin', 'tmp', 'backups', 'node_modules'];
const EXCLUDE_GLOBS = ['*.bak-*', '.bak-*', '*.tmp', './agents/*/browser', './user/node_modules', './user/extensions/*/node_modules', '.credentials.json', '*/.credentials.json', './*/.credentials.json'];
const ROOT_EXCLUDE_GLOBS = ['./*-logs.txt'];

/** The set of paths real GNU tar actually adds to the archive under our exclude patterns (`-v`'s file list), i.e. the survivors. */
function realTarIncludedList(srcDir: string): string[] {
  const args = ['--no-wildcards-match-slash', ...ROOT_EXCLUDE_GLOBS.map((g) => `--exclude=${g}`), '--wildcards-match-slash', ...EXCLUDES.map((e) => `--exclude=./${e}`), ...EXCLUDE_GLOBS.map((g) => `--exclude=${g}`), '-cvf', '/dev/null', '-C', srcDir, '.'];
  const r = spawnSync('tar', args, { encoding: 'utf8' });
  return r.stdout.split('\n').filter(Boolean).map((l) => l.replace(/\/$/, ''));
}

function jsIncludedCandidates(srcDir: string, exclude: (c: string) => boolean): string[] {
  // Walk the same tree the same way our writer would, recording which candidates pass.
  const out: string[] = [];
  const walk = (abs: string, tarName: string) => {
    if (exclude(tarName)) return;
    out.push(tarName.replace(/\/$/, ''));
    const st = fs.lstatSync(abs);
    if (st.isDirectory() && !st.isSymbolicLink()) {
      for (const n of fs.readdirSync(abs).sort()) walk(path.join(abs, n), `${tarName === './' ? './' : `${tarName}/`}${n}`);
    }
  };
  walk(srcDir, './');
  return out;
}

function buildExcludeTestTree(dir: string): void {
  const mk = (rel: string) => { fs.mkdirSync(path.join(dir, rel), { recursive: true }); };
  const touch = (rel: string) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), 'x'); };
  mk('run'); touch('run/host.pid');
  mk('chrome-sessions/s1'); touch('chrome-sessions/s1/Cookies');
  mk('chrome-base/Default'); touch('chrome-base/Default/Cookies');
  touch('logs/host.log');
  mk('user-plugin'); touch('user-plugin/x.js');
  mk('ext-plugin'); touch('ext-plugin/x.js');
  touch('tmp/scratch.txt');
  touch('backups/old.tgz');
  mk('node_modules/pkg'); touch('node_modules/pkg/index.js');
  mk('agents/sales/browser'); touch('agents/sales/browser/x.txt');
  mk('agents/x'); touch('agents/x/keep.txt');
  mk('user/node_modules'); touch('user/node_modules/y.js');
  mk('user/extensions/foo/node_modules'); touch('user/extensions/foo/node_modules/z.js');
  mk('user/extensions/foo'); touch('user/extensions/foo/keep.js');
  touch('config.json.bak-1');
  touch('.bak-2');
  touch('foo.tmp');
  touch('uploads/nested.tmp');
  touch('uploads/a.txt');
  touch('uploads/keep-logs.txt'); // root-only glob must NOT reach this
  touch('mcp-logs.txt');
  touch('wa-logs.txt');
  touch('.credentials.json');
  touch('claude-config/.credentials.json');
  touch('a/b/.credentials.json');
  touch('a/b/keep.txt');
}

test('exclude matching: JS matcher agrees with real GNU tar --exclude on every pattern (run, chrome-*, logs, .bak-*, *.tmp, agents/*/browser, user(/extensions/*)/node_modules, .credentials.json at any depth, root-only *-logs.txt)', () => {
  const dir = tmp('excl-');
  buildExcludeTestTree(dir);
  const expectedIncluded = new Set(realTarIncludedList(dir));

  const exclude = tar.makeExcludeMatcher([
    ...ROOT_EXCLUDE_GLOBS.map((pattern) => ({ pattern, slashCross: false })),
    ...EXCLUDES.map((e) => ({ pattern: `./${e}`, slashCross: true })),
    ...EXCLUDE_GLOBS.map((pattern) => ({ pattern, slashCross: true })),
  ]);
  const included = new Set(jsIncludedCandidates(dir, exclude));

  // sanity: specific expectations from the task description
  expect(included.has('./run')).toBe(false);
  expect(included.has('./config.json.bak-1')).toBe(false);
  expect(included.has('./.credentials.json')).toBe(false);
  expect(included.has('./claude-config/.credentials.json')).toBe(false);
  expect(included.has('./a/b/.credentials.json')).toBe(false);
  expect(included.has('./mcp-logs.txt')).toBe(false);
  expect(included.has('./wa-logs.txt')).toBe(false);
  expect(included.has('./uploads/keep-logs.txt')).toBe(true); // root-only glob must not cross into uploads/
  expect(included.has('./agents/sales/browser')).toBe(false);
  expect(included.has('./agents/x/keep.txt')).toBe(true);
  expect(included.has('./user/node_modules')).toBe(false);
  expect(included.has('./user/extensions/foo/node_modules')).toBe(false);
  expect(included.has('./user/extensions/foo/keep.js')).toBe(true);
  expect(included.has('./foo.tmp')).toBe(false);
  expect(included.has('./uploads/nested.tmp')).toBe(false);
  expect(included.has('./a/b/keep.txt')).toBe(true);

  // exhaustive: every entry real GNU tar decided to keep, we keep — and nothing else
  expect([...included].sort()).toEqual([...expectedIncluded].sort());
});

test('globToRegex: FNM_LEADING_DIR semantics — a dir pattern prunes its subtree, a suffix pattern does not need a trailing slash', () => {
  const dirRe = tar.globToRegex('./run', true);
  expect(dirRe.test('./run')).toBe(true);
  expect(dirRe.test('./run/host.pid')).toBe(true);
  expect(dirRe.test('./running')).toBe(false);
  const suffixRe = tar.globToRegex('*.tmp', true);
  expect(suffixRe.test('./foo.tmp')).toBe(true);
  expect(suffixRe.test('./a/b/foo.tmp')).toBe(true);
  expect(suffixRe.test('./foo.tmpx')).toBe(false);
  const rootOnly = tar.globToRegex('./*-logs.txt', false);
  expect(rootOnly.test('./mcp-logs.txt')).toBe(true);
  expect(rootOnly.test('./uploads/keep-logs.txt')).toBe(false);
});

// ---- create → real tar reads it; real tar creates → we read it -----------------------

test('create: our archive opens with real GNU tar (list + extract byte-identical)', async () => {
  const dir = tmp('mk-');
  const src = path.join(dir, 'src');
  fs.mkdirSync(path.join(src, 'a/b'), { recursive: true });
  fs.writeFileSync(path.join(src, 'a/b/c.txt'), 'hello world\n'.repeat(200));
  fs.writeFileSync(path.join(src, 'top.txt'), 'top');
  fs.chmodSync(path.join(src, 'top.txt'), 0o640);
  fs.symlinkSync('a/b/c.txt', path.join(src, 'link'));
  const longName = 'a-very-long-directory-name-that-exceeds-the-classic-ustar-one-hundred-byte-name-field-limit-here';
  fs.mkdirSync(path.join(src, longName));
  fs.writeFileSync(path.join(src, longName, 'deep.txt'), 'deep');

  const out = path.join(dir, 'out.tgz');
  const r = tar.createTarGzStream([{ dir: src, members: ['.'] }]);
  const ws = fs.createWriteStream(out);
  await new Promise<void>((res, rej) => { r.stream.pipe(ws); ws.on('finish', () => res()); ws.on('error', rej); });
  expect(await r.done).toBe(0);

  const extracted = path.join(dir, 'extracted');
  fs.mkdirSync(extracted);
  const x = spawnSync('tar', ['-xzf', out, '-C', extracted], { encoding: 'utf8' });
  expect(x.status).toBe(0);
  expect(fs.readFileSync(path.join(extracted, 'a/b/c.txt'), 'utf8')).toBe(fs.readFileSync(path.join(src, 'a/b/c.txt'), 'utf8'));
  expect(fs.readFileSync(path.join(extracted, longName, 'deep.txt'), 'utf8')).toBe('deep');
  expect(fs.lstatSync(path.join(extracted, 'link')).isSymbolicLink()).toBe(true);
  expect(fs.readlinkSync(path.join(extracted, 'link'))).toBe('a/b/c.txt');
  expect(fs.statSync(path.join(extracted, 'top.txt')).mode & 0o777).toBe(0o640);
});

test('read: our reader lists/extracts an archive made by real GNU tar (old, pre-migration archives keep working)', async () => {
  const dir = tmp('rd-');
  const src = path.join(dir, 'src');
  fs.mkdirSync(path.join(src, 'x/y'), { recursive: true });
  fs.writeFileSync(path.join(src, 'x/y/z.txt'), 'z'.repeat(5000));
  fs.writeFileSync(path.join(src, 'root.txt'), 'root');
  fs.symlinkSync('x/y/z.txt', path.join(src, 'sym'));
  const archive = path.join(dir, 'made-by-real-tar.tgz');
  const c = spawnSync('tar', ['-czf', archive, '-C', src, '.'], { encoding: 'utf8' });
  expect(c.status).toBe(0);

  const jsList = (await tar.listTarGz(archive)).sort();
  expect(jsList).toEqual(sysTarList(archive).sort());

  const dest = path.join(dir, 'extracted-js');
  const res = await tar.extractTarGzToDir(archive, dest, {});
  expect(res.entries).toBeGreaterThan(0);
  expect(fs.readFileSync(path.join(dest, 'x/y/z.txt'), 'utf8')).toBe('z'.repeat(5000));
  expect(fs.readFileSync(path.join(dest, 'root.txt'), 'utf8')).toBe('root');
  expect(fs.readlinkSync(path.join(dest, 'sym'))).toBe('x/y/z.txt');

  const single = await tar.extractFileFromTarGz(archive, './root.txt');
  expect(single?.toString('utf8')).toBe('root');
});

// ---- extractor hardening -------------------------------------------------------------

test('extract: rejects a symlink escaping the destination (absolute or ../ target), keeps a safe one', async () => {
  const dir = tmp('sym-');
  const src = path.join(dir, 'src');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'real.txt'), 'ok');
  fs.symlinkSync('/etc/passwd', path.join(src, 'abs-evil'));
  fs.symlinkSync('../../../../etc/passwd', path.join(src, 'rel-evil'));
  fs.symlinkSync('real.txt', path.join(src, 'safe-link'));

  const archive = path.join(dir, 'a.tgz');
  spawnSync('tar', ['-czf', archive, '-C', src, '.'], { encoding: 'utf8' });

  const dest = path.join(dir, 'out');
  await tar.extractTarGzToDir(archive, dest, {});
  expect(fs.existsSync(path.join(dest, 'abs-evil'))).toBe(false);
  expect(fs.existsSync(path.join(dest, 'rel-evil'))).toBe(false);
  expect(fs.lstatSync(path.join(dest, 'safe-link')).isSymbolicLink()).toBe(true);
});

test('extract: refuses an archive with a path-traversal entry', async () => {
  const root = tmp('esc-');
  fs.mkdirSync(path.join(root, 'in'));
  fs.writeFileSync(path.join(root, 'evil'), 'x');
  fs.writeFileSync(path.join(root, 'in', 'ok.txt'), 'y');
  const esc = path.join(root, 'esc.tgz');
  spawnSync('tar', ['-P', '-czf', esc, '-C', path.join(root, 'in'), '.', '../evil']);
  await expect(tar.extractTarGzToDir(esc, path.join(root, 'dest'), {})).rejects.toThrow(/unsafe path/);
});

// ---- streaming create honours the excludes -------------------------------------------

test('createTarGzStream applies the exclude matcher (streamed, not post-filtered)', async () => {
  const dir = tmp('ce-');
  const src = path.join(dir, 'src');
  fs.mkdirSync(path.join(src, 'run'), { recursive: true });
  fs.writeFileSync(path.join(src, 'run/x'), 'excluded');
  fs.writeFileSync(path.join(src, 'keep.txt'), 'kept');
  const exclude = tar.makeExcludeMatcher([{ pattern: './run', slashCross: true }]);
  const out = path.join(dir, 'out.tgz');
  const r = tar.createTarGzStream([{ dir: src, members: ['.'] }], { exclude });
  const ws = fs.createWriteStream(out);
  await new Promise<void>((res) => { r.stream.pipe(ws); ws.on('finish', () => res()); });
  await r.done;
  const names = await tar.listTarGz(out);
  expect(names).not.toContain('./run/');
  expect(names.some((n) => n.startsWith('./run'))).toBe(false);
  expect(names).toContain('./keep.txt');
});

// ---- round trip: nested dirs, permissions, a bigger file, JS create → JS extract -----

test('round trip (JS create → JS extract): nested dirs, file permissions and a multi-MB file survive byte-for-byte', async () => {
  const dir = tmp('rt-');
  const src = path.join(dir, 'src');
  fs.mkdirSync(path.join(src, 'nested/deep/dir'), { recursive: true });
  fs.writeFileSync(path.join(src, 'nested/deep/dir/file.txt'), 'nested content\n'.repeat(50));
  fs.chmodSync(path.join(src, 'nested/deep/dir/file.txt'), 0o600);
  fs.mkdirSync(path.join(src, 'exec-dir'));
  fs.writeFileSync(path.join(src, 'exec-dir/run.sh'), '#!/bin/sh\necho hi\n');
  fs.chmodSync(path.join(src, 'exec-dir/run.sh'), 0o755);
  const big = Buffer.from(Array.from({ length: 6 * 1024 * 1024 }, (_, i) => i % 256));
  fs.writeFileSync(path.join(src, 'big.bin'), big);

  const out = path.join(dir, 'rt.tgz');
  const r = tar.createTarGzStream([{ dir: src, members: ['.'] }]);
  const ws = fs.createWriteStream(out);
  await new Promise<void>((res) => { r.stream.pipe(ws); ws.on('finish', () => res()); });
  expect(await r.done).toBe(0);

  const dest = path.join(dir, 'restored');
  const res = await tar.extractTarGzToDir(out, dest, {});
  expect(res.entries).toBeGreaterThan(0);

  expect(fs.readFileSync(path.join(dest, 'nested/deep/dir/file.txt'), 'utf8')).toBe(fs.readFileSync(path.join(src, 'nested/deep/dir/file.txt'), 'utf8'));
  expect(fs.statSync(path.join(dest, 'nested/deep/dir/file.txt')).mode & 0o777).toBe(0o600);
  expect(fs.statSync(path.join(dest, 'exec-dir/run.sh')).mode & 0o777).toBe(0o755);
  expect(Buffer.compare(fs.readFileSync(path.join(dest, 'big.bin')), big)).toBe(0);
});
