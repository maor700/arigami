// B4-full (server/backup.ts): full backup manifest + exclusions, profile-bundle
// export that never carries secrets, export-bundle → profile-apply round-trip,
// import refusing newer format/major version, unsafe archive paths, the
// stop-the-world guard, and the .bak swap on restore.
//
// Pure helpers run in-process. Anything that reads ARIGAMI_DIR runs in a child
// with its own throwaway dir (test/_child.js) because server modules capture
// ARIGAMI_DIR at import time. Nothing here touches ~/.arigami.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runInChild } from './_child.js';

const bk = await import('../server/backup.ts');
const tmp = (p = 'arigami-bk-') => fs.mkdtempSync(path.join(os.tmpdir(), p));
const tarList = (f: string) => spawnSync('tar', ['-tzf', f], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean).map((e) => e.replace(/^\.\//, ''));

const SKILL = '---\ndescription: a throwaway exported skill\n---\n\n# Exported\n\nbody\n';

/** A fake, fully populated instance dir — every file is synthetic. */
function fakeInstance(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  const w = (rel: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  };
  w('config.json', JSON.stringify({ port: 3099, defaultModel: 'sonnet', voiceLang: 'en', groqApiKey: 'gsk_FAKE', composioApiKey: 'ck_FAKE' }));
  w('accounts.json', JSON.stringify({ claude: { token: 'sk-ant-FAKE-NOT-REAL' } }));
  w('secrets.env', 'ANTHROPIC_API_KEY=sk-ant-FAKE\n');
  w('users.json', JSON.stringify([{ id: 'u1', email: 'someone@example.com', role: 'admin' }]));
  w('share-secret', 'deadbeef');
  w('repos.json', JSON.stringify([{ name: 'demo-app', source: 'github.com/example/demo-app', branch: 'main', installCmd: 'bun install', envSource: { kind: 'copy', files: ['/home/someone/.env'] } }]));
  w('state.json', JSON.stringify({ sessions: [{ id: 's1', title: 'secret chat' }] }));
  w('sessions.json', '[]');
  w('chat/s1.jsonl', '{"role":"user","text":"private"}\n');
  w('memory/USER.md', '- The user is a test fixture\n- Prefers tabs\n');
  w('memory/MEMORY.md', '- test project uses bun\n');
  w('memory/memory.sqlite', 'not really sqlite');
  w('skills/exported-skill/SKILL.md', SKILL);
  w('skills/exported-skill/notes.md', 'extra file inside the skill dir\n');
  w('uploads/a.txt', 'upload');
  w('triggers.json', JSON.stringify({
    triggers: [
      { id: 'c1', type: 'cron', name: '[old-bundle] morning', prompt: 'say hi', schedule: { kind: 'cron', value: '0 9 * * *' }, enabled: true, autonomous: true, sessionMode: 'existing:s1', deliver: { push: true, whatsapp: '9725550000@s.whatsapp.net', master: 's1' }, createdAt: 'x', lastRun: null, runs: [] },
      { id: 'l1', type: 'linear-filter', name: 'not cron' },
    ],
  }));
  // things a full backup must leave out
  w('run/host.pid', '12345');
  w('run/host.json', '{}');
  w('chrome-sessions/s1/Default/Cookies', 'cookies');
  w('chrome-base/Default/Cookies', 'cookies');
  w('logs/host.log', 'log');
  w('config.json.bak-1', '{}');
  return dir;
}

// ---- pure ----------------------------------------------------------------------------

test('checkManifest: accepts same major, refuses newer format and newer major version', () => {
  const ok = bk.checkManifest({ kind: 'arigami-backup', format: 1, version: '0.1.0' }, { format: 1, version: '0.4.0' });
  expect(ok.version).toBe('0.1.0');
  expect(() => bk.checkManifest({ kind: 'arigami-backup', format: 2, version: '0.1.0' }, { format: 1, version: '0.1.0' })).toThrow(/newer/);
  expect(() => bk.checkManifest({ kind: 'arigami-backup', format: 1, version: '2.0.0' }, { format: 1, version: '1.9.0' })).toThrow(/newer/);
  expect(() => bk.checkManifest({ kind: 'nope' })).toThrow(/not an Arigami backup/);
  expect(() => bk.checkManifest({ kind: 'arigami-backup', version: '1.0.0' })).toThrow(/format/);
  try { bk.checkManifest({ kind: 'arigami-backup', format: 9, version: '0.1.0' }); } catch (e) { expect((e as any).status).toBe(409); }
}, 60_000);

test('assertSafeEntries refuses absolute and parent-escaping paths', () => {
  bk.assertSafeEntries(['./config.json', 'memory/USER.md', 'a/..b/c']);
  expect(() => bk.assertSafeEntries(['../evil'])).toThrow(/unsafe/);
  expect(() => bk.assertSafeEntries(['./a/b/../c'])).toThrow(/unsafe/); // any ".." segment is refused, inside or not
  expect(() => bk.assertSafeEntries(['/etc/passwd'])).toThrow(/unsafe/);
  expect(() => bk.assertSafeEntries(['./ok', 'x/../../evil'])).toThrow(/unsafe/);
}, 60_000);

test('bundleCronFromTrigger strips the bundle tag, existing:<session> mode and personal delivery', () => {
  const c = bk.bundleCronFromTrigger({ name: '[old-bundle] morning', prompt: 'hi', schedule: { kind: 'cron', value: '0 9 * * *' }, enabled: true, autonomous: true, sessionMode: 'existing:s1', deliver: { push: true, whatsapp: '1@s.whatsapp.net', master: 's1' } });
  expect(c).toEqual({ name: 'morning', prompt: 'hi', schedule: { kind: 'cron', value: '0 9 * * *' }, enabled: true, autonomous: true, deliver: { push: true } });
  expect(bk.bundleCronFromTrigger({ name: 'x', prompt: 'p', schedule: { kind: 'interval', value: 3600 }, sessionMode: 'isolated' }).sessionMode).toBe('isolated');
}, 60_000);

test('bundleRepoFromEntry drops local env-file paths; portableSettings is an allow-list', () => {
  const r = bk.bundleRepoFromEntry({ name: 'a', source: 'github.com/x/a', branch: 'main', envSource: { kind: 'copy', files: ['/home/me/.env'] } });
  expect(r).toEqual({ name: 'a', source: 'github.com/x/a', branch: 'main' });
  expect(bk.bundleRepoFromEntry({ name: 'b', source: 's', envSource: { kind: 'command', value: 'vercel env pull' } }).envSource).toEqual({ kind: 'command', value: 'vercel env pull' });
  const s = bk.portableSettings({ defaultModel: 'sonnet', groqApiKey: 'gsk', composioApiKey: 'ck', publicUrl: 'https://example.com', voiceLang: 'he' });
  expect(s).toEqual({ defaultModel: 'sonnet', voiceLang: 'he' });
}, 60_000);

// ---- full export ------------------------------------------------------------------------

test('full export: manifest at the root, secrets kept as-is, run/chrome/logs/.bak excluded', () => {
  const dir = fakeInstance(path.join(tmp(), 'inst'));
  const out = path.join(tmp(), 'full.tgz');
  const r = runInChild(
    `const bk = await import('./server/backup.ts');
     const m = await bk.exportFullToFile(${JSON.stringify(out)});
     emit({ m, tmpLeft: (await import('node:fs')).readdirSync(${JSON.stringify(path.join(dir, 'tmp'))}) });`,
    { ARIGAMI_DIR: dir },
  );
  expect(r.ok).toBe(true);
  const { m, tmpLeft } = r.out[0];
  expect(m.kind).toBe('arigami-backup');
  expect(m.format).toBe(bk.BACKUP_FORMAT);
  expect(typeof m.version).toBe('string');
  expect(m.createdAt).toMatch(/^\d{4}-/);
  expect(m.host.platform).toBe(process.platform);
  expect(tmpLeft).toEqual([]); // scratch dir cleaned up
  const entries = tarList(out);
  expect(entries).toContain(bk.MANIFEST_NAME);
  for (const f of ['config.json', 'accounts.json', 'secrets.env', 'users.json', 'chat/s1.jsonl', 'memory/USER.md', 'skills/exported-skill/SKILL.md', 'uploads/a.txt', 'state.json', 'triggers.json'])
    expect(entries).toContain(f);
  for (const bad of entries) {
    expect(bad.startsWith('run/') || bad === 'run').toBe(false);
    expect(bad.startsWith('chrome-sessions') || bad.startsWith('chrome-base') || bad.startsWith('logs') || bad.startsWith('tmp')).toBe(false);
    expect(/\.bak-/.test(bad)).toBe(false);
  }
}, 60_000);

test('full export --include limits the archive to the named top-level entries', () => {
  const dir = fakeInstance(path.join(tmp(), 'inst'));
  const out = path.join(tmp(), 'part.tgz');
  const r = runInChild(
    `const bk = await import('./server/backup.ts');
     emit(await bk.exportFullToFile(${JSON.stringify(out)}, { include: ['memory', 'skills', 'run', 'nope'] }));`,
    { ARIGAMI_DIR: dir },
  );
  expect(r.ok).toBe(true);
  expect(r.out[0].include).toEqual(['memory', 'skills', 'run', 'nope']);
  const entries = tarList(out);
  expect(entries).toContain('memory/USER.md');
  expect(entries).toContain('skills/exported-skill/SKILL.md');
  expect(entries).toContain(bk.MANIFEST_NAME);
  expect(entries.some((e) => e.startsWith('accounts') || e.startsWith('chat') || e.startsWith('run'))).toBe(false);
}, 60_000);

// ---- bundle export ------------------------------------------------------------------------

test('bundle export: profile.json + skills + memory-seed + cron + README, and NO secrets/chat/state', () => {
  const dir = fakeInstance(path.join(tmp(), 'inst'));
  const out = path.join(tmp(), 'bundle');
  const r = runInChild(
    `const bk = await import('./server/backup.ts');
     const tr = await import('./server/triggers.ts'); tr.load();
     const b = bk.exportBundle({ out: ${JSON.stringify(out)}, cron: tr.listTriggers() });
     const pf = await import('./server/profiles.ts');
     const loaded = pf.loadBundle(b.dir);
     emit({ b, v: pf.validate(loaded), manifest: loaded.manifest, skills: loaded.skills.map(s => s.name), cron: loaded.cron, seed: loaded.memorySeed, trusted: loaded.trusted });`,
    { ARIGAMI_DIR: dir },
  );
  expect(r.ok).toBe(true);
  const o = r.out[0];
  expect(o.b.name).toBe('exported-host');
  expect(o.b.skills).toEqual(['exported-skill']);
  expect(o.b.cron).toBe(1);
  expect(o.b.repos).toBe(1);
  expect(o.b.memorySeed).toEqual(['USER.md', 'MEMORY.md']);
  expect(o.v.ok).toBe(true);
  expect(o.trusted).toBe(false); // an exported bundle is external ⇒ skills go through proposals
  expect(o.manifest.repos).toEqual([{ name: 'demo-app', source: 'github.com/example/demo-app', branch: 'main', installCmd: 'bun install' }]);
  expect(o.manifest.settings).toEqual({ defaultModel: 'sonnet', voiceLang: 'en' });
  expect(JSON.stringify(o.manifest)).not.toMatch(/FAKE|gsk_|ck_|someone/);
  expect(o.cron).toEqual([{ name: 'morning', prompt: 'say hi', schedule: { kind: 'cron', value: '0 9 * * *' }, enabled: true, autonomous: true, deliver: { push: true } }]);
  expect(o.seed.user).toContain('Prefers tabs');

  // files on disk: whole skill dir copied, nothing else leaked
  const all: string[] = [];
  const walk = (d: string, rel = '') => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(rel, e.name); if (e.isDirectory()) walk(path.join(d, e.name), p); else all.push(p); } };
  walk(out);
  expect(all.sort()).toEqual(['README.md', 'cron.json', 'memory-seed/MEMORY.md', 'memory-seed/USER.md', 'profile.json', 'skills/exported-skill/SKILL.md', 'skills/exported-skill/notes.md']);
  for (const f of bk.SECRET_FILES) expect(all).not.toContain(f);
  expect(all.some((f) => /^(chat|uploads|run|state)/.test(f))).toBe(false);
  const readme = fs.readFileSync(path.join(out, 'README.md'), 'utf8');
  expect(readme).toContain('exported-skill');
  expect(readme).not.toMatch(/FAKE|someone/);

  // the tarball form, as the UI downloads it
  const tgz = path.join(tmp(), 'bundle.tgz');
  const r2 = runInChild(
    `const bk = await import('./server/backup.ts'); const fs = await import('node:fs');
     const t = bk.tarDir(${JSON.stringify(out)}, 'b.tgz'); const w = fs.createWriteStream(${JSON.stringify(tgz)}); t.stream.pipe(w);
     await t.done; await new Promise(r => w.on('finish', r)); emit(bk.detectArchive(${JSON.stringify(tgz)}).kind);`,
    { ARIGAMI_DIR: dir },
  );
  expect(r2.ok).toBe(true);
  expect(r2.out[0]).toBe('bundle');
  const entries = tarList(tgz);
  for (const f of ['accounts.json', 'secrets.json', 'secrets.env', 'users.json', 'config.json', 'state.json', 'sessions.json']) expect(entries).not.toContain(f);
  expect(entries).toContain('profile.json');
}, 60_000);

