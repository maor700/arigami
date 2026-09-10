// VER1: scripts/release.ts — the pure pieces (conventional-commit parsing,
// changelog rendering/insertion/extraction, version bumps) and one real run
// against a scratch repo: files written, `chore(release)` commit, annotated tag,
// nothing pushed (there is no remote to push to — and it never tries).
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  bumpVersion, parseConventional, groupCommits, renderSection, insertSection, extractSection,
  setPackageVersion, repoUrlFromPackage, isNoise, lastTag, commitsSince, main, CHANGELOG_HEADER,
  autoBump, NOTHING_TO_RELEASE, clampZeroVer, releaseBoundary, lastVersionCommit,
} from '../scripts/release.ts';

test('bumpVersion: patch/minor/major and an explicit X.Y.Z', () => {
  expect(bumpVersion('0.1.0', 'patch')).toBe('0.1.1');
  expect(bumpVersion('0.1.9', 'minor')).toBe('0.2.0');
  expect(bumpVersion('1.4.2', 'major')).toBe('2.0.0');
  expect(bumpVersion('0.1.0', '3.0.0')).toBe('3.0.0');
  expect(() => bumpVersion('0.1.0', 'huge')).toThrow(/unknown bump/);
});

test('parseConventional: type/scope/!/title, Hebrew titles verbatim, non-conventional → other', () => {
  expect(parseConventional({ sha: 'a', subject: 'feat(ext): sendPrompt מקבל את סמנטיקת המסירה', body: '' }))
    .toMatchObject({ type: 'feat', scope: 'ext', breaking: false, title: 'sendPrompt מקבל את סמנטיקת המסירה' });
  expect(parseConventional({ sha: 'a', subject: 'fix!: drop the old route', body: '' })).toMatchObject({ type: 'fix', scope: null, breaking: true });
  expect(parseConventional({ sha: 'a', subject: 'refactor(core): x', body: 'BREAKING CHANGE: y' })).toMatchObject({ breaking: true });
  expect(parseConventional({ sha: 'a', subject: 'B2: full Docker image', body: '' })).toMatchObject({ type: 'other', title: 'B2: full Docker image' });
  expect(isNoise({ sha: 'a', subject: 'Merge dispatch/x: תיאור', body: '' })).toBe(true);
  expect(isNoise({ sha: 'a', subject: 'chore(release): v0.1.1', body: '' })).toBe(true);
  expect(isNoise({ sha: 'a', subject: 'chore(deps): bump', body: '' })).toBe(false);
});

const COMMITS = [
  { sha: '1111111aaaaaaa', subject: 'Merge dispatch/a: משהו', body: '' },
  { sha: '2222222aaaaaaa', subject: 'feat(ext): הרחבות trusted', body: '' },
  { sha: '3333333aaaaaaa', subject: 'fix(prompts): auto-play kicks', body: '' },
  { sha: '4444444aaaaaaa', subject: 'docs(ext): the tab asset token', body: '' },
  { sha: '5555555aaaaaaa', subject: 'test(ext): 4 cases', body: '' },
  { sha: '6666666aaaaaaa', subject: 'refactor(core)!: drop the slider', body: '' },
  { sha: '7777777aaaaaaa', subject: 'ci: build and publish the control-plane image', body: '' },
  { sha: '8888888aaaaaaa', subject: 'B2: full Docker image', body: '' },
];

test('groupCommits + renderSection: sections in order, merges skipped, links when the repo is known', () => {
  const g = groupCommits(COMMITS);
  expect([...g.keys()]).toEqual(['feat', 'fix', 'docs', 'test', 'breaking', 'chore', 'other']);
  const md = renderSection(COMMITS, { version: '0.2.0', date: '2026-09-08', previousTag: 'v0.1.0', repoUrl: 'https://github.com/o/r' });
  expect(md.split('\n')[0]).toBe('## v0.2.0 — 2026-09-08 — [v0.1.0...v0.2.0](https://github.com/o/r/compare/v0.1.0...v0.2.0)');
  const heads = md.split('\n').filter((l) => l.startsWith('### '));
  expect(heads).toEqual(['### Breaking', '### Features', '### Fixes', '### Refactoring'].slice(0, 0).concat(['### Breaking', '### Features', '### Fixes', '### Docs', '### Tests', '### Chores', '### Other']));
  expect(md).toContain('- **ext:** הרחבות trusted ([2222222](https://github.com/o/r/commit/2222222aaaaaaa))');
  expect(md).toContain('- B2: full Docker image (');
  expect(md).not.toContain('Merge dispatch');
  // no repo url → bare short shas, no compare link
  const bare = renderSection(COMMITS.slice(1, 2), { version: '0.2.0', date: 'd', previousTag: null, repoUrl: null });
  expect(bare).toContain('(2222222)');
  expect(bare.split('\n')[0]).toBe('## v0.2.0 — d');
  expect(renderSection([], { version: '1.0.0', date: 'd', previousTag: null, repoUrl: null })).toContain('_No changes since the previous release._');
});