test('bundle export refuses to write inside $ARIGAMI_DIR (other than tmp/)', () => {
  const dir = fakeInstance(path.join(tmp(), 'inst'));
  const r = runInChild(
    `const bk = await import('./server/backup.ts');
     let e1 = ''; try { bk.exportBundle({ out: ${JSON.stringify(path.join(dir, 'skills'))} }); } catch (e) { e1 = e.message; }
     const ok = bk.exportBundle({}); emit({ e1, okDir: ok.dir });`,
    { ARIGAMI_DIR: dir },
  );
  expect(r.ok).toBe(true);
  expect(r.out[0].e1).toMatch(/refusing/);
  expect(r.out[0].okDir.startsWith(path.join(dir, 'tmp'))).toBe(true);
}, 60_000);

// ---- round trip: export bundle → profile apply on a fresh instance ---------------------------

test('round-trip: an exported bundle applies on a clean instance (repos, skill proposal, memory seed, disabled cron)', () => {
  const src = fakeInstance(path.join(tmp(), 'src'));
  const out = path.join(tmp(), 'bundle');
  const r1 = runInChild(
    `const bk = await import('./server/backup.ts'); const tr = await import('./server/triggers.ts'); tr.load();
     emit(bk.exportBundle({ out: ${JSON.stringify(out)}, cron: tr.listTriggers() }));`,
    { ARIGAMI_DIR: src },
  );
  expect(r1.ok).toBe(true);

  const dst = path.join(tmp(), 'dst');
  fs.mkdirSync(dst, { recursive: true });
  const r2 = runInChild(
    `const pf = await import('./server/profiles.ts'); const tr = await import('./server/triggers.ts'); tr.load();
     const rep = await pf.applySource(${JSON.stringify(out)}); tr.flush();
     const fs = await import('node:fs'); const path = await import('node:path');
     const sp = await import('./server/skill-proposals.ts');
     const pending = sp.listProposals().filter(p => p.status === 'pending').map(p => ({ name: p.name, content: fs.readFileSync(path.join(sp.PROPOSALS_DIR, p.id, 'content.md'), 'utf8') }));
     emit({ rep, repos: JSON.parse(fs.readFileSync(path.join(${JSON.stringify(dst)}, 'repos.json'), 'utf8')),
            user: fs.readFileSync(path.join(${JSON.stringify(dst)}, 'memory/USER.md'), 'utf8'),
            memory: fs.readFileSync(path.join(${JSON.stringify(dst)}, 'memory/MEMORY.md'), 'utf8'),
            triggers: tr.listTriggers().filter(t => t.type === 'cron').map(t => ({ name: t.name, enabled: t.enabled, prompt: t.prompt, autonomous: t.autonomous })),
            pending, prov: JSON.parse(fs.readFileSync(path.join(${JSON.stringify(dst)}, 'profile.json'), 'utf8')).name,
            leaked: ['accounts.json','secrets.env','users.json','state.json','chat'].filter(f => fs.existsSync(path.join(${JSON.stringify(dst)}, f))) });`,
    { ARIGAMI_DIR: dst },
  );
  expect(r2.ok).toBe(true);
  const o = r2.out[0];
  expect(o.rep.errors).toEqual([]);
  expect(o.rep.repos).toEqual(['demo-app']);
  expect(o.repos.map((x: any) => x.name)).toEqual(['demo-app']);
  expect(o.repos[0].envSource).toBeUndefined();
  expect(o.rep.skills).toEqual([{ name: 'exported-skill', status: 'pending', proposalId: expect.any(String) }]);
  expect(o.pending).toEqual([{ name: 'exported-skill', content: SKILL }]);
  expect(o.user).toContain('Prefers tabs');
  expect(o.memory).toContain('test project uses bun');
  expect(o.triggers).toEqual([{ name: '[exported-host] morning', enabled: false, prompt: 'say hi', autonomous: false }]);
  expect(o.prov).toBe('exported-host');
  expect(o.leaked).toEqual([]);

  // re-exporting the applied instance keeps the cron name un-nested (tag stripped again)
  const r3 = runInChild(
    `const bk = await import('./server/backup.ts'); const tr = await import('./server/triggers.ts'); tr.load();
     const b = bk.exportBundle({ cron: tr.listTriggers() }); const fs = await import('node:fs');
     emit(JSON.parse(fs.readFileSync(b.dir + '/cron.json', 'utf8')).map(c => c.name));`,
    { ARIGAMI_DIR: dst },
  );
  expect(r3.ok).toBe(true);
  expect(r3.out[0]).toEqual(['morning']);
}, 60_000);