test('insertSection / extractSection round-trip, newest first', () => {
  const s1 = renderSection(COMMITS.slice(1, 3), { version: '0.1.1', date: 'd1', previousTag: null, repoUrl: null });
  const s2 = renderSection(COMMITS.slice(3, 5), { version: '0.1.2', date: 'd2', previousTag: 'v0.1.1', repoUrl: null });
  const c1 = insertSection('', s1);
  expect(c1.startsWith(CHANGELOG_HEADER)).toBe(true);
  const c2 = insertSection(c1, s2);
  expect(c2.indexOf('## v0.1.2')).toBeLessThan(c2.indexOf('## v0.1.1'));
  expect(extractSection(c2, 'v0.1.1')).toBe(s1.trim() + '\n');
  expect(extractSection(c2, '0.1.2')?.split('\n')[0]).toBe('## v0.1.2 — d2');
  expect(extractSection(c2, '0.1.10')).toBeNull(); // \b: 0.1.1 must not match 0.1.10
  expect(extractSection(c2, '9.9.9')).toBeNull();
});

test('setPackageVersion keeps formatting; repoUrlFromPackage reads git+https / ssh forms', () => {
  expect(setPackageVersion('{\n  "name": "x",\n  "version": "0.1.0",\n  "dependencies": {"y": "1.0.0"}\n}', '0.2.0'))
    .toBe('{\n  "name": "x",\n  "version": "0.2.0",\n  "dependencies": {"y": "1.0.0"}\n}');
  expect(repoUrlFromPackage({ repository: { url: 'git+https://github.com/maor700/arigami.git' } })).toBe('https://github.com/maor700/arigami');
  expect(repoUrlFromPackage({ repository: 'git@github.com:o/r.git' })).toBe('https://github.com/o/r');
  expect(repoUrlFromPackage({})).toBeNull();
});