// ---- import -------------------------------------------------------------------------------------

function makeArchive(files: Record<string, string>, manifest: unknown, extraTar: string[] = []): string {
  const root = tmp('arigami-arch-');
  const src = path.join(root, 'src');
  fs.mkdirSync(src, { recursive: true });
  for (const [rel, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(src, rel)), { recursive: true }); fs.writeFileSync(path.join(src, rel), c); }
  if (manifest !== undefined) fs.writeFileSync(path.join(src, bk.MANIFEST_NAME), JSON.stringify(manifest));
  const out = path.join(root, 'a.tgz');
  const r = spawnSync('tar', ['-czf', out, '-C', src, '.', ...extraTar], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return out;
}

const goodManifest = (over: Record<string, unknown> = {}) => ({ kind: 'arigami-backup', format: bk.BACKUP_FORMAT, version: '0.0.1', commit: 'abc', createdAt: 'now', host: {}, include: null, excludes: [], ...over });

test('import refuses a newer major version / newer format / non-backup / unsafe paths', () => {
  const newer = makeArchive({ 'config.json': '{}' }, goodManifest({ version: '99.0.0' }));
  expect(() => bk.readManifestFromArchive(newer)).toThrow(/newer than this host/);
  const fmt = makeArchive({ 'config.json': '{}' }, goodManifest({ format: bk.BACKUP_FORMAT + 1 }));
  expect(() => bk.readManifestFromArchive(fmt)).toThrow(/newer than this host/);
  const none = makeArchive({ 'config.json': '{}' }, undefined);
  expect(() => bk.readManifestFromArchive(none)).toThrow(/not an Arigami backup/);
  expect(() => bk.detectArchive(none)).toThrow(/neither/);
  // a bundle archive is recognised as such
  const bundle = makeArchive({ 'profile.json': '{"name":"x"}' }, undefined);
  expect(bk.detectArchive(bundle).kind).toBe('bundle');
  // an entry escaping the root
  const root = tmp('arigami-esc-');
  fs.mkdirSync(path.join(root, 'in'));
  fs.writeFileSync(path.join(root, 'evil'), 'x');
  fs.writeFileSync(path.join(root, 'in', bk.MANIFEST_NAME), JSON.stringify(goodManifest()));
  const esc = path.join(root, 'esc.tgz');
  spawnSync('tar', ['-P', '-czf', esc, '-C', path.join(root, 'in'), '.', '../evil']);
  expect(() => bk.readManifestFromArchive(esc)).toThrow(/unsafe path/);
}, 60_000);