test('main: dry run touches nothing; a real patch release writes VERSION/CHANGELOG/package.json, commits and tags; notes prints the section', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-rel-'));
  const g = (...a: string[]) => { const r = spawnSync('git', a, { cwd: repo, encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };
  g('init', '-q'); g('config', 'user.email', 't@example.invalid'); g('config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'package.json'), '{\n  "name": "x",\n  "version": "0.1.0",\n  "repository": {"url": "git+https://github.com/o/r.git"}\n}\n');
  fs.mkdirSync(path.join(repo, 'web'));
  fs.writeFileSync(path.join(repo, 'web/package.json'), '{ "version": "0.1.0" }\n');
  g('add', '.'); g('commit', '-q', '-m', 'chore: init');
  g('tag', '-a', 'v0.1.0', '-m', 'v0.1.0');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a'); g('add', '.'); g('commit', '-q', '-m', 'feat(a): הוספת a');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'b'); g('add', '.'); g('commit', '-q', '-m', 'fix(b): b broke');

  expect(lastTag(repo)).toBe('v0.1.0');
  expect(commitsSince(repo, 'v0.1.0').map((c) => c.subject)).toEqual(['fix(b): b broke', 'feat(a): הוספת a']);

  const logs: string[] = [];
  const origLog = console.log; console.log = (...a: any[]) => { logs.push(a.join(' ')); };
  try {
    expect(main(['patch', '--dry-run'], repo)).toBe(0);
    expect(fs.existsSync(path.join(repo, 'VERSION'))).toBe(false);
    expect(g('status', '--porcelain')).toBe('');
    expect(logs.join('\n')).toContain('release: 0.1.0 → 0.1.1 (v0.1.1)');
    expect(logs.join('\n')).toContain('dry run');

    logs.length = 0;
    expect(main(['patch'], repo)).toBe(0);
  } finally { console.log = origLog; }

  expect(fs.readFileSync(path.join(repo, 'VERSION'), 'utf8')).toBe('0.1.1\n');
  expect(JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version).toBe('0.1.1');
  expect(JSON.parse(fs.readFileSync(path.join(repo, 'web/package.json'), 'utf8')).version).toBe('0.1.1');
  const cl = fs.readFileSync(path.join(repo, 'CHANGELOG.md'), 'utf8');
  expect(cl).toContain('## v0.1.1 — ');
  expect(cl).toContain('[v0.1.0...v0.1.1](https://github.com/o/r/compare/v0.1.0...v0.1.1)');
  expect(cl).toContain('- **a:** הוספת a (');
  expect(cl).toContain('### Fixes');
  expect(g('status', '--porcelain')).toBe('');
  expect(g('log', '-1', '--format=%s')).toBe('chore(release): v0.1.1');
  expect(g('tag', '--points-at', 'HEAD')).toBe('v0.1.1');
  expect(g('cat-file', '-t', 'v0.1.1')).toBe('tag'); // annotated
  expect(g('remote')).toBe(''); // and nothing to push to — the script never pushes

  // refuses to mint the same tag twice, and a dirty tree
  console.log = () => {};
  const errs: string[] = []; const origErr = console.error; console.error = (...a: any[]) => { errs.push(a.join(' ')); };
  try {
    expect(main(['0.1.1'], repo)).toBe(1);
    expect(errs.join('\n')).toMatch(/already exists/);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'changed');
    expect(main(['patch'], repo)).toBe(1);
    expect(errs.join('\n')).toMatch(/uncommitted/);
    g('checkout', '--', 'a.txt');
    // notes → the section, as the GitHub Release body
    const out: string[] = []; const w = process.stdout.write; (process.stdout as any).write = (s: string) => { out.push(String(s)); return true; };
    try { expect(main(['notes', 'v0.1.1'], repo)).toBe(0); } finally { process.stdout.write = w; }
    expect(out.join('').split('\n')[0]).toMatch(/^## v0\.1\.1 — /);
    expect(main(['notes', 'v9.9.9'], repo)).toBe(1);
  } finally { console.log = origLog; console.error = origErr; }
});

test('autoBump: breaking → major, feat → minor, anything else → patch; noise never decides', () => {
  const c = (subject: string, body = '') => ({ sha: 'a'.repeat(40), subject, body });
  expect(autoBump([c('feat(a): x'), c('refactor(b)!: y')])).toBe('major');
  expect(autoBump([c('fix(a): x'), c('refactor(b): y', 'BREAKING CHANGE: z')])).toBe('major');
  expect(autoBump([c('fix(a): x'), c('feat(b): y')])).toBe('minor');
  expect(autoBump([c('fix(a): x'), c('docs: y'), c('B2: not conventional')])).toBe('patch');
  expect(autoBump([])).toBe('patch');
  // a merge subject carrying "feat" and a release commit are noise — neither lifts the bump
  expect(autoBump([c('Merge child/x: feat גדול'), c('chore(release): v9.9.9'), c('fix: real')])).toBe('patch');
});

test('main auto: picks the bump from the commits, exits 3 when there is nothing releasable', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-rel-auto-'));
  const g = (...a: string[]) => { const r = spawnSync('git', a, { cwd: repo, encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };
  g('init', '-q'); g('config', 'user.email', 't@example.invalid'); g('config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'package.json'), '{\n  "name": "x",\n  "version": "0.1.0",\n  "repository": {"url": "git+https://github.com/o/r.git"}\n}\n');
  g('add', '.'); g('commit', '-q', '-m', 'chore: init');
  g('tag', '-a', 'v0.1.0', '-m', 'v0.1.0');

  const logs: string[] = [];
  const origLog = console.log; console.log = (...a: any[]) => { logs.push(a.join(' ')); };
  try {
    // nothing since the tag → skip, no files written, no commit
    expect(main(['auto'], repo)).toBe(NOTHING_TO_RELEASE);
    expect(NOTHING_TO_RELEASE).toBe(3);
    expect(fs.existsSync(path.join(repo, 'VERSION'))).toBe(false);
    expect(g('log', '-1', '--format=%s')).toBe('chore: init');
    expect(logs.join('\n')).toContain('nothing to release');

    // a merge commit alone is still nothing releasable (its parts are listed on their own)
    logs.length = 0;
    fs.writeFileSync(path.join(repo, 'm.txt'), 'm'); g('add', '.'); g('commit', '-q', '-m', 'Merge child/x: משהו');
    expect(main(['auto'], repo)).toBe(NOTHING_TO_RELEASE);

    // a fix → patch
    logs.length = 0;
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a'); g('add', '.'); g('commit', '-q', '-m', 'fix(a): a broke');
    expect(main(['auto'], repo)).toBe(0);
    expect(logs.join('\n')).toContain('→ patch');
    expect(fs.readFileSync(path.join(repo, 'VERSION'), 'utf8')).toBe('0.1.1\n');
    expect(g('log', '-1', '--format=%s')).toBe('chore(release): v0.1.1');
    expect(g('tag', '-l')).toContain('v0.1.1');

    // a feat since v0.1.1 → minor
    logs.length = 0;
    fs.writeFileSync(path.join(repo, 'b.txt'), 'b'); g('add', '.'); g('commit', '-q', '-m', 'feat(b): הוספת b');
    expect(main(['auto'], repo)).toBe(0);
    expect(logs.join('\n')).toContain('→ minor');
    expect(fs.readFileSync(path.join(repo, 'VERSION'), 'utf8')).toBe('0.2.0\n');

    // a breaking change since v0.2.0 → still pre-1.0, so minor (0.3.0), not 1.0.0
    logs.length = 0;
    fs.writeFileSync(path.join(repo, 'c.txt'), 'c'); g('add', '.'); g('commit', '-q', '-m', 'refactor(c)!: drop the old route');
    expect(main(['auto'], repo)).toBe(0);
    expect(logs.join('\n')).toContain('pre-1.0');
    expect(logs.join('\n')).toContain('→ minor');
    expect(fs.readFileSync(path.join(repo, 'VERSION'), 'utf8')).toBe('0.3.0\n');
    expect(JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version).toBe('0.3.0');

    // the release commit it just made is itself noise → the next auto run skips
    logs.length = 0;
    expect(main(['auto'], repo)).toBe(NOTHING_TO_RELEASE);

    // past 1.0 the clamp is off: a breaking change is a major
    logs.length = 0;
    expect(main(['1.0.0'], repo)).toBe(0);
    fs.writeFileSync(path.join(repo, 'd.txt'), 'd'); g('add', '.'); g('commit', '-q', '-m', 'feat(d)!: another break');
    expect(main(['auto'], repo)).toBe(0);
    expect(logs.join('\n')).toContain('→ major');
    expect(fs.readFileSync(path.join(repo, 'VERSION'), 'utf8')).toBe('2.0.0\n');
  } finally { console.log = origLog; }

  const cl = fs.readFileSync(path.join(repo, 'CHANGELOG.md'), 'utf8');
  expect(cl.indexOf('## v2.0.0')).toBeLessThan(cl.indexOf('## v0.3.0'));
  expect(cl).toContain('### Breaking');
});

test('clampZeroVer: pre-1.0 never auto-mints 1.0.0; an explicit major still can', () => {
  expect(clampZeroVer('major', '0.1.0')).toBe('minor');
  expect(clampZeroVer('major', '0.99.3')).toBe('minor');
  expect(clampZeroVer('minor', '0.1.0')).toBe('minor');
  expect(clampZeroVer('patch', '0.1.0')).toBe('patch');
  expect(clampZeroVer('major', '1.0.0')).toBe('major');
  expect(clampZeroVer('major', '2.4.1')).toBe('major');
});

test('releaseBoundary: the last v* tag, else the commit that last wrote VERSION', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-rel-bound-'));
  const g = (...a: string[]) => { const r = spawnSync('git', a, { cwd: repo, encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };
  g('init', '-q'); g('config', 'user.email', 't@example.invalid'); g('config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'package.json'), '{\n  "name": "x",\n  "version": "0.1.0"\n}\n');
  g('add', '.'); g('commit', '-q', '-m', 'chore: init');
  // no VERSION and no tag → nothing to anchor to
  expect(releaseBoundary(repo)).toEqual({ ref: null, fromTag: false });

  // VERSION written by hand, still no tag (this repo's own v0.1.0 situation)
  fs.writeFileSync(path.join(repo, 'VERSION'), '0.1.0\n'); g('add', '.'); g('commit', '-q', '-m', 'feat(release): VERSION by hand');
  const verSha = g('rev-parse', 'HEAD');
  expect(releaseBoundary(repo)).toEqual({ ref: verSha, fromTag: false });
  expect(lastVersionCommit(repo)).toBe(verSha);

  // later commits do not move the boundary — only a VERSION write does
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a'); g('add', '.'); g('commit', '-q', '-m', 'fix(a): a');
  expect(releaseBoundary(repo)).toEqual({ ref: verSha, fromTag: false });

  // once a tag exists it wins
  g('tag', '-a', 'v0.1.0', '-m', 'v0.1.0');
  expect(releaseBoundary(repo)).toEqual({ ref: 'v0.1.0', fromTag: true });
});

test('main auto with no tag: changelog starts at the VERSION commit, not at the dawn of the repo', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-rel-notag-'));
  const g = (...a: string[]) => { const r = spawnSync('git', a, { cwd: repo, encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };
  g('init', '-q'); g('config', 'user.email', 't@example.invalid'); g('config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'package.json'), '{\n  "name": "x",\n  "version": "0.1.0",\n  "repository": {"url": "git+https://github.com/o/r.git"}\n}\n');
  g('add', '.'); g('commit', '-q', '-m', 'feat(ancient): מלפני הגרסה הראשונה');
  fs.writeFileSync(path.join(repo, 'VERSION'), '0.1.0\n');
  fs.writeFileSync(path.join(repo, 'CHANGELOG.md'), CHANGELOG_HEADER + '## v0.1.0 — 2026-09-08\n\nthe first numbered version\n');
  g('add', '.'); g('commit', '-q', '-m', 'feat(release): VERSION + CHANGELOG by hand (VER1)');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a'); g('add', '.'); g('commit', '-q', '-m', 'fix(a): שייך לגרסה הבאה');

  const logs: string[] = [];
  const origLog = console.log; console.log = (...a: any[]) => { logs.push(a.join(' ')); };
  try { expect(main(['auto'], repo)).toBe(0); } finally { console.log = origLog; }

  expect(logs.join('\n')).toContain('no v* tag yet');
  expect(logs.join('\n')).toContain('1 commit(s)');
  expect(fs.readFileSync(path.join(repo, 'VERSION'), 'utf8')).toBe('0.1.1\n');
  const cl = fs.readFileSync(path.join(repo, 'CHANGELOG.md'), 'utf8');
  const section = cl.slice(cl.indexOf('## v0.1.1'), cl.indexOf('## v0.1.0'));
  expect(section).toContain('שייך לגרסה הבאה');
  expect(section).not.toContain('מלפני הגרסה הראשונה'); // the pre-v0.1.0 commit stays out
  expect(section).not.toContain('VER1');
  expect(section.split('\n')[0]).toMatch(/^## v0\.1\.1 — \d{4}-\d{2}-\d{2}$/); // no compare link off a raw sha
  expect(cl).toContain('## v0.1.0 — 2026-09-08'); // the hand-written section survives
});

test('main auto --dry-run touches nothing but still reports the bump it would take', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-rel-dry-'));
  const g = (...a: string[]) => { const r = spawnSync('git', a, { cwd: repo, encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };
  g('init', '-q'); g('config', 'user.email', 't@example.invalid'); g('config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'package.json'), '{\n  "name": "x",\n  "version": "2.3.4"\n}\n');
  g('add', '.'); g('commit', '-q', '-m', 'feat: first');

  const logs: string[] = [];
  const origLog = console.log; console.log = (...a: any[]) => { logs.push(a.join(' ')); };
  try {
    expect(main(['auto', '--dry-run'], repo)).toBe(0);
  } finally { console.log = origLog; }
  expect(logs.join('\n')).toContain('release: 2.3.4 → 2.4.0 (v2.4.0)');
  expect(logs.join('\n')).toContain('dry run');
  expect(fs.existsSync(path.join(repo, 'VERSION'))).toBe(false);
  expect(g('status', '--porcelain')).toBe('');
  expect(g('tag', '-l')).toBe('');
});