test('importFull: stop-the-world guard (409 unless force)', async () => {
  const arch = makeArchive({ 'config.json': '{"a":1}' }, goodManifest());
  const dir = path.join(tmp(), 'inst');
  fakeInstance(dir);
  let status = 0;
  try { await bk.importFull(arch, { dir, busyCount: () => 2 }); } catch (e) { status = (e as any).status; expect((e as Error).message).toMatch(/2 session\(s\) are working/); }
  expect(status).toBe(409);
  expect(fs.readFileSync(path.join(dir, 'accounts.json'), 'utf8')).toContain('FAKE'); // untouched
  const r = await bk.importFull(arch, { dir, busyCount: () => 2, force: true });
  expect(r.restartRequired).toBe(true);
  expect(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'))).toEqual({ a: 1 });
}, 60_000);

test('importFull: restores, keeps a timestamped .bak of the previous dir, carries run/ over, records the manifest', async () => {
  const dir = path.join(tmp(), 'inst');
  fakeInstance(dir);
  const arch = makeArchive(
    { 'config.json': '{"restored":true}', 'memory/USER.md': '- restored user\n', 'accounts.json': '{"from":"backup"}', 'run/host.pid': '999', 'chrome-sessions/x': 'y' },
    goodManifest({ version: '0.0.9' }),
  );
  const now = new Date('2026-08-30T12:34:56Z');
  const r = await bk.importFull(arch, { dir, busyCount: () => 0, now: () => now });
  expect(r.manifest.version).toBe('0.0.9');
  expect(r.restoredTo).toBe(dir);
  expect(r.backupDir).toBe(`${dir}.bak-20260830T123456Z`);
  expect(fs.existsSync(r.backupDir!)).toBe(true);
  // previous data intact in the .bak
  expect(fs.readFileSync(path.join(r.backupDir!, 'accounts.json'), 'utf8')).toContain('FAKE');
  expect(fs.existsSync(path.join(r.backupDir!, 'chat/s1.jsonl'))).toBe(true);
  // new data in place
  expect(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'))).toEqual({ restored: true });
  expect(fs.readFileSync(path.join(dir, 'memory/USER.md'), 'utf8')).toBe('- restored user\n');
  expect(fs.readFileSync(path.join(dir, 'accounts.json'), 'utf8')).toContain('backup');
  expect(fs.existsSync(path.join(dir, 'chat/s1.jsonl'))).toBe(false);
  // run/ is THIS host's, not the archive's; chrome-sessions from the archive are dropped
  expect(fs.readFileSync(path.join(dir, 'run/host.pid'), 'utf8')).toBe('12345');
  expect(fs.existsSync(path.join(dir, 'chrome-sessions'))).toBe(false);
  // manifest kept as provenance
  const kept = JSON.parse(fs.readFileSync(path.join(dir, bk.MANIFEST_NAME), 'utf8'));
  expect(kept.version).toBe('0.0.9');
  expect(kept.importedAt).toMatch(/^\d{4}-/);
  // staging dir gone
  expect(fs.readdirSync(path.dirname(dir)).filter((n) => n.includes('.import-'))).toEqual([]);
  // a second restore makes a second .bak and doesn't clobber the first
  const r2 = await bk.importFull(arch, { dir, busyCount: () => 0, now: () => new Date('2026-08-30T12:35:00Z') });
  expect(r2.backupDir).toBe(`${dir}.bak-20260830T123500Z`);
  expect(fs.existsSync(r.backupDir!)).toBe(true);
}, 60_000);

test('importFull into a missing dir just creates it', async () => {
  const dir = path.join(tmp(), 'fresh');
  const arch = makeArchive({ 'config.json': '{"x":1}' }, goodManifest());
  const r = await bk.importFull(arch, { dir, busyCount: () => 0 });
  expect(r.backupDir).toBeNull();
  expect(fs.existsSync(path.join(dir, 'config.json'))).toBe(true);
}, 60_000);

test('full export → importFull round-trips a whole instance', async () => {
  const src = fakeInstance(path.join(tmp(), 'src'));
  const out = path.join(tmp(), 'full.tgz');
  const r = runInChild(`const bk = await import('./server/backup.ts'); emit(await bk.exportFullToFile(${JSON.stringify(out)}));`, { ARIGAMI_DIR: src });
  expect(r.ok).toBe(true);
  const dst = path.join(tmp(), 'dst');
  await bk.importFull(out, { dir: dst, busyCount: () => 0 });
  for (const f of ['config.json', 'accounts.json', 'secrets.env', 'users.json', 'chat/s1.jsonl', 'memory/USER.md', 'memory/memory.sqlite', 'skills/exported-skill/SKILL.md', 'uploads/a.txt', 'state.json', 'triggers.json', 'repos.json'])
    expect(fs.readFileSync(path.join(dst, f), 'utf8')).toBe(fs.readFileSync(path.join(src, f), 'utf8'));
  expect(fs.existsSync(path.join(dst, 'chrome-sessions'))).toBe(false);
  expect(fs.existsSync(path.join(dst, 'logs'))).toBe(false);
}, 60_000);

// ---- CLI ----------------------------------------------------------------------------------------

test('bun server/backup.ts export/inspect/import CLI', () => {
  const dir = fakeInstance(path.join(tmp(), 'inst'));
  const ROOT = path.resolve(import.meta.dir, '..');
  const run = (args: string[], env: Record<string, string> = {}) => spawnSync('bun', ['server/backup.ts', ...args], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ARIGAMI_DIR: dir, ...env }, timeout: 30_000 });
  const full = path.join(tmp(), 'cli.tgz');
  let r = run(['export', '--full', full]);
  expect(r.status).toBe(0);
  expect(JSON.parse(r.stdout).manifest.kind).toBe('arigami-backup');
  r = run(['inspect', full]);
  expect(JSON.parse(r.stdout).kind).toBe('full');
  const bundle = path.join(tmp(), 'cli-bundle.tgz');
  r = run(['export', '--bundle', bundle, '--name', 'My Setup']);
  expect(r.status).toBe(0);
  expect(JSON.parse(r.stdout).name).toBe('my-setup');
  expect(tarList(bundle)).toContain('profile.json');
  expect(tarList(bundle)).not.toContain('accounts.json');
  r = run(['inspect', bundle]);
  expect(JSON.parse(r.stdout).kind).toBe('bundle');
  // import a newer-major backup → exit 3
  const newer = makeArchive({ 'config.json': '{}' }, goodManifest({ version: '99.0.0' }));
  r = run(['import', newer]);
  expect(r.status).toBe(3);
  expect(r.stderr).toMatch(/newer/);
  // import a bundle applies it (fresh dir)
  const dst = path.join(tmp(), 'dst');
  fs.mkdirSync(dst);
  r = run(['import', bundle], { ARIGAMI_DIR: dst });
  expect(r.status).toBe(0);
  const rep = JSON.parse(r.stdout);
  expect(rep.kind).toBe('bundle');
  expect(rep.repos).toEqual(['demo-app']);
  expect(fs.existsSync(path.join(dst, 'profiles', 'my-setup', 'profile.json'))).toBe(true);
  r = run([]);
  expect(r.status).toBe(2);
}, 60_000);
